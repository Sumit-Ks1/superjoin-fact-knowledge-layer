/**
 * Finding the pairs worth judging.
 *
 * Comparing every fact with every other fact is quadratic and mostly noise: a
 * corpus of 5,000 facts is 12.5 million pairs, almost none of which are about
 * the same thing. Candidates come from four channels instead, each answering a
 * different question:
 *
 *   claim_key    Same subject, measure, period and scope. These *must* agree,
 *                so any disagreement here is the strongest possible signal.
 *   relaxed_key  Same subject and measure, different period or scope. This is
 *                where reconciliation lives — the pairs that look like
 *                contradictions until the qualifier is read.
 *   similarity   Same meaning, different words. Vector neighbours catch
 *                "revenue from contract with customers" against "operating
 *                revenue", which no key would ever match.
 *   arithmetic   Components against the total they sum to. This channel checks
 *                the extraction against itself.
 *
 * The first two are exact and free. The third needs embeddings and is skipped
 * cleanly when none are configured. The fourth needs no model at all.
 */

import { relativeDifference } from "../normalize/value";
import { canonicalize } from "../normalize/text";
import type { LinkableFact } from "./adjudicate";

export type CandidateChannel = "claim_key" | "relaxed_key" | "similarity" | "arithmetic";

export type CandidatePair = {
  a: LinkableFact;
  b: LinkableFact;
  channel: CandidateChannel;
  /** Cosine similarity, for the similarity channel only. */
  score?: number;
};

/**
 * Pairs generated from one key group.
 *
 * A statement repeated on twenty pages would generate 190 pairs that all say
 * the same thing. Groups are capped, and the cap keeps the *most informative*
 * members — highest confidence, and spread across documents — because a pair
 * drawn from two different documents is worth more than a pair from one.
 */
const MAX_GROUP_MEMBERS = 12;

function capGroup(facts: LinkableFact[]): LinkableFact[] {
  if (facts.length <= MAX_GROUP_MEMBERS) return facts;

  // Round-robin across documents so no single document fills the cap.
  const byDocument = new Map<string, LinkableFact[]>();
  for (const fact of facts) {
    const bucket = byDocument.get(fact.documentId) ?? [];
    bucket.push(fact);
    byDocument.set(fact.documentId, bucket);
  }
  for (const bucket of byDocument.values()) {
    bucket.sort((x, y) => y.confidence - x.confidence);
  }

  const kept: LinkableFact[] = [];
  const queues = [...byDocument.values()];
  let index = 0;
  while (kept.length < MAX_GROUP_MEMBERS && queues.some((q) => q.length > 0)) {
    const queue = queues[index % queues.length];
    const next = queue.shift();
    if (next) kept.push(next);
    index += 1;
  }
  return kept;
}

function pairsWithin(facts: LinkableFact[], channel: CandidateChannel): CandidatePair[] {
  const members = capGroup(facts);
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let k = i + 1; k < members.length; k++) {
      pairs.push({ a: members[i], b: members[k], channel });
    }
  }
  return pairs;
}

function groupBy(facts: LinkableFact[], key: (f: LinkableFact) => string): Map<string, LinkableFact[]> {
  const groups = new Map<string, LinkableFact[]>();
  for (const fact of facts) {
    const k = key(fact);
    if (k === "") continue;
    const bucket = groups.get(k) ?? [];
    bucket.push(fact);
    groups.set(k, bucket);
  }
  return groups;
}

/** Stable, order-independent identity for a pair, so duplicates collapse. */
export function pairKey(a: { id: string }, b: { id: string }): string {
  return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
}

/**
 * Exact-key candidates.
 *
 * `claim_key` pairs are emitted first so that when the same pair also appears
 * under `relaxed_key` it keeps the stronger channel.
 */
export function keyCandidates(facts: LinkableFact[]): CandidatePair[] {
  const seen = new Set<string>();
  const out: CandidatePair[] = [];

  const add = (pairs: CandidatePair[]) => {
    for (const pair of pairs) {
      const key = pairKey(pair.a, pair.b);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pair);
    }
  };

  for (const group of groupBy(facts, (f) => f.claimKey).values()) {
    if (group.length > 1) add(pairsWithin(group, "claim_key"));
  }

  for (const group of groupBy(facts, (f) => f.relaxedKey).values()) {
    if (group.length > 1) add(pairsWithin(group, "relaxed_key"));
  }

  return out;
}

