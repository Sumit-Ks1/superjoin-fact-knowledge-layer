/**
 * Postgres connection for serverless.
 *
 * Two decisions carry weight here.
 *
 * `prepare: false` is mandatory. Supabase's transaction pooler (port 6543)
 * multiplexes connections across PgBouncer, which cannot hold prepared
 * statements. Without it, queries fail intermittently under concurrency —
 * exactly the bug that stays hidden until Inngest fans out.
 *
 * The connection is built lazily. `next build` on Vercel runs without runtime
 * secrets, so reading DATABASE_URL at module scope would fail the build for
 * every route that transitively imports this file. Callers ask for a client
 * when they are about to use one.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __fklSql: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __fklDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

function createClient() {
  return postgres(env.databaseUrl, {
    prepare: false,
    // Serverless invocations are short-lived; a small pool avoids exhausting
    // the pooler when many Inngest steps run at once.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    // Surface Postgres notices during development instead of swallowing them.
    onnotice: env.isProduction ? () => {} : undefined,
  });
}

/** Raw postgres.js client. Reused across warm invocations and hot reloads. */
export function getSql() {
  if (!globalThis.__fklSql) globalThis.__fklSql = createClient();
  return globalThis.__fklSql;
}

/** Drizzle client. `casing` keeps camelCase columns mapped to snake_case. */
export function getDb() {
  if (!globalThis.__fklDb) {
    globalThis.__fklDb = drizzle(getSql(), { schema, casing: "snake_case" });
  }
  return globalThis.__fklDb;
}

export { schema };
export type Database = ReturnType<typeof getDb>;
