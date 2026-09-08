/**
 * Deciding what a pair of facts means.
 *
 * This is the judgement the whole system exists to make. Two figures that
 * disagree are not automatically a contradiction — most of the time they are
 * two different measurements that a reader would reconcile without thinking:
 * a nine-month period against a full year, consolidated against standalone,
 * restated against originally reported, crore against million.
 *
 * The order of the checks below is the argument. Reconciliation is attempted
 * *before* contradiction, always, because a false contradiction is the most
 * expensive error this system can make: it discredits every true finding shown
 * beside it. A missed contradiction costs one finding; a false one costs the
 * reader's trust in all of them.
 *
 * Everything here is deterministic and explains itself in words a reader can
 * check against the evidence. The model is called only for pairs these rules
 * cannot separate, and never to produce a number.
 */

import type { RelationType, UnitInfo } from "@/db/schema";

import { comparePeriods, periodLengthDays, type ParsedPeriod } from "../normalize/period";
import { lexicalOverlap, predicateStem } from "../normalize/text";
import { comparableUnits, decimalPlaces, relativeDifference } from "../normalize/value";

/**
 * The shape adjudication needs. Structural rather than tied to the table row,
 * so drafts, database rows and test fixtures all satisfy it.
 */
export type LinkableFact = {
  id: string;
  documentId: string;
  /**
   * The grid or passage this fact was read from.
   *
   * Only meaningful for the arithmetic channel, which may sum figures within
   * one table and never across two: "Total borrowings" on page 40 is not the
   * sum of unrelated rows that happen to share a period and a currency.
   */
  sourceKey?: string;
  /** Position within that grid; the arithmetic channel requires contiguity. */
  rowIndex?: number;
  colIndex?: number;
  /**
   * What the surrounding table or section is about — its caption and heading
   * breadcrumb. Row labels like "Outstanding at the end of the year" mean
   * nothing on their own; this is what tells two of them apart.
   */
  contextLabel?: string;
  subjectText: string;
  predicateText: string;
  valueRaw: string | null;
  valueNum: number | null;
  valueBase: number | null;
  modifier: string;
  unit: UnitInfo | null;
  qualifiers: Record<string, string>;
  period: ParsedPeriod;
  claimKey: string;
  relaxedKey: string;
  confidence: number;
  quarantined: boolean;
};

export type Verdict = {
  type: RelationType;
  /** Which dimension explains the difference: "period", "scope", "unit", … */
  subtype: string | null;
  confidence: number;
  explanation: string;
  arithmetic?: Record<string, unknown>;
  /** True when the rules could not separate the pair and a model should look. */
  needsAdjudication: boolean;
};

/* ── numeric agreement ────────────────────────────────────────────────────── */

/**
 * The precision a printed figure actually claims, as an absolute quantity.
 *
 * "₹4,811 crore" claims precision to the nearest crore; "48,105.30 million"
 * claims precision to the nearest ten thousand rupees. Comparing them with a
 * fixed percentage tolerance is wrong in both directions — too tight and every
 * rounded restatement becomes a contradiction, too loose and a real 1%
 * discrepancy is waved through. Comparing at the coarser of the two stated
 * precisions is what a careful reader does.
 */
export function printedPrecision(raw: string | null, unit: UnitInfo | null): number | null {
  if (!raw) return null;
  if (!/\d/.test(raw)) return null;

  // Decimal places drive the unit in the last place; with none, the figure
  // claims precision only to the unit itself. The separator must be identified
  // the same way the parser does it — "4,811" has no decimals, and reading its
  // grouping comma as a decimal point understates its precision 1000-fold.
  const ulp = Math.pow(10, -decimalPlaces(raw));

  return unit ? ulp * unit.factor : ulp;
}

export type Agreement = "equal" | "rounding" | "different";

/**
 * Do two base values agree?
 *
 * `equal` is exact-to-precision. `rounding` covers figures that agree to within
 * a hair of the coarser precision — the residue of unit conversion between
 * documents — and is reported as corroboration with slightly lower confidence
 * rather than as a contradiction.
 */
export function compareValues(a: LinkableFact, b: LinkableFact): Agreement {
  if (a.valueBase === null || b.valueBase === null) return "different";

  const precisionA = printedPrecision(a.valueRaw, a.unit);
  const precisionB = printedPrecision(b.valueRaw, b.unit);
  const coarser = Math.max(precisionA ?? 0, precisionB ?? 0);

  const gap = Math.abs(a.valueBase - b.valueBase);
  // Half the coarser ULP is the most two correctly-rounded figures can differ.
  if (gap <= coarser / 2) return "equal";
  if (gap <= coarser) return "rounding";

  // Very large magnitudes carry float error from the scale multiplication.
  if (relativeDifference(a.valueBase, b.valueBase) < 1e-9) return "equal";

  return "different";
}

