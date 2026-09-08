/**
 * Grid reconstruction tests.
 *
 * The fixture is the restated P&L from page 17 of the Delhivery prospectus,
 * reduced to its structurally hard parts and with its real coordinates intact.
 * Three properties of that page defeat the obvious implementations:
 *
 *   · the five period columns are right-aligned, and adjacent columns overlap
 *     horizontally, so no vertical whitespace separates them;
 *   · the header is centred, staggered onto two different baseline sets, and
 *     each header cell laps a third of the way into its neighbour;
 *   · one logical row is spread over three physical lines.
 */

import { describe, expect, it } from "vitest";

import { assignToColumns, buildColumnModel, detectTables } from "./tables";
import { buildLines } from "./lines";
import type { Line, TextRun } from "./types";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

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

/**
 * Page 17's header and opening rows, verbatim from the parser's own geometry
 * dump. The nine-month group sits on one set of baselines and the annual group
 * on another, which is why the header has to be assembled by column rather
 * than by row.
 */
function prospectusPage17(): Line[] {
  const runs: TextRun[] = [
    // caption, carrying the scale that never appears in a cell
    run("(in ₹ million, unless otherwise stated)", 380.0, 517.9, 739.0),

    // header — nine-month group
    run("For the nine", 182.4, 229.5, 728.9),
    run("For the nine", 257.7, 304.8, 728.9),
    run("months period", 178.0, 233.9, 718.4),
    run("months period", 253.4, 309.3, 718.4),
    run("ended", 194.4, 217.4, 708.1),
    run("ended", 269.7, 292.7, 708.1),
    run("December 31,", 179.7, 232.2, 697.3),
    run("December 31,", 254.9, 307.5, 697.3),

    // header — annual group, on its own baselines
    run("For the", 425.6, 453.9, 723.6),
    run("For the", 481.4, 509.8, 723.6),
    run("For the year ended", 327.6, 400.3, 718.4),
    run("year ended", 418.7, 460.9, 713.3),
    run("year ended", 474.5, 516.7, 713.3),
    run("March 31,", 420.0, 459.5, 697.3),
    run("March 31,", 475.8, 515.4, 697.3),
    run("March 31, 2021", 334.0, 393.9, 692.1),

    // row-label header, and the year row shared by both groups
    run("Particulars", 97.2, 140.3, 708.1),
    run("2021", 197.0, 215.0, 686.9),
    run("2020", 272.2, 290.3, 686.9),
    run("2020", 430.8, 448.8, 686.9),
    run("2019", 486.6, 504.6, 686.9),

    // section label: belongs to the body, not the header
    run("Income", 77.4, 105.0, 676.4),

    // one logical row over three physical lines, values staggered by group
    run("Revenue from contract", 77.4, 160.0, 665.3),
    run("36,465.27", 370.4, 406.3, 665.3),
    run("27,805.75", 426.3, 462.4, 665.3),
    run("16,538.97", 481.9, 517.9, 665.3),
    run("with customers", 77.4, 132.1, 654.8),
    run("48,105.30", 204.9, 240.9, 654.8),
    run("26,438.66", 274.6, 310.6, 654.8),

    // a clean, fully populated row
    run("Other income", 77.4, 131.0, 644.2),
    run("1,008.76", 209.4, 241.0, 633.7),
    run("1,626.63", 279.2, 310.8, 633.7),
    run("1,917.64", 374.9, 406.4, 633.7),
    run("2,080.54", 430.9, 462.5, 633.7),
    run("409.77", 493.2, 517.9, 633.7),

    run("Total income (I)", 77.4, 140.0, 623.2),
    run("49,114.06", 204.9, 240.9, 623.2),
    run("28,065.29", 274.6, 310.6, 623.2),
    run("38,382.91", 370.4, 406.3, 623.2),
    run("29,886.29", 426.3, 462.4, 623.2),
    run("16,948.74", 481.9, 517.9, 623.2),

    run("Expenses", 77.4, 115.0, 612.7),
    run("Freight, handling and servicing cost", 77.4, 215.0, 602.1),
    run("34,786.36", 204.9, 240.9, 591.6),
    run("20,257.07", 274.6, 310.6, 591.6),
    run("27,780.82", 370.4, 406.3, 591.6),
    run("21,837.96", 426.3, 462.4, 591.6),
    run("12,506.83", 481.9, 517.9, 591.6),
  ];

  return buildLines(runs, 17);
}

