/**
 * Tables → facts, deterministically.
 *
 * No number in this system is ever produced by a language model. A model that
 * transcribes 49,114.06 as 49,141.06 has invented a contradiction that looks
 * exactly like a real one, and no amount of downstream adjudication can tell
 * the difference. Every quantitative fact from a grid is read straight out of
 * the reconstructed cell, and its evidence is that cell's own rectangle.
 *
 * The grid is read as a sentence:
 *
 *     subject      ← the first row-label column, or the document's own subject
 *     predicate    ← the remaining row-label columns
 *     period       ← the column header path
 *     qualifiers   ← whatever in the header path is not a period, plus the
 *                    section the row sits under ("Income", "Expenses")
 *     unit         ← the caption's scale, which is never printed in the cell
 *
 * A table with one label column is describing the document's subject: "Total
 * income" is a property of the issuer. A table with two or more is describing
 * whatever its first column names — a shareholder, a state, a segment — so the
 * subject moves into the row.
 */

import type { BBox, FactKind, PeriodKind, UnitInfo, ValueModifier } from "@/db/schema";
import { stableHash } from "@/lib/hash";
import type { ParsedTable } from "@/pdf/parse";

import {
  looksTemporal,
  parsePeriod,
  type FiscalCalendar,
  type ParsedPeriod,
} from "../normalize/period";
import { canonicalize, tidy } from "../normalize/text";
import { normalizeValue } from "../normalize/value";

/** A fact before it has a database identity. */
export type FactDraft = {
  kind: FactKind;
  subjectText: string;
  predicateText: string;
  objectText: string | null;

  valueRaw: string | null;
  valueNum: number | null;
  valueBase: number | null;
  valueMin: number | null;
  valueMax: number | null;
  modifier: ValueModifier;
  unit: UnitInfo | null;

  qualifiers: Record<string, string>;
  periodKind: PeriodKind;
  periodStart: Date | null;
  periodEnd: Date | null;
  periodLabel: string | null;

  scopeSignature: string;
  claimKey: string;
  relaxedKey: string;

  confidence: number;
  extractionMethod: "table_deterministic" | "narrative_llm";
  quoteVerified: boolean;
  quarantined: boolean;

  /** Page, rectangle and verbatim quote. A fact without this is not a fact. */
  evidence: { pageNo: number; bboxes: BBox[]; quote: string };

  /** Identifies the grid this fact came from; scopes the arithmetic check. */
  sourceKey: string;
  /** Row within that grid. Lets the arithmetic check demand contiguity. */
  rowIndex: number;
  /** Column within that grid, so a sum stays inside one period's column. */
  colIndex: number;
  /** Caption and breadcrumb: what this grid is about. */
  contextLabel: string;

  /** Diagnostics surfaced on the Quality screen. */
  notes: string[];
};

export type TableExtractionResult = {
  facts: FactDraft[];
  issues: { kind: "chart_region_unreadable" | "unit_unresolved" | "period_unresolved"; detail: string; pageNo: number }[];
};

export type TableExtractionContext = {
  /** The document's own subject, learned upstream. Never hardcoded. */
  documentSubject: string;
  /** Fiscal year end learned from the document, or null if it never said. */
  fiscalCalendar: FiscalCalendar;
  /** Heading breadcrumb above the table. */
  breadcrumb: string;
  /** Below this layout confidence, facts are kept but quarantined. */
  quarantineBelow?: number;
};

const DEFAULT_QUARANTINE_BELOW = 0.5;
/** Indent difference, in points, below which two headings are the same level. */
const INDENT_SLACK = 1.5;

/**
 * Splits a column header path into the part that states a period and the part
 * that qualifies the measure some other way.
 *
 * A header stack routinely mixes the two: "Consolidated" over "For the year
 * ended March 31" over "2021". The period pieces make the interval; everything
 * else becomes a qualifier, because "consolidated" versus "standalone" is
 * exactly the kind of difference that explains an apparent contradiction.
 */
function splitHeaderPath(
  path: string[],
  calendar: FiscalCalendar,
): { period: ParsedPeriod | null; residual: string[] } {
  if (path.length === 0) return { period: null, residual: [] };

  // Try the whole path first: "For the nine months period ended December 31,
  // 2021" is only parseable when its rows are joined back together.
  const joined = path.join(" ");
  const whole = parsePeriod(joined, calendar);
  if (whole.kind !== "unknown") {
    // Keep only the fragments that say something other than when.
    const residual = path.filter((segment) => !looksTemporal(segment));
    return { period: whole, residual };
  }

  // Otherwise scan segment by segment, deepest first: the innermost header is
  // the most specific ("2021" under "December 31,").
  for (let i = path.length - 1; i >= 0; i--) {
    const candidate = parsePeriod(path[i], calendar);
    if (candidate.kind !== "unknown") {
      return {
        period: candidate,
        residual: path.filter((segment, k) => k !== i && !looksTemporal(segment)),
      };
    }
  }

  return { period: null, residual: path.filter((segment) => !looksTemporal(segment)) };
}

