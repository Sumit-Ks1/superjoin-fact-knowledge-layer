/**
 * Blocks → chunks.
 *
 * A chunk is the unit that gets embedded, and the unit an extraction prompt
 * sees. Two constraints shape it:
 *
 *  - A table is never split, and never merged with prose. Half a grid is not a
 *    smaller grid, it is a corrupt one, and the deterministic table extractor
 *    needs the whole thing.
 *  - Every chunk carries its heading breadcrumb. "Revenue grew 25%" is
 *    unusable on its own; under "Our Business ▸ Express Parcel" it is a fact
 *    about a segment. The breadcrumb travels with the text into the embedding
 *    and into the prompt, because the model cannot see the page.
 *
 * Nothing here knows what kind of document it is reading. The only inputs are
 * block kind, heading depth and text length, all of which the parser derives
 * from the page's own geometry.
 */

import type { BBox, TableCell } from "@/db/schema";
import { sha256 } from "@/lib/hash";
import type { ParsedBlock } from "@/pdf/blocks";
import type { PageResult, ParsedTable } from "@/pdf/parse";
import { tableToMarkdown } from "@/pdf/tables";

/**
 * Target chunk size in characters.
 *
 * Large enough that a paragraph keeps the sentences that qualify it — "in the
 * nine months ended December 31, 2021" often sits a sentence away from the
 * number it governs — and small enough that a model's attention over the chunk
 * stays even.
 */
const TARGET_CHARS = 2400;
/** Never emit a chunk longer than this; oversized blocks are split at sentences. */
const MAX_CHARS = 4000;
/** Below this a fragment is joined to its neighbour rather than standing alone. */
const MIN_CHARS = 180;

/** Rough token estimate. Used for budgeting only, never for billing. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ChunkDraft = {
  ordinal: number;
  kind: "narrative" | "table";
  breadcrumb: string;
  text: string;
  pageStart: number;
  pageEnd: number;
  bboxUnion: BBox | null;
  tokenCount: number;
  contentHash: string;
  /** Index into the document's table array; resolved to a uuid on persist. */
  tableIndex: number | null;
  factBearing: boolean;
  /** Blocks this chunk was built from, for evidence back-references. */
  blockOrdinals: number[];
};

function unionBBox(boxes: BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/**
 * "Our Business ▸ Network and Infrastructure"
 *
 * Capped independently of the parser's own depth limit. The breadcrumb is
 * prepended to every chunk, so it is charged for on every embedding and every
 * prompt; an unusual document must not be able to spend the whole budget on
 * navigation. The tail is kept because the nearest heading is the informative
 * one.
 */
const MAX_BREADCRUMB_CHARS = 240;

function renderBreadcrumb(path: string[]): string {
  const parts = path.filter((p) => p.trim() !== "");
  const kept: string[] = [];
  let budget = MAX_BREADCRUMB_CHARS;
  for (let i = parts.length - 1; i >= 0; i--) {
    const cost = parts[i].length + 3;
    if (kept.length > 0 && cost > budget) break;
    kept.unshift(parts[i]);
    budget -= cost;
  }
  const rendered = kept.join(" ▸ ");
  return rendered.length > MAX_BREADCRUMB_CHARS
    ? rendered.slice(rendered.length - MAX_BREADCRUMB_CHARS)
    : rendered;
}

/*
 * Cues that a chunk of prose asserts something checkable. Deliberately
 * generic: these are properties of English statements, not of annual reports.
 */
const HAS_DIGIT = /\d/;
const DOT_LEADER = /\.{4,}/;
const RELATIONAL_CUE =
  /\b(?:is|are|was|were|has|have|had|will|acquired|founded|launched|appointed|resigned|owns?|holds?|operates?|reported|increased|decreased|grew|fell|rose|declined|comprises?|consists?|includes?|represents?|amounts?|totall?ed|expects?|estimates?)\b/i;

/**
 * Cheap gate deciding whether a chunk is worth an extraction call.
 *
 * Cost control, not correctness: a false negative loses facts, so the bar is
 * low and only the clearly inert is excluded. A table of contents has digits on
 * every line and asserts nothing, which is why dot leaders are checked before
 * digits.
 */
function isFactBearing(text: string, kind: "narrative" | "table"): boolean {
  if (kind === "table") return true;

  const trimmed = text.trim();
  if (trimmed.length < 40) return false;

  // Contents pages and index runs: "OUR BUSINESS.......... 212".
  const leaderLines = trimmed.split("\n").filter((l) => DOT_LEADER.test(l)).length;
  if (leaderLines > 0 && leaderLines >= trimmed.split("\n").length / 2) return false;

  return HAS_DIGIT.test(trimmed) || RELATIONAL_CUE.test(trimmed);
}

/**
 * Splits an oversized block at sentence boundaries.
 *
 * Falls back to a hard character split when a "sentence" runs past the cap,
 * which happens in legal recitals that go a full page without a full stop.
 */
function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];

  const parts: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = "";

  for (const sentence of sentences) {
    if (current !== "" && current.length + sentence.length + 1 > TARGET_CHARS) {
      parts.push(current);
      current = "";
    }
    if (sentence.length > MAX_CHARS) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
      for (let i = 0; i < sentence.length; i += TARGET_CHARS) {
        parts.push(sentence.slice(i, i + TARGET_CHARS));
      }
      continue;
    }
    current = current === "" ? sentence : `${current} ${sentence}`;
  }

  if (current !== "") parts.push(current);
  return parts;
}