describe("detectTables", () => {
  const tables = detectTables(prospectusPage17(), 17, PAGE_WIDTH, PAGE_HEIGHT);
  const table = tables[0];

  it("finds exactly one grid", () => {
    expect(tables).toHaveLength(1);
    expect(table.kind).toBe("grid");
  });

  it("reconstructs five right-aligned value columns that overlap horizontally", () => {
    expect(table.colCount).toBe(6);
    expect(table.rowLabelCols).toBe(1);
  });

  it("binds each column to its own period rather than its neighbour's", () => {
    // The whole assignment turns on this: 48,105.30 is nine months to
    // December 2021, not a fiscal year. Centred headers overlap the column
    // next door, so an overlap-based rule copies periods across columns.
    const joined = table.colHeaderPaths.map((p) => p.join(" "));
    expect(joined[1]).toBe("For the nine months period ended December 31, 2021");
    expect(joined[2]).toBe("For the nine months period ended December 31, 2020");
    expect(joined[3]).toBe("For the year ended March 31, 2021");
    expect(joined[4]).toBe("For the year ended March 31, 2020");
    expect(joined[5]).toBe("For the year ended March 31, 2019");
  });

  it("takes the scale from the caption, which no cell carries", () => {
    expect(table.unitHint).toBe("in ₹ million, unless otherwise stated");
  });

  it("leaves a section label in the body instead of folding it into the header", () => {
    const header = table.colHeaderPaths.map((p) => p.join(" ")).join(" ");
    expect(header).not.toContain("Income");

    const income = table.cells.find((c) => c.text === "Income");
    expect(income).toBeDefined();
    expect(income!.row).toBeGreaterThanOrEqual(table.headerRowCount);
  });

  it("reunites a logical row split across physical lines and column groups", () => {
    const rowOf = (label: string) => {
      const cell = table.cells.find((c) => c.col === 0 && c.text === label);
      expect(cell, `no row labelled "${label}"`).toBeDefined();
      return table.cells
        .filter((c) => c.row === cell!.row && c.col > 0)
        .sort((a, b) => a.col - b.col)
        .map((c) => c.text);
    };

    // Label wraps over two lines; nine-month figures land on the second line
    // while the annual figures land on the first.
    expect(rowOf("Revenue from contract with customers")).toEqual([
      "48,105.30",
      "26,438.66",
      "36,465.27",
      "27,805.75",
      "16,538.97",
    ]);

    // Label on its own line, figures on the next.
    expect(rowOf("Other income")).toEqual([
      "1,008.76",
      "1,626.63",
      "1,917.64",
      "2,080.54",
      "409.77",
    ]);
  });

  it("reproduces a row exactly as the page prints it", () => {
    const total = table.cells.find((c) => c.col === 0 && c.text === "Total income (I)");
    expect(total).toBeDefined();
    const values = table.cells
      .filter((c) => c.row === total!.row && c.col > 0)
      .sort((a, b) => a.col - b.col)
      .map((c) => c.text);

    expect(values).toEqual([
      "49,114.06",
      "28,065.29",
      "38,382.91",
      "29,886.29",
      "16,948.74",
    ]);
  });

  it("keeps the grid arithmetically consistent", () => {
    const valueAt = (label: string, col: number) => {
      const cell = table.cells.find((c) => c.col === 0 && c.text === label);
      const value = table.cells.find((c) => c.row === cell!.row && c.col === col);
      return Number(value!.text.replace(/,/g, ""));
    };

    // Revenue + other income = total income, in every column.
    for (let col = 1; col <= 5; col++) {
      const revenue = valueAt("Revenue from contract with customers", col);
      const other = valueAt("Other income", col);
      const total = valueAt("Total income (I)", col);
      expect(revenue + other).toBeCloseTo(total, 2);
    }
  });

  it("records evidence geometry for every cell", () => {
    for (const cell of table.cells) {
      expect(cell.bbox.x1).toBeGreaterThan(cell.bbox.x0);
      expect(cell.bbox.y1).toBeGreaterThan(cell.bbox.y0);
    }
  });
});

