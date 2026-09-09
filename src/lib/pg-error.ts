/**
 * Reading Postgres error codes through whatever wrapped them.
 *
 * Drizzle re-throws a driver error inside its own `Error`, so the useful part —
 * the five-character SQLSTATE — is not on the object you catch. It is on
 * `.cause`, and with another layer of tooling it can be deeper still.
 *
 * That detail cost a production outage. A guard written as
 * `error.code === "23503"` looked correct, passed review, and silently never
 * fired: every foreign-key violation propagated as an unhandled failure and
 * Inngest retried it three times. Checking the chain instead of the surface is
 * the whole fix.
 */

/** SQLSTATE codes this system reacts to by name. */
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_UNDEFINED_COLUMN = "42703";
export const PG_UNDEFINED_TABLE = "42P01";

/** How far to follow `.cause` before giving up on a cyclic or absurd chain. */
const MAX_DEPTH = 8;

/**
 * Finds the Postgres SQLSTATE in an error or anything it wraps.
 *
 * Returns null when there is no code to find, which callers should treat as
 * "not a database error I know how to handle" — never as "safe to ignore".
 */
export function postgresErrorCode(error: unknown): string | null {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
    const code = (current as { code?: unknown }).code;
    // SQLSTATE is always five characters; `code` on a Node error is a string
    // like "ECONNRESET", which must not be mistaken for one.
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;

    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }

  return null;
}

/**
 * Did this fail because the row it referenced is gone?
 *
 * Falls back to matching the message when no code is exposed — some wrappers
 * flatten the error to a string, and a violation that reaches a caller
 * unrecognised becomes a retried failure for something a user did on purpose.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  if (postgresErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) return true;
  return /violates foreign key constraint/i.test(String((error as Error)?.message ?? error));
}

export function isUniqueViolation(error: unknown): boolean {
  if (postgresErrorCode(error) === PG_UNIQUE_VIOLATION) return true;
  return /duplicate key value violates unique constraint/i.test(
    String((error as Error)?.message ?? error),
  );
}

/**
 * A schema the code expects but the database does not have.
 *
 * Distinctive because the fix is always the same and always a person's job:
 * a migration has not been run. Worth naming so it is never mistaken for a
 * transient fault and retried.
 */
export function isMissingSchema(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === PG_UNDEFINED_COLUMN || code === PG_UNDEFINED_TABLE;
}