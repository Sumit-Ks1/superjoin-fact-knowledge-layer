/**
 * Fact Knowledge Layer — relational + vector schema (Supabase Postgres + pgvector).
 *
 * Design notes that matter:
 *
 *  - `facts.qualifiers` is an OPEN jsonb map and `qualifier_keys` is a live
 *    registry of the keys seen so far. That pair is the dynamically-evolving
 *    schema: a new kind of fact introduces new qualifier keys with zero DDL.
 *
 *  - Vocabularies that must stay open (fact kind, extraction method, relation
 *    subtype, issue kind) are `text`, not `pgEnum`, so adding a value never
 *    requires a migration. Type safety lives in TypeScript unions instead.
 *
 *  - Every fact is reachable from a rendered PDF rectangle via `evidence`.
 *    A fact with no verified evidence row is a bug, not a fact.
 */

import { relations as drizzleRelations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Embedding width. Gemini's embedding model is dimension-configurable; 768 is
 * the sweet spot for pgvector HNSW (which caps at 2000) and keeps the index
 * small enough to stay resident on Supabase's free tier.
 *
 * Changing this requires a migration — it is a column type, not a runtime knob.
 */
export const EMBEDDING_DIMENSIONS = 768;

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Corpora — lets several unrelated document sets share one deployment without
 * generating cross-domain noise during fact linking.
 * ────────────────────────────────────────────────────────────────────────── */

export const corpora = pgTable("corpora", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  ...timestamps,
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Documents
 * ────────────────────────────────────────────────────────────────────────── */

/** Pipeline stages, in execution order. Also the keys used by `documentStages`. */
export const PIPELINE_STAGES = [
  "parse",
  "chunk",
  "extract",
  "normalize",
  "link",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type DocumentStatus =
  | "uploaded"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: uuid("corpus_id")
      .notNull()
      .references(() => corpora.id, { onDelete: "cascade" }),

    /** Content hash — the idempotency key. Re-uploading a byte-identical PDF is a no-op. */
    sha256: text("sha256").notNull(),
    filename: text("filename").notNull(),
    byteSize: integer("byte_size").notNull(),
    storagePath: text("storage_path").notNull(),

    pageCount: integer("page_count"),
    /** Publication date of the document itself; resolves "as on the date of this Report". */
    docDate: timestamp("doc_date", { withTimezone: true }),
    /** Free-text guess ("prospectus", "annual report", "earnings presentation"). Never branched on. */
    docType: text("doc_type"),
    /** Entity that published the document — becomes an attribution qualifier on its facts. */
    publisherEntityId: uuid("publisher_entity_id"),
    /** Fiscal-year end learned from the document (MM-DD), e.g. "03-31". Not hardcoded. */
    fiscalYearEnd: text("fiscal_year_end"),

    status: text("status").$type<DocumentStatus>().notNull().default("uploaded"),
    error: text("error"),

    ...timestamps,
  },
  (t) => [
    // Same bytes may legitimately appear in two different corpora.
    uniqueIndex("documents_corpus_sha_uq").on(t.corpusId, t.sha256),
    index("documents_status_idx").on(t.status),
  ],
);

/** Per-stage progress. Inngest owns retries; this table is what the UI polls. */
export const documentStages = pgTable(
  "document_stages",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    stage: text("stage").$type<PipelineStage>().notNull(),
    status: text("status")
      .$type<"pending" | "running" | "done" | "failed" | "skipped">()
      .notNull()
      .default("pending"),
    /** 0..1 — coarse progress inside a stage (e.g. pages parsed / total pages). */
    progress: real("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    metrics: jsonb("metrics").$type<Record<string, number | string>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.stage] })],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Layout: pages → blocks / tables
 * ────────────────────────────────────────────────────────────────────────── */

/** A rectangle in PDF user space, origin bottom-left, as produced by pdf.js. */
export type BBox = { x0: number; y0: number; x1: number; y1: number };

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNo: integer("page_no").notNull(),
    width: doublePrecision("width").notNull(),
    height: doublePrecision("height").notNull(),
    /** Column count detected by whitespace-river analysis (1 = single column). */
    columnCount: integer("column_count").notNull().default(1),
    /**
     * 0..1. Low on infographic/chart pages where text runs have no reliable
     * reading order. Facts inheriting low confidence are quarantined from
     * contradiction detection.
     */
    layoutConfidence: real("layout_confidence").notNull().default(1),
    /** Page label printed on the page ("22", "iv") when it differs from pageNo. */
    printedLabel: text("printed_label"),
    ...timestamps,
  },
  (t) => [uniqueIndex("pages_doc_page_uq").on(t.documentId, t.pageNo)],
);

export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "caption"
  | "figure"
  | "footnote"
  | "header_footer";

export const blocks = pgTable(
  "blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNo: integer("page_no").notNull(),
    /** Reading order within the document, after column resolution. */
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").$type<BlockKind>().notNull(),
    text: text("text").notNull(),
    bbox: jsonb("bbox").$type<BBox>().notNull(),
    /** Heading breadcrumb, outermost first. Prepended to chunks for retrieval. */
    headingPath: jsonb("heading_path").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tableId: uuid("table_id"),
    /** Detected font size — drives heading detection without hardcoded styles. */
    fontSize: real("font_size"),
    ...timestamps,
  },
  (t) => [
    index("blocks_doc_page_idx").on(t.documentId, t.pageNo),
    index("blocks_doc_ordinal_idx").on(t.documentId, t.ordinal),
  ],
);

