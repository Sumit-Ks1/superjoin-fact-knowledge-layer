/**
 * Adjudication tests, organised around the four cases the system must handle.
 *
 * The fixtures use real figures from the Delhivery filings so the arithmetic is
 * checkable by hand against the source documents.
 */

import { describe, expect, it } from "vitest";

import { adjudicate, compareValues, printedPrecision, type LinkableFact } from "./adjudicate";
import { parsePeriod, type FiscalCalendar } from "../normalize/period";
import { resolveUnit } from "../normalize/value";

const INDIAN: FiscalCalendar = { endMonth: 2, endDay: 31 };

let counter = 0;

function fact(overrides: Partial<LinkableFact> & { valueRaw: string; unitText: string }): LinkableFact {
  const unit = resolveUnit(overrides.unitText);
  const num = Number(overrides.valueRaw.replace(/[^\d.-]/g, ""));
  const periodLabel = (overrides.period as unknown as string) ?? "";

  return {
    id: `f${counter++}`,
    documentId: "docA",
    subjectText: "Delhivery Limited",
    predicateText: "Revenue from contract with customers",
    valueRaw: overrides.valueRaw,
    valueNum: num,
    valueBase: unit ? num * unit.factor : null,
    modifier: "exact",
    unit,
    qualifiers: {},
    period: typeof periodLabel === "string" ? parsePeriod(periodLabel, INDIAN) : periodLabel,
    claimKey: "",
    relaxedKey: "",
    confidence: 1,
    quarantined: false,
    ...(overrides as Partial<LinkableFact>),
  };
}

/** Builds a fact from a printed value, unit phrase and period phrase. */
function make(
  valueRaw: string,
  unitText: string,
  periodText: string,
  extra: Partial<LinkableFact> = {},
): LinkableFact {
  const base = fact({ valueRaw, unitText });
  return { ...base, period: parsePeriod(periodText, INDIAN), ...extra };
}

describe("printedPrecision", () => {
  it("reads precision from the decimal places the figure claims", () => {
    const million = resolveUnit("₹ million");
    const crore = resolveUnit("₹ crore");
    // "48,105.30 million" claims precision to ₹10,000.
    expect(printedPrecision("48,105.30", million)).toBeCloseTo(1e4, 0);
    // "4,811 crore" claims precision only to ₹1 crore.
    expect(printedPrecision("4,811", crore)).toBeCloseTo(1e7, 0);
  });
});

describe("case 1 — corroboration across documents expressed differently", () => {
  it("treats millions and crore stating the same amount as corroboration", () => {
    const prospectus = make("52,350.00", "(in ₹ million)", "year ended March 31, 2022");
    const deck = make("5,235.00", "₹ crore", "year ended March 31, 2022", { documentId: "docB" });

    const verdict = adjudicate(prospectus, deck);
    expect(verdict.type).toBe("EQUIVALENT_RESTATEMENT");
    expect(verdict.explanation).toContain("same value");
  });

  it("accepts figures that agree only to the coarser printed precision", () => {
    // ₹4,811 crore is ₹48,110 million; the prospectus prints ₹48,105.30 million.
    // They agree to the nearest crore, which is all the coarser figure claims.
    const precise = make("48,105.30", "(in ₹ million)", "year ended March 31, 2021");
    const rounded = make("4,811", "₹ crore", "year ended March 31, 2021", { documentId: "docB" });

    expect(compareValues(precise, rounded)).not.toBe("different");
    expect(adjudicate(precise, rounded).type).toMatch(/CORROBORATES|EQUIVALENT_RESTATEMENT/);
  });

  it("corroborates the same figure restated in a second document", () => {
    const a = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const b = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021", {
      documentId: "docB",
    });

    const verdict = adjudicate(a, b);
    expect(verdict.type).toBe("CORROBORATES");
    expect(verdict.confidence).toBeGreaterThan(0.9);
    expect(verdict.explanation).toContain("across two documents");
  });
});

