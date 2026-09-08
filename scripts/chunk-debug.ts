/**
 * Chunking harness.
 *
 *   npx tsx scripts/chunk-debug.ts <pdf> [--to N] [--show N] [--kind table|narrative]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildChunks } from "../src/pipeline/chunk";
import { extractGeometry, probeDocument } from "../src/pdf/extract";
import { detectBoilerplate, parsePages } from "../src/pdf/parse";

const argv = process.argv.slice(2);
const file = argv.filter((a) => !a.startsWith("--"))[0];
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

const bytes = new Uint8Array(await readFile(path.resolve(file)));
const probe = await probeDocument(bytes);
console.log(`\n▸ ${path.basename(file)} — ${probe.verdict} (${probe.detail})`);
if (!probe.usable) process.exit(0);

const to = Number(flag("to") ?? 40);
const geometry = await extractGeometry(bytes, { fromPage: 1, toPage: to });
const first = parsePages(geometry.pages);
const boilerplate = detectBoilerplate(
  first.results.map((r) => ({ pageNo: r.page.pageNo, height: r.page.height, lines: r.lines })),
);
const { results } = parsePages(geometry.pages, { boilerplate });

const started = Date.now();
const { chunks, tables } = buildChunks(results);
const ms = Date.now() - started;

const narrative = chunks.filter((c) => c.kind === "narrative");
const tableChunks = chunks.filter((c) => c.kind === "table");
const inert = chunks.filter((c) => !c.factBearing);
const lengths = narrative.map((c) => c.text.length).sort((a, b) => a - b);
const median = lengths.length ? lengths[lengths.length >> 1] : 0;

console.log(
  `  ${chunks.length} chunks in ${ms} ms  ·  ${narrative.length} narrative, ` +
    `${tableChunks.length} table (${tables.length} grids)  ·  ${inert.length} not fact-bearing`,
);
console.log(
  `  narrative length: median ${median}, max ${lengths[lengths.length - 1] ?? 0}, ` +
    `min ${lengths[0] ?? 0}`,
);
console.log(`  breadcrumbs present on ${chunks.filter((c) => c.breadcrumb !== "").length}/${chunks.length}`);

const show = Number(flag("show") ?? 0);
const kind = flag("kind");
const sample = chunks.filter((c) => !kind || c.kind === kind).slice(0, show);
for (const c of sample) {
  console.log(
    `\n  ── #${c.ordinal} ${c.kind} p${c.pageStart}-${c.pageEnd} ${c.text.length}ch ` +
      `factBearing=${c.factBearing}`,
  );
  console.log(c.text.split("\n").slice(0, 10).map((l) => `     ${l.slice(0, 140)}`).join("\n"));
}
