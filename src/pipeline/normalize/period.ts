/**
 * Period expressions → comparable intervals.
 *
 * This module decides most of the reconciliation story. "Revenue was ₹48,105.30
 * million" and "Revenue was ₹36,465.27 million" look like a flat contradiction
 * until the periods are read: nine months to December 2021 against the year to
 * March 2021. Different windows, both true. Without interval semantics that
 * pair is a false contradiction, and false contradictions are worse than
 * missed ones — they destroy trust in every finding beside them.
 *
 * Fiscal years are the hard part and are never assumed. "FY24" means April 2023
 * to March 2024 for an Indian issuer and October 2023 to September 2024 for the
 * US federal government. The caller supplies the fiscal year end it *learned*
 * from the document; absent that, a fiscal label resolves to a labelled period
 * with no interval, which compares as "unknown" rather than as a wrong guess.
 */

import type { PeriodKind } from "@/db/schema";

import { contentWords } from "./text";

export type ParsedPeriod = {
  kind: PeriodKind;
  start: Date | null;
  end: Date | null;
  /** As printed: "Fiscal 2021", "nine months ended December 31, 2021". */
  label: string;
  /** True when a fiscal label could not be anchored to a calendar interval. */
  fiscalUnanchored: boolean;
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const MONTH_NAMES = Object.keys(MONTHS).join("|");

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/** Last instant of a month, used to close an interval on its final day. */
function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
}