describe("case 2 — a genuine contradiction", () => {
  it("reports a real disagreement when nothing explains it", () => {
    const a = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const b = make("38,000.00", "(in ₹ million)", "year ended March 31, 2021", {
      documentId: "docB",
    });

    const verdict = adjudicate(a, b);
    expect(verdict.type).toBe("CONTRADICTS");
    expect(verdict.explanation).toContain("values differ");
    expect(verdict.explanation).toContain("across two documents");
  });

  it("says how far apart the two figures are", () => {
    const a = make("100.00", "(in ₹ million)", "year ended March 31, 2021");
    const b = make("110.00", "(in ₹ million)", "year ended March 31, 2021", { documentId: "docB" });

    expect(adjudicate(a, b).explanation).toContain("9.1%");
  });

  it("does not assert a contradiction from a quarantined region", () => {
    // A figure read off a chart must never be the thing that calls a filing wrong.
    const clean = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const chart = make("38,000.00", "(in ₹ million)", "year ended March 31, 2021", {
      documentId: "docB",
      quarantined: true,
    });

    const verdict = adjudicate(clean, chart);
    expect(verdict.type).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdict.explanation).toContain("layout could not be read confidently");
  });
});

describe("case 3 — apparent contradiction explained by context", () => {
  it("reconciles by time: nine months against a full year", () => {
    // The headline case. ₹48,105.30m (nine months to Dec 2021) against
    // ₹36,465.27m (year to Mar 2021) is not a disagreement.
    const nineMonths = make(
      "48,105.30",
      "(in ₹ million)",
      "For the nine months period ended December 31, 2021",
    );
    const fullYear = make("36,465.27", "(in ₹ million)", "For the year ended March 31, 2021");

    const verdict = adjudicate(nineMonths, fullYear);
    expect(verdict.type).toBe("RECONCILED_BY_TIME");
    expect(verdict.subtype).toBe("period");
    expect(verdict.explanation).toContain("different periods");
  });

  it("reconciles by scope: consolidated against standalone", () => {
    const consolidated = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021", {
      qualifiers: { basis: "Consolidated" },
    });
    const standalone = make("34,000.00", "(in ₹ million)", "year ended March 31, 2021", {
      documentId: "docB",
      qualifiers: { basis: "Standalone" },
    });

    const verdict = adjudicate(consolidated, standalone);
    expect(verdict.type).toBe("RECONCILED_BY_SCOPE");
    expect(verdict.subtype).toBe("basis");
    expect(verdict.explanation).toContain("Consolidated");
    expect(verdict.explanation).toContain("Standalone");
  });

  it("reconciles by unit: two currencies are not a disagreement", () => {
    const rupees = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const dollars = make("440.00", "US$ million", "year ended March 31, 2021", {
      documentId: "docB",
    });

    const verdict = adjudicate(rupees, dollars);
    expect(verdict.type).toBe("RECONCILED_BY_UNIT");
    expect(verdict.explanation).toContain("exchange rate");
  });

  it("prefers supersession to contradiction when one figure is restated", () => {
    const restated = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021", {
      predicateText: "Restated revenue from contract with customers",
    });
    const original = make("36,000.00", "(in ₹ million)", "year ended March 31, 2021", {
      documentId: "docB",
      predicateText: "Revenue from contract with customers as reported",
    });

    const verdict = adjudicate(restated, original);
    expect(verdict.type).toBe("SUPERSEDES");
    expect(verdict.subtype).toBe("restated");
  });

  it("checks reconciliation before contradiction, not after", () => {
    // Same values, different periods: equal numbers across different windows
    // are a coincidence, and must not be reported as corroboration.
    const a = make("100.00", "(in ₹ million)", "year ended March 31, 2021");
    const b = make("100.00", "(in ₹ million)", "year ended March 31, 2020", { documentId: "docB" });

    expect(adjudicate(a, b).type).toBe("RECONCILED_BY_TIME");
  });
});

describe("case 4 — refusing to conclude", () => {
  it("declines when the measures are not the same thing", () => {
    const revenue = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const headcount = make("57,000", "count", "year ended March 31, 2021", {
      predicateText: "Number of employees at year end",
    });

    expect(adjudicate(revenue, headcount).type).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("declines when a figure carries no resolvable unit", () => {
    const known = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const unitless = make("36,465.27", "Total", "year ended March 31, 2021", {
      documentId: "docB",
    });

    const verdict = adjudicate(known, unitless);
    expect(verdict.type).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdict.explanation).toContain("no resolvable unit");
  });

  it("declines when neither period could be anchored", () => {
    const a = make("100.00", "(in ₹ million)", "FY2024");
    const b = make("120.00", "(in ₹ million)", "FY2025", { documentId: "docB" });
    // Both unanchored: no calendar, so no interval, so no time judgement.
    const unanchoredA = { ...a, period: parsePeriod("FY2024", null) };
    const unanchoredB = { ...b, period: parsePeriod("FY2025", null) };

    const verdict = adjudicate(unanchoredA, unanchoredB);
    expect(verdict.type).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdict.subtype).toBe("period");
    expect(verdict.needsAdjudication).toBe(true);
  });
});

