/**
 * The pipeline, as stages Inngest can call one at a time.
 *
 * Each stage is a pure-ish function of the database: it reads what earlier
 * stages wrote, does its work, writes its own rows, and records progress. That
 * shape is what makes retries safe and lets a 300-page document run inside a
 * platform that kills any single function after a minute.
 *
 * The split points are chosen around cost, not around code structure:
 *
 *   parse    Deterministic and fast (~2ms/page). Also establishes what the
 *            document is and whose figures it reports, which every later stage
 *            depends on.
 *   extract  Table facts are deterministic and run in the same step. Narrative
 *            facts need a model per chunk, so they are batched separately and
 *            each batch is independently retryable.
 *   embed    Cheap per call, slow in bulk, and entirely skippable — without it
 *            the exact-key channels still work.
 *   link     Corpus-wide, not per-document: a fact only becomes interesting
 *            when compared with one from somewhere else.
 */

import { eq, inArray, isNotNull, sql } from "drizzle-orm";

import { embed } from "@/ai/provider";
import { getDb } from "@/db/client";
import {
  chunks as chunksTable,
  docTables as docTablesTable,
  documents,
  facts as factsTable,
  type IssueKind,
} from "@/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { downloadDocument } from "@/lib/supabase";
import { extractGeometry, probeDocument } from "@/pdf/extract";
import { detectBoilerplate, parsePages } from "@/pdf/parse";

import { buildChunks } from "./chunk";
import { inferDocumentProfile } from "./extract/document";
import { extractNarrativeFacts } from "./extract/narrative";
import { extractTableFacts, type FactDraft } from "./extract/table";
import { adjudicate, type LinkableFact } from "./link/adjudicate";
import {
  arithmeticFindings,
  derivedPairs,
  keyCandidates,
  pairKey,
  similarityCandidates,
} from "./link/candidates";
import { parsePeriod, type FiscalCalendar } from "./normalize/period";
import {
  markStage,
  recordIssues,
  saveChunkEmbeddings,
  saveChunks,
  saveFactEmbeddings,
  saveFacts,
  saveLayout,
  saveRelations,
  setDocumentStatus,
  type RelationRow,
} from "./persist";

/* ── parse ────────────────────────────────────────────────────────────────── */

export type ParseOutcome = {
  pageCount: number;
  tableCount: number;
  chunkCount: number;
  subject: string;
  usable: boolean;
  detail: string;
  /** The document was deleted while the pipeline was running. Not an error. */
  gone?: boolean;
};

/**
 * Parses a document end to end and writes its layout, profile and chunks.
 *
 * Parse and chunk are one step because chunking needs the parsed pages, and
 * re-parsing to get them back would cost more than doing both at once.
 */
