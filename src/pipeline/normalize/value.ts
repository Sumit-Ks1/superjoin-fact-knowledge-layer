/**
 * Numbers and units → a single comparable quantity.
 *
 * Two documents almost never state the same quantity the same way. The
 * prospectus writes ₹52,350.00 million; an Indian analyst deck writes ₹5,235
 * crore; a slide writes ₹5.2k crore. These are one number, and unless they are
 * reduced to one number the corroboration case cannot be demonstrated and the
 * contradiction case is all false positives.
 *
 * The reduction is `valueBase = valueNum × unit.factor`, and `valueBase` is the
 * only field ever compared numerically anywhere downstream.
 *
 * Two deliberate refusals:
 *
 *  · Currencies are never converted. INR and USD reduce to different base
 *    units, so they compare as incomparable rather than as a contradiction.
 *    An exchange rate is a fact about a date, not a constant.
 *  · A scale word is never guessed. If a figure's magnitude is unknown it stays
 *    unknown and the fact is flagged, because guessing turns a missing unit
 *    into a fabricated contradiction six orders of magnitude wide.
 */

import type { UnitInfo, ValueModifier } from "@/db/schema";

export type ParsedValue = {
  /** Exactly as printed, before any interpretation. */
  raw: string;
  /** Sign-corrected, separators and footnote marks removed. Null for sentinels. */
  num: number | null;
  min: number | null;
  max: number | null;
  modifier: ValueModifier;
  unit: UnitInfo | null;
  /** `num × unit.factor`, or null when either is unknown. */
  base: number | null;
  /** Set when the text carried no resolvable scale and one is still needed. */
  scaleUnresolved: boolean;
};

/* ── scale words ──────────────────────────────────────────────────────────── */

/**
 * Multipliers, including the South Asian scale words these corpora use.
 *
 * `k` is deliberately absent as a bare word: "5k" is common but "k" alone
 * appears far more often as an identifier or a column code, and the cost of a
 * wrong multiplier is three orders of magnitude.
 */
const SCALE_WORDS: [RegExp, number][] = [
  [/\btrillions?\b|\btn\b/i, 1e12],
  [/\bbillions?\b|\bbn\b/i, 1e9],
  [/\bmillions?\b|\bmn\b|\bmm\b/i, 1e6],
  [/\bcrores?\b|\bcr\b/i, 1e7],
  [/\blakhs?\b|\blacs?\b/i, 1e5],
  [/\bthousands?\b/i, 1e3],
  [/\bhundreds?\b/i, 1e2],
];

const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/₹|\bINR\b|\bRs\.?\b|\brupees?\b/i, "INR"],
  [/US\s*\$|\bUSD\b|\bUS\s*dollars?\b/i, "USD"],
  [/€|\bEUR\b|\beuros?\b/i, "EUR"],
  [/£|\bGBP\b|\bpounds? sterling\b/i, "GBP"],
  [/¥|\bJPY\b|\byen\b/i, "JPY"],
  // Bare "$" last: "US$" and "C$" must win before it.
  [/\$/, "USD"],
];

/** Non-currency units of measure, kept generic across document domains. */
const MEASURES: [RegExp, UnitInfo["kind"], string, number][] = [
  [/\b(?:tonnes?|tons?|mt)\b/i, "mass", "kg", 1000],
  [/\b(?:kilograms?|kgs?)\b/i, "mass", "kg", 1],
  [/\b(?:grams?|gm?s?)\b/i, "mass", "kg", 0.001],
  [/\b(?:square (?:feet|foot)|sq\.? ?ft\.?|sqft)\b/i, "area", "m2", 0.092903],
  [/\b(?:square metres?|square meters?|sq\.? ?m\.?|sqm)\b/i, "area", "m2", 1],
  [/\b(?:acres?)\b/i, "area", "m2", 4046.86],
  [/\b(?:kilometres?|kilometers?|kms?)\b/i, "length", "m", 1000],
  [/\b(?:metres?|meters?)\b/i, "length", "m", 1],
  [/\b(?:miles?)\b/i, "length", "m", 1609.34],
  [/\b(?:hours?|hrs?)\b/i, "time", "s", 3600],
  [/\b(?:minutes?|mins?)\b/i, "time", "s", 60],
  [/\b(?:days?)\b/i, "time", "s", 86400],
  [/\b(?:gigawatt hours?|gwh)\b/i, "energy", "kWh", 1e6],
  [/\b(?:megawatt hours?|mwh)\b/i, "energy", "kWh", 1000],
  [/\b(?:kilowatt hours?|kwh)\b/i, "energy", "kWh", 1],
];

