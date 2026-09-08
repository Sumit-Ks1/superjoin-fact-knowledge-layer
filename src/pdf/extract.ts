/**
 * Raw geometry extraction via unpdf (a serverless-safe pdf.js build).
 *
 * This layer does exactly one thing: turn a PDF into positioned text runs.
 * Every interpretation — lines, columns, tables, headings — happens downstream
 * on this output, which keeps the reconstruction testable without a PDF.
 */

import { getDocumentProxy } from "unpdf";

import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import type { PageGeometry, TextRun } from "./types";

/** pdf.js text item shape (subset we rely on). */
type TextItemLike = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
};

function isTextItem(item: unknown): item is TextItemLike {
  return typeof item === "object" && item !== null && "str" in item;
}

/**
 * Font styling from the font's own name. pdf.js exposes real descriptors only
 * through `commonObjs`, which costs a round-trip per font for a signal we only
 * use as a heading hint — the name heuristic is generic and good enough.
 */
function styleFromFontName(fontName: string): { bold: boolean; italic: boolean } {
  const n = fontName.toLowerCase();
  return {
    bold: /bold|black|heavy|semib|demi|[-_]bd\b|700|800|900/.test(n),
    italic: /italic|oblique|[-_]it\b/.test(n),
  };
}

function runFromItem(item: TextItemLike): TextRun | null {
  const text = item.str ?? "";
  // Whitespace-only runs carry no content but do carry geometry; pdf.js emits
  // them between words. Dropping them here and re-deriving spacing from gaps is
  // more reliable than trusting the emitted spaces.
  if (text.trim() === "") return null;

  const t = item.transform;
  if (!t || t.length < 6) return null;

  const [a, b, c, d, e, f] = t;
  const x0 = e;
  const y0 = f;

  // Font size under an arbitrary text matrix is the length of the y basis
  // vector; falls back to the reported height for degenerate matrices.
  const derived = Math.hypot(c ?? 0, d ?? 0);
  const fontSize = derived > 0.01 ? derived : (item.height ?? 10);

  // Item width is already in text space; scale only if the matrix says so.
  const scaleX = Math.hypot(a ?? 1, b ?? 0) || 1;
  const width = (item.width ?? 0) * (Math.abs(scaleX - 1) > 0.01 && (item.width ?? 0) > 0 ? 1 : 1);

  const fontName = item.fontName ?? "";
  const { bold, italic } = styleFromFontName(fontName);

  // The x basis vector's tilt. Horizontal text keeps |a| well above |b|;
  // quarter-turned text swaps them.
  const rotated = Math.abs(b ?? 0) > Math.abs(a ?? 0);

  return {
    text,
    x0,
    y0,
    x1: x0 + width,
    y1: y0 + fontSize,
    fontSize,
    fontName,
    bold,
    italic,
    rotated,
  };
}

export type ExtractOptions = {
  /** 1-based, inclusive. Omit to read the whole document. */
  fromPage?: number;
  toPage?: number;
};

export type DocumentGeometry = {
  pageCount: number;
  pages: PageGeometry[];
};

/**
 * Reads positioned runs for a page range.
 *
 * Ranged by design: Vercel caps function duration, so the parse stage walks a
 * document in page batches and each batch is an independently retryable step.
 */
export async function extractGeometry(
  data: Uint8Array,
  options: ExtractOptions = {},
): Promise<DocumentGeometry> {
  // pdf.js transfers and neuters the input buffer; hand it a private copy so
  // the caller can reuse the bytes across batches.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const pageCount = pdf.numPages;

  const from = Math.max(1, options.fromPage ?? 1);
  const to = Math.min(pageCount, options.toPage ?? pageCount);

  const pages: PageGeometry[] = [];

  for (let pageNo = from; pageNo <= to; pageNo++) {
    try {
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        const run = runFromItem(item);
        if (run) runs.push(run);
      }

      pages.push({
        pageNo,
        width: viewport.width,
        height: viewport.height,
        runs,
      });

      // Release page resources eagerly; a 100-page report otherwise accumulates
      // enough retained state to matter inside a 1 GB function.
      page.cleanup();
    } catch (error) {
      // One malformed page must not lose the other 99. Emit an empty page so
      // downstream numbering stays aligned, and let the parse stage record the
      // gap as an issue.
      log.warn("page geometry extraction failed", { pageNo, error });
      pages.push({ pageNo, width: 612, height: 792, runs: [] });
    }
  }

  await pdf.cleanup().catch(() => {});

  return { pageCount, pages };
}

/** Page count only — used at upload time before the pipeline starts. */
export async function readPageCount(data: Uint8Array): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const count = pdf.numPages;
  await pdf.cleanup().catch(() => {});
  return count;
}