/* ── qualifier differences ────────────────────────────────────────────────── */

/** Qualifier keys present on one side and different on the other. */
function differingQualifiers(
  a: Record<string, string>,
  b: Record<string, string>,
): { key: string; left: string; right: string }[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const differences: { key: string; left: string; right: string }[] = [];
  for (const key of keys) {
    const left = a[key] ?? "";
    const right = b[key] ?? "";
    if (left.toLowerCase() !== right.toLowerCase()) {
      differences.push({ key, left, right });
    }
  }
  return differences;
}

/**
 * Wording that marks one statement of a figure as superseding another.
 *
 * Kept to words that describe the *status* of a figure rather than its content,
 * so this stays a general rule about how documents revise themselves rather
 * than a rule about financial reporting.
 */
const SUPERSEDING = [
  { re: /\brestated\b/i, term: "restated" },
  { re: /\baudited\b/i, term: "audited" },
  { re: /\bfinal\b/i, term: "final" },
  { re: /\brevised\b/i, term: "revised" },
  { re: /\bactual\b/i, term: "actual" },
];
const SUPERSEDED = [
  { re: /\bunaudited\b/i, term: "unaudited" },
  { re: /\bprovisional\b/i, term: "provisional" },
  { re: /\bpreliminary\b/i, term: "preliminary" },
  { re: /\bestimated?\b/i, term: "estimate" },
  { re: /\bprojected\b/i, term: "projection" },
  { re: /\bas (?:originally )?reported\b/i, term: "as reported" },
];

function statusOf(fact: LinkableFact): { superseding: string | null; superseded: string | null } {
  const haystack = `${fact.predicateText} ${Object.values(fact.qualifiers).join(" ")}`;
  return {
    superseding: SUPERSEDING.find((s) => s.re.test(haystack))?.term ?? null,
    superseded: SUPERSEDED.find((s) => s.re.test(haystack))?.term ?? null,
  };
}

/* ── formatting helpers ───────────────────────────────────────────────────── */

function describe(fact: LinkableFact): string {
  const value = fact.valueRaw ?? "—";
  const unit = fact.unit?.raw ?? fact.unit?.baseUnit ?? "";
  const period = fact.period.label || "no stated period";
  return `${value}${unit ? ` ${unit}` : ""} (${period})`;
}

function periodPhrase(fact: LinkableFact): string {
  const days = periodLengthDays(fact.period);
  if (days === null) return fact.period.label || "an unstated period";
  const months = Math.round(days / 30.44);
  return `${fact.period.label || "an unlabelled period"} (${months} month${months === 1 ? "" : "s"})`;
}

/* ── the decision ─────────────────────────────────────────────────────────── */

/** Below this, two predicates are too different to be the same measure. */
const PREDICATE_OVERLAP_FLOOR = 0.34;
/** Below this, two tables in one document are not discussing the same subject. */
const CONTEXT_OVERLAP_FLOOR = 0.2;

/**
 * Classifies one pair of facts.
 *
 * Returns `needsAdjudication` when the rules genuinely cannot decide — that is
 * the only path that reaches a language model, and the model is asked to choose
 * among these same labels, never to compute anything.
 */