describe("a table does not contradict itself", () => {
  it("declines a pair from two rows of one column", () => {
    // The balance sheet lists "Financial assets (i) Investments" under both
    // non-current and current assets. The heading between them arrives broken
    // because its column is narrow enough to wrap mid-word.
    const nonCurrent = make("4,205.89", "(in ₹ million)", "as at March 31, 2021", {
      predicateText: "Financial assets (i) Investments",
      sourceKey: "p25:70,100",
      rowIndex: 8,
      colIndex: 2,
    });
    const current = make("7,075.64", "(in ₹ million)", "as at March 31, 2021", {
      predicateText: "Financial assets (i) Investments",
      sourceKey: "p25:70,100",
      rowIndex: 19,
      colIndex: 2,
    });

    const verdict = adjudicate(nonCurrent, current);
    expect(verdict.type).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdict.subtype).toBe("same_table");
  });

  it("declines a pair from two columns that hold different quantities", () => {
    // A stock-option note puts option counts beside exercise prices.
    const count = make("13.76", "Rupees million", "year ended March 31, 2024", {
      predicateText: "Outstanding at the end of the year",
      sourceKey: "p61:70,300",
      rowIndex: 5,
      colIndex: 1,
    });
    const price = make("0.10", "Rupees million", "year ended March 31, 2024", {
      predicateText: "Outstanding at the end of the year",
      sourceKey: "p61:70,300",
      rowIndex: 5,
      colIndex: 2,
    });

    expect(adjudicate(count, price).type).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("still reconciles two columns of one table that report different periods", () => {
    // The rule guards the contradiction verdict only. A year-on-year pair
    // inside one grid is a genuine and useful time reconciliation.
    const thisYear = make("74,540.82", "₹ Million", "year ended March 31, 2024", {
      predicateText: "Revenue from Operations",
      sourceKey: "p40:70,300",
      rowIndex: 3,
      colIndex: 1,
    });
    const lastYear = make("66,586.61", "₹ Million", "year ended March 31, 2023", {
      predicateText: "Revenue from Operations",
      sourceKey: "p40:70,300",
      rowIndex: 3,
      colIndex: 2,
    });

    expect(adjudicate(thisYear, lastYear).type).toBe("RECONCILED_BY_TIME");
  });

  it("declines a pair from unrelated tables in one document", () => {
    // "Outstanding at the end of the year" describes a row's position in its
    // own table, not a measure comparable across tables.
    const options = make("13.76", "(in ₹ million)", "year ended March 31, 2024", {
      predicateText: "Outstanding at the end of the year",
      sourceKey: "p61:70,300",
      contextLabel: "Employee stock option plan",
      rowIndex: 5,
      colIndex: 1,
    });
    const borrowings = make("0.10", "(in ₹ million)", "year ended March 31, 2024", {
      predicateText: "Outstanding at the end of the year",
      sourceKey: "p72:70,300",
      contextLabel: "Movement in lease liabilities",
      rowIndex: 4,
      colIndex: 1,
    });

    const verdict = adjudicate(options, borrowings);
    expect(verdict.type).toBe("INSUFFICIENT_EVIDENCE");
    expect(verdict.subtype).toBe("unrelated_tables");
  });

  it("still reports a contradiction between two documents", () => {
    // The same-table and unrelated-table guards must never suppress the
    // cross-document case, which is the finding that matters most.
    const a = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021", {
      sourceKey: "p17:70,300",
      rowIndex: 3,
      colIndex: 1,
      contextLabel: "Restated summary profit and loss",
    });
    const b = make("38,000.00", "(in ₹ million)", "year ended March 31, 2021", {
      documentId: "docB",
      sourceKey: "p9:70,300",
      rowIndex: 2,
      colIndex: 1,
      contextLabel: "Financial highlights",
    });

    expect(adjudicate(a, b).type).toBe("CONTRADICTS");
  });
});

describe("same-document pairs", () => {
  it("marks an intra-document agreement with lower confidence than a cross-document one", () => {
    const a = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const sameDoc = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021");
    const otherDoc = make("36,465.27", "(in ₹ million)", "year ended March 31, 2021", {
      documentId: "docB",
    });

    // Two documents agreeing is stronger evidence than one document repeating itself.
    expect(adjudicate(a, sameDoc).confidence).toBeLessThan(adjudicate(a, otherDoc).confidence);
  });
});
