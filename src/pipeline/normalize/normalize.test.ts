/**
 * Normalisation tests.
 *
 * These two modules decide which findings are real. A unit misread by 10^7
 * manufactures a contradiction; a period misread by three months hides one. The
 * cases below are drawn from how the corpus actually writes things, plus the
 * conventions any uploaded document might use instead.
 */

import { describe, expect, it } from "vitest";

import {
  comparableUnits,
  normalizeValue,
  parseNumber,
  relativeDifference,
  resolveUnit,
} from "./value";
import {
  comparePeriods,
  inferFiscalCalendar,
  parsePeriod,
  periodLengthDays,
  type FiscalCalendar,
} from "./period";

describe("parseNumber", () => {
  it("reads grouped decimals", () => {
    expect(parseNumber("48,105.30")).toBe(48105.3);
  });

  it("reads accounting parentheses as negative", () => {
    expect(parseNumber("(17,833.04)")).toBe(-17833.04);
  });

  it("reads South Asian grouping", () => {
    expect(parseNumber("1,23,456")).toBe(123456);
  });

  it("reads European grouping", () => {
    // Last separator with two trailing digits is the decimal point.
    expect(parseNumber("1.234,56")).toBe(1234.56);
  });

  it("strips footnote markers", () => {
    expect(parseNumber("9,324,309#")).toBe(9324309);
    expect(parseNumber("1,234.00*")).toBe(1234);
    expect(parseNumber("45.6(1)")).toBe(45.6);
  });

  it("reads a leading minus", () => {
    expect(parseNumber("-2.5")).toBe(-2.5);
    expect(parseNumber("−2.5")).toBe(-2.5); // U+2212
  });

  it("returns null for text with no number", () => {
    expect(parseNumber("Total income")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });
});

describe("resolveUnit", () => {
  it("reads currency and scale from a caption", () => {
    const unit = resolveUnit("(in ₹ million, unless otherwise stated)");
    expect(unit).toMatchObject({ kind: "currency", currency: "INR", factor: 1e6 });
  });

  it("reads Indian scale words", () => {
    expect(resolveUnit("₹ in crore")).toMatchObject({ currency: "INR", factor: 1e7 });
    expect(resolveUnit("Rs. lakhs")).toMatchObject({ currency: "INR", factor: 1e5 });
  });

  it("distinguishes US dollars from a bare dollar sign", () => {
    expect(resolveUnit("US$ billion")).toMatchObject({ currency: "USD", factor: 1e9 });
    expect(resolveUnit("$4.2")).toMatchObject({ currency: "USD" });
  });

  it("treats percent as a ratio regardless of nearby scale words", () => {
    expect(resolveUnit("percent of GDP in millions")).toMatchObject({
      kind: "ratio",
      factor: 0.01,
    });
  });

  it("reads basis points", () => {
    expect(resolveUnit("declined 25 bps")).toMatchObject({ kind: "ratio", factor: 0.0001 });
  });

  it("reads a bare scale word as a count", () => {
    expect(resolveUnit("1.2 million shipments")).toMatchObject({ kind: "count", factor: 1e6 });
  });

  it("returns null when nothing names a unit", () => {
    expect(resolveUnit("Total income")).toBeNull();
  });
});

describe("normalizeValue", () => {
  it("reduces the same amount written two ways to one base value", () => {
    // The corroboration case: prospectus millions against an analyst's crore.
    const millions = normalizeValue("52,350.00", "(in ₹ million)");
    const crore = normalizeValue("5,235.00", "₹ crore");

    expect(millions.base).toBe(52_350_000_000);
    expect(crore.base).toBe(52_350_000_000);
    expect(comparableUnits(millions.unit, crore.unit)).toBe(true);
    expect(relativeDifference(millions.base!, crore.base!)).toBe(0);
  });

  it("keeps a negative through the base conversion", () => {
    const value = normalizeValue("(17,833.04)", "(in ₹ million)");
    expect(value.num).toBe(-17833.04);
    expect(value.base).toBeCloseTo(-17_833_040_000, 0);
  });

  it("marks a value with no resolvable scale rather than guessing one", () => {
    const value = normalizeValue("48,105.30", "Total income");
    expect(value.num).toBe(48105.3);
    expect(value.base).toBeNull();
    expect(value.scaleUnresolved).toBe(true);
  });

  it("reads spreadsheet sentinels", () => {
    expect(normalizeValue("-").modifier).toBe("not_applicable");
    expect(normalizeValue("N.A.").modifier).toBe("not_applicable");
    expect(normalizeValue("Nil")).toMatchObject({ modifier: "nil", num: 0 });
  });

  it("keeps both ends of a range", () => {
    const value = normalizeValue("40,000 to 52,350", "₹ million");
    expect(value.modifier).toBe("range");
    expect(value.min).toBe(40000);
    expect(value.max).toBe(52350);
  });

  it("records hedging as a modifier instead of discarding it", () => {
    expect(normalizeValue("5.3", "approximately 5.3 percent").modifier).toBe("approximate");
    expect(normalizeValue("100", "at least 100 million").modifier).toBe("at_least");
    expect(normalizeValue("100", "up to 100 million").modifier).toBe("at_most");
  });

  it("takes the number from the value, never from its context", () => {
    // A caption's page number or year must not become the value.
    const value = normalizeValue("409.77", "(in ₹ million) Page 17 for fiscal 2021");
    expect(value.num).toBe(409.77);
  });
});

describe("comparableUnits", () => {
  it("refuses to compare across currencies", () => {
    // Without a dated exchange rate the comparison would be invented.
    const inr = resolveUnit("₹ million");
    const usd = resolveUnit("US$ million");
    expect(comparableUnits(inr, usd)).toBe(false);
  });

  it("refuses to compare a ratio with a currency", () => {
    expect(comparableUnits(resolveUnit("percent"), resolveUnit("₹ million"))).toBe(false);
  });

  it("compares the same currency at different scales", () => {
    expect(comparableUnits(resolveUnit("₹ million"), resolveUnit("₹ crore"))).toBe(true);
  });

  it("treats an unknown unit as incomparable", () => {
    expect(comparableUnits(null, resolveUnit("₹ million"))).toBe(false);
  });
});

describe("parsePeriod", () => {
  const indian: FiscalCalendar = { endMonth: 2, endDay: 31 }; // 31 March

  it("reads an interim period and does not collapse it into its year", () => {
    const period = parsePeriod("For the nine months period ended December 31, 2021");
    expect(period.kind).toBe("nine_month");
    expect(period.start?.toISOString().slice(0, 10)).toBe("2021-04-01");
    expect(period.end?.toISOString().slice(0, 10)).toBe("2021-12-31");
    expect(periodLengthDays(period)).toBeGreaterThan(260);
    expect(periodLengthDays(period)).toBeLessThan(280);
  });

  it("reads a fiscal year stated as an end date", () => {
    const period = parsePeriod("For the year ended March 31, 2021");
    expect(period.kind).toBe("fiscal_year");
    expect(period.start?.toISOString().slice(0, 10)).toBe("2020-04-01");
    expect(period.end?.toISOString().slice(0, 10)).toBe("2021-03-31");
  });

  it("calls a December year end a calendar year", () => {
    expect(parsePeriod("year ended December 31, 2023").kind).toBe("calendar_year");
  });

  it("anchors a fiscal label only when the calendar is known", () => {
    const guessed = parsePeriod("FY2024");
    expect(guessed.fiscalUnanchored).toBe(true);
    expect(guessed.start).toBeNull();

    const anchored = parsePeriod("FY2024", indian);
    expect(anchored.fiscalUnanchored).toBe(false);
    expect(anchored.start?.toISOString().slice(0, 10)).toBe("2023-04-01");
    expect(anchored.end?.toISOString().slice(0, 10)).toBe("2024-03-31");
  });

  it("anchors the same label differently under a different fiscal calendar", () => {
    // The reason a fiscal calendar is never assumed: FY24 for the US federal
    // government ends in September, not March.
    const federal = parsePeriod("FY2024", { endMonth: 8, endDay: 30 });
    expect(federal.start?.toISOString().slice(0, 10)).toBe("2023-10-01");
    expect(federal.end?.toISOString().slice(0, 10)).toBe("2024-09-30");
  });

  it("reads a hyphenated fiscal span", () => {
    const period = parsePeriod("2023-24", indian);
    expect(period.kind).toBe("fiscal_year");
    expect(period.end?.toISOString().slice(0, 10)).toBe("2024-03-31");
  });

  it("reads a fiscal quarter against the fiscal calendar", () => {
    const q4 = parsePeriod("Q4 FY24", indian);
    expect(q4.kind).toBe("quarter");
    expect(q4.start?.toISOString().slice(0, 10)).toBe("2024-01-01");
    expect(q4.end?.toISOString().slice(0, 10)).toBe("2024-03-31");
  });

  it("reads a calendar quarter", () => {
    const q3 = parsePeriod("Q3 2024");
    expect(q3.start?.toISOString().slice(0, 10)).toBe("2024-07-01");
    expect(q3.end?.toISOString().slice(0, 10)).toBe("2024-09-30");
  });

  it("reads a balance-sheet instant", () => {
    const at = parsePeriod("as at March 31, 2024");
    expect(at.kind).toBe("instant");
    expect(at.start?.toISOString().slice(0, 10)).toBe("2024-03-31");
  });

  it("reads a bare calendar year", () => {
    const year = parsePeriod("2023");
    expect(year.kind).toBe("calendar_year");
    expect(year.start?.toISOString().slice(0, 10)).toBe("2023-01-01");
  });

  it("returns unknown rather than guessing at unparseable text", () => {
    expect(parsePeriod("Particulars").kind).toBe("unknown");
  });
});

describe("inferFiscalCalendar", () => {
  it("learns the year end from the document's own wording", () => {
    expect(inferFiscalCalendar("our fiscal year ends March 31 of each year")).toEqual({
      endMonth: 2,
      endDay: 31,
    });
  });

  it("learns it from a statement heading", () => {
    expect(
      inferFiscalCalendar("Restated summary for the year ended March 31, 2021"),
    ).toEqual({ endMonth: 2, endDay: 31 });
  });

  it("learns a September year end just as readily", () => {
    expect(inferFiscalCalendar("fiscal year ending September 30")).toEqual({
      endMonth: 8,
      endDay: 30,
    });
  });

  it("is not fooled by an interim period stated first", () => {
    // A prospectus leads with interim results, so the first date-bearing
    // phrase in the file is the nine-month period end. Reading that as the
    // fiscal year end shifts every fiscal label in the document by nine months.
    const prospectus = [
      "For the nine months period ended December 31, 2021",
      "For the nine months period ended December 31, 2020",
      "For the year ended March 31, 2021",
      "For the year ended March 31, 2020",
      "For the year ended March 31, 2019",
    ].join("\n");

    expect(inferFiscalCalendar(prospectus)).toEqual({ endMonth: 2, endDay: 31 });
  });

  it("takes the year end the document repeats, not the one it mentions once", () => {
    const text = [
      "comparative figures for the year ended December 31, 2020 are presented",
      "for the year ended March 31, 2022",
      "for the year ended March 31, 2023",
      "for the year ended March 31, 2024",
    ].join("\n");

    expect(inferFiscalCalendar(text)).toEqual({ endMonth: 2, endDay: 31 });
  });

  it("returns null when the document never says", () => {
    expect(inferFiscalCalendar("Revenue grew strongly this year.")).toBeNull();
  });
});

describe("comparePeriods", () => {
  it("sees nine months as contained within the year, not equal to it", () => {
    // This is the reconciliation case. Reported as identical, the two figures
    // are a contradiction; reported as contained, they are consistent.
    const nine = parsePeriod("nine months ended December 31, 2021");
    const year = parsePeriod("year ended March 31, 2022");
    expect(comparePeriods(nine, year)).toBe("contained");
  });

  it("sees two different fiscal years as disjoint", () => {
    expect(
      comparePeriods(parsePeriod("year ended March 31, 2021"), parsePeriod("year ended March 31, 2020")),
    ).toBe("disjoint");
  });

  it("treats the same period stated two ways as identical", () => {
    const a = parsePeriod("year ended March 31, 2024");
    const b = parsePeriod("FY2024", { endMonth: 2, endDay: 31 });
    expect(comparePeriods(a, b)).toBe("identical");
  });

  it("absorbs a day or two of boundary wobble", () => {
    expect(
      comparePeriods(parsePeriod("year ended December 31, 2023"), parsePeriod("2023")),
    ).toBe("identical");
  });

  it("reports unknown when either side has no interval", () => {
    expect(comparePeriods(parsePeriod("FY2024"), parsePeriod("2024"))).toBe("unknown");
  });

  it("sees overlapping but offset windows as partial", () => {
    expect(
      comparePeriods(
        parsePeriod("year ended March 31, 2021"),
        parsePeriod("year ended December 31, 2021"),
      ),
    ).toBe("partial");
  });
});
