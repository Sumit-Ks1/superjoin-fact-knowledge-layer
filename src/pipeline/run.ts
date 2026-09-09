/**
 * The pipeline, as slices small enough to finish.
 *
 * Every stage reads what earlier stages wrote, does a bounded amount of work,
 * writes its own rows, and records progress. That shape makes retries safe —
 * and, more importantly, it is what lets a 300-page filing be processed on a
 * platform that stops any single function after sixty seconds.
 *
 * The split points are set by that limit, not by the shape of the code:
 *
 *   prepare   Samples the document to learn its running headers and its
 *             subject, then clears any previous run. Cheap regardless of size.
 *   parse     One page range at a time. Layout and chunks for those pages only.
 *   extract   Tables read back from the database — never re-parsed. Prose is
 *             batched separately, because each passage costs a model call.
 *   embed     Batched, and entirely skippable; without it the exact-key and
 *             arithmetic channels still work.
 *   link      Corpus-wide, not per-document: a fact only becomes interesting
 *             when compared with one from somewhere else.
 *
 * Every stage returns `gone: true` rather than throwing if the document was
 * deleted underneath it. That is a user action, not a fault.
 */

import { eq, sql } from "drizzle-orm";

import { embed } from "@/ai/provider";
import { getDb } from "@/db/client";
import {
  chunks as chunksTable,
  documents,
  facts as factsTable,
  type IssueKind,
} from "@/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { isForeignKeyViolation } from "@/lib/pg-error";
import { downloadDocument } from "@/lib/supabase";
import { boilerplateFromPatterns } from "@/pdf/boilerplate";
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
  clearDerived,
  clearFactsForChunks,
  clearFactsForSources,
  loadNarrativeChunks,
  loadTables,
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

/* ── deletion guard ─────────────────────────────────────────── */

/**
 * Runs a stage, treating "the document was deleted" as a normal ending.
 *
 * Every stage checks the document exists before it writes, but that leaves a
 * window: a user can delete it *while* the stage is running, and the next
 * insert fails on a foreign key. Without this the step is reported as failed and
 * retried three times for something the user did deliberately.
 *
 * The check and this guard cover different halves of the same problem. The
 * check makes the common case cheap; this makes the rare one correct.
 */
async function stoppingIfDeleted<T extends { gone?: boolean }>(
  documentId: string,
  stage: string,
  gone: T,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      log.info("document deleted mid-run; stopping", { documentId, stage });
      return gone;
    }
    throw error;
  }
}

/* ── prepare ──────────────────────────────────────────────────────────────── */

export type PrepareOutcome = {
  usable: boolean;
  detail: string;
  pageCount: number;
  subject: string;
  /** Plain strings, so the matcher can be rebuilt inside each later batch. */
  boilerplate: string[];
  gone?: boolean;
};

/**
 * Establishes what the page batches need, without parsing the whole file.
 *
 * Boilerplate and the document profile are both document-wide questions, and
 * both are answerable from a sample: a running header repeats by definition,
 * and a document names itself on its opening pages. Sampling keeps this step
 * far inside the time limit even for a very long filing.
 */
