// S1-3 isolated staging gate. Not imported from any production entrypoint.
// Fail closed without an attested service-binding caller and durable D1 nonce insert.
import { PrivateRealmError } from "./scope.js";
import { STORE_METHODS } from "./store.js";
import { verifyEnvelope } from "./private-worker-core.js";
import { createD1HomeStore } from "./d1-store.js";

const deny = () => new PrivateRealmError("caller_not_authorized");
const unconfigured = () => new PrivateRealmError("private_worker_unconfigured");

export async function handleStagingPrivateCall({
  env, envelope, platformCaller = null, nowMs = Date.now(),
  createStore = createD1HomeStore
} = {}) {
  if (!env || env.PRIVATE_STAGE_ENABLED !== "true") throw unconfigured();
  if (typeof env.PRIVATE_STAGE_CALLER !== "string" || !env.PRIVATE_STAGE_CALLER) throw unconfigured();
  // Platform attestation is REQUIRED (fail closed). The gateway's [[services]] binding must set
  // props = { caller = "<PRIVATE_STAGE_CALLER>" } (wrangler >= 4.13); Cloudflare delivers it as
  // ctx.props and the calling Worker cannot forge it. The signed HMAC caller must match it too.
  if (typeof platformCaller !== "string" || platformCaller !== env.PRIVATE_STAGE_CALLER) throw deny();
  const db = env.CAIRNSTONE_PRIVATE_DB;
  if (!db || typeof db.prepare !== "function") throw unconfigured();
  if (!env.CAIRNSTONE_PRIVATE_R2 || typeof env.CAIRNSTONE_PRIVATE_R2.put !== "function") throw unconfigured();
  const call = await verifyEnvelope({ env, envelope, platformCaller, nowMs });
  if (call.caller !== env.PRIVATE_STAGE_CALLER) throw deny();
  if (!STORE_METHODS.includes(call.method)) throw new PrivateRealmError("unknown_store_method");
  if (call.args.length === 0 || call.args.length > 3) throw new PrivateRealmError("invalid_arguments");
  // D1's unique primary key is the cross-isolate durable replay barrier.
  // Never accept a successful response without a proved, committed one-row insert.
  // Per-isolate nonce caches are only a fast additional layer, NOT our security boundary.
  try {
    const stmt = db.prepare(
      "INSERT INTO priv_service_nonces (caller,nonce,issued_at) VALUES (?1,?2,?3) ON CONFLICT(caller,nonce) DO NOTHING"
    );
    const receipt = await stmt.bind(call.caller, envelope.nonce, envelope.iat).run();
    if (receipt?.success !== true || receipt?.meta?.changes !== 1) throw deny();
  } catch {
    // Storage outage, missing schema, duplicate, uncertain receipt: identical external denial.
    throw deny();
  }
  try {
    const store = createStore({ db, r2: env.CAIRNSTONE_PRIVATE_R2 });
    if (!Object.prototype.hasOwnProperty.call(store, call.method) ||
        typeof store[call.method] !== "function") {
      throw new PrivateRealmError("unknown_store_method");
    }
    return await store[call.method](...call.args);
  } catch (error) {
    if (error instanceof PrivateRealmError) throw new PrivateRealmError(error.code);
    throw new PrivateRealmError("private_store_error");
  }
}
