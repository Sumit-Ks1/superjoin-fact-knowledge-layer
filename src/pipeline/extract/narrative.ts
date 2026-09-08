/**
 * Prose → facts, with the model kept on a short leash.
 *
 * Tables are read deterministically. Prose cannot be, so a model is used here —
 * but it is used to *locate* claims, never to state them. The contract is:
 *
 *   The model returns a verbatim quote from the chunk. Everything numeric is
 *   then re-derived from that quote by the same parser that reads table cells.
 *
 * That single rule removes the failure mode that would otherwise poison the
 * whole system. A model that transcribes ₹48,105.30 million as ₹48,150.30
 * million has manufactured a contradiction indistinguishable from a real one.
 * Here it cannot: if the quote is not found in the chunk character-for-
 * character the fact is rejected, and if it is found, the number comes from the
 * chunk rather than from the model's output.
 *
 * Everything else the model produces — subject, predicate, qualifiers — is
 * descriptive text, where being approximately right is useful and being wrong
 * is visible to a reader looking at the evidence.
 */

import { z } from "zod";

import { complete, modelProvidersConfigured } from "@/ai/provider";
import { log } from "@/lib/logger";

import { parsePeriod, type FiscalCalendar } from "../normalize/period";
import { canonicalize, tidy } from "../normalize/text";
import { normalizeValue } from "../normalize/value";
import { stableHash } from "@/lib/hash";
import type { BBox, FactKind } from "@/db/schema";
import type { FactDraft } from "./table";

const ClaimSchema = z.object({
  subject: z.string().min(1).max(160),
  predicate: z.string().min(1).max(160),
  /** The measured value exactly as printed, or null for a non-numeric claim. */
  value: z.string().max(80).nullable(),
  /** Unit words as printed nearby: "₹ million", "per cent", "shipments". */
  unit: z.string().max(80).nullable(),
  /** Period phrase exactly as printed: "in fiscal 2024", "as at March 31, 2024". */
  period: z.string().max(120).nullable(),
  /** Anything that changes what is being measured: basis, segment, geography. */
  qualifiers: z.record(z.string(), z.string()).optional(),
  /** For non-numeric claims: what is asserted about the subject. */
  object: z.string().max(200).nullable(),
  kind: z.enum(["quantitative", "temporal", "relational", "attributive", "definitional"]),
  /** Must appear in the chunk character-for-character. */
  quote: z.string().min(8).max(400),
});

const ResponseSchema = z.object({ facts: z.array(ClaimSchema).max(24) });

export type NarrativeClaim = z.infer<typeof ClaimSchema>;

const SYSTEM = `You extract checkable claims from a passage of a document.

Rules, in order of importance:

1. QUOTE VERBATIM. Every claim must carry a "quote" copied character-for-
   character from the passage, including punctuation, digits and separators.
   Never reformat a number, never expand an abbreviation, never tidy spacing.
   A claim whose quote is not an exact substring of the passage will be
   discarded.
2. NEVER CALCULATE. Do not sum, convert, annualise, or restate a figure in
   different units. Copy what is written. If the passage says "grew 25% to
   ₹4,811 crore", that is one claim about the growth rate and one about the
   amount — not a claim about the prior year, which you would have to compute.
3. ONLY WHAT IS STATED. No inference, no outside knowledge, no filling in a
   period or unit the passage does not give. Leave a field null instead.
4. Prefer claims a reader could check against the sentence. Skip aspirations,
   marketing language, and anything hedged past the point of being checkable.

Field notes:
- "subject" is the entity the claim is about. Use the name the passage uses.
- "predicate" is what is being measured or asserted, as a noun phrase.
- "value" is the measured amount exactly as printed, digits and all, or null.
- "unit" is the unit words printed near it, or null.
- "period" is the time expression exactly as printed, or null.
- "qualifiers" holds anything that changes what is being measured — basis
  (consolidated, standalone), segment, geography, adjustment. Omit if none.

Return JSON: {"facts": [...]}. Return {"facts": []} if the passage makes no
checkable claim. An empty answer is a good answer for boilerplate.`;

export type NarrativeContext = {
  documentSubject: string;
  fiscalCalendar: FiscalCalendar;
  breadcrumb: string;
  pageStart: number;
  bbox: BBox | null;
  sourceKey: string;
};

export type NarrativeResult = {
  facts: FactDraft[];
  /** Claims discarded, with the reason, for the Quality screen. */
  rejected: { reason: string; claim: NarrativeClaim }[];
  skipped: boolean;
};

/**
 * Normalises whitespace for quote matching without altering any character that
 * carries meaning. Line wrapping differs between the chunk and the model's copy
 * of it; digits, punctuation and letters must still match exactly.
 */
