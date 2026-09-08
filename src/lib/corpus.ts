/**
 * Which corpus a request is talking about.
 *
 * A corpus is the comparison boundary: linking runs across everything inside
 * one and never reaches outside it. That makes it the right tool for keeping
 * development data away from real data, which matters here because the
 * alternative is worse than untidy — test documents in the same corpus as a
 * user's uploads would be *linked against them*, and the user's findings would
 * quietly include comparisons with someone else's sample PDFs.
 *
 * So local development points `DEFAULT_CORPUS_SLUG` at something like
 * `local-dev` and production leaves it unset. One Supabase project, two
 * completely separate worlds, no code change.
 */

import { env } from "./env";

/**
 * Slugs are user-supplied via `?corpus=`, so they are constrained rather than
 * trusted. Lowercase, digits, hyphens: enough to name a corpus, not enough to
 * be interesting to anything downstream.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export class InvalidCorpusSlugError extends Error {
  constructor(slug: string) {
    super(
      `"${slug}" is not a valid corpus name. Use lowercase letters, digits and hyphens (1–64 characters).`,
    );
    this.name = "InvalidCorpusSlugError";
  }
}

/**
 * Resolves the corpus for a request.
 *
 * An explicit `?corpus=` wins, then `DEFAULT_CORPUS_SLUG`, then `default`.
 * Every route resolves through here so a deployment cannot end up writing to
 * one corpus and reading from another — the failure that would produce is
 * "my upload succeeded but nothing appears", which is miserable to diagnose.
 */
export function resolveCorpusSlug(requested?: string | null): string {
  const slug = (requested ?? "").trim().toLowerCase() || env.defaultCorpusSlug;
  if (!SLUG_PATTERN.test(slug)) throw new InvalidCorpusSlugError(slug);
  return slug;
}

/** Human-readable name for a corpus created on demand. */
export function corpusDisplayName(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
