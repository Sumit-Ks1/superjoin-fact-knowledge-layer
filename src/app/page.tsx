"use client";

/**
 * Documents: upload and progress.
 *
 * The upload goes browser → Supabase Storage directly, using a signed URL this
 * page asks the API for. The bytes never pass through a serverless function,
 * because the platform caps a request body at 4.5 MB and real filings are
 * larger than that.
 *
 * The file is hashed in the browser before anything is sent. That hash is the
 * idempotency key, so re-uploading the same document is recognised as the same
 * document rather than processed twice.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { describeSkippedStage } from "@/lib/user-message";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  FilterGroup,
  Loading,
  Notice,
  PageHeader,
  type FilterOption,
  type Tone,
} from "@/components/ui";

type Stage = {
  stage: string;
  status: string;
  metrics: Record<string, unknown> | null;
};

type DocumentRow = {
  id: string;
  filename: string;
  byteSize: number;
  pageCount: number | null;
  docType: string | null;
  fiscalYearEnd: string | null;
  status: string;
  error: string | null;
  factCount: number;
  issueCount: number;
  stages: Stage[];
};

const STAGES = ["parse", "chunk", "extract", "normalize", "link"] as const;

const STATUS_TONE: Record<string, Tone> = {
  ready: "agree",
  processing: "context",
  failed: "conflict",
  uploaded: "unknown",
};

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatBytes(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export default function DocumentsPage() {
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [corpus, setCorpus] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/documents", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? data.error ?? "Could not load documents.");
      setRows(data.documents ?? []);
      setCorpus(data.corpusSlug ?? null);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while anything is in flight, and stop once everything settles.
  useEffect(() => {
    const active = rows.some((r) => r.status === "processing" || r.status === "uploaded");
    if (!active) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [rows, refresh]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    for (const file of Array.from(files)) {
      try {
        setBusy(`Hashing ${file.name}…`);
        const sha256 = await sha256Hex(file);

        setBusy(`Reserving ${file.name}…`);
        const created = await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: file.name, byteSize: file.size, sha256 }),
        });
        const meta = await created.json();
        if (!created.ok) throw new Error(meta.detail ?? meta.error);

        if (!meta.duplicate) {
          setBusy(`Uploading ${file.name}…`);
          const put = await fetch(meta.uploadUrl, {
            method: "PUT",
            headers: { "content-type": "application/pdf" },
            body: file,
          });
          if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
        }

        setBusy(`Starting ${file.name}…`);
        const started = await fetch(`/api/documents/${meta.documentId}/ingest`, { method: "POST" });
        if (!started.ok) {
          const detail = await started.json().catch(() => ({}));
          throw new Error(detail.detail ?? detail.error ?? "Could not start processing.");
        }
      } catch (e) {
        setError(`${file.name}: ${String((e as Error).message)}`);
      }
    }

    setBusy(null);
    if (inputRef.current) inputRef.current.value = "";
    void refresh();
  }

  async function remove(row: DocumentRow) {
    const warning =
      row.status === "processing"
        ? `"${row.filename}" is still processing. Deleting it now will stop the run.`
        : `Delete "${row.filename}"?`;

    const confirmed = window.confirm(
      `${warning}\n\nThis removes its facts, evidence and findings, including any ` +
        `cross-document findings that referenced them. It cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleting(row.id);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${row.id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail ?? body.error ?? "Delete failed.");

      // Drop it locally straight away rather than waiting for the refetch —
      // the row is gone, and leaving it on screen looks like a failure.
      setRows((current) => current.filter((r) => r.id !== row.id));

      if (body.storageRemoved === false) {
        setError(
          `"${row.filename}" was removed, but its stored file could not be deleted. It is orphaned and harmless.`,
        );
      }
    } catch (e) {
      setError(`Could not delete ${row.filename}: ${String((e as Error).message)}`);
    } finally {
      setDeleting(null);
      void refresh();
    }
  }

  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  const filters: FilterOption[] = [
    { value: "", label: "All", count: rows.length },
    { value: "ready", label: "Ready", count: counts.ready ?? 0 },
    { value: "processing", label: "Processing", count: counts.processing ?? 0 },
    { value: "failed", label: "Failed", count: counts.failed ?? 0 },
  ];

  const visible = filter ? rows.filter((row) => row.status === filter) : rows;

  return (
    <div className="space-y-6">
      <PageHeader title="Documents">
        Upload any PDFs that ought to talk about the same things. Findings come from comparing
        documents, so a second upload re-examines everything already here.
        
      </PageHeader>

      <Card className="border-dashed p-6">
        <label className="block">
          <span className="text-sm font-medium text-ink">Add documents</span>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            multiple
            disabled={busy !== null}
            onChange={(e) => void upload(e.target.files)}
            className="mt-2 block w-full text-sm text-muted file:mr-4 file:rounded-md file:border file:border-accent file:bg-accent file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-accent-hover disabled:opacity-50"
          />
        </label>
        <p className="mt-2 text-xs leading-relaxed text-faint">
          {busy ??
            "PDFs with a text layer. Scanned documents are detected and reported rather than silently producing nothing."}
        </p>
      </Card>

      {error ? <Notice>{error}</Notice> : null}

      {rows.length > 0 ? (
        <FilterGroup label="Document status" options={filters} value={filter} onChange={setFilter} />
      ) : null}

      {!loaded ? <Loading /> : null}

      {loaded && rows.length === 0 ? (
        <EmptyState>
          Nothing uploaded yet. Two or more related documents show the system at its most useful.
        </EmptyState>
      ) : null}

      {loaded && rows.length > 0 && visible.length === 0 ? (
        <EmptyState>No documents with that status.</EmptyState>
      ) : null}

      <div className="space-y-3">
        {visible.map((row) => (
          <Card key={row.id} as="article" className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-medium text-ink">{row.filename}</h2>
                <p className="mt-1 text-xs text-muted">
                  {formatBytes(row.byteSize)}
                  {row.pageCount ? ` · ${row.pageCount} pages` : ""}
                  {row.fiscalYearEnd ? ` · fiscal year ends ${row.fiscalYearEnd}` : ""}
                </p>
              </div>
              <Badge tone={STATUS_TONE[row.status] ?? "unknown"}>{row.status}</Badge>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              {STAGES.map((stage) => {
                const found = row.stages.find((s) => s.stage === stage);
                return (
                  <StagePill key={stage} stage={stage} status={found?.status ?? "pending"} />
                );
              })}
            </div>

            {/* What a skipped step means for the reader — derived from the
                step itself, never from the underlying error. */}
            {row.stages
              .filter((s) => s.status === "skipped")
              .map((s) => (
                <p key={s.stage} className="mt-2 text-xs leading-relaxed text-muted">
                  {describeSkippedStage(s.stage)}
                </p>
              ))}

            {row.error ? (
              <div className="mt-4">
                <Notice>{row.error}</Notice>
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <a
                className="text-sm text-accent underline-offset-4 hover:underline"
                href={`/facts?document=${row.id}`}
              >
                {row.factCount} fact{row.factCount === 1 ? "" : "s"}
              </a>
              <span className="text-line-strong">·</span>
              <a
                className="text-sm text-accent underline-offset-4 hover:underline"
                href={`/quality?document=${row.id}`}
              >
                {row.issueCount} issue{row.issueCount === 1 ? "" : "s"}
              </a>
              <Button
                variant="danger"
                onClick={() => void remove(row)}
                disabled={deleting === row.id}
                className="ml-auto"
              >
                {deleting === row.id ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * One pipeline stage.
 *
 * Status is carried by a filled dot as well as by colour, so the sequence still
 * reads when printed or seen by someone who cannot distinguish the hues.
 */
function StagePill({ stage, status }: { stage: string; status: string }) {
  const styles: Record<string, string> = {
    done: "border-agree/40 bg-agree-soft text-agree",
    running: "border-context/40 bg-context-soft text-context",
    failed: "border-conflict/40 bg-conflict-soft text-conflict",
    skipped: "border-line bg-unknown-soft text-muted",
    pending: "border-line bg-surface text-faint",
  };
  const marks: Record<string, string> = {
    done: "●",
    running: "◐",
    failed: "✕",
    skipped: "○",
    pending: "○",
  };

  return (
    <span
      title={`${stage}: ${status}`}
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium ${styles[status] ?? styles.pending}`}
    >
      <span aria-hidden>{marks[status] ?? marks.pending}</span>
      {stage}
    </span>
  );
}
