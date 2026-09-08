/** Content addressing. Used for dedupe, cache keys, claim keys, scope signatures. */
import { createHash } from "node:crypto";

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Short, collision-resistant-enough key for grouping (not for security). */
export function shortHash(input: string, length = 16): string {
  return sha256(input).slice(0, length);
}

/**
 * Order-independent hash of a key/value map. Two facts with the same qualifiers
 * written in a different order must produce the same scope signature.
 */
export function stableHash(parts: Record<string, string | number | null | undefined>): string {
  const normalized = Object.entries(parts)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()
    .join("\u0000");
  return shortHash(normalized, 24);
}
