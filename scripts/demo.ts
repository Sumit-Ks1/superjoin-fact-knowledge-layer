/**
 * End-to-end demonstration, with no credentials and no network.
 *
 *   npx tsx scripts/demo.ts <pdf> [<pdf> …] [--pages N]
 *
 * Runs the real pipeline — parse, reconstruct tables, extract facts, normalise,
 * link, adjudicate — entirely in memory, and prints what it found under the
 * four headings the assignment asks about. Everything here is deterministic:
 * no model is called, so the output is reproducible and the numbers can be
 * checked against the source PDFs by hand.
 *
 * With a model key configured the deployed pipeline additionally extracts facts
 * from prose; that path needs the network and is exercised through the app.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { extractGeometry, probeDocument } from "../src/pdf/extract";
import { detectBoilerplate, parsePages } from "../src/pdf/parse";
import { guessSubject } from "../src/pipeline/extract/document";
import { extractTableFacts } from "../src/pipeline/extract/table";
import { adjudicate, type LinkableFact } from "../src/pipeline/link/adjudicate";
import { arithmeticFindings, keyCandidates, pairSalience } from "../src/pipeline/link/candidates";
import { inferFiscalCalendar, parsePeriod } from "../src/pipeline/normalize/period";

const argv = process.argv.slice(2);
const files = argv.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")),
);
const flagIndex = argv.indexOf("--pages");
const maxPages = flagIndex !== -1 ? Number(argv[flagIndex + 1]) : 40;

if (files.length === 0) {
  console.error("usage: npx tsx scripts/demo.ts <pdf> [<pdf> …] [--pages N]");
  process.exit(1);
}

const rule = (label: string) => `\n${"─".repeat(78)}\n${label}\n${"─".repeat(78)}`;

const all: LinkableFact[] = [];
const issues: string[] = [];
let factId = 0;

console.log(rule("DOCUMENTS"));

for (const file of files) {
  const bytes = new Uint8Array(await readFile(path.resolve(file)));
  const name = path.basename(file);

  const probe = await probeDocument(bytes);
  if (!probe.usable) {
    console.log(`  ${name}\n    rejected: ${probe.detail}`);
    continue;
  }

  const geometry = await extractGeometry(bytes, { fromPage: 1, toPage: maxPages });
  const firstPass = parsePages(geometry.pages);
  const boilerplate = detectBoilerplate(
    firstPass.results.map((r) => ({ pageNo: r.page.pageNo, height: r.page.height, lines: r.lines })),
  );
  const { results } = parsePages(geometry.pages, { boilerplate });

  const bodyText = results.flatMap((r) => r.blocks.map((b) => b.text)).join("\n");
  const prominent = [
    ...results
      .filter((r) => r.page.pageNo <= 1)
      .flatMap((r) => r.blocks.filter((b) => b.kind === "heading").map((b) => b.text)),
    ...firstPass.results.flatMap((r) =>
      r.lines.filter((l) => boilerplate.isBoilerplate(l, r.page.height)).map((l) => l.text),
    ),
  ];

  const calendar = inferFiscalCalendar(bodyText);
  const subject = guessSubject(bodyText, prominent)?.subject ?? name.replace(/\.pdf$/i, "");

  let facts = 0;
  let tables = 0;
  let charts = 0;

  for (const result of results) {
    for (const table of result.tables) {
      if (table.kind === "chart") charts += 1;
      else tables += 1;

      const out = extractTableFacts(table, {
        documentSubject: subject,
        fiscalCalendar: calendar,
        breadcrumb: "",
      });
      for (const issue of out.issues) issues.push(`${name} p${issue.pageNo}: ${issue.detail}`);

      for (const fact of out.facts) {
        facts += 1;
        all.push({
          id: `f${factId++}`,
          documentId: name,
          subjectText: fact.subjectText,
          predicateText: fact.predicateText,
          valueRaw: fact.valueRaw,
          valueNum: fact.valueNum,
          valueBase: fact.valueBase,
          modifier: fact.modifier,
          unit: fact.unit,
          qualifiers: fact.qualifiers,
          period: parsePeriod(fact.periodLabel ?? "", calendar),
          claimKey: fact.claimKey,
          relaxedKey: fact.relaxedKey,
          confidence: fact.confidence,
          quarantined: fact.quarantined,
          sourceKey: `${name}:${fact.sourceKey}`,
          rowIndex: fact.rowIndex,
          colIndex: fact.colIndex,
          contextLabel: fact.contextLabel,
        });
      }
    }
  }

  console.log(
    `  ${name}\n` +
      `    subject inferred: ${subject}\n` +
      `    fiscal year end:  ${calendar ? `${calendar.endMonth + 1}/${calendar.endDay} (learned from the document)` : "not stated — fiscal labels left unanchored"}\n` +
      `    ${results.length} pages · ${tables} tables · ${charts} charts refused · ${facts} facts`,
  );
}

/* ── the four cases ───────────────────────────────────────────────────────── */

