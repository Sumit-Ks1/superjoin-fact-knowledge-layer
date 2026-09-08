/**
 * Segmentation tests.
 *
 * Coordinates are taken from real pages rather than invented, because the cases
 * that break this code are the ones no one would think to make up: a row label
 * emitted as a single run 210 points from its first figure, a header centred
 * over a column whose data is right-aligned, a line of nothing but numbers.
 */

import { describe, expect, it } from "vitest";

import { buildLines, numericRatio } from "./lines";
import type { TextRun } from "./types";

function run(text: string, x0: number, x1: number, y0 = 100, fontSize = 9): TextRun {
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

/** Lays words out left to right with a uniform gap, as loose prose. */
function prose(words: string[], startX: number, gap: number, fontSize = 9): TextRun[] {
  const runs: TextRun[] = [];
  let x = startX;
  for (const word of words) {
    const width = word.length * fontSize * 0.5;
    runs.push(run(word, x, x + width, 100, fontSize));
    x += width + gap;
  }
  return runs;
}

describe("segmentBaseline", () => {
  it("splits a financial row whose label is one run far from its figures", () => {
    // Prospectus p17: the label→value gap is 210pt while the column gaps are 20pt.
    // A largest-relative-jump rule picks the 210pt gap and merges all three
    // figures into a single cell.
    const [line] = buildLines(
      [
        run("Revenue from contract", 77.4, 160.0),
        run("36,465.27", 370.4, 406.3),
        run("27,805.75", 426.3, 462.4),
        run("16,538.97", 481.9, 517.9),
      ],
      1,
    );

    expect(line.segments.map((s) => s.text)).toEqual([
      "Revenue from contract",
      "36,465.27",
      "27,805.75",
      "16,538.97",
    ]);
  });

  it("splits a row of nothing but figures", () => {
    // No word gaps exist to calibrate against, so any within-line median rule
    // collapses the whole row into one cell.
    const [line] = buildLines(
      [
        run("1,008.76", 209.4, 241.0),
        run("1,626.63", 279.2, 310.8),
        run("1,917.64", 374.9, 406.4),
        run("2,080.54", 430.9, 462.5),
        run("409.77", 493.2, 517.9),
      ],
      1,
    );

    expect(line.segments).toHaveLength(5);
    expect(numericRatio(line)).toBe(1);
  });

  it("splits a header row of bare years", () => {
    const [line] = buildLines(
      [
        run("2021", 197.0, 215.0),
        run("2020", 272.2, 290.3),
        run("2020", 430.8, 448.8),
        run("2019", 486.6, 504.6),
      ],
      1,
    );

    expect(line.segments.map((s) => s.text)).toEqual(["2021", "2020", "2020", "2019"]);
  });

  it("keeps prose as a single segment", () => {
    const [line] = buildLines(prose("Real GDP growth has remained robust".split(" "), 72, 3), 1);

    expect(line.segments).toHaveLength(1);
    expect(line.segments[0].text).toBe("Real GDP growth has remained robust");
  });

  it("keeps justified prose with wide spaces as a single segment", () => {
    // Justification stretches spaces; they must still read as spaces.
    const [line] = buildLines(prose("policies coupled with instrumental reform".split(" "), 72, 7), 1);

    expect(line.segments).toHaveLength(1);
  });

  it("separates prose from a chart label sitting beside it", () => {
    // IMF p9: a plot's y-axis tick sits to the right of the body text.
    const runs = [...prose("living standards and a significant reduction in".split(" "), 72, 3)];
    const proseEnd = Math.max(...runs.map((r) => r.x1));
    runs.push(run("70", proseEnd + 40, proseEnd + 49));

    const [line] = buildLines(runs, 1);
    expect(line.segments).toHaveLength(2);
    expect(line.segments[1].text).toBe("70");
  });

  it("rejoins a word the renderer split for kerning", () => {
    const [line] = buildLines([run("Par", 97.2, 110.0), run("ticulars", 110.3, 140.3)], 1);

    expect(line.segments).toHaveLength(1);
    expect(line.segments[0].text).toBe("Particulars");
  });

  it("keeps a set space between runs that abut closely", () => {
    // "page" + "588" 1.6pt apart is a space, not a kerning pair. At the old
    // glue ratio this produced "page588".
    const [line] = buildLines([run("page", 97.2, 115.0), run("588", 116.6, 130.0)], 1);

    expect(line.segments[0].text).toBe("page 588");
  });
});

describe("buildLines", () => {
  it("orders lines down the page, against PDF y direction", () => {
    const lines = buildLines(
      [
        run("bottom", 72, 120, 100),
        run("top", 72, 100, 700),
        run("middle", 72, 110, 400),
      ],
      1,
    );

    expect(lines.map((l) => l.text)).toEqual(["top", "middle", "bottom"]);
  });

  it("attaches a superscript marker to the line it annotates", () => {
    const lines = buildLines(
      [
        run("Total income", 72, 130, 100, 9),
        // Footnote marker: smaller, raised, but part of the same line.
        run("(1)", 131, 137, 104, 5),
      ],
      1,
    );

    expect(lines).toHaveLength(1);
  });
});