export async function runParse(documentId: string): Promise<ParseOutcome> {
  const db = getDb();
  await markStage(documentId, "parse", "running");

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);

  /*
   * The document can be deleted while its pipeline is in flight. That is a
   * user action, not a fault: the run ends quietly rather than retrying three
   * times against a row that will never come back.
   */
  if (!doc) {
    log.info("document deleted mid-run; stopping", { documentId, stage: "parse" });
    return {
      pageCount: 0,
      tableCount: 0,
      chunkCount: 0,
      subject: "",
      usable: false,
      gone: true,
      detail: "The document was deleted before parsing finished.",
    };
  }

  const bytes = await downloadDocument(doc.storagePath);

  const probe = await probeDocument(bytes);
  if (!probe.usable) {
    await recordIssues(documentId, doc.corpusId, [
      { kind: "stage_failed", detail: probe.detail, severity: "error" },
    ]);
    await markStage(documentId, "parse", "failed", { error: probe.detail });
    await setDocumentStatus(documentId, "failed", probe.detail);
    return {
      pageCount: probe.pageCount,
      tableCount: 0,
      chunkCount: 0,
      subject: doc.filename,
      usable: false,
      detail: probe.detail,
    };
  }

  const geometry = await extractGeometry(bytes);

  // Boilerplate needs a document-wide view, so the pages are parsed twice: once
  // to learn the running headers, once to strip them.
  const firstPass = parsePages(geometry.pages);
  const boilerplate = detectBoilerplate(
    firstPass.results.map((r) => ({
      pageNo: r.page.pageNo,
      height: r.page.height,
      lines: r.lines,
    })),
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

  const profile = await inferDocumentProfile(
    bodyText.slice(0, 40_000),
    doc.filename.replace(/\.pdf$/i, ""),
    prominent,
  );

  const { tableIdBySourceKey } = await saveLayout(documentId, results);

  const { chunks: chunkDrafts, tables: chunkTables } = buildChunks(results);

  // Chunk → table, via the same source key the extractor uses. Positional
  // matching would break the moment a table failed to persist.
  const tableIds = chunkDrafts.map((c) => {
    if (c.tableIndex === null) return null;
    const table = chunkTables[c.tableIndex]?.table;
    if (!table) return null;
    const key = `p${table.pageNo}:${Math.round(table.bbox.x0)},${Math.round(table.bbox.y0)}`;
    return tableIdBySourceKey.get(key) ?? null;
  });
  await saveChunks(documentId, chunkDrafts, tableIds);

  await db
    .update(documents)
    .set({
      pageCount: geometry.pageCount,
      fiscalYearEnd: profile.fiscalCalendar
        ? `${String(profile.fiscalCalendar.endMonth + 1).padStart(2, "0")}-${String(profile.fiscalCalendar.endDay).padStart(2, "0")}`
        : null,
      docType: profile.title,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));

  const lowConfidencePages = results.filter((r) => r.page.layoutConfidence < 0.5).length;
  if (lowConfidencePages > 0) {
    await recordIssues(documentId, doc.corpusId, [
      {
        kind: "chart_region_unreadable",
        severity: "info",
        detail: `${lowConfidencePages} page(s) have low layout confidence — typically infographic or chart pages. Facts from them are quarantined.`,
      },
    ]);
  }

  const tableCount = results.reduce((n, r) => n + r.tables.length, 0);
  await markStage(documentId, "parse", "done", {
    metrics: {
      pages: geometry.pageCount,
      tables: tableCount,
      subject: profile.subject,
      subjectSource: profile.source,
    },
  });
  await markStage(documentId, "chunk", "done", {
    metrics: { chunks: chunkDrafts.length },
  });

  return {
    pageCount: geometry.pageCount,
    tableCount,
    chunkCount: chunkDrafts.length,
    subject: profile.subject,
    usable: true,
    detail: probe.detail,
  };
}

/* ── extract ──────────────────────────────────────────────────────────────── */

/** Re-derives the parse so extraction can read grids the database flattens. */
async function reparse(documentId: string) {
  const db = getDb();
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) return null;

  const bytes = await downloadDocument(doc.storagePath);
  const geometry = await extractGeometry(bytes);
  const firstPass = parsePages(geometry.pages);
  const boilerplate = detectBoilerplate(
    firstPass.results.map((r) => ({ pageNo: r.page.pageNo, height: r.page.height, lines: r.lines })),
  );
  const { results } = parsePages(geometry.pages, { boilerplate });

  const fiscalCalendar: FiscalCalendar = doc.fiscalYearEnd
    ? {
        endMonth: Number(doc.fiscalYearEnd.slice(0, 2)) - 1,
        endDay: Number(doc.fiscalYearEnd.slice(3, 5)),
      }
    : null;

  return { doc, results, fiscalCalendar };
}

export type ExtractOutcome = {
  tableFacts: number;
  narrativeFacts: number;
  rejected: number;
  /** The document was deleted while the pipeline was running. Not an error. */
  gone?: boolean;
};

/**
 * Extracts every fact in a document.
 *
 * Table facts come first and always; narrative facts are attempted only if a
 * model is configured, and a failure there costs prose facts rather than the
 * document.
 */
