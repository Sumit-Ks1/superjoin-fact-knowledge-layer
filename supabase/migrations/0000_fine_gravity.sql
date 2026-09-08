-- Fact Knowledge Layer — initial schema.
--
-- Run this once against your Supabase project (SQL Editor, or `npm run db:push`).
--
-- The extensions come first because the schema depends on them: `facts.embedding`
-- and `chunks.embedding` are pgvector columns, and their HNSW indexes cannot be
-- created until the type exists.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"bbox" jsonb NOT NULL,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"table_id" uuid,
	"font_size" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"breadcrumb" text DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"page_start" integer NOT NULL,
	"page_end" integer NOT NULL,
	"bbox_union" jsonb,
	"token_count" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"table_id" uuid,
	"fact_bearing" boolean DEFAULT true NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpora" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corpora_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "doc_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"page_start" integer NOT NULL,
	"page_end" integer NOT NULL,
	"caption" text,
	"unit_hint" text,
	"row_count" integer NOT NULL,
	"col_count" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"col_header_paths" jsonb NOT NULL,
	"row_label_cols" integer DEFAULT 1 NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_stages" (
	"document_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metrics" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "document_stages_document_id_stage_pk" PRIMARY KEY("document_id","stage")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"page_count" integer,
	"doc_date" timestamp with time zone,
	"doc_type" text,
	"publisher_entity_id" uuid,
	"fiscal_year_end" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"canonical_key" text NOT NULL,
	"type" text DEFAULT 'unknown' NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fact_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"bboxes" jsonb NOT NULL,
	"quote" text NOT NULL,
	"block_id" uuid,
	"table_id" uuid,
	"table_cell" jsonb,
	"char_start" integer,
	"char_end" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid,
	"kind" text NOT NULL,
	"subject_entity_id" uuid,
	"subject_text" text NOT NULL,
	"predicate_id" uuid,
	"predicate_text" text NOT NULL,
	"object_text" text,
	"object_entity_id" uuid,
	"value_raw" text,
	"value_num" double precision,
	"value_base" double precision,
	"value_min" double precision,
	"value_max" double precision,
	"modifier" text DEFAULT 'exact' NOT NULL,
	"unit" jsonb,
	"qualifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"period_kind" text DEFAULT 'unknown' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"period_label" text,
	"scope_signature" text DEFAULT '' NOT NULL,
	"claim_key" text NOT NULL,
	"relaxed_key" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"extraction_method" text NOT NULL,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid,
	"document_id" uuid,
	"page_no" integer,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"detail" text NOT NULL,
	"sample" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"kind" text NOT NULL,
	"response" jsonb NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_no" integer NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"column_count" integer DEFAULT 1 NOT NULL,
	"layout_confidence" real DEFAULT 1 NOT NULL,
	"printed_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predicate_links" (
	"a_id" uuid NOT NULL,
	"b_id" uuid NOT NULL,
	"similarity" real NOT NULL,
	"note" text,
	CONSTRAINT "predicate_links_a_id_b_id_pk" PRIMARY KEY("a_id","b_id")
);
--> statement-breakpoint
CREATE TABLE "predicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"canonical_label" text NOT NULL,
	"canonical_key" text NOT NULL,
	"description" text,
	"unit_kind" text,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualifier_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"value_type" text DEFAULT 'string' NOT NULL,
	"sample_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"is_reconciling" boolean DEFAULT false NOT NULL,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" uuid NOT NULL,
	"fact_a" uuid NOT NULL,
	"fact_b" uuid NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"method" text NOT NULL,
	"explanation" text NOT NULL,
	"arithmetic" jsonb,
	"bridging_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intra_document" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_table_id_doc_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."doc_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_tables" ADD CONSTRAINT "doc_tables_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_stages" ADD CONSTRAINT "document_stages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_table_id_doc_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."doc_tables"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_subject_entity_id_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_predicate_id_predicates_id_fk" FOREIGN KEY ("predicate_id") REFERENCES "public"."predicates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_object_entity_id_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predicate_links" ADD CONSTRAINT "predicate_links_a_id_predicates_id_fk" FOREIGN KEY ("a_id") REFERENCES "public"."predicates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predicate_links" ADD CONSTRAINT "predicate_links_b_id_predicates_id_fk" FOREIGN KEY ("b_id") REFERENCES "public"."predicates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predicates" ADD CONSTRAINT "predicates_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifier_keys" ADD CONSTRAINT "qualifier_keys_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_corpus_id_corpora_id_fk" FOREIGN KEY ("corpus_id") REFERENCES "public"."corpora"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_fact_a_facts_id_fk" FOREIGN KEY ("fact_a") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_fact_b_facts_id_fk" FOREIGN KEY ("fact_b") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_doc_page_idx" ON "blocks" USING btree ("document_id","page_no");--> statement-breakpoint
CREATE INDEX "blocks_doc_ordinal_idx" ON "blocks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_doc_ordinal_uq" ON "chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunks_hash_idx" ON "chunks" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE UNIQUE INDEX "doc_tables_doc_source_uq" ON "doc_tables" USING btree ("document_id","source_key");--> statement-breakpoint
CREATE INDEX "doc_tables_doc_idx" ON "doc_tables" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_corpus_sha_uq" ON "documents" USING btree ("corpus_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_corpus_key_uq" ON "entities" USING btree ("corpus_id","canonical_key");--> statement-breakpoint
CREATE INDEX "entities_corpus_idx" ON "entities" USING btree ("corpus_id");--> statement-breakpoint
CREATE INDEX "entities_embedding_idx" ON "entities" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "evidence_fact_idx" ON "evidence" USING btree ("fact_id");--> statement-breakpoint
CREATE INDEX "evidence_doc_page_idx" ON "evidence" USING btree ("document_id","page_no");--> statement-breakpoint
CREATE INDEX "facts_corpus_claim_idx" ON "facts" USING btree ("corpus_id","claim_key");--> statement-breakpoint
CREATE INDEX "facts_corpus_relaxed_idx" ON "facts" USING btree ("corpus_id","relaxed_key");--> statement-breakpoint
CREATE INDEX "facts_document_idx" ON "facts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "facts_subject_idx" ON "facts" USING btree ("subject_entity_id");--> statement-breakpoint
CREATE INDEX "facts_predicate_idx" ON "facts" USING btree ("predicate_id");--> statement-breakpoint
CREATE INDEX "facts_period_idx" ON "facts" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "facts_qualifiers_gin" ON "facts" USING gin ("qualifiers");--> statement-breakpoint
CREATE INDEX "facts_embedding_idx" ON "facts" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "issues_doc_idx" ON "issues" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "issues_kind_idx" ON "issues" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "llm_cache_model_idx" ON "llm_cache" USING btree ("model");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_doc_page_uq" ON "pages" USING btree ("document_id","page_no");--> statement-breakpoint
CREATE UNIQUE INDEX "predicates_corpus_key_uq" ON "predicates" USING btree ("corpus_id","canonical_key");--> statement-breakpoint
CREATE INDEX "predicates_corpus_idx" ON "predicates" USING btree ("corpus_id");--> statement-breakpoint
CREATE INDEX "predicates_embedding_idx" ON "predicates" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE UNIQUE INDEX "qualifier_keys_corpus_key_uq" ON "qualifier_keys" USING btree ("corpus_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "relations_pair_uq" ON "relations" USING btree ("fact_a","fact_b");--> statement-breakpoint
CREATE INDEX "relations_corpus_type_idx" ON "relations" USING btree ("corpus_id","type");