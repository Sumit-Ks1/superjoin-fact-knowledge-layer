/**
 * Geometry types for layout reconstruction.
 *
 * All coordinates are PDF user space: origin bottom-left, y increasing upward.
 * The UI flips y once, at render time, in the evidence overlay — nowhere else.
 */

import type { BBox } from "@/db/schema";

export type { BBox };

/** A single positioned text run as pdf.js emits it. */
export type TextRun = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fontSize: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  /**
   * Text drawn more than 45 degrees off horizontal.
   *
   * Vertical group labels appear down the side of dense financial tables
   * ("Intangible Assets" turned on its side). They cannot share a baseline with
   * horizontal text, so clustering them together produces rows that exist
   * nowhere on the page — and those phantom rows go on to be read as section
   * headings, which silently changes the scope of every fact beneath them.
   */
  rotated: boolean;
};

/**
 * A horizontal group of runs separated from its neighbours by a gap wide enough
 * to be structural. In a table this is a cell; in prose it is a whole line.
 */
export type LineSegment = {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fontSize: number;
  bold: boolean;
  /** Cheap classification used by table detection and value parsing. */
  isNumeric: boolean;
};

/** Runs sharing a baseline, ordered left to right. */
export type Line = {
  pageNo: number;
  /** Baseline y, used for clustering and vertical ordering. */
  baselineY: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  segments: LineSegment[];
  /** Segments joined by a single space — the plain-text form. */
  text: string;
  /** Dominant font size, length-weighted. */
  fontSize: number;
  bold: boolean;
  /** Assigned during column resolution; -1 means full-width. */
  columnIndex: number;
};

/** A vertical whitespace corridor separating columns. */
export type Gutter = { x0: number; x1: number };

export type PageGeometry = {
  pageNo: number;
  width: number;
  height: number;
  runs: TextRun[];
};

export type ParsedPage = {
  pageNo: number;
  width: number;
  height: number;
  lines: Line[];
  columnCount: number;
  /**
   * 0..1. Driven by how well text runs form lines and columns. Infographic
   * pages score low because their runs have no reliable reading order — facts
   * derived from them are quarantined rather than trusted.
   */
  layoutConfidence: number;
  /** Signals behind `layoutConfidence`, surfaced in the Quality screen. */
  layoutSignals: {
    shortSegmentRatio: number;
    numericSegmentRatio: number;
    alignmentScore: number;
    lineCount: number;
  };
  printedLabel: string | null;
};

export function bboxOf(items: { x0: number; y0: number; x1: number; y1: number }[]): BBox {
  if (items.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    x0: Math.min(...items.map((i) => i.x0)),
    y0: Math.min(...items.map((i) => i.y0)),
    x1: Math.max(...items.map((i) => i.x1)),
    y1: Math.max(...items.map((i) => i.y1)),
  };
}

export function bboxUnion(a: BBox, b: BBox): BBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** Overlap of two 1-D intervals; 0 when disjoint. */
export function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Does this text look like a measured value?
 *
 * Deliberately generic: digits with optional sign, grouping separators,
 * decimals, parenthesised negatives, percent/currency marks, and the
 * spreadsheet sentinels that mean "no value". No domain vocabulary.
 */
const NUMERIC_RE =
  /^[\s(\[]*[-+₹$€£¥]?\s*\d[\d,  .']*\s*(?:%|bps|x)?\s*[)\]]*[*#†‡§^]*\s*$/u;
const SENTINEL_RE = /^\s*(nil|n\.?a\.?|not applicable|none|-|–|—|–|—)\s*[*#†‡§^]*\s*$/i;

export function looksNumeric(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return NUMERIC_RE.test(t);
}

export function looksLikeSentinel(text: string): boolean {
  return SENTINEL_RE.test(text.trim());
}

/** Numeric or an explicit "no value" marker — both occupy value columns. */
export function occupiesValueColumn(text: string): boolean {
  return looksNumeric(text) || looksLikeSentinel(text);
}
