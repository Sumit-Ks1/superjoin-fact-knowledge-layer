/**
 * Environment access.
 *
 * Everything is read lazily. Next builds on Vercel run without runtime secrets,
 * so touching a missing key at import time would break `next build`. Callers ask
 * for what they need, when they need it, and get an actionable error if it is
 * absent — never a bare `undefined` propagating into a query.
 */

class MissingEnvError extends Error {
  constructor(key: string, hint: string) {
    super(`Missing required environment variable ${key}. ${hint}`);
    this.name = "MissingEnvError";
  }
}

function required(key: string, hint: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") throw new MissingEnvError(key, hint);
  return value.trim();
}

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function num(key: string, fallback: number): number {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  /* Supabase — single backend: Postgres + pgvector + Storage */
  get supabaseUrl() {
    return required(
      "NEXT_PUBLIC_SUPABASE_URL",
      "Copy it from Supabase → Project Settings → Data API.",
    );
  },
  get supabaseServiceKey() {
    return required(
      "SUPABASE_SERVICE_ROLE_KEY",
      "Supabase → Project Settings → API keys → service_role. Server-only; never expose to the browser.",
    );
  },
  get storageBucket() {
    return optional("SUPABASE_STORAGE_BUCKET") ?? "documents";
  },

  /**
   * Corpus that uploads land in when the request does not name one.
   *
   * A corpus is the comparison boundary — linking runs across everything inside
   * one and never outside it. Pointing local development at its own corpus is
   * what stops test PDFs being compared against a real user's uploads later,
   * without needing a second Supabase project.
   */
  get defaultCorpusSlug() {
    return optional("DEFAULT_CORPUS_SLUG") ?? "default";
  },

  /* Postgres. Transaction pooler for the app, session pooler for DDL. */
  get databaseUrl() {
    return required(
      "DATABASE_URL",
      "Supabase → Connect → Transaction pooler (port 6543). Append ?pgbouncer=true.",
    );
  },
  /**
   * Session pooler, used only for DDL.
   *
   * Migrations create extensions and indexes, which PgBouncer's transaction
   * mode cannot carry. Falls back to the app connection when unset, which works
   * for most statements but will fail on `CREATE EXTENSION`.
   */
  get directUrl() {
    return optional("DIRECT_URL") ?? this.databaseUrl;
  },

  /* Model providers */
  get googleApiKey() {
    return optional("GOOGLE_API_KEY");
  },
  get groqApiKey() {
    return optional("GROQ_API_KEY");
  },
  get primaryModel() {
    return optional("LLM_PRIMARY_MODEL") ?? "gemini-2.5-flash";
  },
  get fallbackModel() {
    return optional("LLM_FALLBACK_MODEL") ?? "llama-3.3-70b-versatile";
  },
  get embeddingModel() {
    return optional("EMBEDDING_MODEL") ?? "gemini-embedding-001";
  },
  get embeddingDimensions() {
    return num("EMBEDDING_DIMENSIONS", 768);
  },

  /* Pipeline tuning */

  /*
   * Batch sizes, in units of work per serverless invocation.
   *
   * These exist because the platform, not the algorithm, sets the ceiling.
   * Vercel's free tier stops a function after 60 seconds, and a 100-page
   * filing takes well over that to parse in one go — so every stage runs in
   * slices small enough to finish, with Inngest carrying the state between
   * them. Lower them if you see FUNCTION_INVOCATION_TIMEOUT; raise them on a
   * plan with a longer limit.
   */
  get parsePageBatch() {
    return num("PARSE_PAGE_BATCH", 20);
  },
  get extractChunkBatch() {
    return num("EXTRACT_CHUNK_BATCH", 8);
  },
  get embedFactBatch() {
    return num("EMBED_FACT_BATCH", 300);
  },

  get llmMaxConcurrency() {
    return num("LLM_MAX_CONCURRENCY", 3);
  },
  get llmMaxAttempts() {
    return num("LLM_MAX_ATTEMPTS", 4);
  },

  /* Upload limits. Any PDF may be uploaded, so the ceilings are explicit and
   * tunable rather than implicit in whatever the function happens to survive. */
  get maxUploadBytes() {
    return num("MAX_UPLOAD_BYTES", 50 * 1024 * 1024);
  },
  get maxUploadPages() {
    return num("MAX_UPLOAD_PAGES", 500);
  },
  /** Pages sampled when deciding whether a document has a usable text layer. */
  get textLayerProbePages() {
    return num("TEXT_LAYER_PROBE_PAGES", 6);
  },

  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
} as const;

/**
 * Startup preflight for `/api/health`.
 *
 * Reports every problem at once instead of failing on the first: a
 * half-configured deployment should be fixable in one pass, not five.
 *
 * Required and optional are reported separately, and only a missing *required*
 * value makes the deployment unhealthy. Without a model key the system still
 * parses documents, reads tables deterministically, normalises units and
 * periods and runs every linking channel — it finds less, but nothing is
 * broken, and reporting that as a failure would send someone chasing a
 * non-problem during setup.
 */
export function checkConfiguration(): {
  ok: boolean;
  /** True when everything required is present AND nothing is degraded. */
  complete: boolean;
  checks: { key: string; ok: boolean; required: boolean; detail: string }[];
} {
  const checks: { key: string; ok: boolean; required: boolean; detail: string }[] = [];

  const probe = (key: string, fn: () => unknown, detail: string) => {
    try {
      fn();
      checks.push({ key, ok: true, required: true, detail });
    } catch (error) {
      checks.push({ key, ok: false, required: true, detail: (error as Error).message });
    }
  };

  probe("NEXT_PUBLIC_SUPABASE_URL", () => env.supabaseUrl, "Supabase project URL");
  probe("SUPABASE_SERVICE_ROLE_KEY", () => env.supabaseServiceKey, "Storage access (server-only)");
  probe("DATABASE_URL", () => env.databaseUrl, "Postgres, via the transaction pooler");

  /*
   * Not a failure either way, but worth stating plainly: uploading into the
   * wrong corpus is silent, and the symptom ("my upload worked but nothing
   * appears") gives no hint of the cause.
   */
  checks.push({
    key: "DEFAULT_CORPUS_SLUG",
    ok: true,
    required: false,
    detail:
      env.defaultCorpusSlug === "default"
        ? "default — set this to something like local-dev when testing against a shared project"
        : `${env.defaultCorpusSlug} — isolated from the "default" corpus`,
  });

  const hasModel = Boolean(env.googleApiKey || env.groqApiKey);
  checks.push({
    key: "GOOGLE_API_KEY | GROQ_API_KEY",
    ok: hasModel,
    required: false,
    detail: hasModel
      ? `primary=${env.primaryModel}${env.groqApiKey ? `, fallback=${env.fallbackModel}` : " (no fallback configured)"}`
      : "Not set. Tables, normalisation and linking all still run; facts will not be extracted from prose.",
  });

  checks.push({
    key: "GOOGLE_API_KEY (embeddings)",
    ok: Boolean(env.googleApiKey),
    required: false,
    detail: env.googleApiKey
      ? `model=${env.embeddingModel}, dims=${env.embeddingDimensions}`
      : "Not set. The similarity channel is disabled; exact-key and arithmetic channels are unaffected.",
  });

  const required = checks.filter((c) => c.required);

  return {
    ok: required.every((c) => c.ok),
    complete: checks.every((c) => c.ok),
    checks,
  };
}
