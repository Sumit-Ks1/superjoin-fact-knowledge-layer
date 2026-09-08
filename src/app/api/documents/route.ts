/**
 * Uploading and listing documents.
 *
 * Uploads go browser → Supabase Storage directly, via a signed URL issued here.
 * They do not pass through this route because Vercel caps a request body at
 * 4.5 MB and the annual report in the starter set is 6.7 MB — routing the bytes
 * through the function would fail on the very documents the system is for.
 *
 * So the flow is: POST here to reserve a row and get a signed URL, PUT the
 * bytes straight to storage, then POST to `/api/documents/{id}/ingest` to start
 * the pipeline. The document row exists from the first step, so a failed or
 * abandoned upload is visible rather than silently absent.
 */

import { NextResponse } from "next/server";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db/client";
import { documentStages, documents, facts, issues } from "@/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { corpusDisplayName, InvalidCorpusSlugError, resolveCorpusSlug } from "@/lib/corpus";
import { toUserMessage } from "@/lib/user-message";
import { createSignedUploadUrl, ensureBucket } from "@/lib/supabase";
import { ensureCorpus } from "@/pipeline/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  filename: z.string().min(1).max(300),
  byteSize: z.number().int().positive(),
  /** sha256 of the file, computed in the browser. The idempotency key. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Omit to use DEFAULT_CORPUS_SLUG; validated by resolveCorpusSlug. */
  corpusSlug: z.string().min(1).max(80).optional(),
  corpusName: z.string().min(1).max(120).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", detail: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const { filename, byteSize, sha256, corpusName } = parsed.data;

  let corpusSlug: string;
  try {
    corpusSlug = resolveCorpusSlug(parsed.data.corpusSlug);
  } catch (error) {
    /*
     * Only this error's message is written for a reader. Returning whatever
     * else might be thrown here would leak internals through a route that
     * looks like it only ever reports a bad slug.
     */
    if (error instanceof InvalidCorpusSlugError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    log.error("corpus resolution failed", { error });
    return NextResponse.json({ error: "Could not resolve the corpus." }, { status: 500 });
  }

  if (byteSize > env.maxUploadBytes) {
    return NextResponse.json(
      {
        error: `File is ${(byteSize / 1024 / 1024).toFixed(1)} MB; the limit is ${(env.maxUploadBytes / 1024 / 1024).toFixed(0)} MB.`,
      },
      { status: 413 },
    );
  }

  try {
    const db = getDb();
    await ensureBucket();
    const corpusId = await ensureCorpus(corpusSlug, corpusName ?? corpusDisplayName(corpusSlug));

    // Same bytes in the same corpus is the same document. Re-uploading is a
    // no-op that returns the existing row rather than a duplicate.
    const existing = await db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(sql`${documents.corpusId} = ${corpusId} and ${documents.sha256} = ${sha256}`)
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({
        documentId: existing[0].id,
        corpusId,
        duplicate: true,
        status: existing[0].status,
        uploadUrl: null,
      });
    }

    const storagePath = `${corpusId}/${sha256}.pdf`;
    const [row] = await db
      .insert(documents)
      .values({ corpusId, sha256, filename, byteSize, storagePath, status: "uploaded" })
      .returning({ id: documents.id });

    const upload = await createSignedUploadUrl(storagePath);

    return NextResponse.json({
      documentId: row.id,
      corpusId,
      duplicate: false,
      status: "uploaded",
      uploadUrl: upload.signedUrl,
      token: upload.token,
      storagePath,
    });
  } catch (error) {
    log.error("document create failed", { error });
    return NextResponse.json(
      { error: "Could not reserve the upload." },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  try {
    const corpusSlug = resolveCorpusSlug(url.searchParams.get("corpus"));
    const db = getDb();
    const corpusId = await ensureCorpus(corpusSlug, corpusDisplayName(corpusSlug));

    const rows = await db
      .select({
        id: documents.id,
        filename: documents.filename,
        byteSize: documents.byteSize,
        pageCount: documents.pageCount,
        docType: documents.docType,
        fiscalYearEnd: documents.fiscalYearEnd,
        status: documents.status,
        error: documents.error,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.corpusId, corpusId))
      .orderBy(desc(documents.createdAt));

    // Counts per document, so the list can show progress without N queries.
    const factCounts = await db
      .select({ documentId: facts.documentId, n: sql<number>`count(*)::int` })
      .from(facts)
      .where(eq(facts.corpusId, corpusId))
      .groupBy(facts.documentId);

    const issueCounts = await db
      .select({ documentId: issues.documentId, n: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.corpusId, corpusId))
      .groupBy(issues.documentId);

    // Scoped to this corpus. Unfiltered, this reads every stage row in the
    // database — harmless to display, since the lookup is by document id, but
    // it is a full scan and it reaches across the corpus boundary the rest of
    // this endpoint is careful to respect.
    const documentIds = rows.map((r) => r.id);
    const stages =
      documentIds.length === 0
        ? []
        : await db
            .select({
              documentId: documentStages.documentId,
              stage: documentStages.stage,
              status: documentStages.status,
              metrics: documentStages.metrics,
            })
            .from(documentStages)
            .where(inArray(documentStages.documentId, documentIds));

    const factsBy = new Map(factCounts.map((r) => [r.documentId, r.n]));
    const issuesBy = new Map(issueCounts.map((r) => [r.documentId, r.n]));
    const stagesBy = new Map<string, typeof stages>();
    for (const s of stages) {
      const list = stagesBy.get(s.documentId) ?? [];
      list.push(s);
      stagesBy.set(s.documentId, list);
    }

    return NextResponse.json({
      corpusId,
      corpusSlug,
      documents: rows.map((row) => ({
        ...row,
        // Rewritten at the boundary, so rows already holding raw text from an
        // earlier run are cleaned on the way out too.
        error: toUserMessage(row.error),
        factCount: factsBy.get(row.id) ?? 0,
        issueCount: issuesBy.get(row.id) ?? 0,
        stages: (stagesBy.get(row.id) ?? []).map((s) => ({
          stage: s.stage,
          status: s.status,
          metrics: s.metrics,
          /*
           * A stage's stored error is a provider payload — quota metrics, help
           * links, stack frames. It is never sent. What a skipped stage means
           * for the reader is derived from the stage itself, in the UI.
           */
        })),
      })),
    });
  } catch (error) {
    if (error instanceof InvalidCorpusSlugError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    log.error("document list failed", { error });
    return NextResponse.json(
      { error: "Could not load documents." },
      { status: 500 },
    );
  }
}