export async function runExtract(
  documentId: string,
  options: { narrative?: boolean } = {},
): Promise<ExtractOutcome> {
  await markStage(documentId, "extract", "running");

  const reparsed = await reparse(documentId);
  if (!reparsed) {
    log.info("document deleted mid-run; stopping", { documentId, stage: "extract" });
    return { tableFacts: 0, narrativeFacts: 0, rejected: 0, gone: true };
  }
  const { doc, results, fiscalCalendar } = reparsed;

  const subject = doc.docType || doc.filename.replace(/\.pdf$/i, "");
  const drafts: FactDraft[] = [];
  const issueRows: { kind: IssueKind; detail: string; pageNo?: number }[] = [];

  for (const result of results) {
    for (const table of result.tables) {
      const breadcrumb =
        result.blocks.find((b) => b.tableIndex !== null && b.pageNo === table.pageNo)?.headingPath
          .join(" ▸ ") ?? "";

      const out = extractTableFacts(table, {
        documentSubject: subject,
        fiscalCalendar,
        breadcrumb,
      });
      drafts.push(...out.facts);
      for (const issue of out.issues) {
        issueRows.push({ kind: issue.kind, detail: issue.detail, pageNo: issue.pageNo });
      }
    }
  }

  const tableFacts = drafts.length;
  let rejected = 0;

  if (options.narrative !== false) {
    const { chunks: chunkDrafts } = buildChunks(results);
    const narrativeChunks = chunkDrafts.filter((c) => c.kind === "narrative" && c.factBearing);

    for (const chunk of narrativeChunks) {
      const out = await extractNarrativeFacts(chunk.text, {
        documentSubject: subject,
        fiscalCalendar,
        breadcrumb: chunk.breadcrumb,
        pageStart: chunk.pageStart,
        bbox: chunk.bboxUnion,
        sourceKey: `chunk:${chunk.ordinal}`,
      });
      if (out.skipped) break; // No model configured; stop rather than loop.
      drafts.push(...out.facts);
      rejected += out.rejected.length;

      for (const r of out.rejected.slice(0, 2)) {
        issueRows.push({
          kind: "quote_verification_failed",
          pageNo: chunk.pageStart,
          detail: `A proposed fact was discarded: ${r.reason}. Claim: "${r.claim.predicate}" = ${r.claim.value ?? "—"}.`,
        });
      }
    }
  }

  // Chunk ids are needed to attach facts to the text they came from.
  const db = getDb();
  const chunkRows = await db
    .select({ id: chunksTable.id, ordinal: chunksTable.ordinal })
    .from(chunksTable)
    .where(eq(chunksTable.documentId, documentId));
  const chunkIdByOrdinal = new Map(chunkRows.map((r) => [r.ordinal, r.id]));

  // Evidence points at a cell, so each fact's source key must resolve to the
  // stored table row.
  const tableRows = await db
    .select({ id: docTablesTable.id, sourceKey: docTablesTable.sourceKey })
    .from(docTablesTable)
    .where(eq(docTablesTable.documentId, documentId));
  const tableIdBySourceKey = new Map(tableRows.map((r) => [r.sourceKey, r.id]));

  await saveFacts(
    documentId,
    doc.corpusId,
    drafts,
    chunkIdByOrdinal,
    (draft) => {
      const match = draft.sourceKey.match(/^chunk:(\d+)$/);
      return match ? Number(match[1]) : null;
    },
    tableIdBySourceKey,
  );

  if (issueRows.length > 0) {
    // Deduplicated: one row per distinct message keeps the Quality screen readable.
    const seen = new Set<string>();
    const unique = issueRows.filter((r) => {
      const key = `${r.kind}:${r.pageNo}:${r.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await recordIssues(documentId, doc.corpusId, unique.slice(0, 200));
  }

  const narrativeFacts = drafts.length - tableFacts;
  await markStage(documentId, "extract", "done", {
    metrics: { tableFacts, narrativeFacts, rejected },
  });

  return { tableFacts, narrativeFacts, rejected };
}

/* ── embed ────────────────────────────────────────────────────────────────── */

/** One line per fact, the form similarity search compares. */
function renderFactForEmbedding(row: {
  subjectText: string;
  predicateText: string;
  valueRaw: string | null;
  periodLabel: string | null;
  qualifiers: Record<string, string>;
}): string {
  const parts = [row.subjectText, row.predicateText];
  if (row.valueRaw) parts.push(row.valueRaw);
  if (row.periodLabel) parts.push(row.periodLabel);
  for (const value of Object.values(row.qualifiers ?? {})) parts.push(value);
  return parts.join(" · ");
}

export async function runEmbed(documentId: string): Promise<{ facts: number; chunks: number }> {
  await markStage(documentId, "normalize", "running");
  const db = getDb();

  const factRows = await db
    .select({
      id: factsTable.id,
      subjectText: factsTable.subjectText,
      predicateText: factsTable.predicateText,
      valueRaw: factsTable.valueRaw,
      periodLabel: factsTable.periodLabel,
      qualifiers: factsTable.qualifiers,
    })
    .from(factsTable)
    .where(eq(factsTable.documentId, documentId));

  // Matches the provider's own batch size, so one slice is one API call.
  const BATCH = 100;
  let embedded = 0;

  for (let i = 0; i < factRows.length; i += BATCH) {
    const slice = factRows.slice(i, i + BATCH);
    const result = await embed(slice.map(renderFactForEmbedding));
    if (!result.ok) {
      // Similarity is an enhancement; the exact-key channels still work.
      await markStage(documentId, "normalize", "skipped", { error: result.detail });
      log.warn("embeddings unavailable; similarity linking disabled", { detail: result.detail });
      return { facts: embedded, chunks: 0 };
    }
    await saveFactEmbeddings(
      slice.map((row, k) => ({ factId: row.id, embedding: result.vectors[k] })),
    );
    embedded += slice.length;
  }

  const chunkRows = await db
    .select({ id: chunksTable.id, text: chunksTable.text })
    .from(chunksTable)
    .where(eq(chunksTable.documentId, documentId));

  let chunksEmbedded = 0;
  for (let i = 0; i < chunkRows.length; i += BATCH) {
    const slice = chunkRows.slice(i, i + BATCH);
    const result = await embed(slice.map((c) => c.text.slice(0, 6000)));
    if (!result.ok) break;
    await saveChunkEmbeddings(
      slice.map((row, k) => ({ chunkId: row.id, embedding: result.vectors[k] })),
    );
    chunksEmbedded += slice.length;
  }

  await markStage(documentId, "normalize", "done", {
    metrics: { facts: embedded, chunks: chunksEmbedded },
  });
  return { facts: embedded, chunks: chunksEmbedded };
}

/* ── link ─────────────────────────────────────────────────────────────────── */

type FactRow = typeof factsTable.$inferSelect;

function toLinkable(row: FactRow, calendarByDoc: Map<string, FiscalCalendar>): LinkableFact {
  return {
    id: row.id,
    documentId: row.documentId,
    subjectText: row.subjectText,
    predicateText: row.predicateText,
    valueRaw: row.valueRaw,
    valueNum: row.valueNum,
    valueBase: row.valueBase,
    modifier: row.modifier,
    unit: row.unit,
    qualifiers: row.qualifiers ?? {},
    period: parsePeriod(row.periodLabel ?? "", calendarByDoc.get(row.documentId) ?? null),
    claimKey: row.claimKey,
    relaxedKey: row.relaxedKey,
    confidence: row.confidence,
    quarantined: row.quarantined,
  };
}

export type LinkOutcome = {
  facts: number;
  pairs: number;
  relations: number;
  byType: Record<string, number>;
};

/**
 * Links every fact in a corpus.
 *
 * Corpus-wide by necessity: the finding that matters is two documents
 * disagreeing, which no per-document pass can see.
 */
export async function runLink(corpusId: string, documentIds: string[]): Promise<LinkOutcome> {
  const db = getDb();

  const rows = await db.select().from(factsTable).where(eq(factsTable.corpusId, corpusId));

  const docs = await db
    .select({ id: documents.id, fiscalYearEnd: documents.fiscalYearEnd })
    .from(documents)
    .where(eq(documents.corpusId, corpusId));

  const calendarByDoc = new Map<string, FiscalCalendar>(
    docs.map((d) => [
      d.id,
      d.fiscalYearEnd
        ? {
            endMonth: Number(d.fiscalYearEnd.slice(0, 2)) - 1,
            endDay: Number(d.fiscalYearEnd.slice(3, 5)),
          }
        : null,
    ]),
  );

  const linkable = rows.map((r) => toLinkable(r, calendarByDoc));
  const byId = new Map(linkable.map((f) => [f.id, f]));

  // Positional metadata lives on the evidence rows, not on the fact.
  const cells = await db.execute<{ fact_id: string; table_id: string | null; table_cell: { row: number; col: number } | null }>(
    sql`select fact_id, table_id, table_cell from evidence where document_id in (select id from documents where corpus_id = ${corpusId})`,
  );
  for (const cell of cells as unknown as { fact_id: string; table_id: string | null; table_cell: { row: number; col: number } | null }[]) {
    const fact = byId.get(cell.fact_id);
    if (!fact) continue;
    if (cell.table_id) fact.sourceKey = cell.table_id;
    if (cell.table_cell) {
      fact.rowIndex = cell.table_cell.row;
      fact.colIndex = cell.table_cell.col;
    }
  }

  const pairs = keyCandidates(linkable);
  const seen = new Set(pairs.map((p) => pairKey(p.a, p.b)));

  // Similarity: the channel that finds the same measure worded differently.
  const withEmbeddings = await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(sql`${factsTable.corpusId} = ${corpusId} and ${factsTable.embedding} is not null`)
    .limit(1);

  if (withEmbeddings.length > 0) {
    const neighbours = await db.execute<{ a: string; b: string; score: number }>(sql`
      select a.id as a, b.id as b, 1 - (a.embedding <=> b.embedding) as score
      from facts a
      join facts b
        on b.corpus_id = a.corpus_id
       and b.id > a.id
       and b.document_id <> a.document_id
      where a.corpus_id = ${corpusId}
        and a.embedding is not null
        and b.embedding is not null
        and 1 - (a.embedding <=> b.embedding) >= 0.86
      limit 4000
    `);

    const rowsOut = neighbours as unknown as { a: string; b: string; score: number }[];
    const resolved = rowsOut
      .map((n) => ({ a: byId.get(n.a), b: byId.get(n.b), score: Number(n.score) }))
      .filter((n): n is { a: LinkableFact; b: LinkableFact; score: number } => !!n.a && !!n.b);
    pairs.push(...similarityCandidates(resolved, seen));
  }

  const relationRows: RelationRow[] = [];
  const byType: Record<string, number> = {};

  for (const pair of pairs) {
    const verdict = adjudicate(pair.a, pair.b);
    // Nothing useful is learned from recording every non-comparison.
    if (verdict.type === "INSUFFICIENT_EVIDENCE" && verdict.confidence < 0.35) continue;

    byType[verdict.type] = (byType[verdict.type] ?? 0) + 1;
    relationRows.push({
      factA: pair.a.id,
      factB: pair.b.id,
      type: verdict.type,
      subtype: verdict.subtype,
      confidence: verdict.confidence,
      method: "rule",
      explanation: verdict.explanation,
      arithmetic: verdict.arithmetic ?? null,
      intraDocument: pair.a.documentId === pair.b.documentId,
    });
  }

  // The arithmetic channel: a printed total against the rows it sums.
  for (const finding of arithmeticFindings(linkable)) {
    if (finding.status === "components_unclear") continue;

    for (const derived of derivedPairs(finding)) {
      const type = finding.status === "consistent" ? "SUPPORTS_DERIVED" : "CONTRADICTS";
      byType[type] = (byType[type] ?? 0) + 1;
      relationRows.push({
        factA: derived.a.id,
        factB: derived.b.id,
        type,
        subtype: "arithmetic",
        confidence: finding.status === "consistent" ? 0.95 : 0.7,
        method: "arithmetic",
        explanation:
          finding.status === "consistent"
            ? `"${finding.total.predicateText}" equals the sum of the ${finding.components.length} rows above it, confirming every figure in that column was read correctly.`
            : `"${finding.total.predicateText}" is printed as ${finding.total.valueRaw}, but the ${finding.components.length} rows above it sum to a different amount (difference ${finding.residual.toPrecision(4)}).`,
        arithmetic: {
          stated: finding.total.valueBase,
          sum: finding.sum,
          residual: finding.residual,
          components: finding.components.map((c) => c.predicateText),
        },
        intraDocument: true,
      });
    }
  }

  const written = await saveRelations(corpusId, documentIds, relationRows);
  for (const documentId of documentIds) {
    await markStage(documentId, "link", "done", {
      metrics: { pairs: pairs.length, relations: written },
    });
    await setDocumentStatus(documentId, "ready");
  }

  return { facts: linkable.length, pairs: pairs.length, relations: written, byType };
}

/* ── convenience ──────────────────────────────────────────────────────────── */

/** Runs everything for one document, for local use and tests. */
export async function runAll(documentId: string, corpusId: string): Promise<void> {
  try {
    await setDocumentStatus(documentId, "processing");
    const parse = await runParse(documentId);
    if (!parse.usable) return;
    await runExtract(documentId);
    await runEmbed(documentId);
    await runLink(corpusId, [documentId]);
  } catch (error) {
    const detail = String((error as Error)?.message ?? error);
    log.error("pipeline failed", { documentId, error });
    await setDocumentStatus(documentId, "failed", detail);
    throw error;
  }
}

export { env };
