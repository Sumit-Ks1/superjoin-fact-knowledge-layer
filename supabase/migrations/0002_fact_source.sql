-- Records where each fact was read from, on the fact itself.
--
-- Two problems this solves.
--
-- Retried extraction duplicated facts. Extraction runs in batches to fit inside
-- a serverless invocation, and the writes append; a batch that failed halfway
-- and was retried appended its rows a second time. With the grid's key on the
-- row, a batch can delete exactly its own output before rewriting it.
--
-- And the arithmetic channel needs to know which cell a figure came from, to
-- confine a sum to one column of one grid. That was rebuilt on every linking
-- pass by a raw join against `evidence`; now it is simply read.
--
-- Null for facts taken from prose, which have no grid.

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "source_key" text;
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "row_index" integer;
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "col_index" integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "facts_source_idx" ON "facts" ("document_id", "source_key");
