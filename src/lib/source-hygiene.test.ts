/**
 * No source file may contain a raw NUL byte.
 *
 * `cacheKey` joins its parts with U+0000 — a separator chosen because it cannot
 * occur in a model name or a prompt. Written as the character itself rather than
 * an escape, it sat literally inside a template literal, and editors and tools
 * that rewrite the file will happily turn the escape back into the raw byte.
 *
 * Local webpack and Turbopack both parse it. Vercel's build does not: it fails
 * with `Unterminated template` pointing at the exact column of the byte, and the
 * deploy dies before anything runs. The character is fine; spelling it out in
 * source is not.
 *
 * Git also classifies such a file as binary, so the diff is unreviewable and
 * line-ending normalisation silently stops applying to it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".css", ".json", ".sql", ".md"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".git")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

describe("source hygiene", () => {
  it("contains no raw NUL bytes — use the escape sequence instead", () => {
    const offenders = sourceFiles(ROOT)
      .filter((file) => readFileSync(file).includes(0x00))
      .map((file) => path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });
});