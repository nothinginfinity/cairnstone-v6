// S0b-2 — Private R2 body adapter.
//
// DORMANT. Bodies larger than the D1 text limit go to CAIRNSTONE_PRIVATE_R2 only.
// Key format: private/{home_id}/{message_id}. Never written to shared R2, stones, refs or FTS.
// Public gateway holds no private R2 binding.

import { PrivateRealmError } from "./scope.js";

export async function putPrivateBody(r2, home_id, message_id, body) {
  if (!r2 || typeof r2.put !== "function") throw new PrivateRealmError("private_r2_required");
  if (typeof home_id !== "string" || !home_id.startsWith("home_")) throw new PrivateRealmError("invalid_home_id");
  const key = `private/${home_id}/${message_id}`;
  await r2.put(key, body);
  return key;
}

export async function getPrivateBody(r2, key) {
  if (!r2 || typeof r2.get !== "function") throw new PrivateRealmError("private_r2_required");
  if (typeof key !== "string" || !key.startsWith("private/")) throw new PrivateRealmError("invalid_r2_key");
  const obj = await r2.get(key);
  return obj ? await obj.text() : null;
}

// No export of shared-bucket helpers. No fallback to env.CAIRNSTONE_R2 or stones.
