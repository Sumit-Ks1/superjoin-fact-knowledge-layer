/**
 * Model access: one call site, with everything that makes it survivable.
 *
 * The pipeline runs on free-tier quotas against providers that rate-limit
 * aggressively and occasionally return prose where JSON was asked for. Four
 * things make that workable, and they are the reason this file exists rather
 * than callers talking to the SDKs directly:
 *
 *  1. CACHE. Every call is keyed by sha256(model + kind + prompt + schema).
 *     A retried Inngest step, a re-run over the same document, or two documents
 *     sharing boilerplate all hit the cache. Re-runs during development cost
 *     nothing, which is what makes a free tier viable.
 *  2. RETRY. Exponential backoff with jitter, and — importantly — only for
 *     errors worth retrying. A 429 is worth waiting for; a 400 never is.
 *  3. FALLBACK. Gemini is primary, Groq is the failover. Different vendor,
 *     different quota, different outage. When the primary is exhausted the
 *     pipeline slows down instead of stopping.
 *  4. DEGRADATION. With no key configured at all, callers get a typed
 *     "unavailable" result rather than an exception. Deterministic table
 *     extraction still runs, so an unconfigured deployment produces fewer facts
 *     rather than no output and a stack trace.
 *
 * Nothing here is domain-specific. Prompts live with the stages that own them.
 */

import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import pLimit from "p-limit";
import type { z } from "zod";

import { getDb } from "@/db/client";
import { llmCache } from "@/db/schema";
import { env } from "@/lib/env";
import { sha256 } from "@/lib/hash";
import { log } from "@/lib/logger";
import { inArray, sql } from "drizzle-orm";

export type CompletionRequest = {
  /** Stable label for the call site; part of the cache key. */
  task: string;
  system: string;
  prompt: string;
  /** Response is coerced to this shape. Its text form joins the cache key. */
  schema?: z.ZodTypeAny;
  schemaName?: string;
  temperature?: number;
  maxOutputTokens?: number;
};

export type CompletionResult<T> =
  | { ok: true; data: T; model: string; cached: boolean }
  | { ok: false; reason: "unavailable" | "invalid_output" | "exhausted"; detail: string };

/* ── shared limiter ───────────────────────────────────────────────────────── */

/*
 * One limiter per process, not per call. Serverless gives each invocation its
 * own module instance, so this bounds concurrency within a single function —
 * which is the unit that gets rate-limited.
 */
let limiter: ReturnType<typeof pLimit> | null = null;
function getLimiter() {
  if (!limiter) limiter = pLimit(Math.max(1, env.llmMaxConcurrency));
  return limiter;
}

let googleClient: GoogleGenAI | null = null;
let groqClient: Groq | null = null;

function google(): GoogleGenAI | null {
  const key = env.googleApiKey;
  if (!key) return null;
  if (!googleClient) googleClient = new GoogleGenAI({ apiKey: key });
  return googleClient;
}

function groq(): Groq | null {
  const key = env.groqApiKey;
  if (!key) return null;
  if (!groqClient) groqClient = new Groq({ apiKey: key });
  return groqClient;
}

export function modelProvidersConfigured(): boolean {
  return Boolean(env.googleApiKey || env.groqApiKey);
}

/* ── retry policy ─────────────────────────────────────────────────────────── */

/**
 * Whether an error is worth another attempt.
 *
 * Retrying a malformed request just burns quota to get the same 400 back. Rate
 * limits, timeouts and 5xx are transient by definition and are the whole reason
 * this pipeline needs backoff.
 */
export function isRetryable(error: unknown): boolean {
  const status =
    (error as { status?: number })?.status ?? (error as { code?: number })?.code ?? undefined;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return false;
  }
  const message = String((error as Error)?.message ?? error).toLowerCase();
  return /rate.?limit|quota|timeout|timed out|econn|socket|network|overload|unavailable|503|502|500/.test(
    message,
  );
}

