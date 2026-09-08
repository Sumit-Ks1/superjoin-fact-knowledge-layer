/**
 * Column detection and reading order.
 *
 * The FY24 annual report sets body copy in four columns. Read in raw baseline
 * order, four unrelated sentences interleave into nonsense, and every fact
 * extracted from that page inherits the damage. This module finds the vertical
 * whitespace corridors between columns and re-serialises the page.
 *
 * The hard part is telling a column gutter apart from the gap between two table
 * columns — both look like empty vertical bands in an occupancy histogram. The
 * discriminator is straddling: a table row places content on both sides of its
 * column gap at the same baseline, while a genuine column gutter is never
 * crossed by a single line.
 */

import type { Gutter, Line } from "./types";
import { overlap1d } from "./types";

const BIN_SIZE = 2; // points
/** Minimum gutter width, as a fraction of page width. */
const MIN_GUTTER_RATIO = 0.015;
const MIN_GUTTER_POINTS = 8;
/** A band crossed by more than this share of lines is a table gap, not a gutter. */
const MAX_STRADDLE_RATIO = 0.15;
/** Each side of a gutter must carry at least this share of the page's lines. */
const MIN_SIDE_SHARE = 0.12;
/** Pages with fewer lines than this have no reliable column signal. */
const MIN_LINES_FOR_COLUMNS = 12;

/** Marks which x bins carry ink. */
function buildOccupancy(lines: Line[], pageWidth: number): Uint32Array {
  const bins = new Uint32Array(Math.ceil(pageWidth / BIN_SIZE) + 1);
  for (const line of lines) {
    for (const segment of line.segments) {
      const start = Math.max(0, Math.floor(segment.x0 / BIN_SIZE));
      const end = Math.min(bins.length - 1, Math.ceil(segment.x1 / BIN_SIZE));
      for (let i = start; i <= end; i++) bins[i] += 1;
    }
  }
  return bins;
}

/** Contiguous empty bands wide enough to be structural, ignoring page margins. */
function findEmptyBands(bins: Uint32Array, pageWidth: number): Gutter[] {
  const minWidth = Math.max(pageWidth * MIN_GUTTER_RATIO, MIN_GUTTER_POINTS);

  // Confine the search to the inked region so left/right margins are excluded.
  let firstInk = -1;
  let lastInk = -1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] > 0) {
      if (firstInk === -1) firstInk = i;
      lastInk = i;
    }
  }
  if (firstInk === -1) return [];

  const bands: Gutter[] = [];
  let runStart = -1;

  for (let i = firstInk; i <= lastInk; i++) {
    if (bins[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const x0 = runStart * BIN_SIZE;
      const x1 = i * BIN_SIZE;
      if (x1 - x0 >= minWidth) bands.push({ x0, x1 });
      runStart = -1;
    }
  }

  return bands;
}

/** True when the line places content strictly on both sides of the band. */
function straddles(line: Line, gutter: Gutter): boolean {
  let left = false;
  let right = false;
  for (const segment of line.segments) {
    if (segment.x1 <= gutter.x0 + 1) left = true;
    else if (segment.x0 >= gutter.x1 - 1) right = true;
    // A segment overlapping the band itself also counts as crossing it.
    else if (overlap1d(segment.x0, segment.x1, gutter.x0, gutter.x1) > 1) return true;
    if (left && right) return true;
  }
  return false;
}

/**
 * Keeps only bands that behave like page columns: rarely crossed, with real
 * content on both sides.
 */
function acceptGutters(lines: Line[], candidates: Gutter[]): Gutter[] {
  if (lines.length < MIN_LINES_FOR_COLUMNS) return [];

  return candidates.filter((gutter) => {
    let straddleCount = 0;
    let leftCount = 0;
    let rightCount = 0;

    for (const line of lines) {
      if (straddles(line, gutter)) {
        straddleCount += 1;
        continue;
      }
      if (line.x1 <= gutter.x0 + 1) leftCount += 1;
      else if (line.x0 >= gutter.x1 - 1) rightCount += 1;
    }

    if (straddleCount / lines.length > MAX_STRADDLE_RATIO) return false;

    const minSide = Math.max(2, Math.floor(lines.length * MIN_SIDE_SHARE));
    return leftCount >= minSide && rightCount >= minSide;
  });
}

