"use client";

/**
 * Facts: everything extracted, filterable.
 *
 * The useful move here is grouping by measure rather than searching for a
 * number — "show me every figure anyone reported for this" is what surfaces a
 * disagreement, and it is one click from any row.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  FilterGroup,
  Loading,
  Notice,
  PageHeader,
  SearchInput,
  ToggleFilter,
  type FilterOption,
} from "@/components/ui";

type Fact = {
  id: string;
  filename: string;
  subjectText: string;
  predicateText: string;
  valueRaw: string | null;
  unit: { raw: string | null; baseUnit: string } | null;
  periodLabel: string | null;
  qualifiers: Record<string, string>;
  kind: string;
  confidence: number;
  extractionMethod: string;
  quarantined: boolean;
  relaxedKey: string;
  evidence: { pageNo: number; quote: string } | null;
};

/** Fact kinds, as a filter. "" is the unfiltered case. */
const KINDS: FilterOption[] = [
  { value: "", label: "All kinds" },
  { value: "quantitative", label: "Measured" },
  { value: "attributive", label: "Descriptive" },
  { value: "relational", label: "Relational" },
  { value: "temporal", label: "Dated" },
];

function FactsInner() {
  const params = useSearchParams();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [measure, setMeasure] = useState(params.get("measure") ?? "");
  const [documentId] = useState(params.get("document") ?? "");
  const [showQuarantined, setShowQuarantined] = useState(false);
  const [data, setData] = useState<{ facts: Fact[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL("/api/facts", window.location.origin);
      if (query) url.searchParams.set("q", query);
      if (kind) url.searchParams.set("kind", kind);
      if (measure) url.searchParams.set("measure", measure);
      if (documentId) url.searchParams.set("document", documentId);
      if (showQuarantined) url.searchParams.set("quarantined", "1");
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
  }, [query, kind, measure, documentId, showQuarantined]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader title="Facts">
        Every figure is shown as printed, with the page it came from. Numbers in tables are read
        straight from the reconstructed cell and never pass through a language model.
      </PageHeader>

      <div className="space-y-4">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search measure, subject or period…"
        />

        <FilterGroup label="Fact kind" options={KINDS} value={kind} onChange={setKind} />

        <div className="flex flex-wrap items-center gap-2">
          <ToggleFilter checked={showQuarantined} onChange={setShowQuarantined}>
            Include quarantined
          </ToggleFilter>
          {measure ? (
            <Button variant="secondary" onClick={() => setMeasure("")}>
              Clear measure filter
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <Notice>{error}</Notice> : null}

      {data ? (
        <p className="text-sm text-muted">
          <span className="tabular font-medium text-ink">{data.total}</span> fact
          {data.total === 1 ? "" : "s"}
          {data.total > data.facts.length ? ` · showing ${data.facts.length}` : ""}
        </p>
      ) : null}

      {loading ? <Loading /> : null}

      {!loading && data?.facts.length === 0 ? (
        <EmptyState>No facts match these filters.</EmptyState>
      ) : null}

      {data && data.facts.length > 0 ? (
        <Card className="overflow-hidden">
          {data.facts.map((fact) => (
            <div key={fact.id} className="border-b border-line p-4 last:border-0">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <a
                  href={`/facts/${fact.id}`}
                  className="flex-1 text-sm font-medium text-ink underline-offset-4 hover:text-accent hover:underline"
                >
                  {fact.predicateText}
                </a>
                <span className="tabular text-base font-semibold text-ink">
                  {fact.valueRaw ?? "—"}
                  {fact.unit?.raw ? (
                    <span className="ml-1 text-xs font-normal text-muted">{fact.unit.raw}</span>
                  ) : null}
                </span>
                <span className="w-56 shrink-0 text-xs text-muted">
                  {fact.periodLabel ?? "no stated period"}
                </span>
                <Button variant="quiet" onClick={() => setMeasure(fact.relaxedKey)}>
                  compare
                </Button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
                <span>{fact.filename}</span>
                {fact.evidence ? <span>p.{fact.evidence.pageNo}</span> : null}
                <Badge tone={fact.extractionMethod === "table_deterministic" ? "accent" : "unknown"}>
                  {fact.extractionMethod === "table_deterministic" ? "from a table" : "from prose"}
                </Badge>
                {fact.quarantined ? <Badge tone="context">quarantined</Badge> : null}
                {Object.entries(fact.qualifiers ?? {}).map(([key, value]) => (
                  <span key={key} className="text-faint">
                    {key}: {value}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}

export default function FactsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <FactsInner />
    </Suspense>
  );
}