/** Full jitter: spreads a fanned-out batch instead of retrying it in lockstep. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(30_000, 500 * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * The longest a single retry will wait.
 *
 * A provider may ask for longer than the invocation has left. Waiting past that
 * turns a recoverable rate limit into a killed function and loses the step's
 * work, so a hint above this is treated as "not worth waiting for" and the call
 * fails cleanly instead.
 */
const MAX_RETRY_WAIT_MS = 60_000;

/**
 * How long the provider asked us to wait, if it said.
 *
 * Gemini answers a 429 with the actual reset time — `"Please retry in 23.48s"`,
 * and a `RetryInfo` block saying the same. Blind exponential backoff ignores it
 * and, capped at 30s, reliably wakes up inside the same one-minute window and
 * burns another attempt on a certain failure. The free embedding quota is
 * counted per input text at 100 a minute, so this is not an edge case: it is
 * what happens on any document big enough to need a second batch.
 */
export function retryHintMs(error: unknown): number | null {
  const raw = String((error as Error)?.message ?? error);

  // "retryDelay":"23s" — the structured form, preferred.
  const structured = raw.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (structured) return Math.ceil(Number(structured[1]) * 1000);

  // "Please retry in 23.484258793s." — the prose form.
  const prose = raw.match(/retry in ([\d.]+)s/i);
  if (prose) return Math.ceil(Number(prose[1]) * 1000);

  return null;
}

/**
 * What to wait before the next attempt.
 *
 * The provider's own number when it gave one — a second is added because its
 * window boundary and our clock are not the same clock, and landing one tick
 * early costs a whole attempt. Jitter otherwise.
 */
function waitFor(error: unknown, attempt: number): number | null {
  const hint = retryHintMs(error);
  if (hint === null) return backoffMs(attempt);
  if (hint > MAX_RETRY_WAIT_MS) return null;
  return hint + 1_000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── JSON coercion ────────────────────────────────────────────────────────── */

/**
 * Pulls a JSON value out of a model response.
 *
 * Even in JSON mode, models wrap output in fences or prepend a sentence often
 * enough that failing on it would lose real extractions. Brace matching is used
 * rather than a greedy regex so a trailing explanation cannot swallow the
 * object's closing brace.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();

  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }

  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ── cache ────────────────────────────────────────────────────────────────── */

function cacheKey(parts: {
  model: string;
  kind: "completion" | "embedding";
  payload: string;
}): string {
  return sha256(`${parts.kind}\u0000${parts.model}\u0000${parts.payload}`);
}

async function readCache(key: string): Promise<unknown | undefined> {
  try {
    const db = getDb();
    const rows = await db
      .select({ response: llmCache.response })
      .from(llmCache)
      .where(sql`${llmCache.key} = ${key}`)
      .limit(1);
    if (rows.length === 0) return undefined;
    // Hit counting is advisory; a failure here must never fail the call.
    void db
      .update(llmCache)
      .set({ hits: sql`${llmCache.hits} + 1` })
      .where(sql`${llmCache.key} = ${key}`)
      .catch(() => {});
    return rows[0].response;
  } catch (error) {
    // A cache that is down is a slow pipeline, not a broken one.
    log.warn("llm cache read failed", { error });
    return undefined;
  }
}

async function writeCache(
  key: string,
  model: string,
  kind: "completion" | "embedding",
  response: unknown,
): Promise<void> {
  return writeCacheMany(model, kind, [{ key, response }]);
}

/**
 * Reads many cache entries in one query.
 *
 * The per-key version is fine for a completion — one call, one lookup. It is
 * not fine for embeddings, which look up a key per *text*: a 300-fact slice
 * became 300 sequential round trips, and the database is a region away from
 * the function. That alone was ~60s of pure latency, and it was a third of why
 * the embed step overran the platform's execution limit. One `IN` query is the
 * same information for one round trip.
 */
async function readCacheMany(keys: string[]): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>();
  if (keys.length === 0) return found;

  try {
    const db = getDb();
    // Chunked so a large slice cannot exceed the parameter limit of one query.
    for (let i = 0; i < keys.length; i += CACHE_QUERY_CHUNK) {
      const slice = keys.slice(i, i + CACHE_QUERY_CHUNK);
      const rows = await db
        .select({ key: llmCache.key, response: llmCache.response })
        .from(llmCache)
        .where(inArray(llmCache.key, slice));
      for (const row of rows) found.set(row.key, row.response);
    }

    // Hit counting is advisory; a failure here must never fail the call.
    if (found.size > 0) {
      void db
        .update(llmCache)
        .set({ hits: sql`${llmCache.hits} + 1` })
        .where(inArray(llmCache.key, [...found.keys()]))
        .catch(() => {});
    }
  } catch (error) {
    // A cache that is down is a slow pipeline, not a broken one.
    log.warn("llm cache read failed", { error });
    return new Map();
  }

  return found;
}

