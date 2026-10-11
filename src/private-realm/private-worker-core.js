// S0b-2 — private storage Worker core: caller identity + dispatch. Pure ES module, no platform imports,
// so it is unit-tested in Node. The Worker glue (private-worker.js) only adapts it to WorkerEntrypoint.
//
// DORMANT. No public URL, no routes, no binding is provisioned by this repo state.
//
// Trust model
//   * The ONLY thing the worker trusts about a caller is a signed envelope verified against secrets held in
//     the worker's OWN environment (PRIVATE_GATEWAY_HMAC_KEY[/_PREVIOUS], PRIVATE_ALLOWED_CALLERS). The
//     `env` is never a parameter of the RPC surface: a caller cannot supply, replace or influence bindings.
//   * The envelope binds {caller, method, args, iat, nonce} under HMAC-SHA256. Changing any of them (the
//     HomeScope inside `args`, the method, the caller name) invalidates the signature. Only the holder of the
//     key (the public gateway, which builds the HomeScope server-side from a verified authContext) can mint one.
//   * `platformCaller` (optional) is the identity the platform attached to the service binding
//     (WorkerEntrypoint ctx.props). When present it must equal the envelope's caller. This is defence in
//     depth; the HMAC does not depend on it.
//   * Every envelope failure (unknown caller, bad signature, stale, replayed, malformed) collapses to ONE
//     typed code, `caller_not_authorized`, so a probe learns nothing about which check failed.
//   * Only the 12 STORE_METHODS (own properties) are callable. Arguments must be plain JSON.
//   * Errors leave the worker as PrivateRealmError codes only; SQL/D1/R2 errors are collapsed to
//     `private_store_error`, never forwarded.

import { PrivateRealmError } from "./scope.js";
import { STORE_METHODS } from "./store.js";
import { createD1HomeStore } from "./d1-store.js";

const ENVELOPE_VERSION = 1;
const MIN_KEY_CHARS = 32;
const DEFAULT_MAX_SKEW_SECONDS = 60;
const MAX_ARGS = 3;
const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ARRAY = 50;
const MAX_STRING = 70000;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const CALLER_PATTERN = /^[a-z0-9][a-z0-9_.:-]{1,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const hexOf = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
const bytesOf = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));

const denied = () => new PrivateRealmError("caller_not_authorized");

/** Deterministic JSON: object keys sorted recursively. Input must already be plain JSON. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Accept only plain JSON: no undefined, functions, class instances, cycles, prototype tricks or huge payloads. */
export function assertPlainJson(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new PrivateRealmError("invalid_arguments");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PrivateRealmError("invalid_arguments");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING) throw new PrivateRealmError("invalid_arguments");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) throw new PrivateRealmError("invalid_arguments");
    return value.map(v => assertPlainJson(v, depth + 1));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new PrivateRealmError("invalid_arguments");
    const keys = Object.keys(value);
    if (keys.length > MAX_KEYS) throw new PrivateRealmError("invalid_arguments");
    const out = {};
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw new PrivateRealmError("invalid_arguments");
      out[key] = assertPlainJson(value[key], depth + 1);
    }
    return out;
  }
  throw new PrivateRealmError("invalid_arguments");
}

