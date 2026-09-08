/**
 * The findings.
 *
 * This is the endpoint the assignment is really about: not the facts, but what
 * holding two of them side by side reveals. Results are grouped by relation
 * type so the four cases are each directly addressable — corroboration,
 * contradiction, reconciliation, and the refusals.
 *
 * Cross-document findings sort first. Two documents agreeing is real evidence;
 * one document repeating itself is not.
 */

import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDb } from "@/db/client";
import { documents, facts, relations } from "@/db/schema";
import { log } from "@/lib/logger";
import { corpusDisplayName, InvalidCorpusSlugError, resolveCorpusSlug } from "@/lib/corpus";
import { ensureCorpus } from "@/pipeline/persist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

/** The families the UI groups by, in the order a reader should read them. */
const FAMILIES: Record<string, string[]> = {
  contradiction: ["CONTRADICTS"],
  corroboration: ["CORROBORATES", "EQUIVALENT_RESTATEMENT", "SUPPORTS_DERIVED"],
  reconciliation: [
    "RECONCILED_BY_TIME",
    "RECONCILED_BY_SCOPE",
    "RECONCILED_BY_UNIT",
    "RECONCILED_BY_BASIS",
    "RECONCILED_BY_DEFINITION",
    "SUPERSEDES",
  ],
  inconclusive: ["INSUFFICIENT_EVIDENCE"],
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const family = url.searchParams.get("family");
  const type = url.searchParams.get("type");
  const crossOnly = url.searchParams.get("cross") === "1";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  try {
    // Inside the try: an invalid ?corpus= is a 400, and resolving it out here
    // would escape as an unhandled 500 instead.
    const corpusSlug = resolveCorpusSlug(url.searchParams.get("corpus"));
    const db = getDb();
    const corpusId = await ensureCorpus(corpusSlug, corpusDisplayName(corpusSlug));

    const factA = alias(facts, "fact_a");
    const factB = alias(facts, "fact_b");
    const docA = alias(documents, "doc_a");
    const docB = alias(documents, "doc_b");

    const conditions: SQL[] = [eq(relations.corpusId, corpusId)];
    if (type) conditions.push(eq(relations.type, type as never));
    else if (family && FAMILIES[family]) {
      conditions.push(inArray(relations.type, FAMILIES[family] as never[]));
    }
    if (crossOnly) conditions.push(eq(relations.intraDocument, false));

    const where = and(...conditions);

    const rows = await db
      .select({
        id: relations.id,
        type: relations.type,
        subtype: relations.subtype,
        confidence: relations.confidence,
        method: relations.method,
        explanation: relations.explanation,
        arithmetic: relations.arithmetic,
        intraDocument: relations.intraDocument,
        a: {
          id: factA.id,
          subjectText: factA.subjectText,
          predicateText: factA.predicateText,
          valueRaw: factA.valueRaw,
          unit: factA.unit,
          periodLabel: factA.periodLabel,
          qualifiers: factA.qualifiers,
        },
        b: {
          id: factB.id,
          subjectText: factB.subjectText,
          predicateText: factB.predicateText,
          valueRaw: factB.valueRaw,
          unit: factB.unit,
          periodLabel: factB.periodLabel,
          qualifiers: factB.qualifiers,
        },
        filenameA: docA.filename,
        filenameB: docB.filename,
      })
      .from(relations)
      .innerJoin(factA, eq(factA.id, relations.factA))
      .innerJoin(factB, eq(factB.id, relations.factB))
      .innerJoin(docA, eq(docA.id, factA.documentId))
      .innerJoin(docB, eq(docB.id, factB.documentId))
      .where(where)
      // Cross-document first, then by confidence: the strongest findings lead.
      .orderBy(relations.intraDocument, desc(relations.confidence))
      .limit(PAGE_SIZE)
      .offset(offset);

    const counts = await db
      .select({ type: relations.type, n: sql<number>`count(*)::int` })
      .from(relations)
      .where(eq(relations.corpusId, corpusId))
      .groupBy(relations.type);

    const crossCounts = await db
      .select({ type: relations.type, n: sql<number>`count(*)::int` })
      .from(relations)
      .where(and(eq(relations.corpusId, corpusId), eq(relations.intraDocument, false)))
      .groupBy(relations.type);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(relations)
      .where(where);

    return NextResponse.json({
      total,
      offset,
      pageSize: PAGE_SIZE,
      families: FAMILIES,
      counts: Object.fromEntries(counts.map((c) => [c.type, c.n])),
      crossDocumentCounts: Object.fromEntries(crossCounts.map((c) => [c.type, c.n])),
      relations: rows,
    });
  } catch (error) {
    if (error instanceof InvalidCorpusSlugError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    log.error("relations list failed", { error });
    return NextResponse.json(
      { error: "Could not load findings." },
      { status: 500 },
    );
  }
}
