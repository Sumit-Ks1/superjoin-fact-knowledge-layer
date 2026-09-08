"use client";

/**
 * Shared interface pieces.
 *
 * These exist so the filter controls behave identically on every screen. When
 * each page styled its own buttons, "which one is selected?" was answered
 * differently in three places — and on one of them, not at all.
 *
 * The rule every control here follows: **a selected control must be more
 * visible than an unselected one, never less.** Selection is expressed by a
 * filled background *and* a weight change *and* a border change, so it survives
 * a monochrome screen, a colourblind reader, and a projector.
 */

import type { ReactNode } from "react";

/* ── layout ───────────────────────────────────────────────────────────────── */

export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="border-b border-line pb-5">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {children ? (
        <div className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{children}</div>
      ) : null}
    </header>
  );
}

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "article" | "section";
}) {
  return (
    <Tag className={`rounded-card border border-line bg-surface ${className}`}>{children}</Tag>
  );
}

/* ── filters ──────────────────────────────────────────────────────────────── */

export type FilterOption = {
  value: string;
  label: string;
  /** Shown as a count pill inside the button. */
  count?: number;
  /** Explains the option; rendered under the group when this one is active. */
  description?: string;
};

/**
 * A row of mutually exclusive filters.
 *
 * Rendered as real buttons in a `group` role with `aria-pressed`, so a screen
 * reader announces which is active rather than leaving it to colour alone.
 * The selected button is filled and bold; the rest are outlined with readable
 * ink, not muted grey — an unselected filter still has to be legible enough to
 * choose.
 */
export function FilterGroup({
  options,
  value,
  onChange,
  label,
}: {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const active = options.find((option) => option.value === value);

  return (
    <div>
      <div role="group" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={
                selected
                  ? "inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors"
                  : "inline-flex items-center gap-2 rounded-md border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:border-accent hover:bg-accent-soft"
              }
            >
              {option.label}
              {option.count !== undefined ? (
                <span
                  className={
                    selected
                      ? "tabular rounded bg-white/20 px-1.5 py-0.5 text-xs font-semibold"
                      : "tabular rounded bg-unknown-soft px-1.5 py-0.5 text-xs font-semibold text-muted"
                  }
                >
                  {option.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {active?.description ? (
        <p className="mt-3 text-sm leading-relaxed text-muted">{active.description}</p>
      ) : null}
    </div>
  );
}

/**
 * An independent on/off filter.
 *
 * A checkbox would do the job, but next to a row of filled filter buttons a
 * bare checkbox reads as a different kind of control. This matches them.
 */
export function ToggleFilter({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={
        checked
          ? "inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors"
          : "inline-flex items-center gap-2 rounded-md border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink transition-colors hover:border-accent hover:bg-accent-soft"
      }
    >
      <span
        aria-hidden
        className={
          checked
            ? "flex h-4 w-4 items-center justify-center rounded-sm border border-white/70 bg-white/20 text-[10px] leading-none text-white"
            : "flex h-4 w-4 items-center justify-center rounded-sm border border-line-strong text-[10px] leading-none text-transparent"
        }
      >
        ✓
      </span>
      {children}
    </button>
  );
}

/* ── buttons ──────────────────────────────────────────────────────────────── */

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "quiet";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  const styles: Record<string, string> = {
    primary: "border-accent bg-accent text-white hover:bg-accent-hover",
    secondary: "border-line-strong bg-surface text-ink hover:border-accent hover:bg-accent-soft",
    danger: "border-line-strong bg-surface text-conflict hover:border-conflict hover:bg-conflict-soft",
    quiet: "border-transparent bg-transparent text-muted hover:text-ink hover:bg-unknown-soft",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/* ── indicators ───────────────────────────────────────────────────────────── */

export type Tone = "agree" | "conflict" | "context" | "unknown" | "accent";

const TONES: Record<Tone, string> = {
  agree: "border-agree/30 bg-agree-soft text-agree",
  conflict: "border-conflict/30 bg-conflict-soft text-conflict",
  context: "border-context/30 bg-context-soft text-context",
  unknown: "border-line bg-unknown-soft text-unknown",
  accent: "border-accent/30 bg-accent-soft text-accent",
};

export function Badge({
  children,
  tone = "unknown",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Maps a relation type to the colour family it belongs to. */
export function toneForRelation(type: string): Tone {
  if (type === "CONTRADICTS") return "conflict";
  if (type.startsWith("RECONCILED") || type === "SUPERSEDES") return "context";
  if (type === "INSUFFICIENT_EVIDENCE") return "unknown";
  return "agree";
}

/* ── inputs ───────────────────────────────────────────────────────────────── */

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-line-strong bg-surface px-3.5 py-2 text-sm text-ink placeholder:text-faint focus:border-accent"
    />
  );
}

/* ── feedback ─────────────────────────────────────────────────────────────── */

export function Notice({
  children,
  tone = "conflict",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={`rounded-md border px-4 py-3 text-sm ${TONES[tone]}`}>{children}</div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Card className="p-8 text-center text-sm leading-relaxed text-muted">{children}</Card>
  );
}

export function Loading() {
  return <p className="py-8 text-center text-sm text-muted">Loading…</p>;
}
