/**
 * The gate that keeps model output from becoming a fabricated fact.
 *
 * A model returning a plausible quote alongside an invented number is the most
 * dangerous output this system can receive: it looks fully sourced, and a
 * fabricated figure produces a contradiction indistinguishable from a real one.
 * Both halves are therefore checked against the chunk.
 */

import { describe, expect, it } from "vitest";

import { findQuote } from "./narrative";
import { guessSubject } from "./document";

const CHUNK = `Our Business ▸ Express Parcel

Revenue from contract with customers grew to ₹48,105.30 million in the nine
months period ended December 31, 2021, from ₹26,438.66 million in the
corresponding period of the previous year.`;

describe("findQuote", () => {
  it("accepts a quote copied verbatim", () => {
    expect(findQuote(CHUNK, "grew to ₹48,105.30 million")).toBe(true);
  });

  it("accepts a quote that spans the chunk's line wrapping", () => {
    // The model sees the text as one string; the chunk carries newlines.
    expect(findQuote(CHUNK, "in the nine months period ended December 31, 2021")).toBe(true);
  });

  it("rejects a number that was reformatted", () => {
    // "48105.30" never appears; accepting it would let the model silently
    // restate figures.
    expect(findQuote(CHUNK, "grew to ₹48105.30 million")).toBe(false);
  });

  it("rejects a digit that was altered", () => {
    expect(findQuote(CHUNK, "₹48,150.30 million")).toBe(false);
  });

  it("rejects a quote assembled from separate parts of the passage", () => {
    expect(findQuote(CHUNK, "Revenue from contract with customers grew to ₹26,438.66 million")).toBe(
      false,
    );
  });

  it("rejects a fluent sentence that is not in the passage at all", () => {
    expect(findQuote(CHUNK, "Revenue nearly doubled year on year.")).toBe(false);
  });

  it("checks a value against its own quote", () => {
    // The second gate: a real quote paired with a number from elsewhere.
    const quote = "grew to ₹48,105.30 million in the nine";
    expect(findQuote(quote, "48,105.30")).toBe(true);
    expect(findQuote(quote, "26,438.66")).toBe(false);
  });
});

describe("guessSubject", () => {
  it("picks the name a document repeats", () => {
    const text = [
      "Delhivery Limited",
      "Annual Report of Delhivery Limited",
      "Delhivery Limited was incorporated in 2011.",
      "The board of Delhivery Limited met four times.",
    ].join("\n");

    expect(guessSubject(text)?.subject).toBe("Delhivery Limited");
  });

  it("does not mistake the document type for the subject", () => {
    const text = [
      "Reserve Bank of India",
      "Annual Report",
      "Reserve Bank of India publishes this Annual Report.",
      "The Reserve Bank of India sets the policy rate.",
      "Reserve Bank of India staff estimates.",
    ].join("\n");

    const guess = guessSubject(text);
    expect(guess?.subject).toBe("Reserve Bank of India");
  });

  it("returns null rather than guessing from a single mention", () => {
    expect(guessSubject("A report mentioning Acme Corporation once.")).toBeNull();
  });
});
