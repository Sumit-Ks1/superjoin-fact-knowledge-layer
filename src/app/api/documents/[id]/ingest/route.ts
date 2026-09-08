/**
 * Starts the pipeline for an uploaded document.
 *
 * Separate from the upload so the bytes are known to be in storage before any
 * work is queued: a pipeline that starts against a half-uploaded object fails
 * in a confusing way, several minutes later.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { documents } from "@/db/schema";
import { inngest } from "@/inngest/client";
import { log } from "@/lib/logger";
import { setDocumentStatus } from "@/pipeline/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  try {
    const db = getDb();
    const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    if (doc.status === "processing") {
      return NextResponse.json({ documentId: id, status: doc.status, alreadyRunning: true });
    }

    await setDocumentStatus(id, "processing");
    await inngest.send({
      name: "document/uploaded",
      data: { documentId: id, corpusId: doc.corpusId },
    });

    return NextResponse.json({ documentId: id, status: "processing" });
  } catch (error) {
    log.error("ingest trigger failed", { documentId: id, error });
    return NextResponse.json(
      { error: "Could not start processing." },
      { status: 500 },
    );
  }
}