/**
 * Is `next` the tail of a heading that `open` began?
 *
 * Two signals, strongest first. An unclosed bracket means the heading is
 * plainly unfinished. Failing that, a fragment starting with a connective or
 * lowercase word cannot be a heading in its own right.
 */
function continuesHeading(open: string, next: string): boolean {
  const unclosed =
    (open.match(/\(/g)?.length ?? 0) > (open.match(/\)/g)?.length ?? 0) ||
    (open.match(/\[/g)?.length ?? 0) > (open.match(/\]/g)?.length ?? 0);
  if (unclosed) return true;

  return /^\s*(?:[&+,/-]|and|or|to|of|[a-z])/.test(next);
}

/** Qualifier keys are free-form; this keeps them stable across documents. */
function qualifierKey(label: string): string {
  const canonical = canonicalize(label).replace(/\s+/g, "_").slice(0, 40);
  return canonical === "" ? "scope" : canonical;
}

/**
 * Signature of the qualifiers that change *what is being measured*.
 *
 * Everything in `qualifiers` counts. Two figures that differ only in a
 * qualifier are not a contradiction; they are two different measurements, and
 * the qualifier that differs is the explanation the UI shows.
 */
function scopeSignatureOf(qualifiers: Record<string, string>): string {
  return stableHash(qualifiers);
}

function buildKeys(
  subject: string,
  predicate: string,
  period: ParsedPeriod | null,
  scopeSignature: string,
): { claimKey: string; relaxedKey: string } {
  const subjectKey = canonicalize(subject);
  const predicateKey = canonicalize(predicate);
  const periodKey = period
    ? period.start && period.end
      ? `${period.start.toISOString().slice(0, 10)}..${period.end.toISOString().slice(0, 10)}`
      : canonicalize(period.label)
    : "";

  return {
    claimKey: stableHash({ s: subjectKey, p: predicateKey, t: periodKey, q: scopeSignature }),
    relaxedKey: stableHash({ s: subjectKey, p: predicateKey }),
  };
}

/**
 * Reads every measured cell in one table.
 *
 * Section labels — a row with a label and no values — qualify the rows beneath
 * them until the next such row, which is how "Income" and "Expenses" stop being
 * dropped and start distinguishing two rows that would otherwise collide.
 */