/* ── arithmetic ───────────────────────────────────────────────────────────── */

export type ArithmeticStatus =
  /** The components add up to the printed total. */
  | "consistent"
  /** They do not, and the shortfall is small enough to be a real discrepancy. */
  | "inconsistent"
  /**
   * The sum is nowhere near the total. Almost always means the rows above the
   * total are not its components — a nested sub-table, a continued grid, a
   * label that reads like a total but is not one. Reported as a parsing
   * diagnostic, never as an error in the source document.
   */
  | "components_unclear";

export type ArithmeticFinding = {
  total: LinkableFact;
  components: LinkableFact[];
  sum: number;
  /** Difference between the stated total and the sum of its components. */
  residual: number;
  status: ArithmeticStatus;
  consistent: boolean;
};

/**
 * A label that names a sum of the rows around it.
 *
 * English, not accounting: "total", "aggregate" and "sum" describe an addition
 * in any domain. Deliberately narrow — a false positive here reports a document
 * as internally inconsistent, which is a serious claim to make wrongly.
 */
const TOTAL_LABEL = /\b(?:total|aggregate|sum|grand total|all\s+\w+\s+combined)\b/i;

export function looksLikeTotal(predicate: string): boolean {
  return TOTAL_LABEL.test(predicate);
}

/**
 * Checks whether a stated total equals the sum of the figures listed under it.
 *
 * This channel audits the pipeline against itself. When a table's components
 * sum to its printed total, every cell in that column was read correctly — the
 * column model, the sign handling and the unit are all confirmed at once. When
 * they do not, either the extraction is wrong or the document is, and both are
 * worth surfacing rather than hiding.
 *
 * Facts must already share subject, period, scope and unit; the caller groups
 * them, because that grouping is what makes the sum meaningful.
 */
export function checkAdditive(facts: LinkableFact[]): ArithmeticFinding | null {
  const usable = facts.filter((f) => f.valueBase !== null && !f.quarantined);
  if (usable.length < 3) return null;

  const totals = usable.filter((f) => looksLikeTotal(f.predicateText));
  const components = usable.filter((f) => !looksLikeTotal(f.predicateText));
  if (totals.length !== 1 || components.length < 2) return null;

  const total = totals[0];

  /*
   * The components must be every row between the first of them and the total,
   * with no gaps.
   *
   * This is the safeguard that keeps the channel honest. Rows drop out of the
   * group whenever a cell is blank, carries a sentinel, or has no resolvable
   * unit — and a sum over what is left is not the sum the document printed.
   * Reporting that as "the document does not add up" accuses the source of an
   * error that is actually a hole in the extraction. If any row is missing, the
   * check declines to run rather than guessing.
   */
  const totalRow = total.rowIndex;
  if (totalRow === undefined) return null;
  const positioned = components.filter(
    (c): c is LinkableFact & { rowIndex: number } => c.rowIndex !== undefined,
  );
  if (positioned.length !== components.length) return null;

  const above = positioned.filter((c) => c.rowIndex < totalRow);
  if (above.length < 2) return null;

  const rows = above.map((c) => c.rowIndex).sort((x, y) => x - y);
  const span = rows[rows.length - 1] - rows[0] + 1;
  if (span !== rows.length) return null; // a row was dropped; sum is incomplete
  if (rows[rows.length - 1] !== totalRow - 1) return null; // not contiguous with the total

  // Components must be distinct measures; the same row read twice would
  // double-count and manufacture a discrepancy.
  const distinct = new Map<string, LinkableFact>();
  for (const component of above) {
    const key = canonicalize(component.predicateText);
    if (!distinct.has(key)) distinct.set(key, component);
  }
  const unique = [...distinct.values()];
  if (unique.length !== above.length) return null; // duplicate labels: ambiguous
  if (unique.length < 2) return null;

  const sum = unique.reduce((acc, f) => acc + (f.valueBase ?? 0), 0);
  const residual = (total.valueBase ?? 0) - sum;

  // Tolerance follows the figures themselves: a column printed to two decimals
  // in millions accumulates rounding across every row it sums.
  const tolerance = Math.max(
    Math.abs(total.valueBase ?? 0) * 1e-6,
    unique.length * (total.unit?.factor ?? 1) * 0.005,
  );

  const consistent = Math.abs(residual) <= tolerance;

  /*
   * Before calling a document wrong, ask whether the components were even
   * found. A sum that is 1% of the printed total is not a bookkeeping error;
   * it is proof that the rows above the total are not what it adds up. The
   * pipeline is far likelier to be wrong here than the filing is.
   */
  const stated = Math.abs(total.valueBase ?? 0);
  const ratio = stated === 0 ? 1 : Math.abs(sum) / stated;
  const status: ArithmeticStatus = consistent
    ? "consistent"
    : ratio < 0.5 || ratio > 2
      ? "components_unclear"
      : "inconsistent";

  return { total, components: unique, sum, residual, status, consistent };
}

