/**
 * Running header/footer detection.
 *
 * "Delhivery Limited  Annual Report 2023-24  42" appears on nearly every page.
 * Left in, it becomes a fact on every page and pollutes retrieval. It cannot be
 * matched by string equality because the page number changes, so text is
 * normalised by stripping digits before counting repeats — the structure of the
 * line is the signal, not its exact characters.
 */

import type { Line } from "./types";

/** Fraction of page height treated as the header/footer band. */
const BAND_RATIO = 0.12;
/** Minimum share of pages a line must appear on to count as boilerplate. */
const MIN_PAGE_SHARE = 0.3;
const MIN_PAGE_COUNT = 3;

function normalizeForRepeat(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^\w#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type BoilerplateMatcher = {
  isBoilerplate: (line: Line, pageHeight: number) => boolean;
  patterns: string[];
};

export function detectBoilerplate(
  pages: { pageNo: number; height: number; lines: Line[] }[],
): BoilerplateMatcher {
  const counts = new Map<string, Set<number>>();

  for (const page of pages) {
    const topEdge = page.height * (1 - BAND_RATIO);
    const bottomEdge = page.height * BAND_RATIO;

    for (const line of page.lines) {
      const inBand = line.y0 >= topEdge || line.y1 <= bottomEdge;
      if (!inBand) continue;

      const normalized = normalizeForRepeat(line.text);
      // Very short strings are usually bare page numbers, handled separately.
      if (normalized.length < 4) continue;

      const band = line.y0 >= topEdge ? "top" : "bottom";
      const key = `${band}:${normalized}`;
      const seen = counts.get(key) ?? new Set<number>();
      seen.add(page.pageNo);
      counts.set(key, seen);
    }
  }

  const threshold = Math.max(MIN_PAGE_COUNT, Math.ceil(pages.length * MIN_PAGE_SHARE));
  const repeated = new Set<string>();
  for (const [key, seen] of counts) {
    if (seen.size >= threshold) repeated.add(key);
  }

  return {
    patterns: [...repeated],
    isBoilerplate(line: Line, pageHeight: number) {
      const topEdge = pageHeight * (1 - BAND_RATIO);
      const bottomEdge = pageHeight * BAND_RATIO;
      const inBand = line.y0 >= topEdge || line.y1 <= bottomEdge;
      if (!inBand) return false;

      // A lone page number in the band is always boilerplate.
      const bare = line.text.trim();
      if (/^[ivxlcdm]{1,7}$|^\d{1,4}$/i.test(bare)) return true;

      const band = line.y0 >= topEdge ? "top" : "bottom";
      return repeated.has(`${band}:${normalizeForRepeat(line.text)}`);
    },
  };
}

/** The page number printed on the page, which often differs from its index. */
export function findPrintedLabel(lines: Line[], pageHeight: number): string | null {
  const bottomEdge = pageHeight * BAND_RATIO;
  const topEdge = pageHeight * (1 - BAND_RATIO);

  const candidates = lines.filter((l) => l.y1 <= bottomEdge || l.y0 >= topEdge);
  for (const line of candidates) {
    const text = line.text.trim();
    if (/^\d{1,4}$/.test(text)) return text;
    if (/^[ivxlcdm]{1,7}$/i.test(text) && text.length <= 7) return text.toLowerCase();
    // "Page 12 of 340"
    const match = text.match(/\bpage\s+(\d{1,4})\b/i);
    if (match) return match[1];
  }
  return null;
}
