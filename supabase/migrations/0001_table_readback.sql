-- Lets extraction read tables back from the database instead of re-parsing.
--
-- Tables were being written here and then never read: the extract stage
-- re-downloaded the PDF and rebuilt every grid from scratch, putting a second
-- full parse on the critical path. On a 60-second serverless limit that alone
-- exhausted the invocation.
--
-- Three columns were missing to make the stored row sufficient on its own.
-- Existing rows get defaults and are re-populated on the next run.

ALTER TABLE "doc_tables"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'grid';
--> statement-breakpoint

ALTER TABLE "doc_tables"
  ADD COLUMN IF NOT EXISTS "bbox" jsonb;
--> statement-breakpoint

ALTER TABLE "doc_tables"
  ADD COLUMN IF NOT EXISTS "header_row_count" integer NOT NULL DEFAULT 0;
