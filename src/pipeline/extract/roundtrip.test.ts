/**
 * Extraction must give the same answer from a stored grid as from a fresh one.
 *
 * The pipeline no longer re-parses the PDF to extract facts — it reads the
 * reconstructed grids back from the database, because re-parsing put a second
 * full parse on the critical path and exhausted the serverless time limit.
 *
 * That only holds if the stored row carries everything extraction needs. If a
 * field is dropped on the way to the database, facts extracted in production
 * differ from facts extracted locally, and nothing in the type system notices:
 * the shapes are structural and the missing value is simply a default.
 *
 * So this pins the round trip. The fixture is reduced to exactly the columns
 * `doc_tables` stores, then extracted, and the result must match extraction
 * from the parser's own object.
 */

import { describe, expect, it } from "vitest";

import { buildLines } from "@/pdf/lines";
import { detectTables } from "@/pdf/tables";
import type { TextRun } from "@/pdf/types";

import { extractTableFacts, type ExtractableTable } from "./table";

function run(text: string, x0: number, x1: number, y0: number, fontSize = 9): TextRun {
  return {
    text,
    x0,
    x1,
    y0,
    y1: y0 + fontSize,
    fontSize,
    fontName: "Times",
    bold: false,
    italic: false,
    rotated: false,
  };
}

/** A small P&L with a stacked header, a section row and a checkable total. */
function fixture() {
  const runs: TextRun[] = [
    run("(in ₹ million, unless otherwise stated)", 380, 517.9, 739),

    run("For the year", 418.7, 460.9, 718.4),
    run("For the year", 474.5, 516.7, 718.4),
    run("ended", 425.6, 453.9, 708.1),
    run("ended", 481.4, 509.8, 708.1),
    run("March 31,", 420.0, 459.5, 697.3),
    run("March 31,", 475.8, 515.4, 697.3),
    run("Particulars", 97.2, 140.3, 708.1),
    run("2021", 430.8, 448.8, 686.9),
    run("2020", 486.6, 504.6, 686.9),

    run("Income", 77.4, 105.0, 676.4),
    run("Revenue from contract with customers", 77.4, 240.0, 665.3),
    run("36,465.27", 426.3, 462.4, 665.3),
    run("27,805.75", 481.9, 517.9, 665.3),
    run("Other income", 77.4, 131.0, 654.8),
    run("1,917.64", 430.9, 462.5, 654.8),
    run("2,080.54", 486.3, 517.9, 654.8),
    run("Total income", 77.4, 140.0, 644.2),
    run("38,382.91", 426.3, 462.4, 644.2),
    run("29,886.29", 481.9, 517.9, 644.2),
  ];
  return detectTables(buildLines(runs, 17), 17, 595, 842);
}

/** Exactly the fields `doc_tables` persists — nothing the parser keeps in memory. */
function asStored(table: ReturnType<typeof fixture>[number]): ExtractableTable {
  return {
    kind: table.kind,
    pageNo: table.pageNo,
    rowCount: table.rowCount,
    colCount: table.colCount,
    cells: table.cells,
    colHeaderPaths: table.colHeaderPaths,
    headerRowCount: table.headerRowCount,
    rowLabelCols: table.rowLabelCols,
    caption: table.caption,
    unitHint: table.unitHint,
    confidence: table.confidence,
    needsReview: table.needsReview,
    bbox: table.bbox,
  };
}

const CONTEXT = {
  documentSubject: "Delhivery Limited",
  fiscalCalendar: { endMonth: 2, endDay: 31 },
  breadcrumb: "",
};

describe("stored grids extract identically to freshly parsed ones", () => {
  const [table] = fixture();

  it("parses the fixture at all", () => {
    expect(table).toBeDefined();
    expect(table.kind).toBe("grid");
  });

  it("produces the same facts from the persisted columns alone", () => {
    const fresh = extractTableFacts(table, CONTEXT);
    const stored = extractTableFacts(asStored(table), CONTEXT);

    expect(stored.facts.length).toBe(fresh.facts.length);
    expect(stored.facts.length).toBeGreaterThan(0);

    // Everything a reader would check: the number, its meaning, its period,
    // its scope, and where it came from.
    const summarise = (facts: typeof fresh.facts) =>
      facts.map((f) => ({
        predicate: f.predicateText,
        raw: f.valueRaw,
        base: f.valueBase,
        unit: f.unit?.baseUnit ?? null,
        period: f.periodLabel,
        qualifiers: f.qualifiers,
        page: f.evidence.pageNo,
        cell: [f.rowIndex, f.colIndex],
        claimKey: f.claimKey,
      }));

    expect(summarise(stored.facts)).toEqual(summarise(fresh.facts));
  });

  it("keeps the unit, which lives in the caption rather than any cell", () => {
    const stored = extractTableFacts(asStored(table), CONTEXT);
    const total = stored.facts.find((f) => f.predicateText.startsWith("Total income"));

    expect(total?.unit?.baseUnit).toBe("INR");
    // 38,382.91 million, not 38,382.91.
    expect(total?.valueBase).toBeCloseTo(3.838291e10, 0);
  });

  it("keeps the period, which lives in the stacked column header", () => {
    const stored = extractTableFacts(asStored(table), CONTEXT);
    const periods = new Set(stored.facts.map((f) => f.periodLabel));

    expect([...periods].some((p) => p?.includes("2021"))).toBe(true);
    expect([...periods].some((p) => p?.includes("2020"))).toBe(true);
  });

  it("keeps the section, which comes from a label-only row", () => {
    const stored = extractTableFacts(asStored(table), CONTEXT);
    const revenue = stored.facts.find((f) =>
      f.predicateText.startsWith("Revenue from contract"),
    );
    expect(revenue?.qualifiers.section).toBe("Income");
  });
});
