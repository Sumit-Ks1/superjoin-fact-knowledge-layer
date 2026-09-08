/**
 * Removing a document.
 *
 * Needed because uploads are otherwise permanent, and the common case for
 * wanting one gone is exactly the dangerous one: test documents sitting in a
 * corpus that a real user's uploads will later be compared against.
 *
 * Two ordering decisions carry the weight here.
 *
 * **The database row goes first, storage second.** Either step can fail, so the
 * question is which orphan is worse. A deleted row with surviving bytes leaves
 * an unreferenced object that costs a little storage and is reclaimed the next
 * time the same file is uploaded. A surviving row with deleted bytes leaves a
 * document that lists in the UI, reports facts, and fails every time anything
 * tries to re-read it — a much worse state, and one that needs manual repair.
 *
 * **Relations die with their facts.** Every foreign key from `documents`
 * cascades, and `relations` cascades from `facts`, so a single DELETE removes
 * pages, blocks, tables, chunks, facts, evidence, issues, stages, and any
 * finding that referenced this document's facts — including cross-document
 * findings, which is correct: a comparison against a fact that no longer exists
 * is not a finding, it is a dangling reference.
 *
 * Findings *between the surviving documents* are untouched, because relations
 * are pairwise. Deleting one document does not require re-linking the rest.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { documents } from "@/db/schema";
import { log } from "@/lib/logger";
import { removeDocument } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  try {
    const db = getDb();
    const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    return NextResponse.json({ document: doc });
  } catch (error) {
    log.error("document fetch failed", { documentId: id, error });
    return NextResponse.json(
      { error: "Could not load the document." },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  try {
    const db = getDb();

    const [doc] = await db
      .select({
        id: documents.id,
        filename: documents.filename,
        storagePath: documents.storagePath,
        status: documents.status,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);

    /*
     * Already gone is a success, not an error. Deleting is naturally retried —
     * a double-click, an impatient refresh — and answering 404 to the second
     * attempt makes a completed action look broken.
     */
    if (!doc) {
      return NextResponse.json({ deleted: true, alreadyAbsent: true });
    }

    /*
     * A document mid-pipeline can be deleted. The in-flight Inngest run will
     * fail on its next step when the row is missing, which the pipeline treats
     * as non-retriable and reports rather than looping. Blocking the delete
     * instead would strand anything whose run died without clearing its status,
     * and "processing" is precisely the state a stuck document sits in.
     */
    const wasProcessing = doc.status === "processing";

    await db.delete(documents).where(eq(documents.id, id));

    // Best effort, and deliberately after the row is gone. An orphaned object
    // is cheap; a row pointing at absent bytes is not.
    let storageRemoved = true;
    try {
      await removeDocument(doc.storagePath);
    } catch (error) {
      storageRemoved = false;
      log.warn("document row deleted but storage object remains", {
        documentId: id,
        storagePath: doc.storagePath,
        error,
      });
    }

    log.info("document deleted", { documentId: id, filename: doc.filename, storageRemoved });

    return NextResponse.json({
      deleted: true,
      filename: doc.filename,
      storageRemoved,
      wasProcessing,
    });
  } catch (error) {
    log.error("document delete failed", { documentId: id, error });
    return NextResponse.json(
      { error: "Could not delete the document." },
      { status: 500 },
    );
  }
}
