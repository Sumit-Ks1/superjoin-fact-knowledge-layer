/**
 * Durable pipeline functions.
 *
 * Each `step.run` is a checkpoint: its result is persisted, it gets its own
 * serverless invocation, and a retry resumes from the last completed step
 * rather than from the beginning.
 *
 * That last property is what this file is for. The platform's free tier stops
 * any function after sixty seconds, and a hundred-page filing takes minutes to
 * process — so the work is cut into slices small enough to finish, and Inngest
 * carries the state between them. Sizes come from `env` so they can be lowered
 * without a deploy if a document still overruns.
 *
 * Concurrency is capped per function rather than left to the platform. Someone
 * dropping six PDFs at once would otherwise open six times the model
 * concurrency and exhaust a free-tier quota in seconds, turning a slow ingest
 * into a failed one.
 */

import { NonRetriableError } from "inngest";

import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { isMissingSchema } from "@/lib/pg-error";
import {
  runEmbedBatch,
  runEmbedChunks,
  runExtractNarrative,
  runExtractTables,
  runLink,
  runParseBatch,
  runPrepare,
} from "@/pipeline/run";
import { listLinkableDocuments, markStage, setDocumentStatus } from "@/pipeline/persist";

import { inngest } from "./client";

/** Bounds the step count so a pathological document cannot loop forever. */
const MAX_BATCHES = 200;

export const ingestDocument = inngest.createFunction(
  {
    id: "ingest-document",
    name: "Ingest a document",
    // Two documents at a time: enough to keep the pipeline busy, few enough
    // that the model provider's rate limit is not the thing that fails.
    concurrency: { limit: 2 },
    retries: 3,
    onFailure: async ({ event, error }) => {
      const { documentId } = event.data.event.data;
      log.error("ingest failed after retries", { documentId, error });

      /*
       * A missing column or table means a migration has not been run. That is
       * a person's job, not a transient fault, so the document says so rather
       * than reporting a generic failure that invites another retry.
       */
      const detail = isMissingSchema(error)
        ? "The database schema is behind the application. Run the pending migrations in supabase/migrations."
        : String(error?.message ?? error);

      await setDocumentStatus(documentId, "failed", detail);
    },
  },
  { event: "document/uploaded" },
  async ({ event, step }) => {
    const { documentId, corpusId } = event.data;

    await step.run("mark-processing", async () => {
      await setDocumentStatus(documentId, "processing");
      return true;
    });

    /* 1. Prepare — sample the document, learn its headers and subject. */
    const prepared = await step.run("prepare", () => runPrepare(documentId));

    /*
     * A document deleted mid-run ends the pipeline quietly. It is a user
     * action, not a fault, and reporting it as a failure would fill the run
     * history with red for something that worked exactly as asked.
     */
    if (prepared.gone) return { stopped: "document deleted" as const };

    /*
     * An unreadable file, by contrast, is a real outcome — but not one to
     * retry. A scanned PDF will still be scanned on the third attempt, and
     * retrying only delays telling the user something they can act on.
     */
    if (!prepared.usable) throw new NonRetriableError(prepared.detail);

    /* 2. Parse — one page range per invocation. */
    const pageBatch = Math.max(1, env.parsePageBatch);
    let chunkOffset = 0;
    let tableCount = 0;

    for (let from = 1; from <= prepared.pageCount; from += pageBatch) {
      const to = Math.min(from + pageBatch - 1, prepared.pageCount);
      const batch = await step.run(`parse-${from}-${to}`, () =>
        runParseBatch(documentId, from, to, prepared.boilerplate, chunkOffset),
      );
      if (batch.gone) return { stopped: "document deleted" as const };
      chunkOffset += batch.chunks;
      tableCount += batch.tables;
    }

    await step.run("parse-done", async () => {
      await markStage(documentId, "parse", "done", {
        metrics: { pages: prepared.pageCount, tables: tableCount, subject: prepared.subject },
      });
      await markStage(documentId, "chunk", "done", { metrics: { chunks: chunkOffset } });
      return true;
    });

    /* 3. Extract — tables read back from the database, then prose in slices. */
    const tableBatch = Math.max(1, env.extractTableBatch);
    let tableFacts = 0;

    for (let i = 0; i < MAX_BATCHES; i++) {
      const offset = i * tableBatch;
      const out = await step.run(`extract-tables-${offset}`, () =>
        runExtractTables(documentId, offset, tableBatch),
      );
      if (out.gone) return { stopped: "document deleted" as const };
      if (out.processed === 0) break;
      tableFacts += out.facts;
    }

    const chunkBatch = Math.max(1, env.extractChunkBatch);
    let narrativeFacts = 0;

    for (let i = 0; i < MAX_BATCHES; i++) {
      const offset = i * chunkBatch;
      const out = await step.run(`extract-prose-${offset}`, () =>
        runExtractNarrative(documentId, offset, chunkBatch),
      );
      if (out.gone) return { stopped: "document deleted" as const };
      // `skipped` means no model is configured; `processed === 0` means done.
      if (out.skipped || out.processed === 0) break;
      narrativeFacts += out.facts;
    }

    await step.run("extract-done", async () => {
      await markStage(documentId, "extract", "done", {
        metrics: { tableFacts, narrativeFacts },
      });
      return true;
    });

    /*
     * 4. Embed — batched, and allowed to fail. Similarity is an enhancement;
     * the exact-key, reconciliation and arithmetic channels do not need it, so
     * an exhausted free quota must not fail the document.
     */
    const embedBatch = Math.max(1, env.embedFactBatch);
    let embedded = 0;
    let embedSkipped = false;

    for (let i = 0; i < MAX_BATCHES && !embedSkipped; i++) {
      const offset = i * embedBatch;
      const out = await step.run(`embed-${offset}`, () =>
        runEmbedBatch(documentId, offset, embedBatch),
      );
      if (out.gone) return { stopped: "document deleted" as const };
      if (out.skipped) {
        embedSkipped = true;
        break;
      }
      if (out.processed === 0) break;
      embedded += out.facts;
    }

    if (!embedSkipped) {
      /*
       * Chunk vectors, in slices of their own. They are longer texts than a
       * fact line, so they get a smaller batch than the fact loop above.
       */
      const chunkEmbedBatch = Math.max(1, env.embedChunkBatch);
      for (let i = 0; i < MAX_BATCHES; i++) {
        const out = await step.run(`embed-chunks-${i * chunkEmbedBatch}`, () =>
          runEmbedChunks(documentId, i * chunkEmbedBatch, chunkEmbedBatch),
        );
        if (out.skipped || out.processed === 0) break;
      }

      await step.run("embed-done", async () => {
        await markStage(documentId, "normalize", "done", { metrics: { facts: embedded } });
        return true;
      });
    }

    /*
     * 5. Link — corpus-wide, and its own function, so a second upload re-links
     * against everything already ingested.
     */
    await step.sendEvent("request-link", {
      name: "corpus/link-requested",
      data: { corpusId, documentIds: [documentId] },
    });

    return {
      pages: prepared.pageCount,
      tables: tableCount,
      chunks: chunkOffset,
      facts: tableFacts + narrativeFacts,
      embedded,
    };
  },
);