export function adjudicate(a: LinkableFact, b: LinkableFact): Verdict {
  const sameDocument = a.documentId === b.documentId;

  /* 1. Do they even talk about the same thing? ---------------------------- */
  const samePredicate = predicateStem(a.predicateText) === predicateStem(b.predicateText);
  const predicateOverlap = lexicalOverlap(a.predicateText, b.predicateText);
  const subjectOverlap = lexicalOverlap(a.subjectText, b.subjectText);

  if (!samePredicate && predicateOverlap < PREDICATE_OVERLAP_FLOOR) {
    return {
      type: "INSUFFICIENT_EVIDENCE",
      subtype: "predicate",
      confidence: 0.3,
      explanation: `"${a.predicateText}" and "${b.predicateText}" do not describe the same measure closely enough to compare.`,
      needsAdjudication: predicateOverlap > 0.15,
    };
  }

  /* 2. Are they on the same measuring stick? ------------------------------ */
  if (!comparableUnits(a.unit, b.unit)) {
    // Different currencies are not a contradiction; without a dated exchange
    // rate the comparison cannot be made at all.
    if (a.unit?.kind === "currency" && b.unit?.kind === "currency") {
      return {
        type: "RECONCILED_BY_UNIT",
        subtype: "currency",
        confidence: 0.8,
        explanation: `Stated in different currencies (${a.unit.currency} and ${b.unit.currency}). Comparing them would require an exchange rate for a specific date, which neither document supplies.`,
        needsAdjudication: false,
      };
    }
    return {
      type: "INSUFFICIENT_EVIDENCE",
      subtype: "unit",
      confidence: 0.4,
      explanation:
        a.unit && b.unit
          ? `Measured in different units (${a.unit.baseUnit} and ${b.unit.baseUnit}); they are not comparable quantities.`
          : "At least one figure carries no resolvable unit or scale, so the two cannot be compared numerically.",
      needsAdjudication: false,
    };
  }

  /* 3. Do they cover the same window? ------------------------------------- */
  const overlap = comparePeriods(a.period, b.period);
  const agreement = compareValues(a, b);

  if (overlap === "contained" || overlap === "partial" || overlap === "disjoint") {
    // Same measure, different windows. Equal values across different windows
    // are a coincidence, not corroboration.
    const shorter = (periodLengthDays(a.period) ?? 0) <= (periodLengthDays(b.period) ?? 0) ? a : b;
    const longer = shorter === a ? b : a;

    const relation =
      overlap === "disjoint"
        ? `cover separate windows`
        : overlap === "contained"
          ? `${periodPhrase(shorter)} falls inside ${periodPhrase(longer)}`
          : `overlap only partially`;

    return {
      type: "RECONCILED_BY_TIME",
      subtype: "period",
      confidence: 0.9,
      explanation: `Both report "${a.predicateText}", but over different periods: ${describe(a)} and ${describe(b)}. They ${relation}, so the figures are not expected to match.`,
      needsAdjudication: false,
    };
  }

  if (overlap === "unknown") {
    // One side has no anchored interval. If the labels match verbatim the pair
    // is still usable; otherwise nothing can be concluded about time.
    const sameLabel =
      a.period.label.trim().toLowerCase() === b.period.label.trim().toLowerCase() &&
      a.period.label.trim() !== "";
    if (!sameLabel) {
      return {
        type: "INSUFFICIENT_EVIDENCE",
        subtype: "period",
        confidence: 0.35,
        explanation: `The periods could not be resolved to comparable dates (${a.period.label || "unstated"} vs ${b.period.label || "unstated"}), so a difference in value cannot be interpreted.`,
        needsAdjudication: true,
      };
    }
  }

  /* 4. Same measure, same window. Does the scope differ? ------------------ */
  const scopeDifferences = differingQualifiers(a.qualifiers, b.qualifiers);

  if (agreement !== "different" && scopeDifferences.length === 0) {
    const restatement = !samePredicate || a.unit?.scale !== b.unit?.scale;
    return {
      type: restatement ? "EQUIVALENT_RESTATEMENT" : "CORROBORATES",
      subtype: restatement ? "wording" : null,
      confidence: agreement === "equal" ? (sameDocument ? 0.85 : 0.95) : 0.8,
      explanation: restatement
        ? `Same quantity expressed differently: ${describe(a)} and ${describe(b)} reduce to the same value${agreement === "rounding" ? " once rounding is allowed for" : ""}.`
        : `Both state ${describe(a)} for "${a.predicateText}"${sameDocument ? " within the same document" : " across two documents"}${agreement === "rounding" ? ", agreeing to the precision each is printed at" : ""}.`,
      needsAdjudication: false,
    };
  }

  if (agreement === "different" && scopeDifferences.length > 0) {
    const difference = scopeDifferences[0];
    return {
      type: "RECONCILED_BY_SCOPE",
      subtype: difference.key,
      confidence: 0.8,
      explanation: `The figures differ (${describe(a)} vs ${describe(b)}) but so does their scope: "${difference.key}" is "${difference.left || "unset"}" in one and "${difference.right || "unset"}" in the other. They measure different things.`,
      needsAdjudication: false,
    };
  }

  if (agreement !== "different" && scopeDifferences.length > 0) {
    // Equal values under different scopes: worth surfacing, but as agreement.
    return {
      type: "CORROBORATES",
      subtype: "cross_scope",
      confidence: 0.6,
      explanation: `Both report ${describe(a)}, though their stated scope differs ("${scopeDifferences[0].key}"). The figures agree regardless.`,
      needsAdjudication: false,
    };
  }

  /* 5. Same measure, same window, same scope, different value ------------- */
  const statusA = statusOf(a);
  const statusB = statusOf(b);

  if (statusA.superseding && statusB.superseded) {
    return {
      type: "SUPERSEDES",
      subtype: statusA.superseding,
      confidence: 0.75,
      explanation: `${describe(a)} is described as ${statusA.superseding} and ${describe(b)} as ${statusB.superseded}; the ${statusA.superseding} figure supersedes the other rather than contradicting it.`,
      needsAdjudication: false,
    };
  }
  if (statusB.superseding && statusA.superseded) {
    return {
      type: "SUPERSEDES",
      subtype: statusB.superseding,
      confidence: 0.75,
      explanation: `${describe(b)} is described as ${statusB.superseding} and ${describe(a)} as ${statusA.superseded}; the ${statusB.superseding} figure supersedes the other rather than contradicting it.`,
      needsAdjudication: false,
    };
  }

  /*
   * Before calling it a disagreement: are these two tables even about the same
   * thing?
   *
   * Many row labels are positional rather than descriptive — "Total",
   * "Outstanding at the end of the year", "At the beginning of the year". They
   * identify a row's place in its own table and nothing beyond it. Two such
   * rows in different tables of one document are almost never the same measure,
   * and reporting them as a contradiction says the filing disagrees with itself
   * when the truth is that a share count was compared with an exercise price.
   *
   * Across documents this check is skipped: two filings describing the same
   * measure under different headings is exactly what the system is looking for.
   */
  /*
   * One table never contradicts itself, pairwise.
   *
   * A grid's whole purpose is that each cell measures something different from
   * every other. Down a column the rows are different measures; across a row
   * the columns are different periods, bases or quantities entirely. So two
   * cells of one grid disagreeing is never evidence that the document is wrong
   * — it is evidence that they were paired in the first place.
   *
   * Two real cases from the Delhivery filings, both of which this stops: a
   * balance sheet listing "Financial assets (i) Investments" under both
   * non-current and current assets, separated by a heading that arrives broken
   * because its column is narrow enough to wrap mid-word; and a stock-option
   * note whose columns hold option counts beside exercise prices, so
   * "Outstanding at the end of the year" reads as 13.76 against 0.10.
   *
   * This sits here, below every reconciliation route, rather than at the top:
   * two columns of one table reporting FY2024 and FY2023 are a genuine and
   * useful RECONCILED_BY_TIME, and must still be reported as one. A table is
   * also still audited internally — by the arithmetic channel, which checks
   * printed totals against the rows they sum. That is a sound internal check;
   * pairwise comparison is not.
   */
  if (a.sourceKey !== undefined && a.sourceKey === b.sourceKey) {
    return {
      type: "INSUFFICIENT_EVIDENCE",
      subtype: "same_table",
      confidence: 0.3,
      explanation: `Both figures come from the same table, in different ${
        a.colIndex === b.colIndex ? "rows" : "cells"
      }. Every cell of a grid measures something different by construction, so the two are not competing statements of one fact. This table's internal consistency is checked by summing its printed totals instead.`,
      needsAdjudication: false,
    };
  }

  if (sameDocument && a.sourceKey !== b.sourceKey) {
    const contextOverlap = lexicalOverlap(a.contextLabel ?? "", b.contextLabel ?? "");
    if (contextOverlap < CONTEXT_OVERLAP_FLOOR) {
      return {
        type: "INSUFFICIENT_EVIDENCE",
        subtype: "unrelated_tables",
        confidence: 0.3,
        explanation: `Both rows are labelled "${a.predicateText}", but they come from different tables in the same document that are not about the same subject${a.contextLabel && b.contextLabel ? ` ("${a.contextLabel.slice(0, 60)}" and "${b.contextLabel.slice(0, 60)}")` : ""}. The label describes a row's position in its own table, not a measure that can be compared across them.`,
        needsAdjudication: false,
      };
    }
  }

  // Nothing explains the difference. This is a genuine disagreement.
  const gap =
    a.valueBase !== null && b.valueBase !== null
      ? relativeDifference(a.valueBase, b.valueBase)
      : null;

  // Quarantined facts never assert a contradiction on their own authority.
  if (a.quarantined || b.quarantined) {
    return {
      type: "INSUFFICIENT_EVIDENCE",
      subtype: "quarantined",
      confidence: 0.3,
      explanation: `The figures differ (${describe(a)} vs ${describe(b)}), but at least one comes from a region whose layout could not be read confidently, so the difference may be an extraction error rather than a disagreement.`,
      needsAdjudication: false,
    };
  }

  return {
    type: "CONTRADICTS",
    subtype: null,
    confidence: Math.min(0.9, 0.55 + Math.min(a.confidence, b.confidence) * 0.35),
    explanation:
      `Same measure ("${a.predicateText}"), same period (${a.period.label || "unstated"}), same stated scope, ` +
      `but the values differ: ${describe(a)} against ${describe(b)}` +
      (gap !== null ? ` — a difference of ${(gap * 100).toFixed(1)}%` : "") +
      `${sameDocument ? ", within the same document" : ", across two documents"}.`,
    needsAdjudication: subjectOverlap < 0.5 && a.subjectText !== b.subjectText,
  };
}