/* ── sentinels and modifiers ──────────────────────────────────────────────── */

const NIL_RE = /^\s*(?:nil|none|zero)\s*$/i;
const NA_RE = /^\s*(?:n\.?\s*a\.?|not applicable|not available|n\.?\s*m\.?|-{1,2}|[–—])\s*$/i;

const APPROX_RE = /\b(?:approx(?:imately)?|about|around|circa|c\.|~|nearly|roughly|almost)\b|~/i;
const AT_LEAST_RE = /\b(?:at least|no less than|minimum of|more than|over|in excess of|above|>=?)\b/i;
const AT_MOST_RE = /\b(?:at most|no more than|maximum of|less than|under|below|up to|<=?)\b/i;

/** Trailing reference marks: "9,324,309#", "1,234.00*", "45.6(1)". */
const FOOTNOTE_TAIL = /(?:[*#†‡§^]+|\((?:\d{1,2}|[a-z])\))\s*$/i;

/* ── number parsing ───────────────────────────────────────────────────────── */

/**
 * Reads the numeric literal out of a fragment.
 *
 * Grouping separators are stripped wholesale rather than validated, because
 * South Asian grouping ("1,23,456") is irregular by design and rejecting it
 * would drop most figures in this corpus. The decimal separator is whichever of
 * `.` or `,` appears last with 1–2 trailing digits, which distinguishes the
 * European "1.234,56" from the Anglo "1,234.56" without being told which
 * convention the document uses.
 */
export function decimalSeparatorIndex(cleaned: string): number {
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  if (lastDot > lastComma && /\.\d{1,3}$/.test(cleaned)) return lastDot;
  if (lastComma > lastDot && /,\d{1,2}$/.test(cleaned)) return lastComma;
  return -1;
}

/**
 * Digits after the decimal separator; 0 when the figure states none.
 *
 * Shared with the precision check used during adjudication, which must agree
 * with the parser exactly. If the two disagree, a figure's claimed precision is
 * wrong by orders of magnitude and correctly-rounded restatements of the same
 * quantity start reading as contradictions.
 */
export function decimalPlaces(raw: string): number {
  const cleaned = raw.replace(/[^\d.,]/g, "");
  const at = decimalSeparatorIndex(cleaned);
  return at === -1 ? 0 : cleaned.length - at - 1;
}

export function parseNumber(text: string): number | null {
  let t = text.trim().replace(FOOTNOTE_TAIL, "").trim();
  if (t === "") return null;

  const parenthesised = /^\(.*\)$/.test(t);
  if (parenthesised) t = t.slice(1, -1).trim();

  const explicitSign = /^[-−–]/.test(t) ? -1 : 1;
  t = t.replace(/^[-−–+]\s*/, "");

  // Drop everything that is not a digit or a separator.
  const cleaned = t.replace(/[^\d.,'   ]/g, "").trim();
  if (!/\d/.test(cleaned)) return null;

  const decimalAt = decimalSeparatorIndex(cleaned);

  let integerPart = decimalAt === -1 ? cleaned : cleaned.slice(0, decimalAt);
  const fractionPart = decimalAt === -1 ? "" : cleaned.slice(decimalAt + 1);

  integerPart = integerPart.replace(/[^\d]/g, "");
  const fraction = fractionPart.replace(/[^\d]/g, "");
  if (integerPart === "" && fraction === "") return null;

  const value = Number(`${integerPart || "0"}.${fraction || "0"}`);
  if (!Number.isFinite(value)) return null;

  // Accounting parentheses mean negative; a leading sign says so directly.
  return (parenthesised ? -1 : explicitSign) * value;
}

/* ── unit resolution ──────────────────────────────────────────────────────── */

/**
 * Builds a unit from the text around a number.
 *
 * `context` is everything that could carry the scale: the cell, its column
 * header, the table caption, the sentence. Scale is stated once per table and
 * never repeated in the cell, so a cell-only reading finds nothing.
 */
export function resolveUnit(context: string): UnitInfo | null {
  const text = context.trim();
  if (text === "") return null;

  /*
   * `raw` is the unit as a reader would write it — "₹ million", not the whole
   * caption it was found in. The context handed to this function is often a
   * caption, a header stack and a row label concatenated together, and storing
   * that verbatim puts a paragraph into every fact's unit label and into every
   * explanation built from one.
   */
  const matched = (re: RegExp): string | undefined => text.match(re)?.[0]?.trim();

  const scaleEntry = SCALE_WORDS.find(([re]) => re.test(text));
  const scale = scaleEntry?.[1];
  const scaleWord = scaleEntry ? matched(scaleEntry[0]) : undefined;

  const currencyEntry = CURRENCY_SYMBOLS.find(([re]) => re.test(text));
  const currency = currencyEntry?.[1];
  const currencyMark = currencyEntry ? matched(currencyEntry[0]) : undefined;

  const label = (...parts: (string | undefined)[]) =>
    parts.filter((p) => p && p !== "").join(" ") || null;

  // Percent and basis points are ratios, and dominate any scale word nearby.
  const percent = matched(/%|\bper ?cent(?:age)?\b|\bpercentage points?\b|\bpp\b/i);
  if (percent) {
    return { raw: percent, kind: "ratio", baseUnit: "ratio", factor: 0.01 };
  }
  const bps = matched(/\bbps\b|\bbasis points?\b/i);
  if (bps) {
    return { raw: bps, kind: "ratio", baseUnit: "ratio", factor: 0.0001 };
  }

  if (currency) {
    return {
      raw: label(currencyMark, scaleWord),
      kind: "currency",
      currency,
      scale: scale ?? 1,
      // The currency is the base unit: no cross-currency conversion is implied.
      baseUnit: currency,
      factor: scale ?? 1,
    };
  }

  const measureEntry = MEASURES.find(([re]) => re.test(text));
  if (measureEntry) {
    const [re, kind, baseUnit, factor] = measureEntry;
    return {
      raw: label(scaleWord, matched(re)),
      kind,
      uom: baseUnit,
      scale: scale ?? 1,
      baseUnit,
      factor: factor * (scale ?? 1),
    };
  }

  const multiple = matched(/\b(?:times|x)\b|\bratio\b/i);
  if (multiple) {
    return { raw: multiple, kind: "ratio", baseUnit: "ratio", factor: 1 };
  }

  // A bare scale word with no unit is still a count: "1.2 million shipments".
  if (scale !== undefined) {
    return { raw: scaleWord ?? null, kind: "count", scale, baseUnit: "count", factor: scale };
  }

  return null;
}

/* ── entry point ──────────────────────────────────────────────────────────── */

/**
 * Resolves a unit from several contexts, nearest first.
 *
 * Specificity has to be respected or units leak sideways. A share-movement
 * table prints counts in one column and percentages in the next, under a single
 * caption that mentions both; reading the caption and the whole header stack as
 * one blob makes every count a percentage. In the Delhivery annual report that
 * turned 728,715,149 shares and 728.72 million shares — the same holding stated
 * two ways — into a 100% contradiction.
 *
 * So each scope is tried in order and the first that names a unit wins: the
 * cell itself, then its own column header, then the row label, then the
 * caption. A caption only supplies what nothing closer already has.
 */
export function resolveUnitScoped(scopes: string[], ratioScopes = 2): UnitInfo | null {
  let fallback: UnitInfo | null = null;

  for (let i = 0; i < scopes.length; i++) {
    const unit = resolveUnit(scopes[i]);
    if (!unit) continue;

    /*
     * A percentage is marked where it is printed — in the cell, or at the head
     * of its own column. A scale, by contrast, is stated once in a caption and
     * applies to everything beneath it. So a ratio found only in a distant
     * scope is somebody else's column leaking across: an annual report note
     * listing share counts beside a percentage column turned 728,715,149 shares
     * into 7,287,151% and reported it as contradicting the same holding stated
     * in millions.
     *
     * Widening this to the row label was tried and made things worse: macro
     * tables routinely mention a percentage in a label whose column holds
     * counts, and unit refusals nearly tripled across the macro corpus.
     */
    if (unit.kind === "ratio" && i >= ratioScopes) {
      fallback = fallback ?? null;
      continue;
    }
    return unit;
  }

  return fallback;
}

/**
 * Normalises one printed value together with whatever context qualifies it.
 *
 * `context` may be a single string or an ordered list from most specific to
 * least — see `resolveUnitScoped`. It is only ever read for units and
 * modifiers; the number itself comes from `raw` alone, so a stray figure in a
 * caption can never be mistaken for the value.
 */
export function normalizeValue(raw: string, context: string | string[] = ""): ParsedValue {
  const text = raw.trim();
  const scopes = (Array.isArray(context) ? context : [context]).filter((s) => s.trim() !== "");
  // The cell is always the most specific scope.
  const ordered = [text, ...scopes];
  const scope = ordered.join(" ").trim();

  const base: ParsedValue = {
    raw: text,
    num: null,
    min: null,
    max: null,
    modifier: "exact",
    unit: null,
    base: null,
    scaleUnresolved: false,
  };

  if (NIL_RE.test(text)) return { ...base, modifier: "nil", num: 0, base: 0 };
  if (NA_RE.test(text)) return { ...base, modifier: "not_applicable" };

  // A range keeps both ends: "₹40,000 to ₹52,350 million" is not a midpoint.
  const range = text.match(
    /^\s*([-−–+]?[\d.,]+)\s*(?:-|–|—|to|through|and)\s*([-−–+]?[\d.,]+)\s*$/i,
  );
  if (range) {
    const low = parseNumber(range[1]);
    const high = parseNumber(range[2]);
    if (low !== null && high !== null && low <= high) {
      const unit = resolveUnitScoped(ordered);
      return {
        ...base,
        num: (low + high) / 2,
        min: low,
        max: high,
        modifier: "range",
        unit,
        base: unit ? ((low + high) / 2) * unit.factor : null,
        scaleUnresolved: unit === null,
      };
    }
  }

  const num = parseNumber(text);
  if (num === null) return base;

  const unit = resolveUnitScoped(ordered);

  let modifier: ValueModifier = "exact";
  if (APPROX_RE.test(scope)) modifier = "approximate";
  else if (AT_LEAST_RE.test(scope)) modifier = "at_least";
  else if (AT_MOST_RE.test(scope)) modifier = "at_most";

  return {
    ...base,
    num,
    modifier,
    unit,
    base: unit ? num * unit.factor : null,
    // A bare number with no unit anywhere is comparable only to other bare
    // numbers; the caller decides whether that is acceptable for its fact kind.
    scaleUnresolved: unit === null,
  };
}

/**
 * Are two quantities on the same measuring stick?
 *
 * The gate before any numeric comparison. Ratios compare to ratios, INR to INR;
 * INR never compares to USD, because without a dated exchange rate the answer
 * would be invented.
 */
export function comparableUnits(a: UnitInfo | null, b: UnitInfo | null): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "currency") return a.currency === b.currency;
  return a.baseUnit === b.baseUnit;
}

/**
 * Relative difference between two base values.
 *
 * Symmetric in the denominator so that neither ordering of a pair reports a
 * different magnitude, and defined when one side is zero.
 */
export function relativeDifference(a: number, b: number): number {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  return Math.abs(a - b) / scale;
}
