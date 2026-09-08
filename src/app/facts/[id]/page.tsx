"use client";

/**
 * One fact, laid out for checking rather than for reading.
 *
 * The quote and its page come first, because that is what makes the claim
 * falsifiable. Everything else — normalisation, related findings — sits below
 * it, and the normalised value is shown beside the printed one so a reader can
 * see exactly what the system did to the number before comparing it.
 */

import { use, useEffect, useState } from "react";

import {
  Badge,
  Card,
  Loading,
  Notice,
  toneForRelation,
  type Tone,
} from "@/components/ui";

type Detail = {
  fact: {
    subjectText: string;
    predicateText: string;
    valueRaw: string | null;
    valueNum: number | null;
    valueBase: number | null;
    unit: { raw: string | null; baseUnit: string; factor: number; kind: string } | null;
    periodLabel: string | null;
    periodKind: string;
    periodStart: string | null;
    periodEnd: string | null;
    qualifiers: Record<string, string>;
    confidence: number;
    extractionMethod: string;
    quoteVerified: boolean;
    quarantined: boolean;
  };
  document: { id: string; filename: string; docType: string | null };
  evidence: {
    id: string;
    pageNo: number;
    quote: string;
    tableCell: { row: number; col: number } | null;
  }[];
  tables: {
    id: string;
    caption: string | null;
    unitHint: string | null;
    confidence: number;
    needsReview: boolean;
  }[];
  relations: {
    id: string;
    type: string;
    subtype: string | null;
    explanation: string;
    confidence: number;
    other: {
      id: string;
      predicateText: string;
      valueRaw: string | null;
      periodLabel: string | null;
      filename: string;
    };
  }[];
};

export default function FactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`/api/facts/${id}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail ?? body.error);
        setData(body);
      } catch (e) {
        setError(String((e as Error).message));
      }
    })();
  }, [id]);

  if (error) return <Notice>{error}</Notice>;
  if (!data) return <Loading />;

  const { fact, document, evidence, tables, relations } = data;

  return (
    <div className="space-y-6">
      <header className="border-b border-line pb-5">
        <a
          href={`/facts?document=${document.id}`}
          className="text-xs text-accent underline-offset-4 hover:underline"
        >
          {document.filename}
        </a>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">
          {fact.predicateText}
        </h1>
        <p className="mt-1 text-sm text-muted">about {fact.subjectText}</p>
      </header>

      <Card className="p-5">
        <div className="grid gap-5 sm:grid-cols-3">
          <Figure label="As printed">
            <span className="tabular text-3xl font-semibold text-ink">
              {fact.valueRaw ?? "—"}
            </span>
            {fact.unit?.raw ? (
              <span className="ml-2 text-base text-muted">{fact.unit.raw}</span>
            ) : null}
          </Figure>

          <Figure label="Normalised for comparison">
            {fact.valueBase === null ? (
              <span className="text-sm text-context">not comparable — no unit resolved</span>
            ) : (
              <>
                <span className="tabular text-xl font-medium text-ink">
                  {fact.valueBase.toLocaleString()}
                </span>{" "}
                <span className="text-sm text-muted">{fact.unit?.baseUnit}</span>
              </>
            )}
          </Figure>

          <Figure label="Period">
            <span className="text-sm text-ink">{fact.periodLabel ?? "not stated"}</span>
            {fact.periodStart && fact.periodEnd ? (
              <span className="tabular mt-1 block text-xs text-muted">
                {fact.periodStart.slice(0, 10)} → {fact.periodEnd.slice(0, 10)}
              </span>
            ) : null}
          </Figure>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <Badge tone={fact.extractionMethod === "table_deterministic" ? "accent" : "unknown"}>
            {fact.extractionMethod === "table_deterministic"
              ? "read from a table cell"
              : "extracted from prose"}
          </Badge>
          <Badge>{(fact.confidence * 100).toFixed(0)}% confidence</Badge>
          {fact.quoteVerified ? <Badge tone="agree">quote verified</Badge> : null}
          {fact.quarantined ? (
            <Badge tone="context">quarantined — excluded from contradiction detection</Badge>
          ) : null}
          {Object.entries(fact.qualifiers ?? {}).map(([key, value]) => (
            <Badge key={key}>
              {key}: {value}
            </Badge>
          ))}
        </div>
      </Card>

      <Section title="Evidence">
        {evidence.map((item) => (
          <Card key={item.id} className="p-5">
            <p className="text-xs text-muted">
              page {item.pageNo}
              {item.tableCell
                ? ` · row ${item.tableCell.row}, column ${item.tableCell.col}`
                : ""}
            </p>
            <blockquote className="mt-2 border-l-2 border-accent pl-3 text-sm leading-relaxed text-ink">
              {item.quote}
            </blockquote>
          </Card>
        ))}
        {evidence.length === 0 ? (
          <Notice>No evidence recorded. A fact without evidence is a bug, not a fact.</Notice>
        ) : null}
      </Section>

      {tables.length > 0 ? (
        <Section title="Source table">
          {tables.map((table) => (
            <Card key={table.id} className="p-5 text-sm">
              {table.caption ? <p className="text-ink">{table.caption}</p> : null}
              {table.unitHint ? (
                <p className="mt-1 text-muted">Units: {table.unitHint}</p>
              ) : null}
              <p className="mt-2 text-xs text-muted">
                reconstruction confidence {(table.confidence * 100).toFixed(0)}%
                {table.needsReview ? " · flagged for review" : ""}
              </p>
            </Card>
          ))}
        </Section>
      ) : null}

      <Section title="Related findings">
        {relations.map((relation) => (
          <a
            key={relation.id}
            href={`/facts/${relation.other.id}`}
            className="block rounded-card border border-line bg-surface p-5 transition-colors hover:border-accent hover:bg-accent-soft"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={toneForRelation(relation.type)}>
                {relation.type.replace(/_/g, " ").toLowerCase()}
              </Badge>
              {relation.subtype ? (
                <span className="text-xs text-muted">via {relation.subtype}</span>
              ) : null}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-ink">{relation.explanation}</p>
            <p className="mt-2 text-xs text-muted">
              compared with{" "}
              <span className="tabular font-medium">{relation.other.valueRaw ?? "—"}</span> (
              {relation.other.periodLabel ?? "no period"}) in {relation.other.filename}
            </p>
          </a>
        ))}
        {relations.length === 0 ? (
          <Card className="p-5 text-sm leading-relaxed text-muted">
            Nothing else in the corpus states this measure, so there is nothing to compare it
            with yet.
          </Card>
        ) : null}
      </Section>
    </div>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-2.5 space-y-2.5">{children}</div>
    </section>
  );
}

export type { Tone };
