/**
 * The boundary between what went wrong and what a person is told.
 *
 * Errors from the pipeline carry provider payloads, stack frames and quota
 * metrics. All of that is worth logging and none of it belongs on screen: it
 * buries the one thing a reader can act on under a paragraph of machine detail,
 * and it exposes internals to anyone who can upload a file.
 *
 * So nothing reaches the browser unless it is recognised here and rewritten as
 * a sentence about *their* document. Anything unrecognised collapses to a
 * generic line — deliberately, because an unrecognised error is exactly the one
 * most likely to contain something that should not be shown.
 */

/** Ordered most specific first; the first match wins. */
const PATTERNS: { test: RegExp; message: string }[] = [
  {
    test: /password|encrypted/i,
    message: "This PDF is password-protected. Remove the password and upload it again.",
  },
  {
    test: /no text layer|scanned/i,
    message:
      "No text layer was found — this looks like a scanned document. It needs OCR before facts can be extracted.",
  },
  {
    test: /does not begin with a PDF header|not_a_pdf/i,
    message: "This file is not a PDF.",
  },
  {
    test: /could not be opened|invalid pdf|corrupt/i,
    message: "This PDF could not be opened. It may be damaged.",
  },
  {
    test: /the limit is|too large|exceeds/i,
    message: "This file is larger than the upload limit.",
  },
  {
    test: /too many pages|MAX_UPLOAD_PAGES/i,
    message: "This document has more pages than the limit. Upload an excerpt.",
  },
  {
    test: /RESOURCE_EXHAUSTED|429|quota|rate.?limit/i,
    message:
      "A model provider was temporarily unavailable. Everything that does not depend on it completed normally.",
  },
  {
    test: /API_KEY|PERMISSION_DENIED|401|403|unauthor/i,
    message: "A model provider rejected its credentials. Contact whoever configured this instance.",
  },
];

/**
 * Rewrites an internal error for display.
 *
 * Returns null for null, so a caller can pass a nullable column straight
 * through. Runs at the API boundary rather than at write time, which means
 * errors already stored in the database are cleaned on the way out too.
 */
export function toUserMessage(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === "") return null;

  for (const { test, message } of PATTERNS) {
    if (test.test(raw)) return message;
  }

  return "Processing did not complete. The reason has been recorded in the server logs.";
}

/**
 * What a skipped stage means for the reader.
 *
 * Keyed on the stage, not on the error, so no provider text can reach the page
 * by this route at all. A stage is only ever skipped when it is optional, and
 * the useful thing to say is what still worked.
 */
const SKIPPED: Record<string, string> = {
  normalize:
    "Similarity matching was unavailable. Facts were still compared by exact match, period, scope and arithmetic.",
  extract: "Extraction was skipped for this document.",
  link: "Comparison against other documents has not run yet.",
};

export function describeSkippedStage(stage: string): string {
  return SKIPPED[stage] ?? "This step was skipped; the rest of the pipeline completed.";
}
