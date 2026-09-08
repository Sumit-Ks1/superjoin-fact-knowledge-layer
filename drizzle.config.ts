import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./supabase/migrations",
  dialect: "postgresql",
  dbCredentials: {
    /*
     * Session pooler (DIRECT_URL) when available, not the transaction pooler.
     * Migrations run CREATE EXTENSION and CREATE INDEX, which PgBouncer's
     * transaction mode cannot carry; DATABASE_URL is the fallback so a project
     * configured with only one connection string still works for most DDL.
     */
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
  // pgvector / pg_trgm are created by hand in 0000_extensions.sql
  extensionsFilters: ["postgis"],
  verbose: true,
  strict: true,
});