export function extractTableFacts(
  table: ParsedTable,
  context: TableExtractionContext,
): TableExtractionResult {
  const facts: FactDraft[] = [];
  const issues: TableExtractionResult["issues"] = [];

  if (table.kind === "chart") {
    issues.push({
      kind: "chart_region_unreadable",
      pageNo: table.pageNo,
      detail:
        "Region on this page reconstructs as a grid but its figures form an axis scale with no row labels. Read as a chart; no facts were taken from it.",
    });
    return { facts, issues };
  }

  const quarantineBelow = context.quarantineBelow ?? DEFAULT_QUARANTINE_BELOW;
  const labelCols = Math.max(1, table.rowLabelCols);

  // The scale lives in the caption, never in the cell.
  const unitContext = [table.unitHint ?? "", table.caption ?? "", context.breadcrumb]
    .filter((s) => s !== "")
    .join(" ");

  const contextLabel = [table.caption ?? "", context.breadcrumb]
    .filter((s) => s.trim() !== "")
    .join(" ");

  // Stable within a run: page plus the grid's own rectangle.
  const sourceKey = `p${table.pageNo}:${Math.round(table.bbox.x0)},${Math.round(table.bbox.y0)}`;

  let unresolvedUnits = 0;
  let unresolvedPeriods = 0;

  /*
   * Section headings nest, and the nesting is carried by indentation.
   *
   * A balance sheet says ASSETS ▸ Non-current assets ▸ Financial assets, then
   * ASSETS ▸ Current assets ▸ Financial assets, and lists a row called
   * "Investments" under both. Keeping only the most recent heading makes those
   * two rows indistinguishable, and two genuinely different figures for the
   * same period and the same label then read as a contradiction in the filing.
   *
   * Depth comes from the label's left edge, which the parser already measured.
   * Nothing here needs to know what a balance sheet is.
   */
  const sections: { label: string; indent: number }[] = [];

  const cellAt = (row: number, col: number) =>
    table.cells.find((c) => c.row === row && c.col === col);

  for (let row = table.headerRowCount; row < table.rowCount; row++) {
    const labelCells = [];
    for (let col = 0; col < labelCols; col++) {
      const cell = cellAt(row, col);
      if (cell && cell.text.trim() !== "") labelCells.push(cell);
    }

    const valueCells = [];
    for (let col = labelCols; col < table.colCount; col++) {
      const cell = cellAt(row, col);
      if (cell && cell.text.trim() !== "") valueCells.push(cell);
    }

    if (labelCells.length === 0) continue;

    const rowLabel = tidy(labelCells.map((c) => c.text).join(" "));

    // A labelled row with no values is a section heading for what follows.
    if (valueCells.length === 0) {
      const indent = labelCells[0].bbox.x0;
      const open = sections[sections.length - 1];

      /*
       * A heading that wrapped is one heading, not two.
       *
       * "Restated loss per share (Note 1" and "& 2)" are consecutive
       * label-only rows at the same indent, so the outline rule below would
       * treat the second as closing the first and every row beneath it would
       * be filed under the section "& 2)". An unclosed bracket on the open
       * heading is decisive; a fragment that opens with a connective is the
       * weaker but still reliable case.
       */
      if (open && open.indent === indent && continuesHeading(open.label, rowLabel)) {
        open.label = tidy(`${open.label} ${rowLabel}`);
        continue;
      }

      // Otherwise indent decides where it sits: a heading at or left of an
      // open one closes it, the way an outline does.
      while (sections.length > 0 && sections[sections.length - 1].indent >= indent - INDENT_SLACK) {
        sections.pop();
      }
      sections.push({ label: rowLabel, indent });
      continue;
    }

    // With two or more label columns the row names its own subject.
    const subjectText =
      labelCols >= 2 && labelCells[0]
        ? tidy(labelCells[0].text)
        : context.documentSubject;
    const predicateText =
      labelCols >= 2 && labelCells.length > 1
        ? tidy(labelCells.slice(1).map((c) => c.text).join(" "))
        : rowLabel;

    if (predicateText === "") continue;

    for (const cell of valueCells) {
      const headerPath = table.colHeaderPaths[cell.col] ?? [];
      const { period, residual } = splitHeaderPath(headerPath, context.fiscalCalendar);

      const qualifiers: Record<string, string> = {};
      // The whole open path, so two identically-named rows under
      // different parents key differently.
      const section = sections.map((s) => s.label).join(" ▸ ");
      if (section !== "") qualifiers.section = section;
      for (const segment of residual) {
        const trimmed = tidy(segment);
        if (trimmed === "") continue;
        qualifiers[qualifierKey(trimmed)] = trimmed;
      }

      // Nearest scope first: the cell, then its own column header, then the
      // row label, and only then the caption. A caption that mentions both
      // millions and percentages must not make a count into a percentage.
      const value = normalizeValue(cell.text, [
        headerPath.join(" "),
        predicateText,
        unitContext,
      ]);

      // A cell that is neither a number nor an explicit "no value" is a stray
      // label the grid picked up; it is not a quantitative fact.
      if (value.num === null && value.modifier === "exact") continue;

      const scopeSignature = scopeSignatureOf(qualifiers);
      const { claimKey, relaxedKey } = buildKeys(
        subjectText,
        predicateText,
        period,
        scopeSignature,
      );

      const notes: string[] = [];
      if (value.scaleUnresolved && value.num !== null) {
        notes.push("no unit or scale could be resolved for this figure");
        unresolvedUnits += 1;
      }
      if (!period || period.kind === "unknown") {
        notes.push("no period could be resolved from the column header");
        unresolvedPeriods += 1;
      } else if (period.fiscalUnanchored) {
        notes.push(
          "fiscal period label could not be anchored to dates; the document never states its year end",
        );
      }

      // Layout confidence and table confidence both bound how much this cell
      // can be trusted; a chart-adjacent grid should never contradict a clean one.
      const confidence = Math.max(0.1, Math.min(1, table.confidence));

      facts.push({
        kind: "quantitative",
        subjectText,
        predicateText,
        objectText: null,

        valueRaw: cell.text,
        valueNum: value.num,
        valueBase: value.base,
        valueMin: value.min,
        valueMax: value.max,
        modifier: value.modifier,
        unit: value.unit,

        qualifiers,
        periodKind: period?.kind ?? "unknown",
        periodStart: period?.start ?? null,
        periodEnd: period?.end ?? null,
        periodLabel: period?.label ?? null,

        scopeSignature,
        claimKey,
        relaxedKey,

        confidence,
        extractionMethod: "table_deterministic",
        // The quote is the cell text itself, taken from the reconstructed grid;
        // there is no transcription step in which it could drift.
        quoteVerified: true,
        quarantined: table.needsReview || confidence < quarantineBelow,

        evidence: {
          pageNo: table.pageNo,
          bboxes: [cell.bbox],
          quote: cell.text,
        },
        sourceKey,
        rowIndex: row,
        colIndex: cell.col,
        contextLabel,
        notes,
      });
    }
  }

  if (unresolvedUnits > 0) {
    issues.push({
      kind: "unit_unresolved",
      pageNo: table.pageNo,
      detail: `${unresolvedUnits} figure(s) in this table carry no resolvable unit or scale. They are kept, but excluded from numeric comparison.`,
    });
  }
  if (unresolvedPeriods > 0) {
    issues.push({
      kind: "period_unresolved",
      pageNo: table.pageNo,
      detail: `${unresolvedPeriods} figure(s) in this table have no resolvable period. They can corroborate by value but not by time.`,
    });
  }

  return { facts, issues };
}