describe("chart rejection", () => {
  /** Two stacked y-axis tick scales, as a plot leaves them in the text layer. */
  function chartAxis(): Line[] {
    const runs: TextRun[] = [];
    let y = 700;
    for (const [left, right] of [
      ["12", "50"],
      ["10", "40"],
      ["8", "30"],
      ["6", "20"],
      ["4", "10"],
      ["2", "0"],
      ["0", "-10"],
    ]) {
      runs.push(run(left, 200 - left.length * 4.5, 200, y));
      runs.push(run(right, 400 - right.length * 4.5, 400, y));
      y -= 20;
    }
    return buildLines(runs, 10);
  }

  it("flags an axis scale rather than emitting its ticks as facts", () => {
    const [table] = detectTables(chartAxis(), 10, PAGE_WIDTH, PAGE_HEIGHT);

    expect(table).toBeDefined();
    expect(table.kind).toBe("chart");
    expect(table.needsReview).toBe(true);
    expect(table.confidence).toBeLessThan(0.2);
    expect(table.reviewReasons.join(" ")).toContain("axis scale");
  });

  it("does not mistake an evenly stepping labelled series for an axis", () => {
    // A yearly series steps by exactly one, which is what an axis looks like,
    // and its figures can step evenly too. The row labels are what make it a
    // table: a chart axis has none.
    const runs: TextRun[] = [];
    let y = 700;
    for (const [label, revenue, margin] of [
      ["FY2021", "1,000.00", "10.00"],
      ["FY2022", "2,000.00", "20.00"],
      ["FY2023", "3,000.00", "30.00"],
      ["FY2024", "4,000.00", "40.00"],
      ["FY2025", "5,000.00", "50.00"],
    ]) {
      runs.push(run(label, 77, 120, y));
      runs.push(run(revenue, 200, 245, y));
      runs.push(run(margin, 300, 330, y));
      y -= 12;
    }

    const [table] = detectTables(buildLines(runs, 1), 1, PAGE_WIDTH, PAGE_HEIGHT);
    expect(table).toBeDefined();
    expect(table.kind).toBe("grid");
  });
});

describe("assignToColumns", () => {
  const lines = prospectusPage17();
  const columns = buildColumnModel(
    lines.filter((l) => l.segments.filter((s) => s.isNumeric).length >= 3),
    PAGE_WIDTH,
  );

  it("builds one label column and five value columns", () => {
    expect(columns.filter((c) => c.kind === "value")).toHaveLength(5);
  });

  it("snaps a figure to its right-edge anchor", () => {
    const segment = {
      text: "(17,833.04)",
      x0: 470.0,
      x1: 517.9,
      y0: 100,
      y1: 109,
      fontSize: 9,
      bold: false,
      isNumeric: true,
    };

    // This figure starts to the LEFT of where column 4's figures end, so no
    // vertical line separates the two columns anywhere on the page.
    expect(assignToColumns(segment, columns)).toEqual([5]);
  });

  it("gives a centred header only the column it sits over", () => {
    const segment = {
      text: "March 31, 2021",
      x0: 334.0,
      x1: 393.9,
      y0: 100,
      y1: 109,
      fontSize: 9,
      bold: false,
      isNumeric: false,
    };

    expect(assignToColumns(segment, columns)).toEqual([3]);
  });

  it("spans a header stretched across two columns", () => {
    const segment = {
      text: "For the nine months period ended",
      x0: 180.0,
      x1: 320.0,
      y0: 100,
      y1: 109,
      fontSize: 9,
      bold: false,
      isNumeric: false,
    };

    expect(assignToColumns(segment, columns)).toEqual([1, 2]);
  });
});
