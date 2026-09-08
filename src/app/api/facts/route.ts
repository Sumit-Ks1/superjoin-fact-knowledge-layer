/**
 * Browsing extracted facts.
 *
 * Filters are the point of this endpoint rather than search: the interesting
 * question is rarely "find me a number" but "show me every figure for this
 * measure across every document", which is what makes a disagreement visible.
 */

import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db/client";
import { documents, evidence, facts } from "@/db/schema";
import { log } from "@/lib/logger";
import { corpusDisplayName, InvalidCorpusSlugError, resolveCorpusSlug } from "@/lib/corpus";
import { ensureCorpus } from "@/pipeline/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const documentId = url.searchParams.get("document");
  const relaxedKey = url.searchParams.get("measure");
  const kind = url.searchParams.get("kind");
  const includeQuarantined = url.searchParams.get("quarantined") === "1";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  try {
    // Inside the try: an invalid ?corpus= is a 400, and resolving it out here
    // would escape as an unhandled 500 instead.
    const corpusSlug = resolveCorpusSlug(url.searchParams.get("corpus"));
    const db = getDb();
    const corpusId = await ensureCorpus(corpusSlug, corpusDisplayName(corpusSlug));

    const conditions: SQL[] = [eq(facts.corpusId, corpusId)];
    if (documentId) conditions.push(eq(facts.documentId, documentId));
    if (relaxedKey) conditions.push(eq(facts.relaxedKey, relaxedKey));
    if (kind) conditions.push(eq(facts.kind, kind as never));
    if (!includeQuarantined) conditions.push(eq(facts.quarantined, false));
    if (query !== "") {
      const like = `%${query}%`;
      const match = or(
        ilike(facts.predicateText, like),
        ilike(facts.subjectText, like),
        ilike(facts.periodLabel, like),
      );
      if (match) conditions.push(match);
    }

    const where = and(...conditions);

    const rows = await db
      .select({
        id: facts.id,
        documentId: facts.documentId,
        filename: documents.filename,
        subjectText: facts.subjectText,
        predicateText: facts.predicateText,
        objectText: facts.objectText,
        valueRaw: facts.valueRaw,
        valueBase: facts.valueBase,
        unit: facts.unit,
        modifier: facts.modifier,
        qualifiers: facts.qualifiers,
        periodLabel: facts.periodLabel,
        periodKind: facts.periodKind,
        kind: facts.kind,
        confidence: facts.confidence,
        extractionMethod: facts.extractionMethod,
        quarantined: facts.quarantined,
        relaxedKey: facts.relaxedKey,
      })
      .from(facts)
      .innerJoin(documents, eq(documents.id, facts.documentId))
      .where(where)
      .orderBy(desc(facts.confidence), facts.predicateText)
      .limit(PAGE_SIZE)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(facts)
      .where(where);

    // One evidence row per fact is enough for a list; the detail view loads all.
    const ids = rows.map((r) => r.id);
    const evidenceRows =
      ids.length === 0
        ? []
        : await db
            .select({
              factId: evidence.factId,
              pageNo: evidence.pageNo,
              quote: evidence.quote,
            })
            .from(evidence)
            .where(inArray(evidence.factId, ids));

    const evidenceBy = new Map(evidenceRows.map((e) => [e.factId, e]));

    return NextResponse.json({
      total,
      offset,
      pageSize: PAGE_SIZE,
      facts: rows.map((row) => ({
        ...row,
        evidence: evidenceBy.get(row.id) ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof InvalidCorpusSlugError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    log.error("fact list failed", { error });
    return NextResponse.json(
      { error: "Could not load facts." },
      { status: 500 },
    );
  }
}
