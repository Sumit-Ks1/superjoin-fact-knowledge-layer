/**
 * Table detection and grid reconstruction.
 *
 * Most of the value in these documents lives in tables, and almost none of it
 * survives naive text extraction. A row like
 *
 *   Total income   49,114.06   28,065.29   38,382.91   29,886.29   16,948.74
 *
 * is meaningless until each number is bound to the column header above it —
 * "nine months ended December 31, 2021" versus "year ended March 31, 2021" —
 * and to the scale printed in the caption, not in the cell.
 *
 * The column model is anchored on RIGHT EDGES rather than on horizontal
 * position. Financial tables right-align their figures, and adjacent columns
 * overlap horizontally whenever one holds a long value and its neighbour a
 * short one: in the restated P&L, "(17,833.04)" in the last column begins three
 * points to the LEFT of where the previous column's figures end. No vertical
 * line separates those two columns anywhere on the page, so occupancy analysis
 * alone merges them. Their right edges, by contrast, sit in two clusters 55
 * points apart with sub-point spread.
 *
 * So: label columns come from whitespace, value columns come from right-edge
 * clusters, and header cells are mapped onto the resulting grid where their
 * width becomes a column span.
 *
 * KNOWN LIMITATION. A page that sets body prose beside an inset table puts both
 * on the same baselines, and detection runs before the page's text columns are
 * known (it has to — a full-width table row straddles every gutter and would
 * suppress column detection entirely). Badly contaminated regions are caught by
 * the prose signal below and quarantined. Partial contamination is not caught:
 * cell text cannot separate the two classes, because a real financial row label
 * — "Fair value loss on financial liabilities at fair value through profit or
 * loss" — is longer than the prose that contaminates. The fix is to re-cut
 * candidate regions along the page's column bands, not a better text heuristic.
 */

import type { BBox, Line, LineSegment } from "./types";
import { overlap1d } from "./types";

export type GridCell = {
  row: number;
  col: number;
  text: string;
  bbox: BBox;
  colSpan: number;
  isNumeric: boolean;
};

export type DetectedTable = {
  /**
   * `chart` marks a region that reconstructs as a grid but is not one — almost
   * always a plot's axis ticks. Kept rather than discarded, so the failure is
   * visible downstream instead of silently vanishing.
   */
  kind: "grid" | "chart";
  pageNo: number;
  /** Index into the page's ordered line array where the table begins. */
  lineStart: number;
  lineEnd: number;
  bbox: BBox;
  rowCount: number;
  colCount: number;
  cells: GridCell[];
  /** Per column, outermost header first. Empty when no header row was found. */
  colHeaderPaths: string[][];
  headerRowCount: number;
  rowLabelCols: number;
  caption: string | null;
  unitHint: string | null;
  confidence: number;
  needsReview: boolean;
  reviewReasons: string[];
  /** Continuation hints for tables split across a page break. */
  startsNearPageTop: boolean;
  endsNearPageBottom: boolean;
};

/** A reconstructed column: a territory, plus a right-edge anchor for value columns. */
export type ColumnSpec = {
  kind: "label" | "value";
  x0: number;
  x1: number;
  /** Shared right edge of this column's figures; null for label columns. */
  anchorX1: number | null;
};

const BIN_SIZE = 1.5;
/** Minimum empty band, in points, that separates two label columns. */
const MIN_COLUMN_GAP = 4;
const MIN_TABLE_LINES = 3;
/**
 * Non-table-like lines tolerated inside a region. Row labels in these financial
 * statements routinely wrap over three lines ("Restated loss before" /
 * "exceptional item and" / "tax (III= I - II)") before the values arrive, so a
 * tight limit here fractures one table into several.
 */
const MAX_INTERIOR_GAP_LINES = 4;
/**
 * Safety net on how deep a header stack may run.
 *
 * These stacks are deeper than they look. "As at and for" over "the nine" over
 * "months period" over "ended" over "December 31," over "2021" is six rows for
 * a single column heading, and the prospectus summary table reaches eleven.
 *
 * This was 10, and the cost was invisible until you looked at the output: the
 * cap fell exactly between "December 31," and "2021", so the years never
 * joined the header. Every figure in that table then had no resolvable period,
 * and every comparison between them was declined as "periods could not be
 * resolved" — a silent, total loss of the time dimension for that page, caused
 * by an off-by-one in a bound that was only ever meant to stop a runaway.
 *
 * Content checks are what actually end the walk; this only bounds the damage
 * if they fail.
 */