function forMatching(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Locates a quote in the chunk, tolerating only whitespace differences. */
export function findQuote(chunk: string, quote: string): boolean {
  return forMatching(chunk).includes(forMatching(quote));
}

/**
 * Extracts claims from one narrative chunk.
 *
 * Never throws. A chunk that fails extraction yields no facts and a recorded
 * reason; the document continues.
 */
export async function extractNarrativeFacts(
  chunkText: string,
  context: NarrativeContext,
): Promise<NarrativeResult> {
  if (!modelProvidersConfigured()) {
    return { facts: [], rejected: [], skipped: true };
  }

  const result = await complete({
    task: "narrative-facts",
    system: SYSTEM,
    prompt: chunkText,
    schema: ResponseSchema,
    schemaName: "narrative_facts_v1",
  });

  if (!result.ok) {
    log.warn("narrative extraction failed", {
      page: context.pageStart,
      reason: result.reason,
      detail: result.detail,
    });
    return { facts: [], rejected: [], skipped: false };
  }

  const facts: FactDraft[] = [];
  const rejected: NarrativeResult["rejected"] = [];

  for (const claim of result.data.facts) {
    /* The one hard gate. */
    if (!findQuote(chunkText, claim.quote)) {
      rejected.push({ reason: "quote not found verbatim in the chunk", claim });
      continue;
    }

    /*
     * The value must also appear inside the quote. A model can return a real
     * quote alongside a number it invented, and that combination is the most
     * dangerous output it can produce: it looks fully sourced.
     */
    if (claim.value !== null && !findQuote(claim.quote, claim.value)) {
      rejected.push({ reason: "value does not appear in its own quote", claim });
      continue;
    }

    const qualifiers: Record<string, string> = {};
    for (const [key, value] of Object.entries(claim.qualifiers ?? {})) {
      const cleanKey = canonicalize(key).replace(/\s+/g, "_").slice(0, 40);
      if (cleanKey === "" || value.trim() === "") continue;
      qualifiers[cleanKey] = tidy(value);
    }

    // Re-derived from the quote by the same parser the tables use.
    const value =
      claim.value === null
        ? null
        : normalizeValue(claim.value, [claim.unit ?? "", claim.quote, context.breadcrumb]);

    const period = parsePeriod(claim.period ?? "", context.fiscalCalendar);
    const scopeSignature = stableHash(qualifiers);
    const subjectText = tidy(claim.subject) || context.documentSubject;
    const predicateText = tidy(claim.predicate);
    if (predicateText === "") {
      rejected.push({ reason: "empty predicate", claim });
      continue;
    }

    const periodKey =
      period.start && period.end
        ? `${period.start.toISOString().slice(0, 10)}..${period.end.toISOString().slice(0, 10)}`
        : canonicalize(period.label);

    const notes: string[] = [];
    if (value && value.scaleUnresolved && value.num !== null) {
      notes.push("no unit or scale could be resolved for this figure");
    }
    if (claim.period && period.kind === "unknown") {
      notes.push(`period "${claim.period}" could not be resolved to dates`);
    }

    facts.push({
      kind: claim.kind as FactKind,
      subjectText,
      predicateText,
      objectText: claim.object ? tidy(claim.object) : null,

      valueRaw: claim.value,
      valueNum: value?.num ?? null,
      valueBase: value?.base ?? null,
      valueMin: value?.min ?? null,
      valueMax: value?.max ?? null,
      modifier: value?.modifier ?? "exact",
      unit: value?.unit ?? null,

      qualifiers,
      periodKind: period.kind,
      periodStart: period.start,
      periodEnd: period.end,
      periodLabel: period.label || claim.period,

      scopeSignature,
      claimKey: stableHash({
        s: canonicalize(subjectText),
        p: canonicalize(predicateText),
        t: periodKey,
        q: scopeSignature,
      }),
      relaxedKey: stableHash({
        s: canonicalize(subjectText),
        p: canonicalize(predicateText),
      }),

      /*
       * Prose facts start below table facts and stay there. The number was
       * copied out of a sentence by a model rather than read from a cell, and
       * when a prose fact disagrees with a table fact the table is right far
       * more often than not.
       */
      confidence: 0.65,
      extractionMethod: "narrative_llm",
      quoteVerified: true,
      quarantined: false,

      evidence: {
        pageNo: context.pageStart,
        bboxes: context.bbox ? [context.bbox] : [],
        quote: claim.quote,
      },

      sourceKey: context.sourceKey,
      // Prose has no grid; the arithmetic channel skips these.
      rowIndex: -1,
      colIndex: -1,
      contextLabel: context.breadcrumb,
      notes,
    });
  }

  return { facts, rejected, skipped: false };
}
