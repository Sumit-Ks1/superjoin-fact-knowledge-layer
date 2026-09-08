/**
 * What is this document, and who is it about?
 *
 * Every fact from a table needs a subject, and a financial statement never
 * names one: the row says "Total income", not "Delhivery Limited's total
 * income". The subject comes from the document, so it has to be established
 * once, up front, and it cannot be hardcoded — anyone may upload anything.
 *
 * Two paths, and the deterministic one runs first. Cover pages and running
 * headers repeat the issuer's name more than any other phrase, which is enough
 * on its own for most filings. The model is asked only to confirm or improve
 * that, and if no model is configured the heuristic result stands. A document
 * whose subject cannot be established still produces facts; they are simply
 * scoped to the document rather than to a named entity, which is honest.
 */

import { z } from "zod";

import { complete, modelProvidersConfigured } from "@/ai/provider";
import { log } from "@/lib/logger";

import { inferFiscalCalendar, type FiscalCalendar } from "../normalize/period";
import { tidy } from "../normalize/text";

export type DocumentProfile = {
  /** The entity the document is about. Falls back to the document title. */
  subject: string;
  /** "organization" | "government" | "person" | "place" | … open vocabulary. */
  subjectKind: string;
  title: string;
  /** Who published it — matters when two documents about one subject disagree. */
  publisher: string | null;
  fiscalCalendar: FiscalCalendar;
  /** How the subject was established, shown on the document screen. */
  source: "model" | "heuristic" | "filename";
  confidence: number;
};

/* ── deterministic pass ───────────────────────────────────────────────────── */

/**
 * Phrases that look like a proper name.
 *
 * Two or more capitalised words in a row, allowing lowercase connectives, so
 * "Reserve Bank of India" and "Delhivery Limited" both survive while ordinary
 * sentence-initial capitals do not.
 */
const PROPER_NAME =
  /\b([A-Z][\w&.'-]*(?:[ 	]+(?:of|and|for|the|de|von|van)[ 	]+|[ 	]+)?(?:[A-Z][\w&.'-]*)(?:[ 	]+(?:of|and|for|the)[ 	]+[A-Z][\w&.'-]*|[ 	]+[A-Z][\w&.'-]*){0,4})\b/g;

/** Words that make a capitalised phrase a document type rather than a name. */
const DOCUMENT_WORDS =
  /\b(?:annual|report|prospectus|statement|statements|presentation|survey|review|results|disclosure|offer|document|red herring|draft|consolidated|standalone|notes?|schedule|appendix|annexure|table|chapter|section|contents|index|quarter|quarterly|financial year|fiscal)\b/i;

/**
 * Institutional words. Generic across domains: companies, regulators,
 * ministries and multilaterals all carry one somewhere in their name.
 */
const ORGANISATION_WORD =
  /\b(?:limited|ltd|inc|incorporated|corporation|corp|company|plc|llp|llc|gmbh|bank|fund|authority|commission|ministry|department|council|association|federation|institute|university|holdings|partners|trust)\b/i;

/**
 * Generic stand-ins a document uses for itself: "Your Company", "the Group",
 * "Our Bank". They carry an institutional word but name nothing.
 */
const GENERIC_SELF_REFERENCE = /^(?:your|our|the|this)\s+\w+$/i;

/** A phrase that names a period rather than a thing: "FY24", "Q3 2024". */
const PERIOD_LIKE = /^(?:FY|F\.?Y\.?|Q[1-4]|H[12]|CY)\s*'?\d{2,4}$|^\d{4}(?:[-–/]\d{2,4})?$/i;

/**
 * Guesses the subject from repetition and prominence.
 *
 * Frequency alone is not enough, and fails in a specific way: the most repeated
 * capitalised phrase in a prospectus is "Preference Shares", in an annual
 * report "EBITDA", and in an earnings deck "FY24". None of them is the issuer.
 *
 * Prominence is what separates them. A document names its subject where it
 * introduces itself — the cover, the title block, the running header on every
 * page — and repeats it throughout. Terms of art repeat without ever appearing
 * there. So `prominent` lines are weighted an order of magnitude above body
 * mentions, and phrases that are plainly not names are dropped outright.
 */