const MAX_HEADER_ROWS = 16;
/** A row must be at least this close to its neighbour to stay in the region. */
const MAX_ROW_GAP_RATIO = 2.6;
/** Two rows merge into one logical row only if they are this vertically tight. */
const ROW_MERGE_GAP_RATIO = 1.8;
/** Right edges within one numeric column agree to about this tolerance. */
const RIGHT_EDGE_TOLERANCE = 3;
/**
 * Clustering distance for right edges. Deliberately tight: a single stray
 * figure sitting ~10pt off its column would otherwise bridge into the real
 * cluster, push the combined spread past the tolerance above, and destroy the
 * whole anchor. Over-splitting is corrected by the pitch merge below; losing an
 * anchor is not recoverable.
 */
const RIGHT_EDGE_CLUSTER_GAP = 4;
/** Two anchors closer than this are one column that split under tight clustering. */
const MIN_COLUMN_PITCH = 12;
/** How far a figure's right edge may sit from an anchor and still belong to it. */
const RIGHT_EDGE_SNAP = 6;
/**
 * Share of a column a non-numeric segment must cover to be read as spanning it.
 *
 * Header text is centred while data is right-aligned, so a header sitting over
 * one column routinely laps a third of the way into its neighbour. Counting
 * that as a span copies "March 31, 2021" into the column beside it and makes
 * every figure in both columns claim two different periods.
 */
const SPAN_COVERAGE_RATIO = 0.5;

/* ── region discovery ─────────────────────────────────────────────────────── */

/** Strong enough to start a table region on its own. */
export function looksTabular(line: Line): boolean {
  const numeric = line.segments.filter((s) => s.isNumeric).length;
  if (numeric >= 2) return true;
  return line.segments.length >= 3 && numeric >= 1;
}

/**
 * Carries a value but not enough structure to start a region.
 *
 * Sparse rows print one figure per baseline — "Exceptional items (IV)" is
 * followed by five lines holding a single cell each. Those lines belong to the
 * table, so they must not count towards the run of non-table lines that ends a
 * region, but they are too weak to open one.
 */
function isWeaklyTabular(line: Line): boolean {
  return line.segments.some((s) => s.isNumeric);
}

/** Candidate row runs, before header extension. */
function findCores(lines: Line[]): { start: number; end: number }[] {
  const cores: { start: number; end: number }[] = [];
  let start = -1;
  let lastContent = -1;
  let gap = 0;

  const close = () => {
    if (start !== -1 && lastContent - start + 1 >= MIN_TABLE_LINES) {
      cores.push({ start, end: lastContent });
    }
    start = -1;
    lastContent = -1;
    gap = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (looksTabular(line)) {
      if (start === -1) start = i;
      lastContent = i;
      gap = 0;
      continue;
    }
    if (start === -1) continue;

    if (isWeaklyTabular(line)) {
      // Neutral: extends the region without resetting or advancing the gap.
      lastContent = i;
      gap = 0;
      continue;
    }

    gap += 1;
    if (gap > MAX_INTERIOR_GAP_LINES) close();
  }
  close();

  return cores;
}

/* ── column model ─────────────────────────────────────────────────────────── */

/** Empty vertical bands. Reliable for label columns, not for value columns. */
export function deriveColumnBands(
  lines: Line[],
  pageWidth: number,
): { x0: number; x1: number }[] {
  const bins = new Uint32Array(Math.ceil(pageWidth / BIN_SIZE) + 1);
  for (const line of lines) {
    for (const segment of line.segments) {
      const from = Math.max(0, Math.floor(segment.x0 / BIN_SIZE));
      const to = Math.min(bins.length - 1, Math.ceil(segment.x1 / BIN_SIZE));
      for (let i = from; i <= to; i++) bins[i] += 1;
    }
  }

  let first = -1;
  let last = -1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] > 0) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return [];

  const bands: { x0: number; x1: number }[] = [];
  let bandStart = first;
  let emptyStart = -1;

  for (let i = first; i <= last; i++) {
    if (bins[i] === 0) {
      if (emptyStart === -1) emptyStart = i;
    } else {
      if (emptyStart !== -1) {
        const gapWidth = (i - emptyStart) * BIN_SIZE;
        if (gapWidth >= MIN_COLUMN_GAP) {
          bands.push({ x0: bandStart * BIN_SIZE, x1: emptyStart * BIN_SIZE });
          bandStart = i;
        }
        emptyStart = -1;
      }
    }
  }
  bands.push({ x0: bandStart * BIN_SIZE, x1: (last + 1) * BIN_SIZE });

  return bands.filter((b) => b.x1 > b.x0);
}

