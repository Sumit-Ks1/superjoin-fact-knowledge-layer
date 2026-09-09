/**
 * The three places a model call goes wrong in ways worth encoding.
 *
 * Response shape: providers wrap JSON in fences, prepend a sentence, or append
 * an explanation, even in JSON mode. Losing those responses would silently drop
 * real extractions.
 *
 * Retry classification: retrying a 400 burns quota to receive the same 400.
 * Not retrying a 429 throws away a document that would have succeeded.
 *
 * Retry timing: the embedding quota is a one-minute window, and backoff capped
 * below it wakes up inside the same window every time. The provider states the
 * reset; these assert that it is read rather than guessed at.
 */

import { describe, expect, it } from "vitest";

import { describeProviderError, extractJson, isRetryable, retryHintMs } from "./provider";

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"facts":[]}')).toEqual({ facts: [] });
  });

  it("parses a fenced block", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses an unlabelled fenced block", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers an object from a chatty preamble", () => {
    expect(extractJson('Sure! Here is the JSON:\n{"a":1}')).toEqual({ a: 1 });
  });

  it("stops at the object's own closing brace, not the last one in the text", () => {
    // A greedy regex would swallow the trailing prose and fail to parse.
    const raw = 'Result: {"a":{"b":2}} — note that {this} is not JSON.';
    expect(extractJson(raw)).toEqual({ a: { b: 2 } });
  });

  it("ignores braces inside strings", () => {
    expect(extractJson('{"note":"a } brace","ok":true}')).toEqual({
      note: "a } brace",
      ok: true,
    });
  });

  it("ignores escaped quotes inside strings", () => {
    expect(extractJson('{"q":"he said \\"hi\\" }","ok":true}')).toEqual({
      q: 'he said "hi" }',
      ok: true,
    });
  });

  it("parses a top-level array", () => {
    expect(extractJson('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("returns undefined when there is no JSON at all", () => {
    expect(extractJson("I cannot help with that request.")).toBeUndefined();
  });

  it("returns undefined for truncated JSON rather than guessing", () => {
    expect(extractJson('{"facts":[{"value":1')).toBeUndefined();
  });
});

describe("isRetryable", () => {
  it("retries rate limits", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  it("retries server errors", () => {
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it("does not retry a bad request", () => {
    expect(isRetryable({ status: 400 })).toBe(false);
  });

  it("does not retry an auth failure", () => {
    // Waiting will not produce a key.
    expect(isRetryable({ status: 401 })).toBe(false);
  });

  it("retries transport failures that carry no status", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryable(new Error("request timed out"))).toBe(true);
    expect(isRetryable(new Error("model is overloaded"))).toBe(true);
  });

  it("does not retry an unrecognised error", () => {
    expect(isRetryable(new Error("invalid argument: schema"))).toBe(false);
  });
});

describe("describeProviderError", () => {
  /*
   * What a reader sees when a provider fails. The raw payload is a wall of
   * nested JSON — quota metrics, help links, retry hints — and pasting it into
   * the page buries the one fact that matters behind a paragraph of machine
   * detail.
   */
  const QUOTA =
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/embed_content_free_tier_requests, limit: 1000","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"EmbedContentRequestsPerDayPerProjectPerModel-FreeTier"}]}}';

  it("turns a daily-quota wall of JSON into one sentence", () => {
    const message = describeProviderError(new Error(QUOTA));
    expect(message).toContain("free daily quota");
    expect(message).not.toContain("{");
    expect(message.length).toBeLessThan(200);
  });

  it("says what still works, because most of the system does", () => {
    expect(describeProviderError(new Error(QUOTA))).toContain("every other channel is unaffected");
  });

  it("distinguishes a rate limit from an exhausted daily allowance", () => {
    const burst = describeProviderError(new Error('{"code":429,"status":"RESOURCE_EXHAUSTED"}'));
    expect(burst).toContain("rate-limiting");
    expect(burst).not.toContain("daily");
  });

  it("names the setting to check for a rejected key", () => {
    expect(describeProviderError(new Error("API key not valid [401]"))).toContain(
      "GOOGLE_API_KEY",
    );
  });

  it("truncates an unrecognised error rather than pasting a document", () => {
    const message = describeProviderError(new Error("x".repeat(500)));
    expect(message.length).toBeLessThanOrEqual(181);
    expect(message.endsWith("…")).toBe(true);
  });

  it("keeps a short unrecognised error intact", () => {
    expect(describeProviderError(new Error("socket hang up"))).toBe("socket hang up");
  });
});

describe("retryHintMs", () => {
  /* Verbatim from a gemini-embedding-001 429, trimmed to the parts that matter. */
  const quotaError = new Error(
    '{"error":{"code":429,"message":"You exceeded your current quota. ' +
      "* Quota exceeded for metric: generativelanguage.googleapis.com/embed_content_free_tier_requests, limit: 100" +
      '\nPlease retry in 23.484258793s.","status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}',
  );

  it("prefers the structured retryDelay", () => {
    expect(retryHintMs(quotaError)).toBe(23_000);
  });

  it("falls back to the prose form, rounding up to clear the window", () => {
    expect(retryHintMs(new Error("Please retry in 23.484258793s."))).toBe(23_485);
  });

  it("returns null when the provider said nothing, leaving jitter to decide", () => {
    expect(retryHintMs(new Error("socket hang up"))).toBeNull();
    expect(retryHintMs({ status: 503 })).toBeNull();
  });

  /*
   * The bug this encodes: a 30s ceiling on a 60s window meant every retry was
   * spent on a request that could not yet succeed.
   */
  it("reads a hint longer than the old backoff ceiling", () => {
    expect(retryHintMs(new Error('"retryDelay":"47s"'))).toBe(47_000);
  });
});