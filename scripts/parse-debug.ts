/**
 * Parser debug harness.
 *
 *   npx tsx scripts/parse-debug.ts <pdf> [--from 1] [--to 5] [--tables] [--blocks] [--json out.json]
 *
 * The layout engine is the foundation everything else stands on, so it needs to
 * be inspectable without spinning up the app, a database, or a model provider.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { extractGeometry } from "../src/pdf/extract";
import { detectBoilerplate, parsePages } from "../src/pdf/parse";
import { tableToMarkdown } from "../src/pdf/tables";

type Args = {
  file: string;
  from: number;
  to: number;
  showTables: boolean;
  showBlocks: boolean;
  showLines: boolean;
  json?: string;
};

function parseArgs(argv: string[]): Args {
  const [file] = argv.filter((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: tsx scripts/parse-debug.ts <pdf> [--from N] [--to N] [--tables] [--blocks] [--lines] [--json out.json]");
    process.exit(1);
  }
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index !== -1 ? argv[index + 1] : undefined;
  };
  return {
    file,
    from: Number(flag("from") ?? 1),
    to: Number(flag("to") ?? 5),
    showTables: argv.includes("--tables"),
    showBlocks: argv.includes("--blocks"),
    showLines: argv.includes("--lines"),
    json: flag("json"),
  };
}

const bar = (value: number, width = 20) =>
  "█".repeat(Math.round(value * width)).padEnd(width, "░");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bytes = new Uint8Array(await readFile(path.resolve(args.file)));

  console.log(`\n▸ ${path.basename(args.file)}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);

  const started = Date.now();
  const geometry = await extractGeometry(bytes, { fromPage: args.from, toPage: args.to });
  const extractMs = Date.now() - started;

  console.log(`  ${geometry.pageCount} pages total; extracted ${geometry.pages.length} in ${extractMs} ms`);

  // Boilerplate needs a document-wide view; use the sampled pages for it.
  const provisional = geometry.pages.map((p) => ({
    pageNo: p.pageNo,
    height: p.height,
    lines: [] as never[],
  }));
  void provisional;

  const parseStarted = Date.now();
  const firstPass = parsePages(geometry.pages);
  const boilerplate = detectBoilerplate(
    firstPass.results.map((r) => ({
      pageNo: r.page.pageNo,
      height: r.page.height,
      lines: r.lines,
    })),
  );
  const { results } = parsePages(geometry.pages, { boilerplate });
  const parseMs = Date.now() - parseStarted;

  console.log(`  parsed in ${parseMs} ms  (${(parseMs / geometry.pages.length).toFixed(0)} ms/page)`);
  if (boilerplate.patterns.length > 0) {
    console.log(`  boilerplate stripped: ${boilerplate.patterns.length} pattern(s)`);
    for (const p of boilerplate.patterns.slice(0, 4)) console.log(`      · ${p}`);
  }

  let totalTables = 0;
  let totalCells = 0;
  let lowConfidencePages = 0;

  for (const result of results) {
    const { page, blocks, tables } = result;
    totalTables += tables.length;
    totalCells += tables.reduce((n, t) => n + t.cells.length, 0);
    if (page.layoutConfidence < 0.6) lowConfidencePages += 1;

    const kinds = blocks.reduce<Record<string, number>>((acc, b) => {
      acc[b.kind] = (acc[b.kind] ?? 0) + 1;
      return acc;
    }, {});

    console.log(
      `\n── page ${String(page.pageNo).padStart(3)} ` +
        `│ cols ${page.columnCount} │ lines ${String(page.lines.length).padStart(3)} ` +
        `│ tables ${tables.length} │ conf ${bar(page.layoutConfidence)} ${page.layoutConfidence.toFixed(2)}` +
        (page.printedLabel ? ` │ label "${page.printedLabel}"` : ""),
    );
    console.log(
      `   signals: align ${page.layoutSignals.alignmentScore.toFixed(2)} · ` +
        `short ${page.layoutSignals.shortSegmentRatio.toFixed(2)} · ` +
        `numeric ${page.layoutSignals.numericSegmentRatio.toFixed(2)}`,
    );
    console.log(
      `   blocks: ${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`,
    );

    const heading = blocks.find((b) => b.kind === "heading");
    if (heading) console.log(`   first heading: "${heading.text.slice(0, 90)}"`);

    if (args.showLines) {
      const starts = new Set(tables.map((t) => t.lineStart));
      const ends = new Set(tables.map((t) => t.lineEnd));
      page.lines.slice(0, 40).forEach((line, i) => {
        const mark = starts.has(i) ? "┌TBL" : ends.has(i) ? "└TBL" : "    ";
        console.log(`  ${String(i).padStart(3)} ${mark} [${line.segments.length}] ${line.text.slice(0, 120)}`);
      });
    }

    if (args.showBlocks) {
      for (const block of blocks.slice(0, 14)) {
        const crumb = block.headingPath.slice(-2).join(" > ");
        console.log(
          `     ${block.kind.padEnd(11)} ${crumb ? `(${crumb.slice(0, 45)}) ` : ""}${block.text.replace(/\n/g, " ⏎ ").slice(0, 110)}`,
        );
      }
    }

    if (args.showTables) {
      for (const table of tables) {
        console.log(
          `\n   ┌ ${table.kind} ${table.rowCount}×${table.colCount} · header rows ${table.headerRowCount} · ` +
            `label cols ${table.rowLabelCols} · conf ${table.confidence.toFixed(2)}` +
            (table.continuationGroup !== null ? ` · cont#${table.continuationGroup}` : ""),
        );
        if (table.caption) console.log(`   │ caption:  ${table.caption.slice(0, 100)}`);
        console.log(`   │ unitHint: ${table.unitHint ?? "— none —"}`);
        if (table.reviewReasons.length) {
          for (const r of table.reviewReasons) console.log(`   │ ⚠ ${r}`);
        }
        table.colHeaderPaths.forEach((p, i) => {
          if (p.length) console.log(`   │ col ${i}: ${p.join("  ▸  ").slice(0, 120)}`);
        });
        console.log(
          tableToMarkdown(table)
            .split("\n")
            .slice(0, Number(process.env.ROWS ?? 12))
            .map((l) => `   │ ${l.slice(0, 160)}`)
            .join("\n"),
        );
        console.log("   └");
      }
    }
  }

  console.log(
    `\n▸ summary: ${totalTables} tables, ${totalCells} cells, ` +
      `${lowConfidencePages}/${results.length} pages below 0.6 layout confidence\n`,
  );

  if (args.json) {
    await writeFile(args.json, JSON.stringify(results, null, 2));
    console.log(`  wrote ${args.json}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