/** Groups figure right edges into the columns they were aligned to. */
function clusterRightEdges(lines: Line[]) {
  const edges: { x0: number; x1: number }[] = [];
  for (const line of lines) {
    for (const segment of line.segments) {
      if (segment.isNumeric) edges.push({ x0: segment.x0, x1: segment.x1 });
    }
  }
  if (edges.length === 0) return [];

  const sorted = edges.sort((a, b) => a.x1 - b.x1);
  const clusters: { x0: number; x1: number }[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const current = clusters[clusters.length - 1];
    if (sorted[i].x1 - current[current.length - 1].x1 > RIGHT_EDGE_CLUSTER_GAP) {
      clusters.push([sorted[i]]);
    } else {
      current.push(sorted[i]);
    }
  }

  const anchors = clusters
    .filter((c) => {
      if (c.length < 2) return false;
      const spread = Math.max(...c.map((e) => e.x1)) - Math.min(...c.map((e) => e.x1));
      return spread <= RIGHT_EDGE_TOLERANCE;
    })
    .map((c) => ({
      anchorX1: Math.max(...c.map((e) => e.x1)),
      minX0: Math.min(...c.map((e) => e.x0)),
      support: c.length,
    }))
    .sort((a, b) => a.anchorX1 - b.anchorX1);

  // Collapse anchors that tight clustering split apart; keep the better-supported.
  const merged: typeof anchors = [];
  for (const anchor of anchors) {
    const previous = merged[merged.length - 1];
    if (previous && anchor.anchorX1 - previous.anchorX1 < MIN_COLUMN_PITCH) {
      if (anchor.support > previous.support) {
        merged[merged.length - 1] = {
          anchorX1: anchor.anchorX1,
          minX0: Math.min(previous.minX0, anchor.minX0),
          support: anchor.support + previous.support,
        };
      } else {
        previous.minX0 = Math.min(previous.minX0, anchor.minX0);
        previous.support += anchor.support;
      }
      continue;
    }
    merged.push({ ...anchor });
  }

  return merged;
}

/** Builds the column grid: whitespace for labels, right-edge anchors for values. */
export function buildColumnModel(lines: Line[], pageWidth: number): ColumnSpec[] {
  const bands = deriveColumnBands(lines, pageWidth);
  if (bands.length === 0) return [];

  const asLabels = (): ColumnSpec[] =>
    bands.map((b) => ({ kind: "label" as const, x0: b.x0, x1: b.x1, anchorX1: null }));

  const anchors = clusterRightEdges(lines);
  if (anchors.length === 0) return asLabels();

  const contentX0 = bands[0].x0;
  const contentX1 = bands[bands.length - 1].x1;
  const valuesStart = Math.min(...anchors.map((a) => a.minX0));

  // Whitespace columns that finish before any figure begins are label columns.
  const labelColumns: ColumnSpec[] = bands
    .filter((b) => b.x1 <= valuesStart + 1)
    .map((b) => ({ kind: "label" as const, x0: b.x0, x1: b.x1, anchorX1: null }));

  if (labelColumns.length === 0) {
    labelColumns.push({
      kind: "label",
      x0: contentX0,
      x1: Math.max(contentX0, valuesStart),
      anchorX1: null,
    });
  }

  const labelEnd = labelColumns[labelColumns.length - 1].x1;
  const columns: ColumnSpec[] = [...labelColumns];

  anchors.forEach((anchor, k) => {
    // Territories meet midway between neighbouring anchors, so a header
    // stretched over two columns overlaps both and earns a colSpan of 2.
    const left = k === 0 ? labelEnd : (anchors[k - 1].anchorX1 + anchor.anchorX1) / 2;
    const right =
      k === anchors.length - 1
        ? Math.max(contentX1, anchor.anchorX1 + 4)
        : (anchor.anchorX1 + anchors[k + 1].anchorX1) / 2;
    columns.push({ kind: "value", x0: left, x1: right, anchorX1: anchor.anchorX1 });
  });

  return columns;
}

/**
 * Places a segment in the grid.
 *
 * Figures snap to the nearest right-edge anchor, which is what keeps
 * horizontally overlapping columns apart. Everything else — labels, headers,
 * spanning titles — falls back to territory, and may cover several columns at
 * once: a segment holds the territory its centre lands in, plus any territory
 * it covers outright. Mere overlap is not enough, because centred header text
 * always overlaps the column next door.
 */
export function assignToColumns(segment: LineSegment, columns: ColumnSpec[]): number[] {
  if (columns.length === 0) return [0];

  if (segment.isNumeric) {
    let best = -1;
    let bestDistance = Infinity;
    columns.forEach((column, index) => {
      if (column.anchorX1 === null) return;
      const distance = Math.abs(segment.x1 - column.anchorX1);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best !== -1 && bestDistance <= RIGHT_EDGE_SNAP) return [best];
  }

  const center = (segment.x0 + segment.x1) / 2;
  const covered: number[] = [];
  columns.forEach((column, index) => {
    const width = Math.max(1, column.x1 - column.x0);
    const holdsCenter = center >= column.x0 && center < column.x1;
    const o = overlap1d(segment.x0, segment.x1, column.x0, column.x1);
    if (holdsCenter || o >= width * SPAN_COVERAGE_RATIO) covered.push(index);
  });
  if (covered.length > 0) return covered;

  let nearest = 0;
  let nearestDistance = Infinity;
  columns.forEach((column, index) => {
    const d =
      center < column.x0 ? column.x0 - center : center > column.x1 ? center - column.x1 : 0;
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = index;
    }
  });
  return [nearest];
}