async function hmacKey(secret, usages) {
  return globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function signedPayload({ caller, method, args, iat, nonce }) {
  return canonicalJson({ v: ENVELOPE_VERSION, caller, method, args, iat, nonce });
}

/** Gateway-side: build a signed envelope. Used by tests and by the (future) public gateway client. */
export async function signEnvelope({ key, caller, method, args = [], iat = Math.floor(Date.now() / 1000), nonce = randomNonce() }) {
  if (typeof key !== "string" || key.length < MIN_KEY_CHARS) throw new PrivateRealmError("private_worker_unconfigured");
  const body = { caller, method, args: assertPlainJson(args), iat, nonce };
  const sig = hexOf(await globalThis.crypto.subtle.sign("HMAC", await hmacKey(key, ["sign"]), new TextEncoder().encode(signedPayload(body))));
  return { v: ENVELOPE_VERSION, ...body, sig };
}

function randomNonce() {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return hexOf(buf);
}

function configuredKeys(env) {
  const keys = [env?.PRIVATE_GATEWAY_HMAC_KEY, env?.PRIVATE_GATEWAY_HMAC_KEY_PREVIOUS].filter(k => k !== undefined && k !== null && k !== "");
  if (keys.length === 0 || !keys.every(k => typeof k === "string" && k.length >= MIN_KEY_CHARS)) {
    throw new PrivateRealmError("private_worker_unconfigured");
  }
  return keys;
}

function allowedCallers(env) {
  const raw = env?.PRIVATE_ALLOWED_CALLERS;
  const list = typeof raw === "string" ? raw.split(",").map(s => s.trim()).filter(Boolean) : [];
  if (list.length === 0 || !list.every(c => CALLER_PATTERN.test(c))) throw new PrivateRealmError("private_worker_unconfigured");
  return new Set(list);
}

// Best-effort per-isolate replay cache. Not a security boundary on its own (see residuals): freshness + HMAC are.
const seenNonces = new Map();
function rememberNonce(nonce, expiresAtMs, nowMs) {
  for (const [n, exp] of seenNonces) if (exp <= nowMs) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  if (seenNonces.size > 10000) return false; // fail closed rather than grow without bound
  seenNonces.set(nonce, expiresAtMs);
  return true;
}
export function __resetNonceCacheForTests() { seenNonces.clear(); }

/** Verify an envelope against the worker's OWN env. Throws caller_not_authorized for every failure. Returns {caller, method, args}. */
export async function verifyEnvelope({ env, envelope, platformCaller = null, nowMs = Date.now() }) {
  const keys = configuredKeys(env);     // operator misconfiguration is distinguishable to the operator, not to callers
  const callers = allowedCallers(env);
  try {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw denied();
    const { v, caller, method, args, iat, nonce, sig } = envelope;
    if (v !== ENVELOPE_VERSION) throw denied();
    if (typeof caller !== "string" || !callers.has(caller)) throw denied();
    if (platformCaller !== null && platformCaller !== undefined && platformCaller !== caller) throw denied();
    if (typeof method !== "string" || !Array.isArray(args) || typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) throw denied();
    if (!Number.isInteger(iat)) throw denied();
    const skew = Number.parseInt(env.PRIVATE_ENVELOPE_MAX_SKEW_SECONDS, 10);
    const maxSkew = Number.isInteger(skew) && skew > 0 && skew <= 300 ? skew : DEFAULT_MAX_SKEW_SECONDS;
    if (Math.abs(Math.floor(nowMs / 1000) - iat) > maxSkew) throw denied();
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) throw denied();
    let plain;
    try { plain = assertPlainJson(args); } catch { throw denied(); }
    const data = new TextEncoder().encode(signedPayload({ caller, method, args: plain, iat, nonce }));
    let valid = false;
    for (const secret of keys) {
      // crypto.subtle.verify compares in constant time.
      if (await globalThis.crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), bytesOf(sig), data)) valid = true;
    }
    if (!valid) throw denied();
    if (!rememberNonce(nonce, nowMs + (maxSkew * 2 + 1) * 1000, nowMs)) throw denied();
    return { caller, method, args: plain };
  } catch (error) {
    if (error instanceof PrivateRealmError && error.code === "caller_not_authorized") throw error;
    throw denied();
  }
}

/**
 * The single entry point the Worker glue calls. `env` is the worker's own environment, never caller data.
 * Returns the store method's result, or throws a PrivateRealmError whose code is safe to show a caller.
 */
export async function handlePrivateCall({ env, envelope, platformCaller = null, nowMs = Date.now(), createStore = createD1HomeStore }) {
  const call = await verifyEnvelope({ env, envelope, platformCaller, nowMs });
  if (!STORE_METHODS.includes(call.method)) throw new PrivateRealmError("unknown_store_method");
  if (call.args.length === 0 || call.args.length > MAX_ARGS) throw new PrivateRealmError("invalid_arguments");
  try {
    const store = createStore({ db: env.CAIRNSTONE_PRIVATE_DB, r2: env.CAIRNSTONE_PRIVATE_R2 ?? null });
    if (!Object.prototype.hasOwnProperty.call(store, call.method) || typeof store[call.method] !== "function") {
      throw new PrivateRealmError("unknown_store_method");
    }
    return await store[call.method](...call.args);
  } catch (error) {
    if (error instanceof PrivateRealmError) throw new PrivateRealmError(error.code); // drop `detail`
    throw new PrivateRealmError("private_store_error");
  }
}
