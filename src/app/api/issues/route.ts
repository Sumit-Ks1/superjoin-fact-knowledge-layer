/**
 * The honesty surface.
 *
 * Everything the pipeline could not do, and why. This exists because a system
 * that only shows what it succeeded at is not checkable: a reader has no way to
 * tell an empty result from a silent failure. Chart regions it refused to read,
 * quotes that failed verification, units it could not resolve, periods it would
 * not guess at — all of them are here, attributed to a page.
 */
import { NextResponse } from "next/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db/client";
import { documents, facts, issues } from "@/db/schema";
import { log } from "@/lib/logger";
import { corpusDisplayName, InvalidCorpusSlugError, resolveCorpusSlug } from "@/lib/corpus";
import { ensureCorpus } from "@/pipeline/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("document");
  const kind = url.searchParams.get("kind");

  try {
    // Inside the try: an invalid ?corpus= is a 400, and resolving it out here
    // would escape as an unhandled 500 instead.
    const corpusSlug = resolveCorpusSlug(url.searchParams.get("corpus"));
    const db = getDb();
    const corpusId = await ensureCorpus(corpusSlug, corpusDisplayName(corpusSlug));

    const conditions: SQL[] = [eq(issues.corpusId, corpusId)];
    if (documentId) conditions.push(eq(issues.documentId, documentId));
    if (kind) conditions.push(eq(issues.kind, kind as never));

    const rows = await db
      .select({
        id: issues.id,
        kind: issues.kind,
        severity: issues.severity,
        detail: issues.detail,
        pageNo: issues.pageNo,
        sample: issues.sample,
        documentId: issues.documentId,
        filename: documents.filename,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .leftJoin(documents, eq(documents.id, issues.documentId))
      .where(and(...conditions))
      .orderBy(desc(issues.severity), issues.kind)
      .limit(300);

    const byKind = await db
      .select({ kind: issues.kind, n: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.corpusId, corpusId))
      .groupBy(issues.kind);

    // Coverage: how much of the extraction is trustworthy enough to compare.
    const [totals] = await db
      .select({
        facts: sql<number>`count(*)::int`,
        quarantined: sql<number>`count(*) filter (where ${facts.quarantined})::int`,
        unresolvedUnit: sql<number>`count(*) filter (where ${facts.unit} is null and ${facts.valueNum} is not null)::int`,
        unresolvedPeriod: sql<number>`count(*) filter (where ${facts.periodKind} = 'unknown')::int`,
        fromTables: sql<number>`count(*) filter (where ${facts.extractionMethod} = 'table_deterministic')::int`,
        fromProse: sql<number>`count(*) filter (where ${facts.extractionMethod} = 'narrative_llm')::int`,
      })
      .from(facts)
      .where(eq(facts.corpusId, corpusId));

    return NextResponse.json({
      issues: rows,
      countsByKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
      coverage: totals,
    });
  } catch (error) {
    if (error instanceof InvalidCorpusSlugError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    log.error("issues list failed", { error });
    return NextResponse.json(
      { error: "Could not load quality data." },
      { status: 500 },
    );
  }
}