/** A table rendered for retrieval: caption and scale travel with the grid. */
function renderTableChunk(table: ParsedTable, breadcrumb: string): string {
  const header: string[] = [];
  if (breadcrumb !== "") header.push(breadcrumb);
  if (table.caption) header.push(table.caption);
  if (table.unitHint) header.push(`Units: ${table.unitHint}`);
  header.push(`Page ${table.pageNo}`);
  return `${header.join("\n")}\n\n${tableToMarkdown(table)}`;
}

/** Blocks that carry no assertion of their own. */
function isSkippable(block: ParsedBlock): boolean {
  return block.kind === "header_footer" || block.kind === "figure";
}

export type ChunkingResult = {
  chunks: ChunkDraft[];
  /** Tables in document order; index matches `ChunkDraft.tableIndex`. */
  tables: { table: ParsedTable; cells: TableCell[] }[];
};

/**
 * Builds chunks for a whole document.
 *
 * Takes every page at once because a paragraph that runs over a page break is
 * one thought, and splitting it would strand the number from the period that
 * qualifies it.
 */
export function buildChunks(pages: PageResult[]): ChunkingResult {
  const chunks: ChunkDraft[] = [];
  const tables: { table: ParsedTable; cells: TableCell[] }[] = [];

  // Open narrative buffer, flushed at heading changes and size limits.
  let buffer: {
    breadcrumb: string;
    texts: string[];
    boxes: BBox[];
    pages: number[];
    blockOrdinals: number[];
  } | null = null;

  const flush = () => {
    if (!buffer || buffer.texts.length === 0) return;
    const joined = buffer.texts.join("\n\n").trim();
    if (joined === "") {
      buffer = null;
      return;
    }

    for (const part of splitLongText(joined)) {
      const body = part.trim();
      if (body === "") continue;
      // The breadcrumb is part of the embedded text, not metadata beside it.
      const text = buffer!.breadcrumb === "" ? body : `${buffer!.breadcrumb}\n\n${body}`;
      chunks.push({
        ordinal: chunks.length,
        kind: "narrative",
        breadcrumb: buffer!.breadcrumb,
        text,
        pageStart: Math.min(...buffer!.pages),
        pageEnd: Math.max(...buffer!.pages),
        bboxUnion: unionBBox(buffer!.boxes),
        tokenCount: estimateTokens(text),
        contentHash: sha256(text),
        tableIndex: null,
        factBearing: isFactBearing(body, "narrative"),
        blockOrdinals: [...buffer!.blockOrdinals],
      });
    }
    buffer = null;
  };

  for (const page of pages) {
    for (const block of page.blocks) {
      if (isSkippable(block)) continue;

      const breadcrumb = renderBreadcrumb(block.headingPath);

      if (block.kind === "table" && block.tableIndex !== null) {
        // A table interrupts the prose around it; the buffer must not span it.
        flush();

        const table = page.tables[block.tableIndex];
        if (!table) continue;

        const tableIndex = tables.length;
        tables.push({
          table,
          cells: table.cells.map((c) => ({
            row: c.row,
            col: c.col,
            text: c.text,
            bbox: c.bbox,
            colSpan: c.colSpan,
            isNumeric: c.isNumeric,
          })),
        });

        const text = renderTableChunk(table, breadcrumb);
        chunks.push({
          ordinal: chunks.length,
          kind: "table",
          breadcrumb,
          text,
          pageStart: table.pageNo,
          pageEnd: table.pageNo,
          bboxUnion: table.bbox,
          tokenCount: estimateTokens(text),
          contentHash: sha256(text),
          tableIndex,
          // A chart's ticks are not facts; the region is kept for the audit
          // trail but never sent for extraction.
          factBearing: table.kind === "grid",
          blockOrdinals: [block.ordinal],
        });
        continue;
      }

      // A heading opens a new section: flush what came before so the previous
      // section's text never inherits the next section's breadcrumb.
      if (block.kind === "heading") {
        flush();
        continue;
      }

      if (buffer && buffer.breadcrumb !== breadcrumb) flush();

      if (!buffer) {
        buffer = { breadcrumb, texts: [], boxes: [], pages: [], blockOrdinals: [] };
      }

      buffer.texts.push(block.text);
      buffer.boxes.push(block.bbox);
      buffer.pages.push(block.pageNo);
      buffer.blockOrdinals.push(block.ordinal);

      if (buffer.texts.join("\n\n").length >= TARGET_CHARS) flush();
    }
  }

  flush();

  return { chunks, tables: mergeUndersizedNeighbours(chunks, tables) };
}

