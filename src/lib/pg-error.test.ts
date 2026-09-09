/**
 * The shape of a real production failure.
 *
 * A guard written as `error.code === "23503"` never fired, because Drizzle
 * re-throws the driver error inside its own Error and the SQLSTATE lives on
 * `.cause`. Every foreign-key violation propagated unhandled and was retried
 * three times. These fixtures reproduce that exact nesting.
 */

import { describe, expect, it } from "vitest";

import {
  isForeignKeyViolation,
  isMissingSchema,
  isUniqueViolation,
  postgresErrorCode,
} from "./pg-error";

/** What Drizzle actually throws: its own Error, with the driver's on `.cause`. */
function drizzleWrapped(code: string, message: string): Error {
  const driver = Object.assign(new Error(message), { code, name: "PostgresError" });
  return Object.assign(
    new Error('Failed query: insert into "document_stages" ("document_id", "stage") values ($1, $2)'),
    { cause: driver },
  );
}

describe("postgresErrorCode", () => {
  it("finds a code on the error itself", () => {
    expect(postgresErrorCode(Object.assign(new Error("x"), { code: "23503" }))).toBe("23503");
  });

  it("finds a code one level down, which is where Drizzle puts it", () => {
    expect(postgresErrorCode(drizzleWrapped("23503", "violates foreign key constraint"))).toBe(
      "23503",
    );
  });

  it("finds a code several levels down", () => {
    const inner = Object.assign(new Error("inner"), { code: "23505" });
    const mid = Object.assign(new Error("mid"), { cause: inner });
    const outer = Object.assign(new Error("outer"), { cause: mid });
    expect(postgresErrorCode(outer)).toBe("23505");
  });

  it("does not mistake a Node error code for a SQLSTATE", () => {
    // "ECONNRESET" is a string `code` too, and treating it as a SQLSTATE would
    // make transport failures look like constraint violations.
    expect(postgresErrorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
    expect(postgresErrorCode(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBeNull();
  });

  it("returns null rather than guessing", () => {
    expect(postgresErrorCode(new Error("something went wrong"))).toBeNull();
    expect(postgresErrorCode(null)).toBeNull();
    expect(postgresErrorCode(undefined)).toBeNull();
    expect(postgresErrorCode("a string")).toBeNull();
  });

  it("survives a cyclic cause chain", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(postgresErrorCode(looped)).toBeNull();
  });
});

describe("isForeignKeyViolation", () => {
  it("recognises the production failure", () => {
    // The exact case: a document deleted while its pipeline was still running.
    const error = drizzleWrapped(
      "23503",
      'insert or update on table "document_stages" violates foreign key constraint "document_stages_document_id_documents_id_fk"',
    );
    expect(isForeignKeyViolation(error)).toBe(true);
  });

  it("recognises it from the message when no code survives", () => {
    expect(
      isForeignKeyViolation(new Error('violates foreign key constraint "x_fk"')),
    ).toBe(true);
  });

  it("does not swallow unrelated failures", () => {
    expect(isForeignKeyViolation(new Error("connection terminated"))).toBe(false);
    expect(isForeignKeyViolation(drizzleWrapped("23505", "duplicate key"))).toBe(false);
  });
});

describe("isUniqueViolation", () => {
  it("recognises a duplicate through the wrapper", () => {
    expect(isUniqueViolation(drizzleWrapped("23505", "duplicate key value"))).toBe(true);
  });
});

describe("isMissingSchema", () => {
  it("recognises a column or table the migration never created", () => {
    expect(isMissingSchema(drizzleWrapped("42703", 'column "kind" does not exist'))).toBe(true);
    expect(isMissingSchema(drizzleWrapped("42P01", 'relation "facts" does not exist'))).toBe(true);
  });

  it("is not confused by a constraint violation", () => {
    expect(isMissingSchema(drizzleWrapped("23503", "fk"))).toBe(false);
  });
});