/**
 * Assigns one line's segments to columns competitively.
 *
 * `assignToColumns` judges each segment on its own, which is right for data
 * rows and wrong for header stacks. "For the nine" centred over column 1 is
 * wider than the figures beneath it and laps into column 2, so two sibling
 * period headers both claim column 1 and their text collapses into one cell
 * reading "For the nine For the nine".
 *
 * No two cells on a row can occupy the same column, so contested columns are
 * awarded to the nearest claimant and each segment keeps only what it wins.
 */
function assignRowSegments(
  segments: LineSegment[],
  columns: ColumnSpec[],
): { segment: LineSegment; colStart: number; colSpan: number }[] {
  if (segments.length === 0) return [];

  const claims = segments.map((s) => assignToColumns(s, columns));

  /** Distance from a segment to a column, measured the way that column reads. */
  const affinity = (segment: LineSegment, col: number): number => {
    const column = columns[col];
    if (segment.isNumeric && column.anchorX1 !== null) {
      return Math.abs(segment.x1 - column.anchorX1);
    }
    const center = (segment.x0 + segment.x1) / 2;
    return Math.abs(center - (column.x0 + column.x1) / 2);
  };

  const owner = new Map<number, number>();
  for (let col = 0; col < columns.length; col++) {
    let best = -1;
    let bestDistance = Infinity;
    claims.forEach((cols, index) => {
      if (!cols.includes(col)) return;
      const distance = affinity(segments[index], col);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best !== -1) owner.set(col, best);
  }

  const won = segments.map<number[]>(() => []);
  for (const [col, index] of owner) won[index].push(col);

  return segments.map((segment, index) => {
    let cols = won[index];
    if (cols.length === 0) {
      // Out-competed everywhere. Fall back to its own best column, which puts
      // it in the same cell as the segment that beat it — the right outcome for
      // a phrase the renderer happened to break in two.
      cols = [
        claims[index].reduce((a, b) => (affinity(segment, a) <= affinity(segment, b) ? a : b)),
      ];
    }
    const colStart = Math.min(...cols);
    return { segment, colStart, colSpan: Math.max(...cols) - colStart + 1 };
  });
}

/* ── header handling ──────────────────────────────────────────────────────── */

/**
 * A measured value, as opposed to a header token that merely contains digits.
 *
 * Header rows are frequently all-numeric — "2021  2020  2020  2019" is the
 * bottom row of a five-period stack — so the upward walk cannot stop at digits.
 * Values carry decimals, separators or parenthesised signs; bare years do not,
 * and "December 31," is punctuated but is plainly a date.
 */
function looksLikeMeasuredValue(text: string): boolean {
  const t = text.trim().replace(/[*#†‡§^]+$/, "");
  if (!/\d/.test(t)) return false;
  if (/[A-Za-z]{2,}/.test(t)) return false;
  return /[.,%()]/.test(t) || t.replace(/\D/g, "").length > 4;
}

const SCALE_WORDS =
  /\b(?:million|billion|trillion|thousand|crore|lakh|lakhs|mn|bn|tn|cr|k)\b/i;
const CURRENCY_MARK = /[₹$€£¥]|\b(?:rs|inr|usd|eur|gbp|jpy|rupees?)\b/i;

/**
 * Walks upward from the numeric core collecting rows that align with the grid.
 * This is what recovers two-level headers such as "Face Value per Equity Share"
 * over "Pre-split | Post-split", and the five-deep period stacks in the
 * restated financial statements.
 */
function extendHeaderRows(
  lines: Line[],
  coreStart: number,
  columns: ColumnSpec[],
  bodyFontSize: number,
): number {
  let start = coreStart;

  for (let i = coreStart - 1; i >= 0 && coreStart - i <= MAX_HEADER_ROWS; i--) {
    const line = lines[i];
    if (line.segments.length === 0) break;

    // A row of actual measurements belongs to a different table.
    if (line.segments.filter((s) => looksLikeMeasuredValue(s.text)).length >= 2) break;

    // A caption ("(in ₹ million, unless otherwise stated)") sits above the
    // header, not inside it — and is harvested separately as the unit hint.
    if (SCALE_WORDS.test(line.text) && CURRENCY_MARK.test(line.text)) break;

    // A section title set noticeably larger is not a column header.
    if (line.fontSize > bodyFontSize * 1.25) break;

    const below = lines[i + 1];
    if (below.y1 - line.y0 > line.fontSize * MAX_ROW_GAP_RATIO) break;

    const aligned = line.segments.filter(
      (s) => assignToColumns(s, columns).length > 0 && s.x1 > columns[0].x0 - 2,
    ).length;
    if (aligned / line.segments.length < 0.5) break;

    start = i;
  }

  return start;
}

/** Builds header paths by propagating spanning cells over the columns they cover. */
function buildHeaderPaths(
  cells: GridCell[],
  headerRowCount: number,
  colCount: number,
): string[][] {
  const paths: string[][] = Array.from({ length: colCount }, () => []);
  if (headerRowCount === 0) return paths;

  for (let row = 0; row < headerRowCount; row++) {
    const rowCells = cells
      .filter((c) => c.row === row && c.text.trim() !== "")
      .sort((a, b) => a.col - b.col);
    for (const cell of rowCells) {
      for (let col = cell.col; col < Math.min(colCount, cell.col + cell.colSpan); col++) {
        const path = paths[col];
        // Avoid repeating a label inherited from a wider span.
        if (path[path.length - 1] !== cell.text) path.push(cell.text);
      }
    }
  }

  return paths;
}

/** Leading columns that identify the row rather than carry a measurement. */
function countRowLabelColumns(
  cells: GridCell[],
  headerRowCount: number,
  rowCount: number,
  colCount: number,
  columns: ColumnSpec[],
): number {
  // The column model already knows which columns hold figures.
  const firstValue = columns.findIndex((c) => c.kind === "value");
  if (firstValue > 0) return firstValue;

  const bodyRows = rowCount - headerRowCount;
  if (bodyRows <= 0) return 1;

  let labelCols = 0;
  for (let col = 0; col < colCount; col++) {
    let numeric = 0;
    let filled = 0;
    for (let row = headerRowCount; row < rowCount; row++) {
      const cell = cells.find((c) => c.row === row && c.col === col);
      if (!cell || cell.text.trim() === "") continue;
      filled += 1;
      if (cell.isNumeric) numeric += 1;
    }
    if (filled > 0 && numeric / filled > 0.3) break;
    labelCols += 1;
  }

  return Math.max(1, Math.min(labelCols, Math.max(1, colCount - 1)));
}

/* ── captions ─────────────────────────────────────────────────────────────── */

/**
 * Unit / scale hint from the caption above the table.
 *
 * Generic by construction: it looks for a parenthesised phrase containing a
 * scale word or currency mark. It knows about measurement language, not about
 * any particular company or report.
 */
export function extractUnitHint(candidateLines: Line[]): {
  caption: string | null;
  unitHint: string | null;
} {
  let caption: string | null = null;
  let unitHint: string | null = null;

  for (const line of candidateLines) {
    const text = line.text.trim();
    if (text.length === 0 || text.length > 220) continue;

    const parenthesised = text.match(/\(([^)]{3,160})\)/g);
    if (parenthesised) {
      for (const raw of parenthesised) {
        const inner = raw.slice(1, -1);
        if (SCALE_WORDS.test(inner) || CURRENCY_MARK.test(inner)) {
          unitHint = inner.trim();
          break;
        }
      }
    }

    // Bare hints such as a "₹ Cr" stub in a slide table.
    if (!unitHint && text.length <= 24 && CURRENCY_MARK.test(text) && SCALE_WORDS.test(text)) {
      unitHint = text;
    }

    if (!caption && text.length >= 8 && !line.segments.every((s) => s.isNumeric)) {
      caption = text;
    }

    if (unitHint) break;
  }

  return { caption, unitHint };
}

/* ── logical rows ─────────────────────────────────────────────────────────── */

/**
 * Merges physical rows that form one logical row.
 *
 * PDF baselines do not correspond to table rows. Three patterns recur:
 *
 *   A. a label with no values, followed by its values on the next baseline
 *      ("Total income (I)" / "49,114.06  28,065.29  …")
 *   B. a wrapped label ("Freight, handling and" / "servicing cost  34,786.36 …")
 *   C. period groups typeset at different vertical offsets, so the nine-month
 *      figures and the annual figures for one line item land on separate
 *      baselines — precisely the transposition trap in this corpus.
 *
 * All three are recognised structurally: rows merge only when their filled
 * value columns are disjoint and they are vertically adjacent.
 */
const CONTINUATION_CUE =
  /(?:,|-|–|—|\b(?:and|or|of|for|to|in|on|at|from|with|the|a|an|as|by|under|per|non|other)\s*)$/i;

function mergeLogicalRows(
  cells: GridCell[],
  rowLines: Line[],
  headerRowCount: number,
  rowLabelCols: number,
): { cells: GridCell[]; rowCount: number } {
  const target = new Array(rowLines.length).fill(0).map((_, i) => i);

  const labelTextOf = (row: number) =>
    cells
      .filter((c) => c.row === row && c.col < rowLabelCols)
      .sort((a, b) => a.col - b.col)
      .map((c) => c.text)
      .join(" ")
      .trim();

  for (let row = headerRowCount + 1; row < rowLines.length; row++) {
    const previous = target[row - 1];
    if (previous < headerRowCount) continue;

    /*
     * Vertical adjacency is a property of neighbouring physical lines, not of
     * the logical row's first line. A row assembled from three staggered lines
     * already spans two line pitches, so measuring from its top would reject
     * the wrapped label that follows it.
     */
    if (rowLines[row - 1].y0 - rowLines[row].y1 > rowLines[row].fontSize * ROW_MERGE_GAP_RATIO) {
      continue;
    }

    const previousValues = new Set(
      cells.filter((c) => target[c.row] === previous && c.col >= rowLabelCols).map((c) => c.col),
    );
    const currentValues = new Set(
      cells.filter((c) => c.row === row && c.col >= rowLabelCols).map((c) => c.col),
    );

    // Disjointness is the core test: two genuine data rows always collide.
    let disjoint = true;
    for (const col of currentValues) if (previousValues.has(col)) disjoint = false;
    if (!disjoint) continue;

    const previousLabel = cells
      .filter((c) => target[c.row] === previous && c.col < rowLabelCols)
      .map((c) => c.text)
      .join(" ")
      .trim();
    const currentLabel = labelTextOf(row);

    const previousHasValues = previousValues.size > 0;
    const currentHasValues = currentValues.size > 0;
    const continues = CONTINUATION_CUE.test(previousLabel) || /^[a-z(]/.test(currentLabel);

    let merge: boolean;
    if (!currentHasValues && !previousHasValues) {
      // Two bare labels: a wrapped phrase, never two section headings.
      merge = continues;
    } else if (currentHasValues && !previousHasValues) {
      // Values arriving under their label. Guard against absorbing a section
      // heading that merely precedes an unrelated row.
      merge = currentLabel === "" || continues;
    } else if (!currentHasValues && previousHasValues) {
      merge = currentLabel !== "" && /^[a-z(]/.test(currentLabel);
    } else {
      // Both carry values, in disjoint columns: the staggered-period case.
      merge = true;
    }

    if (merge) target[row] = previous;
  }

  const remap = new Map<number, number>();
  let next = 0;
  for (let row = 0; row < rowLines.length; row++) {
    if (target[row] === row) remap.set(row, next++);
  }

  const merged = new Map<string, GridCell>();
  for (const cell of cells) {
    const logical = remap.get(target[cell.row]);
    if (logical === undefined) continue;
    const key = `${logical}:${cell.col}`;
    const existing = merged.get(key);
    if (existing) {
      // Same column filled twice: a wrapped label. Values never collide here,
      // because collision is what prevented the merge in the first place.
      existing.text = `${existing.text} ${cell.text}`.trim();
      existing.bbox = {
        x0: Math.min(existing.bbox.x0, cell.bbox.x0),
        y0: Math.min(existing.bbox.y0, cell.bbox.y0),
        x1: Math.max(existing.bbox.x1, cell.bbox.x1),
        y1: Math.max(existing.bbox.y1, cell.bbox.y1),
      };
      existing.isNumeric = false;
    } else {
      merged.set(key, { ...cell, row: logical });
    }
  }

  return { cells: [...merged.values()], rowCount: next };
}

/* ── chart rejection ── */

/** Reads a cell as a plain number. Layout-stage only; units come much later. */
function cellValue(text: string): number | null {
  const t = text.trim().replace(/[*#†‡§^]+$/, "");
  if (t === "") return null;
  const negative = /^\(.*\)$/.test(t);
  const bare = t.replace(/[()₹$€£¥,%\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(bare)) return null;
  const n = Number(bare);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Recognises a chart axis wearing a table's clothes.
 *
 * A y-axis tick scale — 12, 10, 8, 6, 4, 2, 0, -2 — is a right-aligned run of
 * numbers with nothing but whitespace beside it, which is structurally
 * identical to a one-column financial table. Arithmetic tells them apart:
 * measured quantities do not walk down a page in exactly equal steps.
 */
function looksLikeAxisScale(values: number[]): boolean {
  if (values.length < 4) return false;
  const step = values[1] - values[0];
  if (step === 0) return false;
  for (let i = 2; i < values.length; i++) {
    if (Math.abs(values[i] - values[i - 1] - step) > Math.abs(step) * 0.02) return false;
  }
  return true;
}

/**
 * True when a reconstructed grid is really a plot.
 *
 * Both conditions are required. A time series legitimately steps by one year,
 * but it says so in its row labels; a chart axis has no labels to give. And an
 * unlabelled block of figures is only a chart if the figures form a scale.
 */
function looksLikeChart(
  cells: GridCell[],
  headerRowCount: number,
  rowCount: number,
  colCount: number,
  rowLabelCols: number,
): boolean {
  const bodyRows: number[] = [];
  for (let row = headerRowCount; row < rowCount; row++) bodyRows.push(row);
  if (bodyRows.length < 4) return false;

  const labelled = bodyRows.filter((row) =>
    cells.some((c) => c.row === row && c.col < rowLabelCols && c.text.trim() !== ""),
  ).length;
  if (labelled > bodyRows.length * 0.4) return false;

  for (let col = rowLabelCols; col < colCount; col++) {
    const values: number[] = [];
    for (const row of bodyRows) {
      const cell = cells.find((c) => c.row === row && c.col === col);
      if (!cell) continue;
      const value = cellValue(cell.text);
      if (value !== null) values.push(value);
    }
    if (looksLikeAxisScale(values)) return true;
  }
  return false;
}

/**
 * Share of a grid's cells that read as running prose.
 *
 * A page whose body text sits beside an inset table puts both on the same
 * baselines, so the paragraph's lines are swept into the grid as row labels
 * and the reconstruction is meaningless. Cell text tells them apart by length:
 * a row label is a noun phrase, and even the longest in these documents —
 * "Fair value loss on financial liabilities at fair value through profit or
 * loss" — is rare, while a contaminated region is mostly clauses.
 */
function proseCellRatio(cells: GridCell[]): number {
  const filled = cells.filter((c) => c.text.trim() !== "");
  if (filled.length === 0) return 0;
  const wordy = filled.filter((c) => c.text.trim().split(/\s+/).length >= 8).length;
  return wordy / filled.length;
}

/* ── entry point ──────────────────────────────────────────────────────────── */

function bboxOfLines(lines: Line[]): BBox {
  return {
    x0: Math.min(...lines.map((l) => l.x0)),
    y0: Math.min(...lines.map((l) => l.y0)),
    x1: Math.max(...lines.map((l) => l.x1)),
    y1: Math.max(...lines.map((l) => l.y1)),
  };
}

export function detectTables(
  lines: Line[],
  pageNo: number,
  pageWidth: number,
  pageHeight: number,
): DetectedTable[] {
  const tables: DetectedTable[] = [];

  for (const core of findCores(lines)) {
    const coreLines = lines.slice(core.start, core.end + 1);

    /*
     * The grid is defined by the DATA rows alone. Header text spans several
     * columns by design, so including header rows in the occupancy histogram
     * bridges the gaps between value columns and collapses five periods into
     * one. Headers are mapped onto this grid afterwards, where their width
     * becomes a colSpan instead of destroying the structure.
     */
    const gridLines = coreLines.filter(looksTabular);
    const sourceLines = gridLines.length >= 2 ? gridLines : coreLines;
    const columns = buildColumnModel(sourceLines, pageWidth);
    if (columns.length < 2) continue;

    const sizes = coreLines.map((l) => l.fontSize).sort((a, b) => a - b);
    const coreFontSize = sizes[sizes.length >> 1] ?? 10;

    const start = extendHeaderRows(lines, core.start, columns, coreFontSize);
    const regionLines = lines.slice(start, core.end + 1);
    const colCount = columns.length;

    const rawCells: GridCell[] = [];
    const reviewReasons: string[] = [];

    regionLines.forEach((line, rowIndex) => {
      const perColumn = new Map<number, { segments: LineSegment[]; colSpan: number }>();

      for (const { segment, colStart, colSpan } of assignRowSegments(line.segments, columns)) {
        const existing = perColumn.get(colStart);
        if (existing) {
          existing.segments.push(segment);
          existing.colSpan = Math.max(existing.colSpan, colSpan);
        } else {
          perColumn.set(colStart, { segments: [segment], colSpan });
        }
      }

      for (const [col, entry] of perColumn) {
        const ordered = entry.segments.sort((a, b) => a.x0 - b.x0);
        const text = ordered.map((s) => s.text).join(" ").trim();
        if (text === "") continue;

        rawCells.push({
          row: rowIndex,
          col,
          text,
          bbox: {
            x0: Math.min(...ordered.map((s) => s.x0)),
            y0: Math.min(...ordered.map((s) => s.y0)),
            x1: Math.max(...ordered.map((s) => s.x1)),
            y1: Math.max(...ordered.map((s) => s.y1)),
          },
          colSpan: entry.colSpan,
          // A cell assembled from several segments is no longer a clean number.
          isNumeric: ordered.length === 1 && ordered[0].isNumeric,
        });
      }
    });

    const firstValueCol = Math.max(0, columns.findIndex((c) => c.kind === "value"));

    /*
     * Ask whether this is a plot before splitting header from body. A chart's
     * ticks are bare numbers with no text anywhere, so the header walk below
     * swallows them one row at a time until no data rows remain and the region
     * is discarded without a trace. Deciding first keeps the failure on record.
     */
    const isChart = looksLikeChart(
      rawCells,
      0,
      regionLines.length,
      colCount,
      Math.max(1, firstValueCol),
    );

    // Header rows: leading rows carrying no more than one measured value.
    let headerRowCount = 0;
    for (let row = 0; !isChart && row < regionLines.length && row < MAX_HEADER_ROWS; row++) {
      const rowCells = rawCells.filter((c) => c.row === row);
      if (rowCells.length === 0) break;
      if (rowCells.filter((c) => looksLikeMeasuredValue(c.text)).length >= 2) break;
      /*
       * A header row has to say something about the value columns. "Income"
       * and "Expenses" are section labels alone in the row-label column; they
       * belong to the body, and folding "Income" into the header would caption
       * every figure in the table with the name of its first section.
       */
      const describesValues = rowCells.some((c) => {
        if (c.text.trim() === "") return false;
        if (c.col >= firstValueCol) return true;
        // A banner stretched over the whole grid is still header material.
        return c.col + c.colSpan >= columns.length;
      });
      if (!describesValues) break;
      headerRowCount += 1;
    }
    if (headerRowCount >= regionLines.length) continue; // all header, no data

    const rowLabelCols = countRowLabelColumns(
      rawCells,
      headerRowCount,
      regionLines.length,
      colCount,
      columns,
    );

    const { cells, rowCount } = mergeLogicalRows(
      rawCells,
      regionLines,
      headerRowCount,
      rowLabelCols,
    );

    const colHeaderPaths = buildHeaderPaths(cells, headerRowCount, colCount);

    // ── quality signals ────────────────────────────────────────────────────
    let confidence = 1;

    /*
     * Prose swept in from a neighbouring text column. Flagged rather than
     * repaired: the region needs to be re-cut along the page's column bands,
     * and until it is, none of its cells should become facts.
     */
    const prose = proseCellRatio(cells);
    if (prose > 0.25) {
      confidence -= 0.6;
      reviewReasons.push(
        `${Math.round(prose * 100)}% of cells read as running prose; region likely spans a text column`,
      );
    }

    if (isChart) {
      confidence = 0;
      reviewReasons.push(
        "figures form an axis scale with no row labels; read as a chart, not a table",
      );
    }
    if (headerRowCount === 0) {
      confidence -= 0.35;
      reviewReasons.push("no header row detected above the value rows");
    }

    const headerlessValueCols = colHeaderPaths
      .slice(rowLabelCols)
      .filter((p) => p.length === 0).length;
    if (headerlessValueCols > 0) {
      confidence -= Math.min(0.3, headerlessValueCols * 0.1);
      reviewReasons.push(`${headerlessValueCols} value column(s) have no header text`);
    }

    const filledPerRow = Array.from({ length: rowCount }, (_, row) =>
      cells.filter((c) => c.row === row).length,
    ).slice(headerRowCount);
    const maxFilled = Math.max(1, ...filledPerRow);
    const ragged = filledPerRow.filter((n) => n > 0 && n < maxFilled * 0.5).length;
    if (filledPerRow.length > 0 && ragged / filledPerRow.length > 0.4) {
      confidence -= 0.2;
      reviewReasons.push("row widths vary sharply; column assignment may be wrong");
    }

    const bbox = bboxOfLines(regionLines);
    // Reach past the header stack to the caption line carrying the scale.
    const above = lines.slice(Math.max(0, start - 5), start).reverse();
    const { caption, unitHint } = extractUnitHint(above);

    tables.push({
      kind: isChart ? "chart" : "grid",
      pageNo,
      lineStart: start,
      lineEnd: core.end,
      bbox,
      rowCount,
      colCount,
      cells,
      colHeaderPaths,
      headerRowCount,
      rowLabelCols,
      caption,
      unitHint,
      confidence: Math.max(0.1, Math.min(1, confidence)),
      needsReview: reviewReasons.length > 0,
      reviewReasons,
      startsNearPageTop: bbox.y1 > pageHeight * 0.85,
      endsNearPageBottom: bbox.y0 < pageHeight * 0.15,
    });
  }

  return tables;
}

/** Markdown rendering used for table chunks and model prompts. */
export function tableToMarkdown(table: DetectedTable): string {
  const grid: string[][] = Array.from({ length: table.rowCount }, () =>
    Array.from({ length: table.colCount }, () => ""),
  );
  for (const cell of table.cells) {
    if (cell.row < table.rowCount && cell.col < table.colCount) grid[cell.row][cell.col] = cell.text;
  }

  const escape = (s: string) => s.replace(/\|/g, "\\|");
  const out: string[] = [];

  if (table.headerRowCount > 0) {
    const header = table.colHeaderPaths.map((path) => escape(path.join(" — ")));
    out.push(`| ${header.join(" | ")} |`);
    out.push(`| ${table.colHeaderPaths.map(() => "---").join(" | ")} |`);
  }

  for (let row = table.headerRowCount; row < table.rowCount; row++) {
    if (grid[row].every((c) => c.trim() === "")) continue;
    out.push(`| ${grid[row].map(escape).join(" | ")} |`);
  }

  return out.join("\n");
}