/**
 * Groups facts into sets that are legitimately addable, then checks each.
 *
 * The grouping is the whole safety mechanism: figures may only be summed when
 * they share a subject, a period, a unit and a section, because those are
 * exactly the conditions under which a printed total is a sum of them.
 */
export function arithmeticFindings(facts: LinkableFact[]): ArithmeticFinding[] {
  const groups = groupBy(facts, (f) => {
    if (f.valueBase === null || !f.unit) return "";
    const period = f.period.start && f.period.end
      ? `${f.period.start.toISOString().slice(0, 10)}..${f.period.end.toISOString().slice(0, 10)}`
      : canonicalize(f.period.label);
    if (period === "") return "";
    const section = f.qualifiers.section ?? "";
    /*
     * `sourceKey` confines a sum to the grid it was read from. Without it, rows
     * from two unrelated tables that happen to share a period and a currency
     * are added together, and the document is reported as failing to add up
     * when the real fault is the grouping.
     */
    if (!f.sourceKey) return "";
    return [
      f.documentId,
      f.sourceKey,
      canonicalize(f.subjectText),
      period,
      f.unit.baseUnit,
      section,
      // One column only. Period usually separates columns already, but two
      // columns can share a period and differ by basis — consolidated
      // against standalone — and those must never be summed together.
      String(f.colIndex ?? ""),
    ].join("\u0000");
  });

  const findings: ArithmeticFinding[] = [];
  for (const group of groups.values()) {
    const finding = checkAdditive(group);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** Turns a confirmed sum into the relations it justifies. */
export function derivedPairs(finding: ArithmeticFinding): CandidatePair[] {
  return finding.components.map((component) => ({
    a: finding.total,
    b: component,
    channel: "arithmetic" as const,
  }));
}

/* ── similarity ───────────────────────────────────────────────────────────── */

/**
 * Cosine floor for the similarity channel.
 *
 * Set high on purpose. Below this, neighbours are merely topical — two figures
 * about revenue rather than two statements of the same measure — and every one
 * of them costs an adjudication.
 */
export const SIMILARITY_FLOOR = 0.86;

/**
 * Filters vector neighbours down to pairs worth judging.
 *
 * Excludes pairs an exact key already found, and pairs from the same document
 * and same table, which are adjacent cells rather than independent statements.
 */
export function similarityCandidates(
  neighbours: { a: LinkableFact; b: LinkableFact; score: number }[],
  alreadyPaired: Set<string>,
): CandidatePair[] {
  const out: CandidatePair[] = [];
  const seen = new Set(alreadyPaired);

  for (const { a, b, score } of neighbours) {
    if (score < SIMILARITY_FLOOR) continue;
    const key = pairKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, channel: "similarity", score });
  }

  return out;
}

/**
 * How far apart two facts are as a fraction, for ranking what to show first.
 * Larger disagreements between higher-confidence facts matter most.
 */
export function pairSalience(pair: CandidatePair): number {
  const { a, b } = pair;
  if (a.valueBase === null || b.valueBase === null) return 0;
  const gap = relativeDifference(a.valueBase, b.valueBase);
  const crossDocument = a.documentId !== b.documentId ? 1.5 : 1;
  return gap * Math.min(a.confidence, b.confidence) * crossDocument;
}
