/**
 * Writing pipeline results to Postgres.
 *
 * Every function here is idempotent, because Inngest retries steps and a
 * retried step must not double-write. The pattern is delete-then-insert scoped
 * to one document: a stage owns its own rows and replaces them wholesale, which
 * is simpler to reason about than upserting by natural key and cannot leave
 * half-updated state behind.
 *
 * Vocabularies — entities, predicates, qualifier keys — are the exception.
 * They are shared across documents and grow as the corpus does, so they are
 * upserted and never deleted.
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  blocks,
  corpora,
  chunks,
  docTables,
  documentStages,
  documents,
  entities,
  evidence,
  facts,
  issues,
  pages,
  predicates,
  qualifierKeys,
  relations,
  type BBox,
  type IssueKind,
  type PipelineStage,
  type TableCell,
} from "@/db/schema";
import { log } from "@/lib/logger";
import { canonicalize } from "./normalize/text";
import type { ChunkDraft } from "./chunk";
import type { FactDraft } from "./extract/table";
import type { PageResult } from "@/pdf/parse";

type Db = ReturnType<typeof getDb>;

/* ── stage tracking ───────────────────────────────────────────────────────── */

/** Postgres foreign-key violation. */
const FK_VIOLATION = "23503";

/**
 * Records stage progress.
 *
 * Tolerates the document having been deleted underneath a running pipeline.
 * This is an insert with a foreign key, so a deleted document turns the very
 * first line of the parse stage into a constraint violation — which Inngest
 * would then retry three times before reporting a failure that is really just
 * "the user changed their mind". Recording progress for something that no
 * longer exists is a no-op by definition, so it is treated as one.
 */
export async function markStage(
  documentId: string,
  stage: PipelineStage,
  status: "pending" | "running" | "done" | "failed" | "skipped",
  extra: { error?: string; progress?: number; metrics?: Record<string, number | string> } = {},
): Promise<void> {
  const db = getDb();
  const now = new Date();
  try {
    await db
    .insert(documentStages)
    .values({
      documentId,
      stage,
      status,
      progress: extra.progress ?? (status === "done" ? 1 : 0),
      error: extra.error ?? null,
      metrics: extra.metrics ?? null,
      startedAt: status === "running" ? now : null,
      finishedAt: status === "done" || status === "failed" ? now : null,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [documentStages.documentId, documentStages.stage],
      set: {
        status,
        progress: extra.progress ?? (status === "done" ? 1 : 0),
        error: extra.error ?? null,
        metrics: extra.metrics ?? null,
        // Attempt count is what tells a flaky stage from a broken one.
        attempts: sql`${documentStages.attempts} + 1`,
        finishedAt: status === "done" || status === "failed" ? now : null,
      },
    });
  } catch (error) {
    if ((error as { code?: string })?.code === FK_VIOLATION) {
      log.info("stage skipped; document was deleted mid-run", { documentId, stage });
      return;
    }
    throw error;
  }
}

/**
 * Documents in a corpus that a linking pass should finish.
 *
 * Linking is corpus-wide and debounced, so several requests collapse into one
 * and the surviving event names only its own document. Deriving the list from
 * the corpus instead means a document whose request was debounced away still
 * gets its link stage recorded and its status cleared — otherwise it sits at
 * "processing" forever despite having been linked successfully.
 *
 * Only documents that finished extraction qualify. One still mid-pipeline will
 * send its own request when it gets there, and one that failed must stay
 * failed.
 */