export function guessSubject(
  text: string,
  prominent: string[] = [],
): { subject: string; hits: number } | null {
  const scores = new Map<string, { display: string; hits: number; score: number }>();

  const collect = (source: string, weight: number) => {
    for (const match of source.matchAll(PROPER_NAME)) {
      // Running headers run two sentences together: "International Monetary
      // Fund. Not for Redistribution". Keep only the first.
      const phrase = tidy(match[1].split(/(?<=\.)\s+/)[0]).replace(/\.$/, "");
      if (phrase.length < 4 || phrase.length > 70) continue;
      if (DOCUMENT_WORDS.test(phrase)) continue;
      if (PERIOD_LIKE.test(phrase)) continue;
      if (GENERIC_SELF_REFERENCE.test(phrase)) continue;

      const words = phrase.split(/\s+/);
      // A lone all-caps token is an acronym or a column code, not a name.
      if (words.length < 2 && phrase === phrase.toUpperCase()) continue;
      // A long all-caps run is a heading.
      if (phrase === phrase.toUpperCase() && words.length > 3) continue;

      /*
       * Without a model, a subject is claimed only when the phrase carries an
       * institutional word.
       *
       * Frequency and prominence both fail on real documents: the most repeated
       * capitalised phrase is "Preference Shares" in a prospectus and "EBITDA"
       * in an annual report, and the most prominent line on page one is as
       * likely to be "Outlook and Way Forward" or a running header reading
       * "Page No". Naming one of those as the subject is worse than naming
       * none: it files every fact in the document under a phantom entity, and
       * silently prevents any of them from linking to another document.
       *
       * Declining instead falls back to the document's own title, which groups
       * facts per-document. That loses cross-document linking for this file but
       * invents nothing — and it is exactly the case a configured model
       * handles well, which is the intended path.
       */
      if (!ORGANISATION_WORD.test(phrase)) continue;

      const key = phrase.toLowerCase();
      const entry = scores.get(key) ?? { display: phrase, hits: 0, score: 0 };
      entry.hits += 1;
      // An institutional word is the strongest evidence a phrase is a name:
      // "Reserve Bank of India" and "Delhivery Limited" carry one; "Preference
      // Shares" and "Outlook and Way Forward" never do.
      entry.score += weight;
      scores.set(key, entry);
    }
  };

  collect(text, 1);
  // Titles and running headers: where a document says what it is.
  for (const line of prominent) collect(line, 12);

  let best: { display: string; hits: number; score: number } | null = null;
  for (const entry of scores.values()) {
    if (!best || entry.score > best.score) best = entry;
  }

  // A single mention is not evidence of anything.
  if (!best || best.hits < 3) return null;
  return { subject: best.display, hits: best.hits };
}

/* ── model pass ───────────────────────────────────────────────────────────── */

const ProfileSchema = z.object({
  subject: z.string().min(1).max(120),
  subject_kind: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  publisher: z.string().max(120).nullable(),
});

const SYSTEM = `You identify what a document is and whose figures it reports.

You will be shown the opening pages of a document. Reply with JSON only.

- "subject": the single entity whose figures this document reports. For a
  company filing that is the company. For a central bank report it is the bank
  or the country, whichever the figures are about. Use the full formal name as
  the document writes it. Never invent a name that does not appear in the text.
- "subject_kind": one of organization, government, person, place, market, other.
- "title": the document's own title.
- "publisher": the organisation that issued the document, or null if unclear.
  This can differ from the subject: an IMF report about India has subject India
  and publisher International Monetary Fund.

If the document does not make the subject clear, use the title as the subject
and say so by setting subject_kind to "other". Do not guess.`;

/**
 * Establishes the document profile.
 *
 * `sampleText` should be the opening pages: title, cover, contents and the
 * first sections, which is where a document names itself. Passing the whole
 * document would cost more and say less. `prominent` carries the lines that
 * introduce the document — its cover headings and the running header repeated
 * on every page — which the heuristic weights far above body text.
 */
export async function inferDocumentProfile(
  sampleText: string,
  fallbackTitle: string,
  prominent: string[] = [],
): Promise<DocumentProfile> {
  const fiscalCalendar = inferFiscalCalendar(sampleText);
  const guess = guessSubject(sampleText, prominent);

  const heuristic: DocumentProfile = {
    subject: guess?.subject ?? fallbackTitle,
    subjectKind: guess ? "organization" : "other",
    title: fallbackTitle,
    publisher: null,
    fiscalCalendar,
    source: guess ? "heuristic" : "filename",
    confidence: guess ? Math.min(0.75, 0.4 + guess.hits / 40) : 0.25,
  };

  if (!modelProvidersConfigured()) return heuristic;

  const result = await complete({
    task: "document-profile",
    system: SYSTEM,
    prompt: sampleText.slice(0, 12_000),
    schema: ProfileSchema,
    schemaName: "document_profile_v1",
  });

  if (!result.ok) {
    log.warn("document profile fell back to heuristic", { detail: result.detail });
    return heuristic;
  }

  const { subject, subject_kind, title, publisher } = result.data;

  /*
   * Trust but verify: the subject must actually occur in the document. A model
   * that names a company the text never mentions has hallucinated an entity,
   * and every fact in the document would then be filed under it.
   */
  const appears = sampleText.toLowerCase().includes(subject.toLowerCase().slice(0, 24));
  if (!appears) {
    log.warn("model proposed a subject absent from the document; keeping heuristic", {
      proposed: subject,
    });
    return heuristic;
  }

  return {
    subject: tidy(subject),
    subjectKind: subject_kind.toLowerCase(),
    title: tidy(title) || fallbackTitle,
    publisher: publisher ? tidy(publisher) : null,
    fiscalCalendar,
    source: "model",
    confidence: 0.9,
  };
}
