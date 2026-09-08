/**
 * Runs → lines → segments.
 *
 * pdf.js emits text in draw order, which is not reading order and frequently
 * splits a single word across several runs. This module rebuilds the visual
 * structure: cluster runs onto shared baselines, then split each baseline at
 * gaps wide enough to be structural rather than typographic.
 *
 * The segment boundary is the load-bearing decision here. Too eager and prose
 * shatters into fake table cells; too lax and adjacent table columns merge into
 * one. The threshold is therefore derived per line from that line's own gap
 * distribution rather than fixed globally.
 */

import type { Line, LineSegment, TextRun } from "./types";
import { looksNumeric, occupiesValueColumn } from "./types";

/**
 * Runs closer than this fraction of the font size belong to the same word.
 *
 * Calibrated against the corpus: at 0.28 a set space is swallowed and the
 * prospectus contents page reads "DEFINITIONSANDABBREVIATIONS", while below
 * 0.16 the returns collapse (35 more spaces across six documents) and intra-word
 * kerning starts being read as a space. Lowering it to 0.16 restored 507 spaces
 * with the glyph stream byte-identical either way.
 */
const GLUE_RATIO = 0.16;
/** A gap this much larger than the one below it marks the word/column boundary. */
const BIMODAL_RATIO = 2;
/** Any gap this wide is structural regardless of the line's own distribution. */
const ALWAYS_SPLIT_RATIO = 2.2;
/** Gaps at least this wide, when uniform, mean the whole line is columns. */
const COLUMN_GAP_RATIO = 1;
/** Baseline clustering tolerance, as a fraction of font size. */
const BASELINE_TOLERANCE_RATIO = 0.45;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Length-weighted dominant font size: a heading with a trailing footnote marker
 * should report the heading's size, not an average dragged down by one glyph.
 */
function dominantFontSize(runs: { fontSize: number; text: string }[]): number {
  if (runs.length === 0) return 10;
  const buckets = new Map<number, number>();
  for (const run of runs) {
    const key = Math.round(run.fontSize * 2) / 2; // 0.5pt buckets
    buckets.set(key, (buckets.get(key) ?? 0) + Math.max(1, run.text.trim().length));
  }
  let bestSize = runs[0].fontSize;
  let bestWeight = -1;
  for (const [size, weight] of buckets) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestSize = size;
    }
  }
  return bestSize;
}

/** Targeted cleanup only — full NFKC normalisation would mangle currency marks. */
function normalizeText(text: string): string {
  return text
    .replace(/ /g, " ") // non-breaking space
    .replace(/[‐‑]/g, "-") // hyphen variants → ASCII hyphen
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/\s+/g, " ")
    .trim();
}

