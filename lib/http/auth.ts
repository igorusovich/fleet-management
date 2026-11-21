/**
 * Ingest authentication.
 *
 * The robots share one static key (`INGEST_API_KEY`), sent in a header. Checking
 * it is the endpoint's first gate, so it runs before the body is parsed: an
 * unauthenticated caller learns nothing about the schema from error messages,
 * and a rejected request never reaches the database.
 *
 * Key hashing note: `crypto.timingSafeEqual` throws when the two buffers differ
 * in length, so comparing raw strings would need an early length check — and the
 * length of a secret is itself information. Hashing both sides to a fixed 32
 * bytes makes the comparison total and constant-time.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Header the simulator and any gateway must send. Lower-case: `Headers` is case-insensitive. */
export const INGEST_KEY_HEADER = "x-ingest-key";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time check of a provided key against the configured one.
 *
 * A missing header, a blank value or an empty expectation is always a rejection:
 * an unset `INGEST_API_KEY` must never degrade into "no authentication".
 */
export function hasValidIngestKey(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (typeof provided !== "string" || provided.length === 0 || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(digest(provided), digest(expected));
}
