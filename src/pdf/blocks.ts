/**
 * Lines → semantic blocks, with a heading breadcrumb attached to each one.
 *
 * The breadcrumb is what makes retrieval work later: a chunk that reads
 * "82 gateways across India (excluding Spoton)" is ambiguous alone, but
 * "Our Business > Network, Infrastructure and Automation > 82 gateways…" is not.
 */

import type { BlockKind } from "@/db/schema";
import { bodyFontSize } from "./lines";
import type { DetectedTable } from "./tables";
import type { BBox, Line } from "./types";

export type ParsedBlock = {
  pageNo: number;
  ordinal: number;
  kind: BlockKind;
  text: string;
  bbox: BBox;
  headingPath: string[];
  fontSize: number;
  /** Index into the page's table array when `kind === "table"`. */
  tableIndex: number | null;
  lineIndices: number[];
};

/** Headings run at least this much larger than body copy. */
const HEADING_SIZE_RATIO = 1.12;
/** Vertical gap, in line heights, that ends a paragraph. */
const PARAGRAPH_BREAK_RATIO = 1.75;
const MAX_HEADING_LENGTH = 160;
/**
 * Deepest breadcrumb kept.
 *
 * Without a cap the trail grows without bound: a heading whose size is not one
 * of the page's ranked sizes falls back to "one deeper than we are now", and a
 * cover page — where every line is large type and none is body text — appends
 * on every line. The prospectus cover produced a 4,467-character breadcrumb
 * that was then prepended to every chunk for the next forty pages.
 */
const MAX_HEADING_DEPTH = 6;
/** Figure labels are short; chart pages are full of them. */
const FIGURE_SEGMENT_MAX_LENGTH = 8;

const BULLET_RE = /^\s*(?:[•●▪◦‣·–—*]|\(?[a-z]\)|\(?(?:x{0,3}(?:ix|iv|v?i{0,3}))\)|\d{1,2}[.)])\s+/i;
const SENTENCE_END_RE = /[.!?:;]\s*$/;
const NUMBERED_HEADING_RE = /^\s*(?:section\s+[ivxlc]+|annexure|appendix|part\s+[a-z0-9]|\d+(?:\.\d+)*\.?)\s*[:.\-–—]?\s+\S/i;

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^a-z]/gi, "");
  if (letters.length < 3) return false;
  return letters === letters.toUpperCase();
}

function looksLikeHeading(line: Line, bodySize: number): boolean {
  const text = line.text.trim();
  if (text.length === 0 || text.length > MAX_HEADING_LENGTH) return false;
  // A row of numbers is a data row however it is styled.
  if (line.segments.filter((s) => s.isNumeric).length >= 2) return false;

  const larger = line.fontSize >= bodySize * HEADING_SIZE_RATIO;
  const emphasised =
    (line.bold || isAllCaps(text)) && line.fontSize >= bodySize * 0.95 && !SENTENCE_END_RE.test(text);
  const numbered = NUMBERED_HEADING_RE.test(text) && text.length < 100 && !SENTENCE_END_RE.test(text);

  return larger || emphasised || numbered;
}

function looksLikeFigureLabel(line: Line): boolean {
  if (line.segments.length < 3) return false;
  const averageLength =
    line.segments.reduce((sum, s) => sum + s.text.length, 0) / line.segments.length;
  if (averageLength > FIGURE_SEGMENT_MAX_LENGTH) return false;
  const numeric = line.segments.filter((s) => s.isNumeric).length / line.segments.length;
  return numeric >= 0.45;
}

function bboxOf(lines: Line[]): BBox {
  return {
    x0: Math.min(...lines.map((l) => l.x0)),
    y0: Math.min(...lines.map((l) => l.y0)),
    x1: Math.max(...lines.map((l) => l.x1)),
    y1: Math.max(...lines.map((l) => l.y1)),
  };
}

/**
 * Ranks distinct heading sizes so a breadcrumb nests correctly without any
 * hardcoded style assumptions: the largest heading size on the page is level 0,
 * the next is level 1, and bold-at-body-size sits below both.
 */
function buildHeadingLevels(lines: Line[], bodySize: number): Map<number, number> {
  const sizes = new Set<number>();
  for (const line of lines) {
    if (looksLikeHeading(line, bodySize) && line.fontSize >= bodySize * HEADING_SIZE_RATIO) {
      sizes.add(Math.round(line.fontSize * 2) / 2);
    }
  }
  const ordered = [...sizes].sort((a, b) => b - a);
  const levels = new Map<number, number>();
  ordered.forEach((size, index) => levels.set(size, index));
  return levels;
}