export async function listLinkableDocuments(corpusId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .innerJoin(documentStages, eq(documentStages.documentId, documents.id))
    .where(
      and(
        eq(documents.corpusId, corpusId),
        eq(documentStages.stage, "extract"),
        eq(documentStages.status, "done"),
        notInArray(documents.status, ["failed", "cancelled"]),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

/** Is the document still there? Cheap guard for a pipeline that may outlive it. */
export async function documentExists(documentId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  return rows.length > 0;
}

export async function setDocumentStatus(
  documentId: string,
  status: "uploaded" | "processing" | "ready" | "failed" | "cancelled",
  error?: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(documents)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(documents.id, documentId));
}

export async function recordIssues(
  documentId: string,
  corpusId: string,
  rows: { kind: IssueKind; detail: string; pageNo?: number | null; severity?: "info" | "warning" | "error"; sample?: Record<string, unknown> }[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  await db.insert(issues).values(
    rows.map((row) => ({
      documentId,
      corpusId,
      kind: row.kind,
      detail: row.detail,
      pageNo: row.pageNo ?? null,
      severity: row.severity ?? "warning",
      sample: row.sample ?? null,
    })),
  );
}

/* ── layout ───────────────────────────────────────────────────────────────── */

export type SavedLayout = {
  /** Table id by the `sourceKey` the extractor stamps on its facts. */
  tableIdBySourceKey: Map<string, string>;
};

/**
 * Replaces a document's parsed layout.
 *
 * Cascades handle the children: deleting a page removes nothing else, but
 * deleting the document's blocks and tables must happen explicitly because
 * chunks and facts reference them.
 */
export async function saveLayout(
  documentId: string,
  results: PageResult[],
): Promise<SavedLayout> {
  const db = getDb();

  await db.delete(pages).where(eq(pages.documentId, documentId));
  await db.delete(blocks).where(eq(blocks.documentId, documentId));
  await db.delete(docTables).where(eq(docTables.documentId, documentId));

  if (results.length > 0) {
    await db.insert(pages).values(
      results.map((r) => ({
        documentId,
        pageNo: r.page.pageNo,
        width: r.page.width,
        height: r.page.height,
        columnCount: r.page.columnCount,
        layoutConfidence: r.page.layoutConfidence,
        layoutSignals: r.page.layoutSignals as unknown as Record<string, number>,
        printedLabel: r.page.printedLabel,
      })),
    );
  }

  const tableIdBySourceKey = new Map<string, string>();

  for (const result of results) {
    for (const table of result.tables) {
      // Must match the key the extractor stamps on each fact.
      const sourceKey = `p${table.pageNo}:${Math.round(table.bbox.x0)},${Math.round(table.bbox.y0)}`;

      const [row] = await db
        .insert(docTables)
        .values({
          documentId,
          sourceKey,
          pageStart: table.pageNo,
          pageEnd: table.pageNo,
          caption: table.caption,
          unitHint: table.unitHint,
          rowCount: table.rowCount,
          colCount: table.colCount,
          cells: table.cells as TableCell[],
          colHeaderPaths: table.colHeaderPaths,
          rowLabelCols: table.rowLabelCols,
          confidence: table.confidence,
          needsReview: table.needsReview,
        })
        .returning({ id: docTables.id });

      tableIdBySourceKey.set(sourceKey, row.id);
    }

    if (result.blocks.length > 0) {
      await db.insert(blocks).values(
        result.blocks.map((b) => ({
          documentId,
          pageNo: b.pageNo,
          ordinal: b.ordinal,
          kind: b.kind,
          text: b.text,
          bbox: b.bbox,
          headingPath: b.headingPath,
          fontSize: b.fontSize,
        })),
      );
    }
  }

  return { tableIdBySourceKey };
}

/* ── chunks ───────────────────────────────────────────────────────────────── */

export async function saveChunks(
  documentId: string,
  drafts: ChunkDraft[],
  tableIds: (string | null)[],
): Promise<Map<number, string>> {
  const db = getDb();
  await db.delete(chunks).where(eq(chunks.documentId, documentId));

  const idByOrdinal = new Map<number, string>();
  if (drafts.length === 0) return idByOrdinal;

  // Batched: a 300-chunk document in one statement risks the parameter cap.
  const BATCH = 50;
  for (let i = 0; i < drafts.length; i += BATCH) {
    const slice = drafts.slice(i, i + BATCH);
    const rows = await db
      .insert(chunks)
      .values(
        slice.map((c, k) => ({
          documentId,
          ordinal: c.ordinal,
          kind: c.kind,
          breadcrumb: c.breadcrumb,
          text: c.text,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          bboxUnion: c.bboxUnion,
          tokenCount: c.tokenCount,
          contentHash: c.contentHash,
          tableId: tableIds[i + k] ?? null,
          factBearing: c.factBearing,
        })),
      )
      .returning({ id: chunks.id, ordinal: chunks.ordinal });
    for (const row of rows) idByOrdinal.set(row.ordinal, row.id);
  }

  return idByOrdinal;
}

export async function saveChunkEmbeddings(
  updates: { chunkId: string; embedding: number[] }[],
): Promise<void> {
  const db = getDb();
  for (const { chunkId, embedding } of updates) {
    await db.update(chunks).set({ embedding }).where(eq(chunks.id, chunkId));
  }
}

/* ── vocabularies ─────────────────────────────────────────────────────────── */

/**
 * Resolves a name to a canonical entity, creating it if new.
 *
 * Matching is on the canonical form, so "Delhivery Limited" and "DELHIVERY
 * LIMITED" resolve to one entity while "Delhivery Logistics" stays separate.
 * Nothing here merges names that merely look similar — that is a judgement the
 * linking stage makes with evidence, not something to do silently at write time.
 */
export async function resolveEntity(
  corpusId: string,
  name: string,
  kind = "organization",
): Promise<string | null> {
  const canonical = canonicalize(name);
  if (canonical === "") return null;

  const db = getDb();
  const existing = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.corpusId, corpusId), eq(entities.canonicalKey, canonical)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const [row] = await db
    .insert(entities)
    .values({ corpusId, canonicalName: name, canonicalKey: canonical, type: kind })
    .onConflictDoNothing()
    .returning({ id: entities.id });

  if (row) return row.id;

  // Lost a race with a concurrent insert; read it back.
  const retry = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.corpusId, corpusId), eq(entities.canonicalKey, canonical)))
    .limit(1);
  return retry[0]?.id ?? null;
}