function addMonths(date: Date, months: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** Four-digit years only; a two-digit year is ambiguous and is left alone. */
const YEAR = "(19\\d{2}|20\\d{2})";

/**
 * The month a fiscal year ends in, as learned from the document.
 *
 * `month` is 0-based. Passing null means "not established", which is honoured
 * rather than defaulted — an assumed fiscal calendar silently shifts every
 * fiscal fact by up to a year.
 */
export type FiscalCalendar = { endMonth: number; endDay: number } | null;

/**
 * Infers the fiscal year end from statements a document makes about itself.
 *
 * Two passes, because the naive one is wrong. A prospectus presents interim
 * results first, so the first date-bearing phrase in the file is "nine months
 * period ended December 31" — reading that as the year end moves every fiscal
 * label in the document by nine months. Only "year ended" is counted, never
 * "period ended", and the most frequent year end wins rather than the first:
 * a filing repeats its real year end on every statement, while a stray phrasing
 * appears once.
 */
export function inferFiscalCalendar(text: string): FiscalCalendar {
  // Strongest evidence: the document names its year end outright.
  const declared = text.match(
    new RegExp(
      `(?:fiscal|financial) year (?:end(?:ing|ed|s)?)\\s*(?:on\\s*)?(?:the\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})`,
      "i",
    ),
  );
  if (declared) {
    const month = MONTHS[declared[1].toLowerCase()];
    const day = Number(declared[2]);
    if (month !== undefined && day >= 1 && day <= 31) return { endMonth: month, endDay: day };
  }

  // Otherwise, the modal "year ended <date>" across the document.
  const counts = new Map<string, number>();
  const pattern = new RegExp(
    `\\byear ended\\s+(?:on\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})`,
    "gi",
  );
  for (const match of text.matchAll(pattern)) {
    const month = MONTHS[match[1].toLowerCase()];
    const day = Number(match[2]);
    if (month === undefined || day < 1 || day > 31) continue;
    const key = `${month}:${day}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = key;
    }
  }
  if (!best) return null;

  const [month, day] = best.split(":").map(Number);
  return { endMonth: month, endDay: day };
}

/** Interval for the fiscal year *labelled* `year` under `calendar`. */
function fiscalInterval(year: number, calendar: FiscalCalendar): { start: Date; end: Date } | null {
  if (!calendar) return null;
  // A fiscal year is named for the calendar year it ends in.
  const end = utc(year, calendar.endMonth, calendar.endDay);
  end.setUTCHours(23, 59, 59, 999);
  const start = addMonths(utc(year, calendar.endMonth, calendar.endDay), -12);
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(0, 0, 0, 0);
  return { start, end };
}

function unknown(label: string): ParsedPeriod {
  return { kind: "unknown", start: null, end: null, label, fiscalUnanchored: false };
}

/**
 * Parses a period expression.
 *
 * Ordered most specific first: an explicit "nine months ended <date>" must win
 * over the bare year inside it, or every interim period collapses into the
 * annual one and the reconciliation case disappears.
 */
export function parsePeriod(input: string, calendar: FiscalCalendar = null): ParsedPeriod {
  const text = input.trim().replace(/\s+/g, " ");
  if (text === "") return unknown("");

  /* ── explicit N-month periods ended <date> ─────────────────────────────── */
  const monthsEnded = text.match(
    new RegExp(
      `\\b(three|six|nine|twelve|3|6|9|12)[- ]month[s]?\\b[^]{0,24}?\\bended?\\b\\s*(?:on\\s*)?(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s*${YEAR}`,
      "i",
    ),
  );
  if (monthsEnded) {
    const spanWords: Record<string, number> = {
      three: 3, "3": 3, six: 6, "6": 6, nine: 9, "9": 9, twelve: 12, "12": 12,
    };
    const span = spanWords[monthsEnded[1].toLowerCase()];
    const month = MONTHS[monthsEnded[2].toLowerCase()];
    const day = Number(monthsEnded[3]);
    const year = Number(monthsEnded[4]);
    const end = utc(year, month, day);
    end.setUTCHours(23, 59, 59, 999);
    const start = addMonths(utc(year, month, day), -span);
    start.setUTCDate(start.getUTCDate() + 1);
    return {
      kind: span === 3 ? "quarter" : span === 6 ? "half_year" : span === 9 ? "nine_month" : "calendar_year",
      start,
      end,
      label: monthsEnded[0].trim(),
      fiscalUnanchored: false,
    };
  }

  /* ── year / period ended <date> ────────────────────────────────────────── */
  const yearEnded = text.match(
    new RegExp(
      `\\b(?:year|yr|period|fiscal)\\b[^]{0,16}?\\bended?\\b\\s*(?:on\\s*)?(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s*${YEAR}`,
      "i",
    ),
  );
  if (yearEnded) {
    const month = MONTHS[yearEnded[1].toLowerCase()];
    const day = Number(yearEnded[2]);
    const year = Number(yearEnded[3]);
    const end = utc(year, month, day);
    end.setUTCHours(23, 59, 59, 999);
    const start = addMonths(utc(year, month, day), -12);
    start.setUTCDate(start.getUTCDate() + 1);
    return {
      kind: month === 11 && day === 31 ? "calendar_year" : "fiscal_year",
      start,
      end,
      label: yearEnded[0].trim(),
      fiscalUnanchored: false,
    };
  }

  /* ── "as at / as of <date>" — a balance, not a flow ────────────────────── */
  const asAt = text.match(
    new RegExp(`\\bas (?:at|of|on)\\b\\s*(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s*${YEAR}`, "i"),
  );
  if (asAt) {
    const instant = utc(Number(asAt[3]), MONTHS[asAt[1].toLowerCase()], Number(asAt[2]));
    return { kind: "instant", start: instant, end: instant, label: asAt[0].trim(), fiscalUnanchored: false };
  }

  /* ── quarters: "Q4 FY24", "Q3 2024", "fourth quarter of 2023" ──────────── */
  const quarter = text.match(/\bQ([1-4])\b[\s'-]*(?:FY|F\.?Y\.?)?\s*(\d{2,4})\b/i);
  if (quarter) {
    const q = Number(quarter[1]);
    const year = normalizeYear(quarter[2]);
    const fiscal = /FY|F\.Y\./i.test(quarter[0]);

    if (fiscal) {
      const annual = fiscalInterval(year, calendar);
      if (!annual) {
        return { kind: "quarter", start: null, end: null, label: quarter[0].trim(), fiscalUnanchored: true };
      }
      const start = addMonths(annual.start, (q - 1) * 3);
      const end = addMonths(annual.start, q * 3);
      end.setUTCDate(end.getUTCDate() - 1);
      end.setUTCHours(23, 59, 59, 999);
      return { kind: "quarter", start, end, label: quarter[0].trim(), fiscalUnanchored: false };
    }

    const start = utc(year, (q - 1) * 3, 1);
    const end = endOfMonth(year, q * 3 - 1);
    return { kind: "quarter", start, end, label: quarter[0].trim(), fiscalUnanchored: false };
  }

  /* ── fiscal years: "FY2024", "FY24", "fiscal 2021", "2023-24" ──────────── */
  const fiscalYear = text.match(/\b(?:FY|F\.?Y\.?|fiscal(?: year)?)\s*'?(\d{2,4})\b/i);
  if (fiscalYear) {
    const year = normalizeYear(fiscalYear[1]);
    const interval = fiscalInterval(year, calendar);
    return {
      kind: "fiscal_year",
      start: interval?.start ?? null,
      end: interval?.end ?? null,
      label: fiscalYear[0].trim(),
      fiscalUnanchored: interval === null,
    };
  }

  // "2023-24" / "2023–2024": a fiscal span written as a hyphenated pair.
  const spanned = text.match(/\b(19\d{2}|20\d{2})\s*[-–/]\s*(\d{2}|\d{4})\b/);
  if (spanned) {
    const endYear = normalizeYear(spanned[2], Number(spanned[1]));
    const interval = fiscalInterval(endYear, calendar);
    return {
      kind: "fiscal_year",
      start: interval?.start ?? null,
      end: interval?.end ?? null,
      label: spanned[0].trim(),
      fiscalUnanchored: interval === null,
    };
  }

  /* ── month and year: "December 2021" ───────────────────────────────────── */
  const monthYear = text.match(new RegExp(`\\b(${MONTH_NAMES})\\s+${YEAR}\\b`, "i"));
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    const year = Number(monthYear[2]);
    return {
      kind: "month",
      start: utc(year, month, 1),
      end: endOfMonth(year, month),
      label: monthYear[0].trim(),
      fiscalUnanchored: false,
    };
  }

  /* ── a bare date ───────────────────────────────────────────────────────── */
  const bareDate = text.match(new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s*${YEAR}\\b`, "i"));
  if (bareDate) {
    const instant = utc(
      Number(bareDate[3]),
      MONTHS[bareDate[1].toLowerCase()],
      Number(bareDate[2]),
    );
    return { kind: "instant", start: instant, end: instant, label: bareDate[0].trim(), fiscalUnanchored: false };
  }

  /* ── a bare calendar year ──────────────────────────────────────────────── */
  const bareYear = text.match(new RegExp(`^\\s*${YEAR}\\s*$`));
  if (bareYear) {
    const year = Number(bareYear[1]);
    return {
      kind: "calendar_year",
      start: utc(year, 0, 1),
      end: endOfMonth(year, 11),
      label: bareYear[0].trim(),
      fiscalUnanchored: false,
    };
  }

  return unknown(text);
}

/** "24" → 2024, "2024" → 2024. Two-digit years pivot on the century in play. */
function normalizeYear(raw: string, near?: number): number {
  const n = Number(raw);
  if (raw.length === 4) return n;
  if (near !== undefined) {
    // "2023-24": the tail belongs to the same century as the head.
    const century = Math.floor(near / 100) * 100;
    const candidate = century + n;
    return candidate >= near ? candidate : candidate + 100;
  }
  return n >= 70 ? 1900 + n : 2000 + n;
}

/* ── header fragments ────────────────────────────────────────── */

/** Words that only ever help state *when*, never *what*. */
const TEMPORAL_WORDS = new Set([
  "year", "years", "yr", "month", "months", "quarter", "quarters", "half",
  "period", "periods", "ended", "ending", "ends", "end", "fy", "fiscal",
  "financial", "calendar", "annual", "annualised", "annualized", "ytd",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "first", "second", "third", "fourth", "q1", "q2",
  "q3", "q4",
]);

/**
 * Does this header fragment belong to the period expression?
 *
 * A stacked column header arrives as separate lines — "For the nine", "months
 * period", "ended", "December 31,", "2021" — and only the whole stack parses as
 * a period. The leftover lines must not become qualifiers: a fragment reading
 * "For the nine" would enter the scope signature, and two columns describing
 * the same scope would then key differently and never corroborate.
 *
 * A fragment is temporal when it contributes no content word of its own beyond
 * time vocabulary, month names and numbers. "Consolidated" and "Restated"
 * survive, which is right — those are real qualifiers that explain differences.
 */
export function looksTemporal(segment: string): boolean {
  const words = contentWords(segment);
  // Only function words ("For the"): carries nothing, so it qualifies nothing.
  if (words.length === 0) return true;
  return words.every(
    (word) =>
      TEMPORAL_WORDS.has(word) ||
      Object.prototype.hasOwnProperty.call(MONTHS, word) ||
      /^\d+$/.test(word),
  );
}

/* ── comparison ───────────────────────────────────────────────────────────── */

export type PeriodOverlap =
  /** Same window, within a few days of slack at each end. */
  | "identical"
  /** One window sits wholly inside the other: nine months inside a year. */
  | "contained"
  | "partial"
  | "disjoint"
  /** At least one side has no interval; nothing can be concluded. */
  | "unknown";

/** Calendar ends wobble by a day or two between documents; this absorbs that. */
const BOUNDARY_SLACK_MS = 3 * 24 * 60 * 60 * 1000;

export function comparePeriods(a: ParsedPeriod, b: ParsedPeriod): PeriodOverlap {
  if (!a.start || !a.end || !b.start || !b.end) return "unknown";

  const aStart = a.start.getTime();
  const aEnd = a.end.getTime();
  const bStart = b.start.getTime();
  const bEnd = b.end.getTime();

  if (
    Math.abs(aStart - bStart) <= BOUNDARY_SLACK_MS &&
    Math.abs(aEnd - bEnd) <= BOUNDARY_SLACK_MS
  ) {
    return "identical";
  }

  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  if (overlap <= 0) return "disjoint";

  const aInB = aStart >= bStart - BOUNDARY_SLACK_MS && aEnd <= bEnd + BOUNDARY_SLACK_MS;
  const bInA = bStart >= aStart - BOUNDARY_SLACK_MS && bEnd <= aEnd + BOUNDARY_SLACK_MS;
  if (aInB || bInA) return "contained";

  return "partial";
}

/** Length in days; used to describe *how* two windows differ, not whether. */
export function periodLengthDays(period: ParsedPeriod): number | null {
  if (!period.start || !period.end) return null;
  return Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000);
}
