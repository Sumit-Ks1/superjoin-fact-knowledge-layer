"use client";

/**
 * Quality: what the system could not do, and why.
 *
 * This screen exists because a system that only shows its successes is not
 * checkable. An empty result and a silent failure look identical from the
 * outside, and the difference matters enormously — so every refusal is recorded
 * with a page number and a reason, and coverage is stated as a fraction rather
 * than implied.
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
  type FilterOption,
  type Tone,
} from "@/components/ui";

type Issue = {
  id: string;
  kind: string;
  severity: string;
  detail: string;
  pageNo: number | null;
  filename: string | null;
};

type Coverage = {
  facts: number;
  quarantined: number;
  unresolvedUnit: number;
  unresolvedPeriod: number;
  fromTables: number;
  fromProse: number;
};

/** Plain-English names for the failure kinds the pipeline records. */
const KIND_LABELS: Record<string, string> = {
  chart_region_unreadable: "Chart read as a chart, not a table",
  table_header_mismatch: "Table header could not be matched to its columns",
  quote_verification_failed: "Fact discarded — quote did not verify",
  unit_unresolved: "No unit or scale could be resolved",
  period_unresolved: "No period could be resolved",
  possible_source_error: "Figures in the source do not add up",
  entity_ambiguous: "Subject could not be pinned to one entity",
  llm_invalid_output: "Model returned something unusable",
  stage_failed: "A pipeline stage failed",
};

const SEVERITY_TONE: Record<string, Tone> = {
  error: "conflict",
  warning: "context",
  info: "unknown",
};

function QualityInner() {
  const params = useSearchParams();
  const documentId = params.get("document") ?? "";
  const [kind, setKind] = useState("");
  const [data, setData] = useState<{
    issues: Issue[];
    countsByKind: Record<string, number>;
    coverage: Coverage;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL("/api/issues", window.location.origin);
      if (documentId) url.searchParams.set("document", documentId);
      if (kind) url.searchParams.set("kind", kind);
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
  }, [documentId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const coverage = data?.coverage;

  const kindOptions: FilterOption[] = [
    {
      value: "",
      label: "All issues",
      count: Object.values(data?.countsByKind ?? {}).reduce((a, b) => a + b, 0),
    },
    ...Object.entries(data?.countsByKind ?? {}).map(([key, count]) => ({
      value: key,
      label: KIND_LABELS[key] ?? key,
      count,
    })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Quality">
        Everything the pipeline declined to do, with the reason. A refusal recorded here is
        working as intended; a wrong answer that never appears here is not.
      </PageHeader>

      {coverage ? (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Facts extracted" value={coverage.facts} />
          <Stat
            label="Read from tables"
            value={coverage.fromTables}
            note="never passed through a model"
            tone="agree"
          />
          <Stat label="Extracted from prose" value={coverage.fromProse} note="quote-verified" />
          <Stat
            label="Quarantined"
            value={coverage.quarantined}
            note="kept, but excluded from contradiction detection"
            tone={coverage.quarantined > 0 ? "context" : undefined}
          />
          <Stat
            label="No unit resolved"
            value={coverage.unresolvedUnit}
            note="cannot be compared numerically"
            tone={coverage.unresolvedUnit > 0 ? "context" : undefined}
          />
          <Stat
            label="No period resolved"
            value={coverage.unresolvedPeriod}
            note="can corroborate by value, not by time"
            tone={coverage.unresolvedPeriod > 0 ? "context" : undefined}
          />
        </section>
      ) : null}

      {kindOptions.length > 1 ? (
        <FilterGroup label="Issue kind" options={kindOptions} value={kind} onChange={setKind} />
      ) : null}

      {error ? <Notice>{error}</Notice> : null}
      {loading ? <Loading /> : null}

      {!loading && data?.issues.length === 0 ? (
        <EmptyState>
          No issues recorded. Either nothing has been processed yet, or every region parsed
          cleanly.
        </EmptyState>
      ) : null}

      {data && data.issues.length > 0 ? (
        <Card className="overflow-hidden">
          {data.issues.map((issue) => (
            <div key={issue.id} className="border-b border-line p-4 last:border-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-sm font-medium text-ink">
                  {KIND_LABELS[issue.kind] ?? issue.kind}
                </span>
                {issue.filename ? (
                  <span className="text-xs text-muted">
                    {issue.filename}
                    {issue.pageNo ? ` · p.${issue.pageNo}` : ""}
                  </span>
                ) : null}
                <Badge tone={SEVERITY_TONE[issue.severity] ?? "unknown"} className="ml-auto">
                  {issue.severity}
                </Badge>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{issue.detail}</p>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note?: string;
  tone?: Tone;
}) {
  const accent =
    tone === "context" ? "text-context" : tone === "agree" ? "text-agree" : "text-ink";
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={`tabular mt-1.5 text-3xl font-semibold ${accent}`}>
        {value.toLocaleString()}
      </p>
      {note ? <p className="mt-1 text-xs leading-relaxed text-faint">{note}</p> : null}
    </Card>
  );
}

export default function QualityPage() {
  return (
    <Suspense fallback={<Loading />}>
      <QualityInner />
    </Suspense>
  );
}