/** Groups runs onto shared baselines, top of page first. */
function clusterIntoBaselines(runs: TextRun[]): TextRun[][] {
  if (runs.length === 0) return [];

  // PDF y grows upward, so descending y walks the page top-down.
  const sorted = [...runs].sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0);
  const globalFontSize = dominantFontSize(sorted);

  const groups: TextRun[][] = [];
  let current: TextRun[] = [sorted[0]];
  let currentBaseline = sorted[0].y0;

  for (let i = 1; i < sorted.length; i++) {
    const run = sorted[i];
    // Tolerance follows the larger of the two font sizes in play, so a small
    // superscript still attaches to the big heading it annotates.
    const reference = Math.max(run.fontSize, dominantFontSize(current), globalFontSize * 0.5);
    const tolerance = Math.max(reference * BASELINE_TOLERANCE_RATIO, 1);

    if (Math.abs(run.y0 - currentBaseline) <= tolerance) {
      current.push(run);
      // Track the baseline of the dominant text, not the last run seen.
      currentBaseline = median(current.map((r) => r.y0));
    } else {
      groups.push(current);
      current = [run];
      currentBaseline = run.y0;
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Chooses the gap width above which a break is structural rather than a space.
 *
 * The discriminator is absolute — a gap near the font size is far too wide to
 * be a word space — with the observed word gap used only to raise the bar for
 * loosely set text. Relative rules alone do not survive this corpus:
 *
 *   "1,008.76  1,626.63  1,917.64"      no word gaps at all to calibrate against
 *   "Revenue from contract      36,465.27  27,805.75"
 *                                        label is one run, so every gap is
 *                                        structural, and the label→value gap
 *                                        (210pt) dwarfs the column gaps (30pt)
 *
 * In the second line a "largest relative jump" rule picks the 210pt gap and
 * merges three columns into a single cell. An absolute floor picks all three.
 */
function computeSplitThreshold(gaps: number[], fontSize: number): number {
  const positive = gaps.filter((g) => g > fontSize * 0.03);
  if (positive.length === 0) return Infinity;

  const floor = fontSize * COLUMN_GAP_RATIO;

  // Gaps plausibly narrow enough to be word spaces.
  const wordGaps = positive.filter((g) => g < floor);
  const typicalWordGap = wordGaps.length > 0 ? median(wordGaps) : fontSize * 0.25;

  // Justified or letter-spaced text widens its spaces; follow it upward, but
  // never below the absolute floor.
  return Math.min(
    Math.max(floor, typicalWordGap * BIMODAL_RATIO),
    fontSize * ALWAYS_SPLIT_RATIO,
  );
}

/** Splits one baseline into segments at structurally significant gaps. */
function segmentBaseline(runs: TextRun[]): LineSegment[] {
  const ordered = [...runs].sort((a, b) => a.x0 - b.x0);
  const fontSize = dominantFontSize(ordered);

  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(ordered[i].x0 - ordered[i - 1].x1);
  }

  const splitThreshold = computeSplitThreshold(gaps, fontSize);

  const segments: LineSegment[] = [];
  let bucket: TextRun[] = [];
  let text = "";

  const flush = () => {
    if (bucket.length === 0) return;
    const cleaned = normalizeText(text);
    if (cleaned !== "") {
      segments.push({
        text: cleaned,
        x0: Math.min(...bucket.map((r) => r.x0)),
        x1: Math.max(...bucket.map((r) => r.x1)),
        y0: Math.min(...bucket.map((r) => r.y0)),
        y1: Math.max(...bucket.map((r) => r.y1)),
        fontSize: dominantFontSize(bucket),
        // A segment counts as bold only if most of its ink is bold.
        bold:
          bucket.filter((r) => r.bold).reduce((n, r) => n + r.text.length, 0) >
          bucket.reduce((n, r) => n + r.text.length, 0) / 2,
        isNumeric: occupiesValueColumn(cleaned),
      });
    }
    bucket = [];
    text = "";
  };

  for (let i = 0; i < ordered.length; i++) {
    const run = ordered[i];
    if (i === 0) {
      bucket.push(run);
      text = run.text;
      continue;
    }

    const gap = run.x0 - ordered[i - 1].x1;
    const glue = Math.max(run.fontSize, ordered[i - 1].fontSize) * GLUE_RATIO;

    if (gap >= splitThreshold) {
      flush();
      bucket.push(run);
      text = run.text;
    } else if (gap <= glue) {
      // Same word, split by the renderer (kerning pairs, ligatures).
      bucket.push(run);
      text += run.text;
    } else {
      bucket.push(run);
      text += ` ${run.text}`;
    }
  }
  flush();

  return segments;
}

/** Rebuilds the reading structure of one page. */
export function buildLines(runs: TextRun[], pageNo: number): Line[] {
  /*
   * Rotated text is dropped before clustering rather than after.
   *
   * A vertical label shares an x range with the column beside it and a y range
   * with a dozen rows, so baseline clustering scatters its characters across
   * those rows. In the prospectus balance sheet a side label reading
   * "Intangible Assets" arrived as rows "Inta ngib le" and "Asse ts", and the
   * second was read as a section heading that then re-scoped every asset below
   * it. Losing a decorative side label costs nothing; keeping it corrupts the
   * rows it crosses.
   */
  const horizontal = runs.filter((run) => !run.rotated);
  const baselines = clusterIntoBaselines(horizontal);
  const lines: Line[] = [];

  for (const group of baselines) {
    const segments = segmentBaseline(group);
    if (segments.length === 0) continue;

    const fontSize = dominantFontSize(group);
    const boldInk = group.filter((r) => r.bold).reduce((n, r) => n + r.text.length, 0);
    const totalInk = group.reduce((n, r) => n + r.text.length, 0);

    lines.push({
      pageNo,
      baselineY: median(group.map((r) => r.y0)),
      x0: Math.min(...segments.map((s) => s.x0)),
      x1: Math.max(...segments.map((s) => s.x1)),
      y0: Math.min(...segments.map((s) => s.y0)),
      y1: Math.max(...segments.map((s) => s.y1)),
      segments,
      text: segments.map((s) => s.text).join(" "),
      fontSize,
      bold: totalInk > 0 && boldInk > totalInk / 2,
      columnIndex: -1,
    });
  }

  // Already top-down from clustering, but make the ordering explicit.
  return lines.sort((a, b) => b.baselineY - a.baselineY);
}

/** Body text size for the page: the most common size by ink volume. */
export function bodyFontSize(lines: Line[]): number {
  const buckets = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.fontSize * 2) / 2;
    buckets.set(key, (buckets.get(key) ?? 0) + line.text.length);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, weight] of buckets) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = size;
    }
  }
  return best;
}

/** Share of a line's segments that sit in value columns. */
export function numericRatio(line: Line): number {
  if (line.segments.length === 0) return 0;
  return line.segments.filter((s) => s.isNumeric).length / line.segments.length;
}

export function countNumericSegments(line: Line): number {
  return line.segments.filter((s) => s.isNumeric).length;
}

export { looksNumeric, dominantFontSize, median, normalizeText };
