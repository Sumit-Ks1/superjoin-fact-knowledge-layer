/**
 * The corpus resolver is a validation boundary on user input (`?corpus=`) and
 * the thing that keeps development data away from real data. Both properties
 * are worth pinning down.
 */

import { afterEach, describe, expect, it } from "vitest";

import { corpusDisplayName, InvalidCorpusSlugError, resolveCorpusSlug } from "./corpus";

const ORIGINAL = process.env.DEFAULT_CORPUS_SLUG;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DEFAULT_CORPUS_SLUG;
  else process.env.DEFAULT_CORPUS_SLUG = ORIGINAL;
});

describe("resolveCorpusSlug", () => {
  it("falls back to 'default' when nothing is configured", () => {
    delete process.env.DEFAULT_CORPUS_SLUG;
    expect(resolveCorpusSlug()).toBe("default");
    expect(resolveCorpusSlug(null)).toBe("default");
    expect(resolveCorpusSlug("")).toBe("default");
  });

  it("uses DEFAULT_CORPUS_SLUG when the request names no corpus", () => {
    // The whole point: local development writes somewhere real uploads are not.
    process.env.DEFAULT_CORPUS_SLUG = "local-dev";
    expect(resolveCorpusSlug()).toBe("local-dev");
    expect(resolveCorpusSlug("   ")).toBe("local-dev");
  });

  it("lets an explicit corpus override the default", () => {
    process.env.DEFAULT_CORPUS_SLUG = "local-dev";
    expect(resolveCorpusSlug("delhivery")).toBe("delhivery");
  });

  it("normalises case so one corpus cannot become two", () => {
    // "Delhivery" and "delhivery" resolving to different corpora would silently
    // split a document set and stop it linking.
    expect(resolveCorpusSlug("Delhivery")).toBe("delhivery");
    expect(resolveCorpusSlug("  DELHIVERY  ")).toBe("delhivery");
  });

  it("accepts hyphens and digits", () => {
    expect(resolveCorpusSlug("india-macro-2025")).toBe("india-macro-2025");
    expect(resolveCorpusSlug("a")).toBe("a");
  });

  it("rejects anything that is not a plain slug", () => {
    for (const bad of [
      "has space",
      "has_underscore",
      "-leading",
      "trailing-",
      "slash/es",
      "dots.dots",
      "semi;colon",
      "'quote",
      "a".repeat(65),
    ]) {
      expect(() => resolveCorpusSlug(bad), bad).toThrow(InvalidCorpusSlugError);
    }
  });

  it("rejects an invalid DEFAULT_CORPUS_SLUG rather than silently ignoring it", () => {
    // A typo in the env var must not quietly route uploads to "default", which
    // is exactly the corpus it was set to avoid.
    process.env.DEFAULT_CORPUS_SLUG = "Local Dev";
    expect(() => resolveCorpusSlug()).toThrow(InvalidCorpusSlugError);
  });
});

describe("corpusDisplayName", () => {
  it("makes a readable name from a slug", () => {
    expect(corpusDisplayName("local-dev")).toBe("Local Dev");
    expect(corpusDisplayName("default")).toBe("Default");
    expect(corpusDisplayName("india-macro-2025")).toBe("India Macro 2025");
  });
});