const pairs = keyCandidates(all);
const verdicts = pairs.map((pair) => ({ pair, verdict: adjudicate(pair.a, pair.b) }));

const show = (
  heading: string,
  blurb: string,
  types: string[],
  limit = 3,
  crossOnly = false,
) => {
  console.log(rule(heading));
  console.log(`  ${blurb}\n`);

  const matching = verdicts
    .filter(({ verdict }) => types.includes(verdict.type))
    .filter(({ pair }) => !crossOnly || pair.a.documentId !== pair.b.documentId)
    .sort((x, y) => pairSalience(y.pair) - pairSalience(x.pair));

  if (matching.length === 0) {
    console.log("  none found");
    return;
  }

  console.log(`  ${matching.length} found. Showing ${Math.min(limit, matching.length)}:\n`);
  for (const { pair, verdict } of matching.slice(0, limit)) {
    console.log(`  · ${verdict.type}${verdict.subtype ? ` (${verdict.subtype})` : ""}`);
    console.log(`    ${pair.a.documentId} → ${pair.a.valueRaw} ${pair.a.unit?.raw ?? ""} [${pair.a.period.label || "no period"}]`);
    console.log(`    ${pair.b.documentId} → ${pair.b.valueRaw} ${pair.b.unit?.raw ?? ""} [${pair.b.period.label || "no period"}]`);
    console.log(`    ${verdict.explanation.replace(/\s+/g, " ").slice(0, 300)}\n`);
  }
};

show(
  "CASE 1 — CORROBORATION",
  "The same quantity stated by two sources, including in different units or wording.",
  ["CORROBORATES", "EQUIVALENT_RESTATEMENT"],
);

show(
  "CASE 2 — CONTRADICTION",
  "Same measure, same period, same stated scope — and different figures, with nothing to explain the gap.",
  ["CONTRADICTS"],
);

show(
  "CASE 3 — RECONCILED BY CONTEXT",
  "Figures that look like a disagreement until the period, scope, basis or unit is read.",
  [
    "RECONCILED_BY_TIME",
    "RECONCILED_BY_SCOPE",
    "RECONCILED_BY_UNIT",
    "RECONCILED_BY_BASIS",
    "RECONCILED_BY_DEFINITION",
    "SUPERSEDES",
  ],
);

/* ── case 4: what the system got wrong, and how it knows ──────────────────── */

console.log(rule("CASE 4 — FAILURES FOUND AND HANDLED"));

const findings = arithmeticFindings(all);
const consistent = findings.filter((f) => f.status === "consistent");
const inconsistent = findings.filter((f) => f.status === "inconsistent");
const unclear = findings.filter((f) => f.status === "components_unclear");

console.log(
  "  Self-audit: every printed total is checked against the rows it sums. When they\n" +
    "  agree, the whole column was read correctly — the column model, the signs and\n" +
    "  the units are all confirmed at once.\n",
);
console.log(
  `  ${findings.length} totals checked · ${consistent.length} confirmed · ` +
    `${inconsistent.length} genuinely inconsistent · ${unclear.length} components not identified\n`,
);

for (const finding of consistent.slice(0, 3)) {
  console.log(
    `  · "${finding.total.predicateText}" = sum of ${finding.components.length} rows, exactly ` +
      `(${finding.total.valueRaw} ${finding.total.unit?.raw ?? ""})`,
  );
}
for (const finding of inconsistent.slice(0, 3)) {
  console.log(
    `  · "${finding.total.predicateText}" printed as ${finding.total.valueRaw} but its rows sum ` +
      `differently (residual ${finding.residual.toPrecision(4)})`,
  );
}

const refusals = verdicts.filter(({ verdict }) => verdict.type === "INSUFFICIENT_EVIDENCE");
const bySubtype = new Map<string, number>();
for (const { verdict } of refusals) {
  const key = verdict.subtype ?? "unspecified";
  bySubtype.set(key, (bySubtype.get(key) ?? 0) + 1);
}

console.log("\n  Comparisons the system refused to make, by reason:");
for (const [subtype, count] of [...bySubtype.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(6)}  ${subtype}`);
}

if (issues.length > 0) {
  console.log("\n  Extraction problems recorded (first 6 of " + issues.length + "):");
  for (const issue of [...new Set(issues)].slice(0, 6)) {
    console.log(`    · ${issue.replace(/\s+/g, " ").slice(0, 140)}`);
  }
}

console.log(rule("SUMMARY"));
const counts = new Map<string, number>();
for (const { verdict } of verdicts) counts.set(verdict.type, (counts.get(verdict.type) ?? 0) + 1);
console.log(`  ${all.length} facts · ${pairs.length} pairs judged\n`);
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(6)}  ${type}`);
}
console.log();
