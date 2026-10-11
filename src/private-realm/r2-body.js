// S0b-2 — Private R2 body adapter.
//
// DORMANT. Bodies larger than the inline D1 threshold go to CAIRNSTONE_PRIVATE_R2 only.
//
// Key format (content-addressed, Home- and message-scoped):
//     private/{home_id}/{message_id}/{body_sha256}
// - The key is DERIVED from authorized, validated ids and the body hash. It is never taken from
//   caller input, and a stored key is only honoured if it equals the key re-derived for the row
//   being read. A key pointing at another Home or message therefore cannot be dereferenced.
// - Content addressing means a racing or conflicting send can never overwrite another message's
//   object: different bytes -> different key. Same bytes under the same ids -> same key (idempotent).
// - Reads verify the SHA-256 of what came back. A mismatch is reported as `integrity_failed` and the
//   body is withheld.
// - There is no public/shared bucket fallback and no helper for the shared CAIRNSTONE_R2.

import { ID_PATTERNS, PrivateRealmError } from "./scope.js";
import { sha256Hex } from "./hash.js";

const SHA_PATTERN = /^[0-9a-f]{64}$/;

export function privateBodyKey(home_id, message_id, body_sha256) {
  if (typeof home_id !== "string" || !ID_PATTERNS.home.test(home_id)) throw new PrivateRealmError("invalid_home_id");
  if (typeof message_id !== "string" || !ID_PATTERNS.message.test(message_id)) throw new PrivateRealmError("invalid_message_id");
  if (typeof body_sha256 !== "string" || !SHA_PATTERN.test(body_sha256)) throw new PrivateRealmError("invalid_body_hash");
  return `private/${home_id}/${message_id}/${body_sha256}`;
}

/** Store a body under its derived key. Verifies the hash matches the bytes being stored. */
export async function putPrivateBody(r2, { home_id, message_id, body_sha256, body }) {
  if (!r2 || typeof r2.put !== "function") throw new PrivateRealmError("private_r2_required");
  if (typeof body !== "string" || body.length === 0) throw new PrivateRealmError("invalid_body");
  const key = privateBodyKey(home_id, message_id, body_sha256);
  if ((await sha256Hex(body)) !== body_sha256) throw new PrivateRealmError("invalid_body_hash");
  await r2.put(key, body);
  return key;
}

/**
 * Read a body for a specific (home, message, hash) row. `storedKey` is what the row recorded; it must
 * equal the re-derived key. Returns { status: "ok", body } | { status: "unavailable" } | { status: "integrity_failed" }.
 * Never throws for a missing or corrupt object, so one bad body cannot hide the rest of an inbox.
 */
export async function getPrivateBody(r2, { home_id, message_id, body_sha256, storedKey }) {
  const key = privateBodyKey(home_id, message_id, body_sha256);
  if (storedKey !== key) return { status: "integrity_failed" };
  if (!r2 || typeof r2.get !== "function") return { status: "unavailable" };
  let text;
  try {
    const obj = await r2.get(key);
    if (!obj) return { status: "unavailable" };
    text = await obj.text();
  } catch {
    return { status: "unavailable" };
  }
  if (typeof text !== "string" || (await sha256Hex(text)) !== body_sha256) return { status: "integrity_failed" };
  return { status: "ok", body: text };
}