/** Writes many cache entries in one statement, for the same reason. */
async function writeCacheMany(
  model: string,
  kind: "completion" | "embedding",
  entries: { key: string; response: unknown }[],
): Promise<void> {
  // Two identical texts in one batch produce one key; keep the first.
  const unique = [...new Map(entries.map((e) => [e.key, e])).values()];
  if (unique.length === 0) return;

  try {
    const db = getDb();
    for (let i = 0; i < unique.length; i += CACHE_QUERY_CHUNK) {
      await db
        .insert(llmCache)
        .values(
          unique
            .slice(i, i + CACHE_QUERY_CHUNK)
            .map((e) => ({ key: e.key, model, kind, response: e.response as never })),
        )
        .onConflictDoNothing();
    }
  } catch (error) {
    log.warn("llm cache write failed", { error });
  }
}

/**
 * Rows per cache query.
 *
 * An embedding row is a 768-float array, roughly 9 KB of JSON, so this bounds
 * a single statement to a few hundred KB rather than several megabytes.
 */
const CACHE_QUERY_CHUNK = 50;

/* ── completion ───────────────────────────────────────────────────────────── */

type Attempt = { provider: "google" | "groq"; model: string };

/** Primary first, then the other vendor. Skips providers with no key. */
function attemptPlan(): Attempt[] {
  const plan: Attempt[] = [];
  if (env.googleApiKey) plan.push({ provider: "google", model: env.primaryModel });
  if (env.groqApiKey) plan.push({ provider: "groq", model: env.fallbackModel });
  return plan;
}

async function callGoogle(model: string, request: CompletionRequest): Promise<string> {
  const client = google();
  if (!client) throw new Error("google client unavailable");

  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
    config: {
      systemInstruction: request.system,
      temperature: request.temperature ?? 0,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
      responseMimeType: "application/json",
    },
  });

  return response.text ?? "";
}

async function callGroq(model: string, request: CompletionRequest): Promise<string> {
  const client = groq();
  if (!client) throw new Error("groq client unavailable");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
    temperature: request.temperature ?? 0,
    max_tokens: request.maxOutputTokens ?? 4096,
    response_format: { type: "json_object" },
  });

  return response.choices[0]?.message?.content ?? "";
}

/**
 * Runs one structured completion.
 *
 * Never throws for an expected failure. Extraction runs over hundreds of
 * chunks; one bad chunk must degrade to a logged issue, not abort the document.
 */
