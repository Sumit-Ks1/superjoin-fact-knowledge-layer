/**
 * One fact, with everything needed to check it.
 *
 * The point of the detail view is verification, not display: the quote, the
 * page and rectangle it came from, the table cell if it was a grid, and every
 * relation that ties it to another fact — each with the reasoning that produced
 * it. A reader should be able to disagree with the system here, which means the
 * system has to show its work.
 */

import { NextResponse } from "next/server";
import { eq, inArray, or } from "drizzle-orm";

import { getDb } from "@/db/client";
import { docTables, documents, evidence, facts, relations } from "@/db/schema";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  try {
    const db = getDb();

    const [fact] = await db
      .select({
        fact: facts,
        document: {
          id: documents.id,
          filename: documents.filename,
          docType: documents.docType,
          pageCount: documents.pageCount,
        },
      })
      .from(facts)
      .innerJoin(documents, eq(documents.id, facts.documentId))
      .where(eq(facts.id, id))
      .limit(1);

    if (!fact) return NextResponse.json({ error: "Fact not found." }, { status: 404 });

    const evidenceRows = await db
      .select({
        id: evidence.id,
        pageNo: evidence.pageNo,
        bboxes: evidence.bboxes,
        quote: evidence.quote,
        tableId: evidence.tableId,
        tableCell: evidence.tableCell,
      })
      .from(evidence)
      .where(eq(evidence.factId, id));

    // The grid a table fact came from, so the cell can be shown in context.
    const tableIds = evidenceRows.map((e) => e.tableId).filter((t): t is string => t !== null);
    const tables =
      tableIds.length === 0
        ? []
        : await db
            .select({
              id: docTables.id,
              caption: docTables.caption,
              unitHint: docTables.unitHint,
              rowCount: docTables.rowCount,
              colCount: docTables.colCount,
              colHeaderPaths: docTables.colHeaderPaths,
              confidence: docTables.confidence,
              needsReview: docTables.needsReview,
            })
            .from(docTables)
            .where(inArray(docTables.id, tableIds));

    const related = await db
      .select({
        relation: relations,
        other: {
          id: facts.id,
          documentId: facts.documentId,
          subjectText: facts.subjectText,
          predicateText: facts.predicateText,
          valueRaw: facts.valueRaw,
          unit: facts.unit,
          periodLabel: facts.periodLabel,
          qualifiers: facts.qualifiers,
          quarantined: facts.quarantined,
        },
        otherDocument: { filename: documents.filename },
      })
      .from(relations)
      // The pair is unordered, so the "other" side is whichever is not this one.
      .innerJoin(
        facts,
        or(
          eq(facts.id, relations.factB),
          eq(facts.id, relations.factA),
        )!,
      )
      .innerJoin(documents, eq(documents.id, facts.documentId))
      .where(or(eq(relations.factA, id), eq(relations.factB, id))!);

    const relationsOut = related
      .filter((r) => r.other.id !== id)
      .map((r) => ({
        id: r.relation.id,
        type: r.relation.type,
        subtype: r.relation.subtype,
        confidence: r.relation.confidence,
        method: r.relation.method,
        explanation: r.relation.explanation,
        arithmetic: r.relation.arithmetic,
        intraDocument: r.relation.intraDocument,
        other: { ...r.other, filename: r.otherDocument.filename },
      }));

    return NextResponse.json({
      fact: fact.fact,
      document: fact.document,
      evidence: evidenceRows,
      tables,
      relations: relationsOut,
    });
  } catch (error) {
    log.error("fact detail failed", { factId: id, error });
    return NextResponse.json(
      { error: "Could not load the fact." },
      { status: 500 },
    );
  }
}
