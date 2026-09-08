/**
 * Page assembly: runs → lines → tables → columns → blocks.
 *
 * Order matters and is not obvious. Tables are detected *before* columns,
 * because a full-width table row straddles every column gutter on the page and
 * would otherwise suppress column detection entirely. Table lines are therefore
 * excluded from the column analysis, and prose is reordered around them.
 */

import { buildBlocks, type ParsedBlock } from "./blocks";
import { detectBoilerplate, findPrintedLabel, type BoilerplateMatcher } from "./boilerplate";
import { computeAlignmentScore, detectColumns, orderLines } from "./columns";
import { buildLines } from "./lines";
import { detectTables, type DetectedTable } from "./tables";
import type { Line, PageGeometry, ParsedPage } from "./types";

export type ParsedTable = DetectedTable & {
  /** Tables split by a page break share a continuation group id. */
  continuationGroup: number | null;
};

export type PageResult = {
  page: ParsedPage;
  blocks: ParsedBlock[];
  tables: ParsedTable[];
  lines: Line[];
};

/** Chart pages: many short, mostly-numeric labels that never form a grid. */
function computeLayoutSignals(lines: Line[]) {
  const segments = lines.flatMap((l) => l.segments);
  const total = segments.length || 1;
  const shortSegmentRatio = segments.filter((s) => s.text.length <= 6).length / total;
  const numericSegmentRatio = segments.filter((s) => s.isNumeric).length / total;
  const alignmentScore = computeAlignmentScore(lines);
  return { shortSegmentRatio, numericSegmentRatio, alignmentScore, lineCount: lines.length };
}

function scoreLayoutConfidence(signals: ReturnType<typeof computeLayoutSignals>): number {
  let score = 1;

  // Poorly aligned text has no dependable reading order.
  if (signals.alignmentScore < 0.5) score -= (0.5 - signals.alignmentScore) * 1.2;

  // The infographic signature: lots of tiny numeric labels floating free.
  if (signals.shortSegmentRatio > 0.4 && signals.numericSegmentRatio > 0.25) score -= 0.4;
  if (signals.shortSegmentRatio > 0.6) score -= 0.2;

  // Cover pages and dividers carry too little text to judge.
  if (signals.lineCount < 5) score -= 0.15;

  return Math.max(0.05, Math.min(1, score));
}

/**
 * Reorders prose around tables.
 *
 * Table line ranges stay put; each intervening run of non-table lines is
 * re-serialised in column order. Returns the new line array and the remapped
 * table line indices.
 */
function reorderAroundTables(
  lines: Line[],
  tables: DetectedTable[],
  pageWidth: number,
): { ordered: Line[]; tables: DetectedTable[]; columnCount: number } {
  const inTable = new Uint8Array(lines.length);
  for (const table of tables) {
    for (let i = table.lineStart; i <= table.lineEnd; i++) inTable[i] = 1;
  }

  const proseLines = lines.filter((_, i) => inTable[i] === 0);
  const layout = detectColumns(proseLines, pageWidth);

  if (layout.columnCount <= 1) {
    // Nothing to reorder; indices remain valid.
    return { ordered: lines, tables, columnCount: 1 };
  }

  const ordered: Line[] = [];
  const remapped: DetectedTable[] = [];
  let i = 0;

  while (i < lines.length) {
    if (inTable[i] === 1) {
      const table = tables.find((t) => t.lineStart === i);
      const end = table ? table.lineEnd : i;
      const newStart = ordered.length;
      for (let k = i; k <= end; k++) ordered.push(lines[k]);
      if (table) {
        remapped.push({
          ...table,
          lineStart: newStart,
          lineEnd: newStart + (end - i),
        });
      }
      i = end + 1;
      continue;
    }

    const runStart = i;
    while (i < lines.length && inTable[i] === 0) i++;
    const run = lines.slice(runStart, i);
    ordered.push(...orderLines(run, layout));
  }

  return { ordered, tables: remapped, columnCount: layout.columnCount };
}

/** Full reconstruction for one page. */
export function parsePage(
  geometry: PageGeometry,
  options: {
    boilerplate?: BoilerplateMatcher;
    incomingHeadingPath?: string[];
  } = {},
): PageResult & { headingPath: string[] } {
  const { pageNo, width, height } = geometry;

  const allLines = buildLines(geometry.runs, pageNo);
  const printedLabel = findPrintedLabel(allLines, height);

  const contentLines = options.boilerplate
    ? allLines.filter((line) => !options.boilerplate!.isBoilerplate(line, height))
    : allLines;

  const rawTables = detectTables(contentLines, pageNo, width, height);
  const { ordered, tables, columnCount } = reorderAroundTables(contentLines, rawTables, width);

  const signals = computeLayoutSignals(ordered);
  const layoutConfidence = scoreLayoutConfidence(signals);

  const { blocks, headingPath } = buildBlocks(
    ordered,
    tables,
    { pageNo, height },
    options.incomingHeadingPath ?? [],
  );

  return {
    page: {
      pageNo,
      width,
      height,
      lines: ordered,
      columnCount,
      layoutConfidence,
      layoutSignals: signals,
      printedLabel,
    },
    blocks,
    tables: tables.map((t) => ({ ...t, continuationGroup: null })),
    lines: ordered,
    headingPath,
  };
}

/**
 * Links tables split by a page break into continuation groups.
 *
 * The restated financial statements run for pages at a time; treating each page
 * fragment as its own table would strand rows from their header.
 */
export function linkTableContinuations(results: PageResult[]): void {
  let nextGroup = 0;
  const groupOf = new Map<ParsedTable, number>();

  for (let i = 1; i < results.length; i++) {
    const previousPage = results[i - 1];
    const currentPage = results[i];
    if (currentPage.page.pageNo !== previousPage.page.pageNo + 1) continue;

    const tail = previousPage.tables.find((t) => t.endsNearPageBottom);
    const head = currentPage.tables.find((t) => t.startsNearPageTop);
    if (!tail || !head) continue;

    // Same shape is the strongest available signal that it is one table.
    if (Math.abs(tail.colCount - head.colCount) > 1) continue;

    let group = groupOf.get(tail);
    if (group === undefined) {
      group = nextGroup++;
      groupOf.set(tail, group);
      tail.continuationGroup = group;
    }
    groupOf.set(head, group);
    head.continuationGroup = group;
  }
}

/** Convenience wrapper: parse a batch of pages with shared boilerplate context. */
export function parsePages(
  geometries: PageGeometry[],
  options: { boilerplate?: BoilerplateMatcher; incomingHeadingPath?: string[] } = {},
): { results: PageResult[]; headingPath: string[] } {
  let headingPath = options.incomingHeadingPath ?? [];
  const results: PageResult[] = [];

  for (const geometry of geometries) {
    const result = parsePage(geometry, { boilerplate: options.boilerplate, incomingHeadingPath: headingPath });
    headingPath = result.headingPath;
    results.push({ page: result.page, blocks: result.blocks, tables: result.tables, lines: result.lines });
  }

  linkTableContinuations(results);
  return { results, headingPath };
}

export { detectBoilerplate };
export type { BoilerplateMatcher, ParsedBlock, DetectedTable };
