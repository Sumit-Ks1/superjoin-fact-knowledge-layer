/**
 * Durable pipeline functions.
 *
 * Each `step.run` is a checkpoint: its result is persisted, and a retry resumes
 * from the last completed step rather than from the beginning. That is what
 * makes a rate-limited model call survivable — the parse before it is not
 * repeated, and the document does not start over.
 *
 * Concurrency is capped per function rather than left to the platform. A user
 * dropping six PDFs at once would otherwise open six times the model
 * concurrency and exhaust a free-tier quota in seconds, turning a slow ingest
 * into a failed one.
 */

import { NonRetriableError } from "inngest";

import { log } from "@/lib/logger";
import { runEmbed, runExtract, runLink, runParse } from "@/pipeline/run";
import { listLinkableDocuments, markStage, setDocumentStatus } from "@/pipeline/persist";

import { inngest } from "./client";

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
      await setDocumentStatus(documentId, "failed", String(error?.message ?? error));
    },
  },
  { event: "document/uploaded" },
  async ({ event, step }) => {
    const { documentId, corpusId } = event.data;

    await step.run("mark-processing", async () => {
      await setDocumentStatus(documentId, "processing");
      return true;
    });

    const parsed = await step.run("parse", () => runParse(documentId));

    /*
     * A document deleted mid-run ends the pipeline quietly. It is a user
     * action, not a fault, and reporting it as a failure would fill the run
     * history with red for something that worked exactly as asked.
     */
    if (parsed.gone) {
      return { stopped: "document deleted" as const };
    }

    /*
     * An unreadable file, by contrast, is a real outcome — but not one to
     * retry. A scanned PDF will still be scanned on the third attempt, and
     * retrying only delays telling the user something they can act on.
     */
    if (!parsed.usable) {
      throw new NonRetriableError(parsed.detail);
    }

    const extracted = await step.run("extract", () => runExtract(documentId));
    if (extracted.gone) {
      return { stopped: "document deleted" as const };
    }

    // Embeddings are an enhancement: the exact-key channels work without them,
    // so a failure here must not fail the document.
    const embedded = await step
      .run("embed", () => runEmbed(documentId))
      .catch(async (error: unknown) => {
        log.warn("embedding step failed; continuing without similarity search", {
          documentId,
          error,
        });
        await markStage(documentId, "normalize", "skipped", {
          error: String((error as Error)?.message ?? error),
        });
        return { facts: 0, chunks: 0 };
      });

    // Linking is corpus-wide and is its own function, so that a second upload
    // re-links against everything already ingested.
    await step.sendEvent("request-link", {
      name: "corpus/link-requested",
      data: { corpusId, documentIds: [documentId] },
    });

    return { parsed, extracted, embedded };
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