export async function resolvePredicate(corpusId: string, label: string): Promise<string | null> {
  const canonical = canonicalize(label);
  if (canonical === "") return null;

  const db = getDb();
  const existing = await db
    .select({ id: predicates.id })
    .from(predicates)
    .where(and(eq(predicates.corpusId, corpusId), eq(predicates.canonicalKey, canonical)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const [row] = await db
    .insert(predicates)
    .values({ corpusId, canonicalLabel: label, canonicalKey: canonical })
    .onConflictDoNothing()
    .returning({ id: predicates.id });
  if (row) return row.id;

  const retry = await db
    .select({ id: predicates.id })
    .from(predicates)
    .where(and(eq(predicates.corpusId, corpusId), eq(predicates.canonicalKey, canonical)))
    .limit(1);
  return retry[0]?.id ?? null;
}

/**
 * Registers qualifier keys as they are encountered.
 *
 * This is the schema evolving at runtime: a document that qualifies its figures
 * by a dimension no previous document used adds that key here, and it becomes
 * visible in the UI as a filter without a migration.
 */
export async function registerQualifierKeys(
  corpusId: string,
  keys: Map<string, string>,
): Promise<void> {
  if (keys.size === 0) return;
  const db = getDb();
  await db
    .insert(qualifierKeys)
    .values(
      [...keys.entries()].map(([key, example]) => ({
        corpusId,
        key,
        sampleValues: [example],
        occurrences: 1,
      })),
    )
    .onConflictDoUpdate({
      target: [qualifierKeys.corpusId, qualifierKeys.key],
      set: { occurrences: sql`${qualifierKeys.occurrences} + 1` },
    });
}

/* ── facts ────────────────────────────────────────────────────────────────── */

export type SavedFact = { id: string; draft: FactDraft };

/**
 * Replaces a document's facts and their evidence.
 *
 * Relations referencing the old facts are removed by cascade, which is correct:
 * a re-extracted document must be re-linked, and a relation pointing at a fact
 * that no longer exists would be worse than none.
 */
export async function saveFacts(
  documentId: string,
  corpusId: string,
  drafts: FactDraft[],
  chunkIdByOrdinal: Map<number, string>,
  chunkOrdinalByFact: (draft: FactDraft) => number | null,
  tableIdBySourceKey: Map<string, string>,
): Promise<SavedFact[]> {
  const db = getDb();
  await db.delete(facts).where(eq(facts.documentId, documentId));
  if (drafts.length === 0) return [];

  // Vocabularies first, so every fact can carry its resolved ids.
  const entityIds = new Map<string, string | null>();
  const predicateIds = new Map<string, string | null>();
  const qualifierExamples = new Map<string, string>();

  for (const draft of drafts) {
    if (!entityIds.has(draft.subjectText)) {
      entityIds.set(draft.subjectText, await resolveEntity(corpusId, draft.subjectText));
    }
    if (!predicateIds.has(draft.predicateText)) {
      predicateIds.set(draft.predicateText, await resolvePredicate(corpusId, draft.predicateText));
    }
    for (const [key, value] of Object.entries(draft.qualifiers)) {
      if (!qualifierExamples.has(key)) qualifierExamples.set(key, value);
    }
  }
  await registerQualifierKeys(corpusId, qualifierExamples);

  const saved: SavedFact[] = [];
  const BATCH = 40;

  for (let i = 0; i < drafts.length; i += BATCH) {
    const slice = drafts.slice(i, i + BATCH);
    const rows = await db
      .insert(facts)
      .values(
        slice.map((d) => {
          const ordinal = chunkOrdinalByFact(d);
          return {
            corpusId,
            documentId,
            chunkId: ordinal === null ? null : (chunkIdByOrdinal.get(ordinal) ?? null),
            kind: d.kind,
            subjectEntityId: entityIds.get(d.subjectText) ?? null,
            subjectText: d.subjectText,
            predicateId: predicateIds.get(d.predicateText) ?? null,
            predicateText: d.predicateText,
            objectText: d.objectText,
            valueRaw: d.valueRaw,
            valueNum: d.valueNum,
            valueBase: d.valueBase,
            valueMin: d.valueMin,
            valueMax: d.valueMax,
            modifier: d.modifier,
            unit: d.unit,
            qualifiers: d.qualifiers,
            periodKind: d.periodKind,
            periodStart: d.periodStart,
            periodEnd: d.periodEnd,
            periodLabel: d.periodLabel,
            scopeSignature: d.scopeSignature,
            claimKey: d.claimKey,
            relaxedKey: d.relaxedKey,
            confidence: d.confidence,
            extractionMethod: d.extractionMethod,
            quoteVerified: d.quoteVerified,
            quarantined: d.quarantined,
          };
        }),
      )
      .returning({ id: facts.id });

    rows.forEach((row, k) => saved.push({ id: row.id, draft: slice[k] }));
  }

  // Evidence is written second so a fact can never exist without it for long.
  const evidenceRows = saved.map(({ id, draft }) => ({
    factId: id,
    documentId,
    pageNo: draft.evidence.pageNo,
    bboxes: draft.evidence.bboxes as BBox[],
    quote: draft.evidence.quote,
    tableId: tableIdBySourceKey.get(draft.sourceKey) ?? null,
    tableCell:
      draft.rowIndex >= 0 ? { row: draft.rowIndex, col: draft.colIndex } : null,
  }));

  for (let i = 0; i < evidenceRows.length; i += BATCH) {
    await db.insert(evidence).values(evidenceRows.slice(i, i + BATCH));
  }

  return saved;
}

export async function saveFactEmbeddings(
  updates: { factId: string; embedding: number[] }[],
): Promise<void> {
  const db = getDb();
  for (const { factId, embedding } of updates) {
    await db.update(facts).set({ embedding }).where(eq(facts.id, factId));
  }
}

/* ── relations ────────────────────────────────────────────────────────────── */

export type RelationRow = {
  factA: string;
  factB: string;
  type: string;
  subtype: string | null;
  confidence: number;
  method: "rule" | "arithmetic" | "llm";
  explanation: string;
  arithmetic?: Record<string, unknown> | null;
  bridgingFactIds?: string[];
  intraDocument: boolean;
};

/**
 * Writes relations for a corpus.
 *
 * Only relations touching the given documents are cleared first, so re-linking
 * one document does not discard the rest of the corpus's findings.
 */
export async function saveRelations(
  corpusId: string,
  documentIds: string[],
  rows: RelationRow[],
): Promise<number> {
  const db = getDb();

  if (documentIds.length > 0) {
    const affected = await db
      .select({ id: facts.id })
      .from(facts)
      .where(inArray(facts.documentId, documentIds));
    const ids = affected.map((f) => f.id);
    if (ids.length > 0) {
      // A relation belongs to the pair, so either side matching is enough.
      for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200);
        await db.delete(relations).where(inArray(relations.factA, slice));
        await db.delete(relations).where(inArray(relations.factB, slice));
      }
    }
  }

  if (rows.length === 0) return 0;

  let written = 0;
  const BATCH = 40;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const inserted = await db
      .insert(relations)
      .values(
        slice.map((r) => ({
          corpusId,
          factA: r.factA,
          factB: r.factB,
          type: r.type as RelationRow["type"] as never,
          subtype: r.subtype,
          confidence: r.confidence,
          method: r.method,
          explanation: r.explanation,
          arithmetic: r.arithmetic ?? null,
          bridgingFactIds: r.bridgingFactIds ?? [],
          intraDocument: r.intraDocument,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: relations.id });
    written += inserted.length;
  }

  return written;
}

/**
 * Finds or creates a corpus by slug.
 *
 * The slug is the stable address: re-running an import must land in the same
 * corpus rather than creating a second one that shares no facts with the first.
 */
export async function ensureCorpus(slug: string, name: string): Promise<string> {
  const db = getDb();

  const existing = await db
    .select({ id: corpora.id })
    .from(corpora)
    .where(eq(corpora.slug, slug))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const [row] = await db
    .insert(corpora)
    .values({ slug, name })
    .onConflictDoNothing()
    .returning({ id: corpora.id });
  if (row) return row.id;

  // Lost a race; read it back.
  const retry = await db
    .select({ id: corpora.id })
    .from(corpora)
    .where(eq(corpora.slug, slug))
    .limit(1);
  return retry[0].id;
}

export type { Db };
