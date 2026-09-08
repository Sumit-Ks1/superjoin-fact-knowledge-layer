/**
 * Deterministic table-fact harness.
 *
 *   npx tsx scripts/fact-debug.ts <pdf> [--from N] [--to N] [--show N]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { extractGeometry } from "../src/pdf/extract";
import { detectBoilerplate, parsePages } from "../src/pdf/parse";
import { extractTableFacts } from "../src/pipeline/extract/table";
import { inferFiscalCalendar } from "../src/pipeline/normalize/period";

const argv = process.argv.slice(2);
const file = argv.filter((a) => !a.startsWith("--"))[0];
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

const bytes = new Uint8Array(await readFile(path.resolve(file)));
const geometry = await extractGeometry(bytes, {
  fromPage: Number(flag("from") ?? 1),
  toPage: Number(flag("to") ?? 20),
});
const first = parsePages(geometry.pages);
const bp = detectBoilerplate(
  first.results.map((r) => ({ pageNo: r.page.pageNo, height: r.page.height, lines: r.lines })),
);
const { results } = parsePages(geometry.pages, { boilerplate: bp });

const allText = results.flatMap((r) => r.blocks.map((b) => b.text)).join("\n");
const calendar = inferFiscalCalendar(allText);
console.log(`\n▸ ${path.basename(file)}`);
console.log(`  fiscal calendar learned: ${calendar ? `month ${calendar.endMonth + 1} day ${calendar.endDay}` : "not stated"}`);

let facts = 0;
const issues: string[] = [];
const sample: string[] = [];

for (const r of results) {
  for (const table of r.tables) {
    const out = extractTableFacts(table, {
      documentSubject: "Delhivery Limited",
      fiscalCalendar: calendar,
      breadcrumb: "",
    });
    facts += out.facts.length;
    for (const i of out.issues) issues.push(`p${i.pageNo} ${i.kind}: ${i.detail.slice(0, 90)}`);
    for (const f of out.facts) {
      sample.push(
        `p${String(f.evidence.pageNo).padStart(3)} | ${f.predicateText.slice(0, 46).padEnd(46)} | ` +
          `${(f.valueRaw ?? "").padStart(12)} | base=${f.valueBase === null ? "—".padStart(16) : f.valueBase.toExponential(4).padStart(16)} | ` +
          `${(f.unit?.baseUnit ?? "?").padEnd(6)} | ${(f.periodLabel ?? "—").slice(0, 40).padEnd(40)} | ` +
          `${JSON.stringify(f.qualifiers).slice(0, 40)}`,
      );
    }
  }
}

console.log(`  ${facts} facts, ${issues.length} issues`);
const show = Number(flag("show") ?? 12);
for (const s of sample.slice(0, show)) console.log(`   ${s}`);
if (issues.length) {
  console.log("  issues:");
  for (const i of [...new Set(issues)].slice(0, 6)) console.log(`   · ${i}`);
}