async function runPrepareInner(documentId: string): Promise<PrepareOutcome> {
  const db = getDb();

  /*
   * Existence is checked before anything is written. Every table in the
   * pipeline has a foreign key to `documents`, so marking a stage on a deleted
   * document is a constraint violation on the very first statement — which is
   * exactly how this failed in production.
   */
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    log.info("document deleted mid-run; stopping", { documentId, stage: "prepare" });
    return { usable: false, gone: true, detail: "", pageCount: 0, subject: "", boilerplate: [] };
  }

  await markStage(documentId, "parse", "running");

  const bytes = await downloadDocument(doc.storagePath);

  const probe = await probeDocument(bytes);
  if (!probe.usable) {
    await recordIssues(documentId, doc.corpusId, [
      { kind: "stage_failed", detail: probe.detail, severity: "error" },
    ]);
    await markStage(documentId, "parse", "failed", { error: probe.detail });
    await setDocumentStatus(documentId, "failed", probe.detail);
    return {
      usable: false,
      detail: probe.detail,
      pageCount: probe.pageCount,
      subject: "",
      boilerplate: [],
    };
  }

  // A re-run replaces everything. The batches below only append.
  await clearDerived(documentId);

  /*
   * Sample rather than read everything. Boilerplate needs enough pages to see
   * a repeat — the detector wants three — and the profile needs the opening
   * pages. Neither needs page 250.
   */
  const sampleTo = Math.min(probe.pageCount, 24);
  const sample = await extractGeometry(bytes, { fromPage: 1, toPage: sampleTo });
  const sampled = parsePages(sample.pages);
  const boilerplate = detectBoilerplate(
    sampled.results.map((r) => ({ pageNo: r.page.pageNo, height: r.page.height, lines: r.lines })),
  );

  const bodyText = sampled.results.flatMap((r) => r.blocks.map((b) => b.text)).join("\n");
  const prominent = [
    ...sampled.results
      .filter((r) => r.page.pageNo <= 1)
      .flatMap((r) => r.blocks.filter((b) => b.kind === "heading").map((b) => b.text)),
    ...sampled.results.flatMap((r) =>
      r.lines.filter((l) => boilerplate.isBoilerplate(l, r.page.height)).map((l) => l.text),
    ),
  ];

  const profile = await inferDocumentProfile(
    bodyText.slice(0, 40_000),
    doc.filename.replace(/\.pdf$/i, ""),
    prominent,
  );

  await db
    .update(documents)
    .set({
      pageCount: probe.pageCount,
      fiscalYearEnd: profile.fiscalCalendar
        ? `${String(profile.fiscalCalendar.endMonth + 1).padStart(2, "0")}-${String(profile.fiscalCalendar.endDay).padStart(2, "0")}`
        : null,
      docType: profile.title,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));

  return {
    usable: true,
    detail: probe.detail,
    pageCount: probe.pageCount,
    subject: profile.subject,
    boilerplate: boilerplate.patterns,
  };
}

/* ── parse, one page range at a time ──────────────────────────────────────── */

export type ParseBatchOutcome = {
  tables: number;
  chunks: number;
  lowConfidencePages: number;
  gone?: boolean;
};

/**
 * Parses one slice of pages and stores its layout and chunks.
 *
 * The slice is what makes this survivable: a hundred-page filing takes minutes
 * to parse in one go, twenty pages take seconds, and Inngest keeps the state
 * between slices.
 *
 * The cost is at the seams. A paragraph spanning a boundary becomes two chunks
 * instead of one — about one paragraph per slice. No figure is lost; at worst a
 * sentence that qualifies one sits in the neighbouring chunk.
 */
async function runParseBatchInner(
  documentId: string,
  fromPage: number,
  toPage: number,
  boilerplatePatterns: string[],
  chunkOrdinalOffset: number,
): Promise<ParseBatchOutcome> {
  const db = getDb();

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    log.info("document deleted mid-run; stopping", { documentId, stage: "parse" });
    return { tables: 0, chunks: 0, lowConfidencePages: 0, gone: true };
  }

  const bytes = await downloadDocument(doc.storagePath);
  const geometry = await extractGeometry(bytes, { fromPage, toPage });
  const { results } = parsePages(geometry.pages, {
    boilerplate: boilerplateFromPatterns(boilerplatePatterns),
  });

  const { tableIdBySourceKey } = await saveLayout(documentId, results);

  const { chunks: drafts, tables: chunkTables } = buildChunks(results);
  const offsetDrafts = drafts.map((draft) => ({
    ...draft,
    ordinal: draft.ordinal + chunkOrdinalOffset,
  }));

  const tableIds = offsetDrafts.map((chunk) => {
    if (chunk.tableIndex === null) return null;
    const table = chunkTables[chunk.tableIndex]?.table;
    if (!table) return null;
    const key = `p${table.pageNo}:${Math.round(table.bbox.x0)},${Math.round(table.bbox.y0)}`;
    return tableIdBySourceKey.get(key) ?? null;
  });
  await saveChunks(documentId, offsetDrafts, tableIds);

  return {
    tables: results.reduce((n, r) => n + r.tables.length, 0),
    chunks: offsetDrafts.length,
    lowConfidencePages: results.filter((r) => r.page.layoutConfidence < 0.5).length,
  };
}

/* ── extract ──────────────────────────────────────────────────────────────── */

function fiscalCalendarOf(fiscalYearEnd: string | null): FiscalCalendar {
  if (!fiscalYearEnd) return null;
  return {
    endMonth: Number(fiscalYearEnd.slice(0, 2)) - 1,
    endDay: Number(fiscalYearEnd.slice(3, 5)),
  };
}

export type ExtractOutcome = { facts: number; processed: number; gone?: boolean };