/* ── upload validation ────────────────────────────────────────────────────── */

/**
 * Why a document cannot be processed, in terms a person can act on.
 *
 * Anyone may upload anything, so the pipeline needs a boundary that separates
 * "this file is not workable" from "this file produced no facts". Without it a
 * scanned report and a report with nothing to say look identical in the UI:
 * both end at zero facts, and only one of them is the user's fault.
 */
export type ProbeVerdict =
  | "ok"
  /** Text layer present but sparse; parseable, with a warning. */
  | "sparse_text"
  | "not_a_pdf"
  | "encrypted"
  | "corrupt"
  | "no_text_layer"
  | "too_many_pages"
  | "too_large";

export type DocumentProbe = {
  verdict: ProbeVerdict;
  /** True when the pipeline should run at all. */
  usable: boolean;
  pageCount: number;
  /** Share of sampled pages carrying enough text to parse. */
  textCoverage: number;
  /** Human-readable explanation, surfaced directly in the UI. */
  detail: string;
};

/** `%PDF-` — checked before handing bytes to pdf.js, which is not a validator. */
function hasPdfMagic(data: Uint8Array): boolean {
  if (data.length < 5) return false;
  return (
    data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d
  );
}

/** Runs on a page below which it is almost certainly an image, not text. */
const MIN_RUNS_FOR_TEXT_PAGE = 12;

/**
 * Classifies an uploaded file before the pipeline commits to it.
 *
 * Samples pages spread across the document rather than the first few: covers,
 * dividers and plate sections are legitimately textless, and judging a 300-page
 * report by page 1 would reject it.
 */
export async function probeDocument(data: Uint8Array): Promise<DocumentProbe> {
  const empty = { pageCount: 0, textCoverage: 0 };

  if (data.byteLength > env.maxUploadBytes) {
    return {
      ...empty,
      verdict: "too_large",
      usable: false,
      detail: `File is ${(data.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${(env.maxUploadBytes / 1024 / 1024).toFixed(0)} MB.`,
    };
  }

  if (!hasPdfMagic(data)) {
    return {
      ...empty,
      verdict: "not_a_pdf",
      usable: false,
      detail: "The file does not begin with a PDF header. Only PDF files can be processed.",
    };
  }

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (error) {
    const name = (error as Error)?.name ?? "";
    const message = (error as Error)?.message ?? String(error);
    const locked = name === "PasswordException" || /password/i.test(message);
    return {
      ...empty,
      verdict: locked ? "encrypted" : "corrupt",
      usable: false,
      detail: locked
        ? "The PDF is password-protected. Remove the password and upload it again."
        : `The PDF could not be opened: ${message}`,
    };
  }

  try {
    const pageCount = pdf.numPages;

    if (pageCount > env.maxUploadPages) {
      return {
        pageCount,
        textCoverage: 0,
        verdict: "too_many_pages",
        usable: false,
        detail: `The document has ${pageCount} pages; the limit is ${env.maxUploadPages}. Upload an excerpt.`,
      };
    }

    // Evenly spaced sample, so a textless front section cannot decide the verdict.
    const sampleSize = Math.min(env.textLayerProbePages, pageCount);
    const step = Math.max(1, Math.floor(pageCount / sampleSize));
    let textPages = 0;
    let sampled = 0;

    for (let pageNo = 1; pageNo <= pageCount && sampled < sampleSize; pageNo += step) {
      sampled += 1;
      try {
        const page = await pdf.getPage(pageNo);
        const content = await page.getTextContent();
        const runs = content.items.filter(
          (item) => isTextItem(item) && (item.str ?? "").trim() !== "",
        ).length;
        if (runs >= MIN_RUNS_FOR_TEXT_PAGE) textPages += 1;
        page.cleanup();
      } catch {
        // A page that will not render is a page without usable text.
      }
    }

    const textCoverage = sampled > 0 ? textPages / sampled : 0;

    if (textCoverage === 0) {
      return {
        pageCount,
        textCoverage,
        verdict: "no_text_layer",
        usable: false,
        detail:
          "No text layer was found. This looks like a scanned document; it needs OCR before facts can be extracted.",
      };
    }

    if (textCoverage < 0.5) {
      return {
        pageCount,
        textCoverage,
        verdict: "sparse_text",
        usable: true,
        detail: `Only ${Math.round(textCoverage * 100)}% of sampled pages carry a text layer. Pages without one will yield no facts.`,
      };
    }

    return {
      pageCount,
      textCoverage,
      verdict: "ok",
      usable: true,
      detail: `${pageCount} page(s), text layer present.`,
    };
  } finally {
    await pdf.cleanup().catch(() => {});
  }
}
