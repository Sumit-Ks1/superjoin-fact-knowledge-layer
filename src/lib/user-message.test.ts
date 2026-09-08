/**
 * The guarantee this file makes: no internal detail reaches the browser.
 *
 * The failing case that motivated it was a Gemini quota error rendered in full
 * on the Documents screen — nested JSON, quota metric names, an internal
 * hostname and a retry delay, none of which a reader can act on.
 */

import { describe, expect, it } from "vitest";

import { describeSkippedStage, toUserMessage } from "./user-message";

const GEMINI_QUOTA =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/embed_content_free_tier_requests, limit: 1000, model: gemini-embedding-1.0","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"EmbedContentRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}';

describe("toUserMessage", () => {
  it("replaces a provider payload entirely", () => {
    const message = toUserMessage(GEMINI_QUOTA)!;
    for (const leak of [
      "{",
      "googleapis.com",
      "RESOURCE_EXHAUSTED",
      "quotaId",
      "gemini-embedding",
      "429",
    ]) {
      expect(message, `leaked ${leak}`).not.toContain(leak);
    }
    expect(message).toContain("temporarily unavailable");
  });

  it("keeps upload problems specific, because those the user can fix", () => {
    expect(toUserMessage("The PDF is password-protected. Remove the password…")).toContain(
      "password",
    );
    expect(toUserMessage("No text layer was found.")).toContain("OCR");
    expect(toUserMessage("The file does not begin with a PDF header.")).toContain("not a PDF");
  });

  it("collapses anything unrecognised rather than risking a leak", () => {
    const message = toUserMessage(
      "Error: connect ECONNREFUSED 10.0.0.4:5432\n    at TCPConnectWrap.afterConnect",
    )!;
    expect(message).not.toContain("10.0.0.4");
    expect(message).not.toContain("at TCPConnectWrap");
    expect(message).toBe(
      "Processing did not complete. The reason has been recorded in the server logs.",
    );
  });

  it("passes null through so a nullable column needs no special case", () => {
    expect(toUserMessage(null)).toBeNull();
    expect(toUserMessage("")).toBeNull();
    expect(toUserMessage("   ")).toBeNull();
  });
});

describe("describeSkippedStage", () => {
  it("says what still worked, not what failed", () => {
    const message = describeSkippedStage("normalize");
    expect(message).toContain("Similarity matching");
    expect(message).toContain("period, scope and arithmetic");
  });

  it("has an answer for a stage it does not know", () => {
    expect(describeSkippedStage("something-new")).toContain("rest of the pipeline completed");
  });
});