/**
 * Reads every stored grid into facts.
 *
 * Works from the reconstructed cells the parse stage already saved. This used
 * to re-download the PDF and rebuild every grid from geometry — a second full
 * parse of work already done, and the single biggest reason the pipeline could
 * not finish inside one invocation.
 */
async function runExtractTablesInner(
  documentId: string,
  offset = 0,
  limit = Number.MAX_SAFE_INTEGER,
): Promise<ExtractOutcome> {
  const db = getDb();

  // Existence before any write; see `runPrepare`.
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    log.info("document deleted mid-run; stopping", { documentId, stage: "extract" });
    return { facts: 0, processed: 0, gone: true };
  }

  if (offset === 0) await markStage(documentId, "extract", "running");

  const all = await loadTables(documentId);
  const tables = all.slice(offset, offset + limit);
  if (tables.length === 0) return { facts: 0, processed: 0 };

  /*
   * Clear this batch's previous output before rewriting it. A slice that failed
   * partway is retried from the start, and appending twice would give the
   * document duplicate facts that then corroborate each other.
   */
  await clearFactsForSources(
    documentId,
    tables.map((t) => t.sourceKey),
  );

  const subject = doc.docType || doc.filename.replace(/\.pdf$/i, "");
  const fiscalCalendar = fiscalCalendarOf(doc.fiscalYearEnd);

  const drafts: FactDraft[] = [];
  const issueRows: { kind: IssueKind; detail: string; pageNo?: number }[] = [];

  for (const table of tables) {
    const out = extractTableFacts(table, {
      documentSubject: subject,
      fiscalCalendar,
      breadcrumb: table.caption ?? "",
    });
    drafts.push(...out.facts);
    for (const issue of out.issues) {
      issueRows.push({ kind: issue.kind, detail: issue.detail, pageNo: issue.pageNo });
    }
  }

  const tableIdBySourceKey = new Map(tables.map((t) => [t.sourceKey, t.id]));
  await saveFacts(documentId, doc.corpusId, drafts, new Map(), () => null, tableIdBySourceKey);

  if (issueRows.length > 0) {
    const seen = new Set<string>();
    const unique = issueRows.filter((row) => {
      const key = `${row.kind}:${row.pageNo}:${row.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await recordIssues(documentId, doc.corpusId, unique.slice(0, 200));
  }

  return { facts: drafts.length, processed: tables.length };
}

export type NarrativeOutcome = {
  facts: number;
  rejected: number;
  processed: number;
  skipped: boolean;
  gone?: boolean;
};

/**
 * Extracts prose facts from one slice of chunks.
 *
 * Batched because each chunk costs a model call, and a long filing has a couple
 * of hundred fact-bearing passages. Sequentially that is minutes of wall time —
 * fine for the pipeline as a whole, impossible for one invocation.
 */
async function runExtractNarrativeInner(
  documentId: string,
  offset: number,
  limit: number,
): Promise<NarrativeOutcome> {
  const db = getDb();
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) return { facts: 0, rejected: 0, processed: 0, skipped: false, gone: true };

  const slice = await loadNarrativeChunks(documentId, offset, limit);
  if (slice.length === 0) return { facts: 0, rejected: 0, processed: 0, skipped: false };

  const subject = doc.docType || doc.filename.replace(/\.pdf$/i, "");
  const fiscalCalendar = fiscalCalendarOf(doc.fiscalYearEnd);

  const drafts: FactDraft[] = [];
  const issueRows: { kind: IssueKind; detail: string; pageNo?: number }[] = [];
  let rejected = 0;

  for (const chunk of slice) {
    const out = await extractNarrativeFacts(chunk.text, {
      documentSubject: subject,
      fiscalCalendar,
      breadcrumb: chunk.breadcrumb,
      pageStart: chunk.pageStart,
      bbox: chunk.bboxUnion,
      sourceKey: `chunk:${chunk.ordinal}`,
    });

    // No model configured: stop rather than repeating the same no-op.
    if (out.skipped) return { facts: 0, rejected: 0, processed: 0, skipped: true };

    drafts.push(...out.facts);
    rejected += out.rejected.length;
    for (const item of out.rejected.slice(0, 2)) {
      issueRows.push({
        kind: "quote_verification_failed",
        pageNo: chunk.pageStart,
        detail: `A proposed fact was discarded: ${item.reason}. Claim: "${item.claim.predicate}".`,
      });
    }
  }

  // Same reason as the table batches: a retry must replace, not append.
  await clearFactsForChunks(
    documentId,
    slice.map((c) => c.id),
  );

  if (drafts.length > 0) {
    const chunkIdByOrdinal = new Map(slice.map((c) => [c.ordinal, c.id]));
    await saveFacts(
      documentId,
      doc.corpusId,
      drafts,
      chunkIdByOrdinal,
      (draft) => {
        const match = draft.sourceKey.match(/^chunk:(\d+)$/);
        return match ? Number(match[1]) : null;
      },
      new Map(),
    );
  }

  if (issueRows.length > 0) await recordIssues(documentId, doc.corpusId, issueRows.slice(0, 50));

  return { facts: drafts.length, rejected, processed: slice.length, skipped: false };
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

export type EmbedOutcome = {
  facts: number;
  processed: number;
  skipped: boolean;
  detail?: string;
  gone?: boolean;
};

/**
 * Embeds one slice of a document's facts.
 *
 * Batched for the same reason as everything else, and skippable for a different
 * one: similarity is an enhancement. When the provider refuses — an exhausted
 * free quota, most often — the stage is marked skipped and the pipeline carries
 * on, because the exact-key, reconciliation and arithmetic channels do not
 * depend on it.
 */
async function runEmbedBatchInner(
  documentId: string,
  offset: number,
  limit: number,
): Promise<EmbedOutcome> {
  const db = getDb();

  // Existence before any write; see `runPrepare`.
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc) {
    log.info("document deleted mid-run; stopping", { documentId, stage: "normalize" });
    return { facts: 0, processed: 0, skipped: false, gone: true };
  }

  if (offset === 0) await markStage(documentId, "normalize", "running");

  const rows = await db
    .select({
      id: factsTable.id,
      subjectText: factsTable.subjectText,
      predicateText: factsTable.predicateText,
      valueRaw: factsTable.valueRaw,
      periodLabel: factsTable.periodLabel,
      qualifiers: factsTable.qualifiers,
    })
    .from(factsTable)
    .where(eq(factsTable.documentId, documentId))
    .orderBy(factsTable.id)
    .limit(limit)
    .offset(offset);

  if (rows.length === 0) return { facts: 0, processed: 0, skipped: false };

  const result = await embed(rows.map(renderFactForEmbedding));
  if (!result.ok) {
    await markStage(documentId, "normalize", "skipped", { error: result.detail });
    log.warn("embeddings unavailable; similarity linking disabled", { detail: result.detail });
    return { facts: 0, processed: 0, skipped: true, detail: result.detail };
  }

  await saveFactEmbeddings(rows.map((row, k) => ({ factId: row.id, embedding: result.vectors[k] })));
  return { facts: rows.length, processed: rows.length, skipped: false };
}

/**
 * Chunk embeddings, for passage retrieval. Best effort; never fails a run.
 *
 * Sliced like every other stage, and for the same reason: a single call over
 * every chunk in a long filing is one unit of work the platform's execution
 * limit will not accommodate. `orderBy` is what makes the offset meaningful —
 * without it Postgres may return a different window each time and the loop
 * would re-embed some chunks and never reach others.
 */
export async function runEmbedChunks(
  documentId: string,
  offset: number,
  limit: number,
): Promise<{ processed: number; skipped: boolean }> {
  const db = getDb();
  const rows = await db
    .select({ id: chunksTable.id, text: chunksTable.text })
    .from(chunksTable)
    .where(eq(chunksTable.documentId, documentId))
    .orderBy(chunksTable.id)
    .limit(limit)
    .offset(offset);

  if (rows.length === 0) return { processed: 0, skipped: false };

  const result = await embed(rows.map((c) => c.text.slice(0, 6000)));
  // Chunk vectors are a convenience for reading passages back, so an exhausted
  // quota stops the loop rather than retrying it batch after batch.
  if (!result.ok) return { processed: 0, skipped: true };

  await saveChunkEmbeddings(
    rows.map((row, k) => ({ chunkId: row.id, embedding: result.vectors[k] })),
  );
  return { processed: rows.length, skipped: false };
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
    /*
     * Read straight off the row. Two rules depend on it: a grid never
     * contradicts itself, and a printed total may only be summed against rows
     * from its own column. Losing it silently turns both off — the pairs still
     * get judged, just wrongly.
     */
    sourceKey: row.sourceKey ?? undefined,
    rowIndex: row.rowIndex ?? undefined,
    colIndex: row.colIndex ?? undefined,
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


/* ── guarded entry points ─────────────────────────────────────── */

export function runPrepare(documentId: string): Promise<PrepareOutcome> {
  return stoppingIfDeleted(
    documentId,
    "prepare",
    { usable: false, gone: true, detail: "", pageCount: 0, subject: "", boilerplate: [] },
    () => runPrepareInner(documentId),
  );
}

export function runParseBatch(
  documentId: string,
  fromPage: number,
  toPage: number,
  boilerplatePatterns: string[],
  chunkOrdinalOffset: number,
): Promise<ParseBatchOutcome> {
  return stoppingIfDeleted(
    documentId,
    `parse:${fromPage}-${toPage}`,
    { tables: 0, chunks: 0, lowConfidencePages: 0, gone: true },
    () => runParseBatchInner(documentId, fromPage, toPage, boilerplatePatterns, chunkOrdinalOffset),
  );
}

export function runExtractTables(
  documentId: string,
  offset = 0,
  limit = Number.MAX_SAFE_INTEGER,
): Promise<ExtractOutcome> {
  return stoppingIfDeleted(
    documentId,
    `extract-tables:${offset}`,
    { facts: 0, processed: 0, gone: true },
    () => runExtractTablesInner(documentId, offset, limit),
  );
}

export function runExtractNarrative(
  documentId: string,
  offset: number,
  limit: number,
): Promise<NarrativeOutcome> {
  return stoppingIfDeleted(
    documentId,
    `extract-prose:${offset}`,
    { facts: 0, rejected: 0, processed: 0, skipped: false, gone: true },
    () => runExtractNarrativeInner(documentId, offset, limit),
  );
}

export function runEmbedBatch(
  documentId: string,
  offset: number,
  limit: number,
): Promise<EmbedOutcome> {
  return stoppingIfDeleted(
    documentId,
    `embed:${offset}`,
    { facts: 0, processed: 0, skipped: false, gone: true },
    () => runEmbedBatchInner(documentId, offset, limit),
  );
}

/* ── convenience ─────────────────────────────────────────────── */

/**
 * Runs every stage for one document, in one process.
 *
 * For local use and tests. In production Inngest drives the same functions, one
 * step per invocation, which is what keeps each slice inside the platform's
 * time limit — here they simply run back to back.
 */
export async function runAll(documentId: string, corpusId: string): Promise<void> {
  try {
    await setDocumentStatus(documentId, "processing");

    const prepared = await runPrepare(documentId);
    if (!prepared.usable) return;

    const pageBatch = Math.max(1, env.parsePageBatch);
    let chunkOffset = 0;
    for (let from = 1; from <= prepared.pageCount; from += pageBatch) {
      const to = Math.min(from + pageBatch - 1, prepared.pageCount);
      const batch = await runParseBatch(
        documentId,
        from,
        to,
        prepared.boilerplate,
        chunkOffset,
      );
      if (batch.gone) return;
      chunkOffset += batch.chunks;
    }
    await markStage(documentId, "parse", "done", { metrics: { pages: prepared.pageCount } });
    await markStage(documentId, "chunk", "done", { metrics: { chunks: chunkOffset } });

    const tableBatch = Math.max(1, env.extractTableBatch);
    for (let offset = 0; ; offset += tableBatch) {
      const out = await runExtractTables(documentId, offset, tableBatch);
      if (out.gone || out.processed === 0) break;
    }

    const chunkBatch = Math.max(1, env.extractChunkBatch);
    for (let offset = 0; ; offset += chunkBatch) {
      const out = await runExtractNarrative(documentId, offset, chunkBatch);
      if (out.gone || out.skipped || out.processed === 0) break;
    }
    await markStage(documentId, "extract", "done");

    const embedBatch = Math.max(1, env.embedFactBatch);
    let embedSkipped = false;
    for (let offset = 0; ; offset += embedBatch) {
      const out = await runEmbedBatch(documentId, offset, embedBatch);
      if (out.gone || out.skipped || out.processed === 0) {
        embedSkipped = out.skipped;
        if (!out.skipped) await markStage(documentId, "normalize", "done");
        break;
      }
    }

    if (!embedSkipped) {
      const chunkEmbedBatch = Math.max(1, env.embedChunkBatch);
      for (let offset = 0; ; offset += chunkEmbedBatch) {
        const out = await runEmbedChunks(documentId, offset, chunkEmbedBatch);
        if (out.skipped || out.processed === 0) break;
      }
    }

    await runLink(corpusId, [documentId]);
  } catch (error) {
    const detail = String((error as Error)?.message ?? error);
    log.error("pipeline failed", { documentId, error });
    await setDocumentStatus(documentId, "failed", detail);
    throw error;
  }
}