export const linkCorpus = inngest.createFunction(
  {
    id: "link-corpus",
    name: "Link a corpus",
    /*
     * One linking pass per corpus at a time, and later requests collapse into
     * the pending one. Six documents uploaded together would otherwise trigger
     * six full corpus link passes computing almost the same answer.
     */
    concurrency: { limit: 1, key: "event.data.corpusId" },
    debounce: { period: "20s", key: "event.data.corpusId" },
    retries: 2,
  },
  { event: "corpus/link-requested" },
  async ({ event, step }) => {
    const { corpusId } = event.data;

    /*
     * The event's `documentIds` are advisory, not authoritative.
     *
     * This function is debounced per corpus, so three documents finishing
     * together produce three requests and only one run — carrying only the
     * surviving event's document. Marking just that one ready left the other
     * two stuck at "processing" with a pending `link` stage forever, even
     * though the pass had linked their facts perfectly well.
     *
     * So the set is derived from the corpus at run time: every document that
     * finished extraction and has not failed. That also covers a document
     * deleted between the request and the run, since it simply will not be in
     * the list.
     */
    const documentIds = await step.run("documents-to-finish", () =>
      listLinkableDocuments(corpusId),
    );

    const result = await step.run("link", () => runLink(corpusId, documentIds));

    await step.run("mark-ready", async () => {
      for (const documentId of documentIds) await setDocumentStatus(documentId, "ready");
      return true;
    });

    return result;
  },
);

export const functions = [ingestDocument, linkCorpus];