export async function complete<T>(
  request: CompletionRequest & { schema: z.ZodType<T> },
): Promise<CompletionResult<T>> {
  const plan = attemptPlan();
  if (plan.length === 0) {
    return {
      ok: false,
      reason: "unavailable",
      detail: "No model provider is configured. Set GOOGLE_API_KEY or GROQ_API_KEY.",
    };
  }

  const schemaText = request.schemaName ?? "";
  const payload = `${request.task}\u0000${request.system}\u0000${request.prompt}\u0000${schemaText}`;

  const failures: string[] = [];

  for (const attempt of plan) {
    const key = cacheKey({ model: attempt.model, kind: "completion", payload });

    const cached = await readCache(key);
    if (cached !== undefined) {
      const parsed = request.schema.safeParse(cached);
      if (parsed.success) {
        return { ok: true, data: parsed.data, model: attempt.model, cached: true };
      }
      // A cached value that no longer validates means the schema changed under
      // it; fall through and call the model again.
    }

    const maxAttempts = Math.max(1, env.llmMaxAttempts);
    for (let tries = 0; tries < maxAttempts; tries++) {
      try {
        const raw = await getLimiter()(() =>
          attempt.provider === "google"
            ? callGoogle(attempt.model, request)
            : callGroq(attempt.model, request),
        );

        const json = extractJson(raw);
        if (json === undefined) {
          failures.push(`${attempt.model}: response was not JSON`);
          break; // Retrying at temperature 0 returns the same text.
        }

        const parsed = request.schema.safeParse(json);
        if (!parsed.success) {
          failures.push(`${attempt.model}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
          break;
        }

        await writeCache(key, attempt.model, "completion", json);
        return { ok: true, data: parsed.data, model: attempt.model, cached: false };
      } catch (error) {
        const detail = String((error as Error)?.message ?? error);
        const wait = isRetryable(error) ? waitFor(error, tries) : null;
        if (wait === null || tries === maxAttempts - 1) {
          failures.push(`${attempt.model}: ${detail}`);
          break;
        }
        log.warn("model call failed; retrying", {
          task: request.task,
          model: attempt.model,
          attempt: tries + 1,
          waitMs: Math.round(wait),
          error: detail,
        });
        await sleep(wait);
      }
    }
  }

  const detail = failures.join("; ") || "all providers failed";
  log.error("model call exhausted every provider", { task: request.task, detail });
  return {
    ok: false,
    reason: failures.some((f) => /not JSON|schema mismatch/.test(f)) ? "invalid_output" : "exhausted",
    detail,
  };
}

/* ── embeddings ───────────────────────────────────────────────────────────── */

export type EmbeddingResult =
  | { ok: true; vectors: number[][]; cached: number }
  | { ok: false; reason: "unavailable" | "exhausted"; detail: string };

/**
 * Embeds a batch of texts, one cache entry per text.
 *
 * Per-text rather than per-batch caching matters: chunk sets shift between runs
 * as the parser improves, and a batch key would miss on every reshuffle even
 * though almost every individual text is unchanged.
 */
/**
 * Turns a provider error into one sentence a person can act on.
 *
 * Providers return a wall of nested JSON — quota metrics, help links, retry
 * hints. Surfacing that verbatim puts a paragraph of machine detail in the UI
 * and the logs, and buries the one fact that matters. The raw text is still
 * logged at warn level for debugging; this is what a reader sees.
 */
export function describeProviderError(error: unknown): string {
  const raw = String((error as Error)?.message ?? error);

  if (/RESOURCE_EXHAUSTED|429|quota/i.test(raw)) {
    const perDay = /PerDay/i.test(raw);
    return perDay
      ? "The model provider's free daily quota is used up. Similarity linking is disabled until it resets; every other channel is unaffected."
      : "The model provider is rate-limiting requests. Similarity linking was skipped for now; every other channel is unaffected.";
  }
  if (/API_KEY_INVALID|401|403|PERMISSION_DENIED|API key not valid/i.test(raw)) {
    return "The model API key was rejected. Check GOOGLE_API_KEY.";
  }
  if (/NOT_FOUND|is not found for API version|model/i.test(raw) && /404/.test(raw)) {
    return `The embedding model "${env.embeddingModel}" was not found. Check EMBEDDING_MODEL.`;
  }

  // Unknown: keep it short rather than pasting a JSON document into the page.
  const firstLine = raw.split("\n")[0];
  return firstLine.length > 180 ? `${firstLine.slice(0, 180)}…` : firstLine;
}

/**
 * How many texts go into one API call.
 *
 * The provider accepts a list, and using it is the difference between working
 * and not: a single annual report yields ~2,500 facts, and embedding them one
 * request at a time exhausted a 1,000-per-day free quota on the first document.
 * Batched, the same document costs about 25 calls.
 */
const EMBED_BATCH = 100;

/**
 * Embeds a batch of texts, one cache entry per text.
 *
 * Per-text rather than per-batch caching matters: chunk sets shift between runs
 * as the parser improves, and a batch key would miss on every reshuffle even
 * though almost every individual text is unchanged.
 */
export async function embed(texts: string[]): Promise<EmbeddingResult> {
  if (texts.length === 0) return { ok: true, vectors: [], cached: 0 };

  const client = google();
  if (!client) {
    return {
      ok: false,
      reason: "unavailable",
      detail: "Embeddings require GOOGLE_API_KEY. Similarity linking is disabled without it.",
    };
  }

  const model = env.embeddingModel;
  const dimensions = env.embeddingDimensions;
  const vectors: (number[] | null)[] = new Array(texts.length).fill(null);
  const pending: number[] = [];
  let cached = 0;

  /*
   * Keys first, then one batched lookup. Reading them one at a time is the
   * same answer for a round trip per text, which is the difference between a
   * step that finishes and a step the platform kills.
   */
  const keys = texts.map((text) =>
    cacheKey({ model, kind: "embedding", payload: `${dimensions} ${text}` }),
  );
  const hits = await readCacheMany([...new Set(keys)]);

  for (let i = 0; i < texts.length; i++) {
    const hit = hits.get(keys[i]);
    if (Array.isArray(hit) && hit.length === dimensions) {
      vectors[i] = hit as number[];
      cached += 1;
    } else {
      pending.push(i);
    }
  }

  for (let offset = 0; offset < pending.length; offset += EMBED_BATCH) {
    const slice = pending.slice(offset, offset + EMBED_BATCH);
    const maxAttempts = Math.max(1, env.llmMaxAttempts);
    let done = false;

    for (let tries = 0; tries < maxAttempts && !done; tries++) {
      try {
        const response = await getLimiter()(() =>
          client.models.embedContent({
            model,
            contents: slice.map((index) => texts[index]),
            config: { outputDimensionality: dimensions },
          }),
        );

        const returned = response.embeddings ?? [];
        if (returned.length !== slice.length) {
          throw new Error(
            `embedding returned ${returned.length} vectors for ${slice.length} inputs`,
          );
        }

        const toCache: { key: string; response: unknown }[] = [];

        for (let k = 0; k < slice.length; k++) {
          const values = returned[k]?.values;
          if (!values || values.length !== dimensions) {
            throw new Error(
              `embedding returned ${values?.length ?? 0} dimensions, expected ${dimensions}`,
            );
          }
          // Gemini's reduced-dimension output is not unit length; cosine
          // distance in pgvector assumes it is.
          const vector = normalize(values);
          vectors[slice[k]] = vector;
          toCache.push({ key: keys[slice[k]], response: vector });
        }

        // One write for the whole API batch, not one per text.
        await writeCacheMany(model, "embedding", toCache);
        done = true;
      } catch (error) {
        const wait = isRetryable(error) ? waitFor(error, tries) : null;
        if (wait === null || tries === maxAttempts - 1) {
          log.warn("embedding failed", { detail: String((error as Error)?.message ?? error) });
          return { ok: false, reason: "exhausted", detail: describeProviderError(error) };
        }
        log.warn("embedding rate-limited; waiting as the provider asked", {
          attempt: tries + 1,
          waitMs: Math.round(wait),
        });
        await sleep(wait);
      }
    }
  }

  return { ok: true, vectors: vectors as number[][], cached };
}

/** Scales a vector to unit length; a zero vector is returned unchanged. */
function normalize(values: number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}