export type ColumnLayout = {
  gutters: Gutter[];
  /** Left-to-right column bands; a single band means single-column. */
  bands: { x0: number; x1: number }[];
  columnCount: number;
};

export function detectColumns(lines: Line[], pageWidth: number): ColumnLayout {
  const withContent = lines.filter((l) => l.segments.length > 0);
  if (withContent.length === 0) {
    return { gutters: [], bands: [{ x0: 0, x1: pageWidth }], columnCount: 1 };
  }

  const occupancy = buildOccupancy(withContent, pageWidth);
  const gutters = acceptGutters(withContent, findEmptyBands(occupancy, pageWidth));

  const contentX0 = Math.min(...withContent.map((l) => l.x0));
  const contentX1 = Math.max(...withContent.map((l) => l.x1));

  const bands: { x0: number; x1: number }[] = [];
  let cursor = contentX0;
  for (const gutter of gutters) {
    bands.push({ x0: cursor, x1: gutter.x0 });
    cursor = gutter.x1;
  }
  bands.push({ x0: cursor, x1: contentX1 });

  return { gutters, bands, columnCount: bands.length };
}

/**
 * Re-serialises a page into reading order.
 *
 * Full-width lines (headings, spanning table rows) split the page into vertical
 * zones; inside each zone, columns are read left to right, top to bottom. That
 * mirrors how a person reads the page and keeps a heading attached to the
 * column text it introduces.
 */
export function orderLines(lines: Line[], layout: ColumnLayout): Line[] {
  if (layout.columnCount <= 1) {
    return [...lines]
      .sort((a, b) => b.baselineY - a.baselineY)
      .map((line) => ({ ...line, columnIndex: 0 }));
  }

  const assign = (line: Line): number => {
    if (layout.gutters.some((g) => straddles(line, g))) return -1;
    const center = (line.x0 + line.x1) / 2;
    // Nearest band by overlap, falling back to the band containing the centre.
    let best = -1;
    let bestOverlap = 0;
    layout.bands.forEach((band, index) => {
      const o = overlap1d(line.x0, line.x1, band.x0, band.x1);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = index;
      }
    });
    if (best !== -1) return best;
    return layout.bands.findIndex((b) => center >= b.x0 && center <= b.x1);
  };

  const annotated = [...lines]
    .sort((a, b) => b.baselineY - a.baselineY)
    .map((line) => ({ ...line, columnIndex: assign(line) }));

  // Partition into zones delimited by full-width lines.
  const zones: Line[][] = [];
  let zone: Line[] = [];
  for (const line of annotated) {
    if (line.columnIndex === -1) {
      if (zone.length > 0) zones.push(zone);
      zones.push([line]);
      zone = [];
    } else {
      zone.push(line);
    }
  }
  if (zone.length > 0) zones.push(zone);

  const ordered: Line[] = [];
  for (const current of zones) {
    if (current.length === 1 && current[0].columnIndex === -1) {
      ordered.push(current[0]);
      continue;
    }
    const byColumn = [...current].sort(
      (a, b) => a.columnIndex - b.columnIndex || b.baselineY - a.baselineY,
    );
    ordered.push(...byColumn);
  }

  return ordered;
}

/**
 * How strongly segment left edges cluster onto shared x positions.
 *
 * Prose and tables both align; scattered infographic labels do not. Feeds the
 * page's layout-confidence score, which decides whether facts from the page are
 * trusted or quarantined.
 */
export function computeAlignmentScore(lines: Line[]): number {
  const edges: number[] = [];
  for (const line of lines) for (const segment of line.segments) edges.push(segment.x0);
  if (edges.length < 4) return 1;

  const buckets = new Map<number, number>();
  for (const edge of edges) {
    const key = Math.round(edge / 3);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const counts = [...buckets.values()].sort((a, b) => b - a);
  // Share of edges falling on the most popular alignment positions. A well
  // structured page concentrates most of its edges on a handful of them.
  const topK = Math.max(1, Math.ceil(Math.sqrt(counts.length)));
  const covered = counts.slice(0, topK).reduce((sum, c) => sum + c, 0);
  return covered / edges.length;
}