export function buildBlocks(
  lines: Line[],
  tables: DetectedTable[],
  page: { pageNo: number; height: number },
  /** Carried in from the previous page so breadcrumbs survive page breaks. */
  incomingHeadingPath: string[] = [],
): { blocks: ParsedBlock[]; headingPath: string[] } {
  const bodySize = bodyFontSize(lines);
  const headingLevels = buildHeadingLevels(lines, bodySize);

  // Lines consumed by a table are emitted as one block, not as prose.
  const tableOwner = new Map<number, number>();
  tables.forEach((table, index) => {
    for (let i = table.lineStart; i <= table.lineEnd; i++) tableOwner.set(i, index);
  });

  const blocks: ParsedBlock[] = [];
  let headingPath = [...incomingHeadingPath];
  let ordinal = 0;

  let buffer: { indices: number[]; kind: BlockKind } | null = null;

  const flush = () => {
    if (!buffer || buffer.indices.length === 0) return;
    const group = buffer.indices.map((i) => lines[i]);
    blocks.push({
      pageNo: page.pageNo,
      ordinal: ordinal++,
      kind: buffer.kind,
      text: group.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim(),
      bbox: bboxOf(group),
      headingPath: [...headingPath],
      fontSize: group[0].fontSize,
      tableIndex: null,
      lineIndices: [...buffer.indices],
    });
    buffer = null;
  };

  const emittedTables = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.text.trim() === "") continue;

    // ---- table ----------------------------------------------------------
    const owner = tableOwner.get(i);
    if (owner !== undefined) {
      flush();
      if (!emittedTables.has(owner)) {
        emittedTables.add(owner);
        const table = tables[owner];
        const group = lines.slice(table.lineStart, table.lineEnd + 1);
        blocks.push({
          pageNo: page.pageNo,
          ordinal: ordinal++,
          kind: "table",
          text: group.map((l) => l.text).join("\n"),
          bbox: table.bbox,
          headingPath: [...headingPath],
          fontSize: bodySize,
          tableIndex: owner,
          lineIndices: group.map((_, k) => table.lineStart + k),
        });
      }
      continue;
    }

    // ---- footnote -------------------------------------------------------
    const nearBottom = line.y0 < page.height * 0.16;
    if (nearBottom && line.fontSize < bodySize * 0.86) {
      flush();
      blocks.push({
        pageNo: page.pageNo,
        ordinal: ordinal++,
        kind: "footnote",
        text: line.text,
        bbox: bboxOf([line]),
        headingPath: [...headingPath],
        fontSize: line.fontSize,
        tableIndex: null,
        lineIndices: [i],
      });
      continue;
    }

    // ---- heading --------------------------------------------------------
    if (looksLikeHeading(line, bodySize)) {
      flush();
      const key = Math.round(line.fontSize * 2) / 2;
      const level = Math.min(
        headingLevels.get(key) ?? headingPath.length,
        MAX_HEADING_DEPTH - 1,
      );
      headingPath = [...headingPath.slice(0, level), line.text.trim()];
      blocks.push({
        pageNo: page.pageNo,
        ordinal: ordinal++,
        kind: "heading",
        text: line.text,
        bbox: bboxOf([line]),
        headingPath: [...headingPath],
        fontSize: line.fontSize,
        tableIndex: null,
        lineIndices: [i],
      });
      continue;
    }

    // ---- figure / chart label ------------------------------------------
    // Grouped rather than dropped: the Quality screen shows exactly which
    // regions were withheld, and why.
    if (looksLikeFigureLabel(line)) {
      if (buffer === null || buffer.kind !== "figure") {
        flush();
        buffer = { indices: [], kind: "figure" };
      }
      buffer.indices.push(i);
      continue;
    }

    // ---- list -----------------------------------------------------------
    const isBullet = BULLET_RE.test(line.text);
    const kind: BlockKind = isBullet ? "list" : "paragraph";

    if (buffer && buffer.kind === kind && !isBullet) {
      const previous = lines[buffer.indices[buffer.indices.length - 1]];
      const gap = previous.y0 - line.y1;
      const sameColumn = previous.columnIndex === line.columnIndex;
      const similarSize = Math.abs(previous.fontSize - line.fontSize) < bodySize * 0.2;
      if (gap <= line.fontSize * PARAGRAPH_BREAK_RATIO && sameColumn && similarSize) {
        buffer.indices.push(i);
        continue;
      }
    }

    flush();
    buffer = { indices: [i], kind };
  }

  flush();

  return { blocks, headingPath };
}
