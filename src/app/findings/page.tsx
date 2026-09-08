"use client";

/**
 * Findings: what holding two facts side by side reveals.
 *
 * Organised around the four questions the assignment poses, because those are
 * the questions a reader actually has. Each finding shows both figures, the
 * documents they came from, and the reasoning in full — not a score. A reader
 * has to be able to disagree with the verdict, and they cannot do that from a
 * confidence number alone.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  Badge,
  Card,
  EmptyState,
  FilterGroup,
  Loading,
  Notice,
  PageHeader,
  ToggleFilter,
  toneForRelation,
  type FilterOption,
} from "@/components/ui";

type Side = {
  id: string;
  subjectText: string;
  predicateText: string;
  valueRaw: string | null;
  unit: { raw: string | null; baseUnit: string } | null;
  periodLabel: string | null;
  qualifiers: Record<string, string>;
};

type Relation = {
  id: string;
  type: string;
  subtype: string | null;
  confidence: number;
  method: string;
  explanation: string;
  arithmetic: Record<string, unknown> | null;
  intraDocument: boolean;
  a: Side;
  b: Side;
  filenameA: string;
  filenameB: string;
};

const FAMILIES: FilterOption[] = [
  {
    value: "contradiction",
    label: "Contradictions",
    description:
      "Same measure, same period, same stated scope — and different figures. Nothing explains the gap.",
  },
  {
    value: "corroboration",
    label: "Corroborations",
    description:
      "Independent statements that agree, including ones written in different units or wording.",
  },
  {
    value: "reconciliation",
    label: "Reconciled",
    description:
      "Figures that look like they disagree until you read the period, scope, basis or unit.",
  },
  {
    value: "inconclusive",
    label: "Inconclusive",
    description: "Pairs the system refused to judge, and why it refused.",
  },
];

/** Which relation types roll up into which filter. */
const MEMBERS: Record<string, (type: string) => boolean> = {
  contradiction: (type) => type === "CONTRADICTS",
  corroboration: (type) =>
    ["CORROBORATES", "EQUIVALENT_RESTATEMENT", "SUPPORTS_DERIVED"].includes(type),
  reconciliation: (type) => type.startsWith("RECONCILED") || type === "SUPERSEDES",
  inconclusive: (type) => type === "INSUFFICIENT_EVIDENCE",
};

function FindingsInner() {
  const params = useSearchParams();
  const [family, setFamily] = useState(params.get("family") ?? "contradiction");
  const [crossOnly, setCrossOnly] = useState(false);
  const [data, setData] = useState<{
    relations: Relation[];
    counts: Record<string, number>;
    crossDocumentCounts: Record<string, number>;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL("/api/relations", window.location.origin);
      url.searchParams.set("family", family);
      if (crossOnly) url.searchParams.set("cross", "1");
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? body.error);
      setData(body);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, [family, crossOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const source = crossOnly ? data?.crossDocumentCounts : data?.counts;
  const options = FAMILIES.map((option) => ({
    ...option,
    count: Object.entries(source ?? {})
      .filter(([type]) => MEMBERS[option.value](type))
      .reduce((total, [, n]) => total + n, 0),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title="Findings">
        Every pair the system judged, with the reasoning it used. Reconciliation is always
        attempted before contradiction — a figure is only called wrong when nothing explains it.
      </PageHeader>

      <div className="space-y-4">
        <FilterGroup
          label="Finding type"
          options={options}
          value={family}
          onChange={setFamily}
        />
        <ToggleFilter checked={crossOnly} onChange={setCrossOnly}>
          Across documents only
        </ToggleFilter>
      </div>

      {error ? <Notice>{error}</Notice> : null}
      {loading ? <Loading /> : null}

      {!loading && data && data.relations.length === 0 ? (
        <EmptyState>
          Nothing in this category. If documents have been processed and this is empty, the
          system found nothing of this kind — which, for contradictions, is a real result rather
          than a gap.
        </EmptyState>
      ) : null}

      <div className="space-y-3">
        {data?.relations.map((relation) => (
          <Card key={relation.id} as="article" className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={toneForRelation(relation.type)}>
                {relation.type.replace(/_/g, " ").toLowerCase()}
              </Badge>
              {relation.subtype ? (
                <span className="text-xs text-muted">via {relation.subtype}</span>
              ) : null}
              <Badge tone={relation.intraDocument ? "unknown" : "accent"}>
                {relation.intraDocument ? "same document" : "across documents"}
              </Badge>
              <span className="tabular ml-auto text-xs text-muted">
                {relation.method} · {(relation.confidence * 100).toFixed(0)}% confidence
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <FactSide side={relation.a} filename={relation.filenameA} />
              <FactSide side={relation.b} filename={relation.filenameB} />
            </div>

            <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-ink">
              {relation.explanation}
            </p>

            {relation.arithmetic ? (
              <pre className="mt-3 overflow-x-auto rounded-md bg-ground p-3 text-xs leading-relaxed text-muted">
                {JSON.stringify(relation.arithmetic, null, 2)}
              </pre>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

function FactSide({ side, filename }: { side: Side; filename: string }) {
  return (
    <a
      href={`/facts/${side.id}`}
      className="block rounded-md border border-line p-4 transition-colors hover:border-accent hover:bg-accent-soft"
    >
      <p className="truncate text-xs text-muted">{filename}</p>
      <p className="mt-1.5 text-sm font-medium text-ink">{side.predicateText}</p>
      <p className="tabular mt-2 text-xl font-semibold text-ink">
        {side.valueRaw ?? "—"}
        {side.unit?.raw ? (
          <span className="ml-1.5 text-sm font-normal text-muted">{side.unit.raw}</span>
        ) : null}
      </p>
      <p className="mt-1 text-xs text-muted">{side.periodLabel ?? "no stated period"}</p>
      {Object.keys(side.qualifiers ?? {}).length > 0 ? (
        <p className="mt-1.5 text-xs text-faint">
          {Object.entries(side.qualifiers)
            .map(([key, value]) => `${key}: ${value}`)
            .join(" · ")}
        </p>
      ) : null}
    </a>
  );
}

export default function FindingsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <FindingsInner />
    </Suspense>
  );
}