/** One reconstructed table cell, carrying its own rectangle for evidence. */
export type TableCell = {
  row: number;
  col: number;
  text: string;
  bbox: BBox;
  /** Cell spans more than one grid column (typical of grouped headers). */
  colSpan: number;
  isNumeric: boolean;
};

export const docTables = pgTable(
  "doc_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /**
     * Stable identity for the grid within its document: page plus the grid's
     * own rectangle. The extractor stamps the same key on every fact it reads
     * from this table, which is what lets evidence point back at the exact cell
     * and what confines the arithmetic check to one grid.
     */
    sourceKey: text("source_key").notNull(),
    pageStart: integer("page_start").notNull(),
    pageEnd: integer("page_end").notNull(),
    caption: text("caption"),
    /**
     * Scale/currency hint harvested from the nearest caption ("(in ₹ million)",
     * "₹ Cr"), inheritable page → document. The scale lives outside the cell.
     */
    unitHint: text("unit_hint"),
    rowCount: integer("row_count").notNull(),
    colCount: integer("col_count").notNull(),
    cells: jsonb("cells").$type<TableCell[]>().notNull(),
    /** Per-column header path, outermost first: ["Nine months ended", "December 31, 2021"]. */
    colHeaderPaths: jsonb("col_header_paths").$type<string[][]>().notNull(),
    /** Leading label columns that identify the row subject rather than a value. */
    rowLabelCols: integer("row_label_cols").notNull().default(1),
    confidence: real("confidence").notNull().default(1),
    /** Cell count disagreed with header count, spans were ambiguous, etc. */
    needsReview: boolean("needs_review").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("doc_tables_doc_source_uq").on(t.documentId, t.sourceKey),
    index("doc_tables_doc_idx").on(t.documentId),
  ],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Chunks — layout-aware, never split across a table boundary.
 * ────────────────────────────────────────────────────────────────────────── */

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").$type<"narrative" | "table">().notNull(),
    /** "Our Business > Network, Infrastructure and Automation" */
    breadcrumb: text("breadcrumb").notNull().default(""),
    text: text("text").notNull(),
    pageStart: integer("page_start").notNull(),
    pageEnd: integer("page_end").notNull(),
    bboxUnion: jsonb("bbox_union").$type<BBox>(),
    tokenCount: integer("token_count").notNull().default(0),
    /** sha256 of `text` — the cache key that makes re-runs free. */
    contentHash: text("content_hash").notNull(),
    tableId: uuid("table_id").references(() => docTables.id, { onDelete: "cascade" }),
    /** Cheap gate: does this chunk plausibly carry a fact? Skips LLM calls entirely. */
    factBearing: boolean("fact_bearing").notNull().default(true),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("chunks_doc_ordinal_uq").on(t.documentId, t.ordinal),
    index("chunks_hash_idx").on(t.contentHash),
    index("chunks_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Canonical vocabularies — discovered from the corpus, never seeded per-domain.
 * ────────────────────────────────────────────────────────────────────────── */

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: uuid("corpus_id")
      .notNull()
      .references(() => corpora.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    /**
     * Canonicalised name, and the key entity resolution actually matches on.
     *
     * Stored rather than computed so the unique index below can enforce it:
     * two writers racing to create the same entity must produce one row, not
     * two, or a document's facts split across duplicate entities and stop
     * linking to each other.
     */
    canonicalKey: text("canonical_key").notNull(),
    /** "organization" | "person" | "place" | "instrument" | "concept" | ... open. */
    type: text("type").notNull().default("unknown"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /**
     * Strong keys (CIN, DIN, ISIN, pincode). Two entities sharing one of these
     * are the same; two differing on one are NOT — this is what stops
     * "Gurugram 122002" from merging into "Gurgaon 122009".
     */
    identifiers: jsonb("identifiers").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("entities_corpus_key_uq").on(t.corpusId, t.canonicalKey),
    index("entities_corpus_idx").on(t.corpusId),
    index("entities_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

export const predicates = pgTable(
  "predicates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: uuid("corpus_id")
      .notNull()
      .references(() => corpora.id, { onDelete: "cascade" }),
    canonicalLabel: text("canonical_label").notNull(),
    /** Canonicalised label; see the note on `entities.canonicalKey`. */
    canonicalKey: text("canonical_key").notNull(),
    description: text("description"),
    /** Base unit family this predicate is normally measured in ("currency", "count", "ratio"). */
    unitKind: text("unit_kind"),
    occurrences: integer("occurrences").notNull().default(0),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("predicates_corpus_key_uq").on(t.corpusId, t.canonicalKey),
    index("predicates_corpus_idx").on(t.corpusId),
    index("predicates_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

/**
 * Near-synonym links between predicates. Deliberately NOT merges: "revenue from
 * contracts with customers" and "revenue from services" sit at ~0.9 similarity
 * but differ by traded goods, and the corpus says so in a footnote. Keeping them
 * distinct-but-linked lets the reconciler report a definitional difference
 * instead of a false contradiction.
 */
export const predicateLinks = pgTable(
  "predicate_links",
  {
    aId: uuid("a_id").notNull().references(() => predicates.id, { onDelete: "cascade" }),
    bId: uuid("b_id").notNull().references(() => predicates.id, { onDelete: "cascade" }),
    similarity: real("similarity").notNull(),
    note: text("note"),
  },
  (t) => [primaryKey({ columns: [t.aId, t.bId] })],
);

/** Live registry of qualifier keys — this is the evolving part of the schema. */
export const qualifierKeys = pgTable(
  "qualifier_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: uuid("corpus_id")
      .notNull()
      .references(() => corpora.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    description: text("description"),
    valueType: text("value_type").notNull().default("string"),
    /** Distinct values observed, capped — primes the extractor prompt. */
    sampleValues: jsonb("sample_values").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    occurrences: integer("occurrences").notNull().default(0),
    /** True for keys the reconciler treats as reconciling dimensions. */
    isReconciling: boolean("is_reconciling").notNull().default(false),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    ...timestamps,
  },
  (t) => [uniqueIndex("qualifier_keys_corpus_key_uq").on(t.corpusId, t.key)],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Facts
 * ────────────────────────────────────────────────────────────────────────── */

export type FactKind =
  | "quantitative"
  | "temporal"
  | "relational"
  | "attributive"
  | "definitional";

export type ValueModifier =
  | "exact"
  | "approximate"
  | "at_least"
  | "at_most"
  | "range"
  | "not_applicable"
  | "nil";

export type ExtractionMethod = "table_deterministic" | "narrative_llm" | "vision_llm";

/** Normalized unit. `factor` converts `valueNum` into `baseUnit`. */
export type UnitInfo = {
  raw: string | null;
  kind: "currency" | "count" | "ratio" | "mass" | "area" | "length" | "time" | "energy" | "other";
  currency?: string;
  scale?: number;
  uom?: string;
  baseUnit: string;
  factor: number;
};

export type PeriodKind =
  | "fiscal_year"
  | "calendar_year"
  | "quarter"
  | "half_year"
  | "nine_month"
  | "month"
  | "instant"
  | "range"
  | "unknown";

export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: uuid("corpus_id")
      .notNull()
      .references(() => corpora.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").references(() => chunks.id, { onDelete: "set null" }),

    kind: text("kind").$type<FactKind>().notNull(),

    subjectEntityId: uuid("subject_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    subjectText: text("subject_text").notNull(),

    predicateId: uuid("predicate_id").references(() => predicates.id, { onDelete: "set null" }),
    predicateText: text("predicate_text").notNull(),

    /** Non-quantitative object ("resigned", "New Delhi 110037"). */
    objectText: text("object_text"),
    objectEntityId: uuid("object_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),

    /** Exactly as printed, including parentheses and footnote marks. */
    valueRaw: text("value_raw"),
    /** Parsed, sign-corrected, footnote-stripped. NULL for Nil / N.A. */
    valueNum: doublePrecision("value_num"),
    /** Value expressed in `unit.baseUnit` — the only field ever compared numerically. */
    valueBase: doublePrecision("value_base"),
    valueMin: doublePrecision("value_min"),
    valueMax: doublePrecision("value_max"),
    modifier: text("modifier").$type<ValueModifier>().notNull().default("exact"),
    unit: jsonb("unit").$type<UnitInfo>(),

    /** OPEN map. New keys register themselves in `qualifier_keys`. */
    qualifiers: jsonb("qualifiers").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),

    periodKind: text("period_kind").$type<PeriodKind>().notNull().default("unknown"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    /** Label as printed: "Fiscal 2021", "Q4 FY24", "as at March 31, 2024". */
    periodLabel: text("period_label"),

    /** Stable hash of the qualifier subset that changes what is being measured. */
    scopeSignature: text("scope_signature").notNull().default(""),

    /** hash(subject, predicate, period, scope) — exact same claim. */
    claimKey: text("claim_key").notNull(),
    /** hash(subject, predicate) — same measure, any period/scope. */
    relaxedKey: text("relaxed_key").notNull(),

    confidence: real("confidence").notNull().default(0.5),
    extractionMethod: text("extraction_method").$type<ExtractionMethod>().notNull(),
    /** The quote was found verbatim in its chunk. False ⇒ never surfaced as fact. */
    quoteVerified: boolean("quote_verified").notNull().default(false),
    /** Excluded from contradiction detection (chart-derived, low layout confidence). */
    quarantined: boolean("quarantined").notNull().default(false),

    /** Embedding of a canonical one-line rendering — powers "expressed differently". */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),

    ...timestamps,
  },
  (t) => [
    index("facts_corpus_claim_idx").on(t.corpusId, t.claimKey),
    index("facts_corpus_relaxed_idx").on(t.corpusId, t.relaxedKey),
    index("facts_document_idx").on(t.documentId),
    index("facts_subject_idx").on(t.subjectEntityId),
    index("facts_predicate_idx").on(t.predicateId),
    index("facts_period_idx").on(t.periodStart, t.periodEnd),
    index("facts_qualifiers_gin").using("gin", t.qualifiers),
    index("facts_embedding_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    factId: uuid("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNo: integer("page_no").notNull(),
    /** One rect per line the quote spans — drawn directly over the rendered page. */
    bboxes: jsonb("bboxes").$type<BBox[]>().notNull(),
    quote: text("quote").notNull(),
    blockId: uuid("block_id").references(() => blocks.id, { onDelete: "set null" }),
    tableId: uuid("table_id").references(() => docTables.id, { onDelete: "set null" }),
    tableCell: jsonb("table_cell").$type<{ row: number; col: number }>(),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    ...timestamps,
  },
  (t) => [index("evidence_fact_idx").on(t.factId), index("evidence_doc_page_idx").on(t.documentId, t.pageNo)],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Relations — the output the assignment actually grades.
 * ────────────────────────────────────────────────────────────────────────── */

export type RelationType =
  | "CORROBORATES"
  | "EQUIVALENT_RESTATEMENT"
  | "CONTRADICTS"
  | "RECONCILED_BY_TIME"
  | "RECONCILED_BY_SCOPE"
  | "RECONCILED_BY_UNIT"
  | "RECONCILED_BY_BASIS"
  | "RECONCILED_BY_DEFINITION"
  | "SUPERSEDES"
  | "SUPPORTS_DERIVED"
  | "INSUFFICIENT_EVIDENCE";

export type RelationMethod = "rule" | "arithmetic" | "llm";

export const relations = pgTable(
  "relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: uuid("corpus_id")
      .notNull()
      .references(() => corpora.id, { onDelete: "cascade" }),
    factA: uuid("fact_a")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    factB: uuid("fact_b")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    type: text("type").$type<RelationType>().notNull(),
    /** Which qualifier key explains the difference ("period", "scope", "basis"). */
    subtype: text("subtype"),
    confidence: real("confidence").notNull().default(0.5),
    method: text("method").$type<RelationMethod>().notNull(),
    /** Human-readable reasoning shown verbatim in the UI. */
    explanation: text("explanation").notNull(),
    /** Machine-checkable reconciliation, e.g. { lhs: 122, rhs: 82+40, ok: true }. */
    arithmetic: jsonb("arithmetic").$type<Record<string, unknown>>(),
    /** Third-party facts that made the reconciliation possible. */
    bridgingFactIds: jsonb("bridging_fact_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Same-document pair. Cross-document conflicts are the headline finding. */
    intraDocument: boolean("intra_document").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("relations_pair_uq").on(t.factA, t.factB),
    index("relations_corpus_type_idx").on(t.corpusId, t.type),
  ],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Issues — the honesty surface. Powers the "Quality & Failures" screen.
 * ────────────────────────────────────────────────────────────────────────── */

export type IssueKind =
  | "chart_region_unreadable"
  | "table_header_mismatch"
  | "quote_verification_failed"
  | "unit_unresolved"
  | "period_unresolved"
  | "possible_source_error"
  | "entity_ambiguous"
  | "llm_invalid_output"
  | "stage_failed";

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    corpusId: uuid("corpus_id").references(() => corpora.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    pageNo: integer("page_no"),
    kind: text("kind").$type<IssueKind>().notNull(),
    severity: text("severity").$type<"info" | "warning" | "error">().notNull().default("warning"),
    detail: text("detail").notNull(),
    /** The offending text/cells, so the UI can show what actually went wrong. */
    sample: jsonb("sample").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [index("issues_doc_idx").on(t.documentId), index("issues_kind_idx").on(t.kind)],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Model-call cache — content-addressed. Makes retries and re-runs free, which
 * is what keeps the pipeline inside a free-tier quota.
 * ────────────────────────────────────────────────────────────────────────── */

export const llmCache = pgTable(
  "llm_cache",
  {
    /** sha256(model + kind + prompt + schema) */
    key: text("key").primaryKey(),
    model: text("model").notNull(),
    kind: text("kind").$type<"completion" | "embedding">().notNull(),
    response: jsonb("response").notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [index("llm_cache_model_idx").on(t.model)],
);

/* ────────────────────────────────────────────────────────────────────────── *
 * Drizzle relation graph (for typed `with:` queries)
 * ────────────────────────────────────────────────────────────────────────── */

export const documentsRelations = drizzleRelations(documents, ({ one, many }) => ({
  corpus: one(corpora, { fields: [documents.corpusId], references: [corpora.id] }),
  pages: many(pages),
  blocks: many(blocks),
  tables: many(docTables),
  chunks: many(chunks),
  facts: many(facts),
  stages: many(documentStages),
  issues: many(issues),
}));

export const factsRelations = drizzleRelations(facts, ({ one, many }) => ({
  document: one(documents, { fields: [facts.documentId], references: [documents.id] }),
  chunk: one(chunks, { fields: [facts.chunkId], references: [chunks.id] }),
  subject: one(entities, { fields: [facts.subjectEntityId], references: [entities.id] }),
  predicate: one(predicates, { fields: [facts.predicateId], references: [predicates.id] }),
  evidence: many(evidence),
}));

export const evidenceRelations = drizzleRelations(evidence, ({ one }) => ({
  fact: one(facts, { fields: [evidence.factId], references: [facts.id] }),
  document: one(documents, { fields: [evidence.documentId], references: [documents.id] }),
}));

export const relationsRelations = drizzleRelations(relations, ({ one }) => ({
  a: one(facts, { fields: [relations.factA], references: [facts.id], relationName: "factA" }),
  b: one(facts, { fields: [relations.factB], references: [facts.id], relationName: "factB" }),
}));

export const chunksRelations = drizzleRelations(chunks, ({ one, many }) => ({
  document: one(documents, { fields: [chunks.documentId], references: [documents.id] }),
  table: one(docTables, { fields: [chunks.tableId], references: [docTables.id] }),
  facts: many(facts),
}));
