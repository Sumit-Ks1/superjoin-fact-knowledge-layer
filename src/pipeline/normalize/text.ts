/**
 * Canonical forms for the strings that facts are keyed on.
 *
 * Two documents describe the same measure with different words and different
 * punctuation: "Total income (I)", "Total Income", "Total income¹". If the
 * claim key is built from raw text, those are three unrelated facts and nothing
 * ever corroborates anything. If canonicalisation is too aggressive, "Revenue
 * from contract with customers" and "Revenue" collapse into one and unrelated
 * figures start contradicting each other.
 *
 * The line taken here: strip what is certainly presentational — case, footnote
 * marks, statement cross-references, bullet numbering, punctuation — and keep
 * every content word. Nothing is stemmed and no synonym list is applied. Two
 * predicates that survive as different strings are treated as different
 * measures, and it is the linking stage, with embeddings and an adjudicator,
 * that decides whether they mean the same thing.
 */

/** Roman-numeral statement references: "Total expenses (II)", "(V= III+IV)". */
const STATEMENT_REF = /\(\s*[ivxlc]+\s*(?:=[^)]*)?\)/gi;
/** Footnote and reference marks left attached to a label. */
const FOOTNOTE_MARK = /[*#†‡§^]+|\((?:\d{1,2}|[a-z])\)/gi;
/** Leading list markers: "1.", "(a)", "•", "iii)". */
const LEADING_MARKER = /^\s*(?:[•●▪◦‣·–—*]|\(?[a-z]\)|\(?[ivxlc]+\)|\d{1,2}[.)])\s+/i;

/**
 * Canonical form used for keys and equality.
 *
 * Lossy by design and never displayed: every fact keeps its printed text for
 * the UI, and this form exists only so two spellings of one measure land in the
 * same bucket.
 */
export function canonicalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(STATEMENT_REF, " ")
    .replace(FOOTNOTE_MARK, " ")
    .replace(LEADING_MARKER, " ")
    .toLowerCase()
    // Keep intra-word hyphens and ampersands; they carry meaning in labels
    // like "e-commerce" and "research & development".
    .replace(/[^\p{L}\p{N}\s&-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Display form: tidy, but faithful to what the page says.
 *
 * Used for `subjectText` and `predicateText`, which are shown to the reader
 * beside the evidence, so nothing meaningful may be removed here.
 */
export function tidy(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/(\()\s+/g, "$1")
    .trim();
}

/**
 * Strips the qualifying clause a label carries so a measure can be recognised
 * across documents that qualify it differently.
 *
 * "Revenue from contract with customers" and "Revenue" are still different
 * predicates after this; what it removes is only parenthetical asides and
 * trailing scale notes that belong in the unit, not the name.
 */
export function predicateStem(text: string): string {
  return canonicalize(
    text
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(?:in|as a percentage of|as % of)\s+[^,;]+$/i, " "),
  );
}

/**
 * Words too common to identify anything, used when deciding whether a label
 * names an entity or a measure. Function words only — no domain vocabulary.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "in", "on", "at", "to", "from",
  "by", "with", "as", "is", "are", "was", "were", "be", "been", "total", "net",
  "gross", "other", "per", "its", "our", "their",
]);

export function contentWords(text: string): string[] {
  return canonicalize(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Jaccard overlap of content words. A cheap first pass before embeddings, and
 * the tie-breaker when two candidate labels are equally close in vector space.
 */
export function lexicalOverlap(a: string, b: string): number {
  const left = new Set(contentWords(a));
  const right = new Set(contentWords(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