/**
 * Joins a stranded fragment onto the chunk before it.
 *
 * Section headers frequently sit above a single short line, which alone carries
 * too little context to extract from and pollutes similarity search. Tables are
 * never touched.
 */
function mergeUndersizedNeighbours(
  chunks: ChunkDraft[],
  tables: { table: ParsedTable; cells: TableCell[] }[],
): { table: ParsedTable; cells: TableCell[] }[] {
  for (let i = chunks.length - 1; i > 0; i--) {
    const current = chunks[i];
    const previous = chunks[i - 1];
    if (current.kind !== "narrative" || previous.kind !== "narrative") continue;
    if (current.text.length >= MIN_CHARS) continue;
    if (previous.breadcrumb !== current.breadcrumb) continue;
    // Absorbing a fragment must not push the host past the size ceiling; a
    // stranded fragment is a smaller problem than an oversized chunk.
    if (previous.text.length + current.text.length > MAX_CHARS) continue;

    previous.text = `${previous.text}\n\n${current.text.slice(current.breadcrumb.length).trim()}`;
    previous.pageEnd = Math.max(previous.pageEnd, current.pageEnd);
    previous.tokenCount = estimateTokens(previous.text);
    previous.contentHash = sha256(previous.text);
    previous.blockOrdinals.push(...current.blockOrdinals);
    previous.factBearing = previous.factBearing || current.factBearing;
    previous.bboxUnion = unionBBox(
      [previous.bboxUnion, current.bboxUnion].filter((b): b is BBox => b !== null),
    );
    chunks.splice(i, 1);
  }

  // Ordinals must stay dense and monotonic; they are the document's reading order.
  chunks.forEach((chunk, index) => {
    chunk.ordinal = index;
  });

  return tables;
}
