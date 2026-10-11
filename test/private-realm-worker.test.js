// S0b-2 private storage Worker boundary: caller identity, dispatch and error collapse.
// Exercises private-worker-core.js (pure) against the real SQLite-backed store. The Workers-runtime glue
// (private-worker.js) is syntax-checked only; its source is inspected here for the properties that matter.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PrivateRealmError } from "../src/private-realm/index.js";
import { STORE_METHODS } from "../src/private-realm/store.js";
import { assertPlainJson, canonicalJson, handlePrivateCall, signEnvelope, verifyEnvelope } from "../src/private-realm/private-worker-core.js";
import { SQLITE_AVAILABLE, createClock, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";

const skip = SQLITE_AVAILABLE ? false : "node:sqlite unavailable";
const KEY = "k".repeat(40);
const OLD_KEY = "o".repeat(40);
const GATEWAY = "public-gateway";
const chatgpt = sc("alice", "chatgpt");

const envFor = (db, extra = {}) => ({ CAIRNSTONE_PRIVATE_DB: db, PRIVATE_GATEWAY_HMAC_KEY: KEY, PRIVATE_ALLOWED_CALLERS: GATEWAY, ...extra });
const call = (env, method, args, extra = {}) => signEnvelope({ key: KEY, caller: GATEWAY, method, args, ...extra }).then(envelope => handlePrivateCall({ env, envelope }));
const code = fn => fn().then(() => null, e => (e instanceof PrivateRealmError ? e.code : `RAW:${e && e.message}`));
const storeFactory = db => opts => createD1HomeStore({ ...opts, db, now: createClock(), mintId: createMint() });

test("a correctly signed call from an allowed caller reaches the real store", { skip }, async () => {
  const db = createSqliteD1();
  const out = await handlePrivateCall({
    env: envFor(db),
    envelope: await signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] }),
    createStore: storeFactory(db)
  });
  assert.equal(out.created, true);
  assert.equal(db.count("priv_homes"), 1);
});

test("every envelope failure collapses to the same typed code and touches no storage", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db);
  const good = () => signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] });
  const mutate = async fn => { const e = structuredClone(await good()); fn(e); return e; };
  const bad = {
    "no envelope": undefined,
    "string envelope": "ensureDefaultHome",
    "array envelope": [],
    "missing signature": await mutate(e => { delete e.sig; }),
    "garbage signature": await mutate(e => { e.sig = "z".repeat(64); }),
    "all-zero signature": await mutate(e => { e.sig = "0".repeat(64); }),
    "tampered scope (other account)": await mutate(e => { e.args[0].account_id = "acct_bobby"; }),
    "tampered scope (other connection)": await mutate(e => { e.args[0].connection_id = "conn_alice_other"; }),
    "tampered role request": await mutate(e => { e.args[0].home_role = "admin"; }),
    "tampered method": await mutate(e => { e.method = "revokeConnection"; }),
    "tampered caller": await mutate(e => { e.caller = "other-caller"; }),
    "tampered iat": await mutate(e => { e.iat += 1; }),
    "wrong version": await mutate(e => { e.v = 2; }),
    "wrong key": await signEnvelope({ key: "w".repeat(40), caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] }),
    "caller not on allow-list": await signEnvelope({ key: KEY, caller: "intruder", method: "ensureDefaultHome", args: [chatgpt] }),
    "stale": await signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt], iat: Math.floor(Date.now() / 1000) - 3600 }),
    "from the future": await signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt], iat: Math.floor(Date.now() / 1000) + 3600 })
  };
  for (const [name, envelope] of Object.entries(bad)) {
    assert.equal(await code(() => handlePrivateCall({ env, envelope, createStore: storeFactory(db) })), "caller_not_authorized", name);
  }
  assert.equal(db.log.length, 0, "no statement was issued for any rejected envelope");
});

test("an envelope cannot be replayed", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db);
  const envelope = await signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] });
  await handlePrivateCall({ env, envelope, createStore: storeFactory(db) });
  assert.equal(await code(() => handlePrivateCall({ env, envelope, createStore: storeFactory(db) })), "caller_not_authorized");
});

test("platform-attached caller identity must agree with the envelope when present", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db, { PRIVATE_ALLOWED_CALLERS: `${GATEWAY},second-gateway` });
  const mk = () => signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] });
  assert.equal(await code(async () => handlePrivateCall({ env, envelope: await mk(), platformCaller: "second-gateway", createStore: storeFactory(db) })), "caller_not_authorized");
  assert.equal((await handlePrivateCall({ env, envelope: await mk(), platformCaller: GATEWAY, createStore: storeFactory(db) })).created, true);
});

test("the caller cannot supply env, bindings or another database", { skip }, async () => {
  const real = createSqliteD1();
  const attacker = createSqliteD1();
  const env = envFor(real);
  // Extra envelope fields and args are signed-over or ignored; there is no parameter through which env can change.
  const envelope = await signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] });
  envelope.env = { CAIRNSTONE_PRIVATE_DB: attacker };
  envelope.CAIRNSTONE_PRIVATE_DB = attacker;
  await handlePrivateCall({ env, envelope, createStore: storeFactory(real) });
  assert.equal(real.count("priv_homes"), 1);
  assert.equal(attacker.count("priv_homes"), 0);
  assert.equal(attacker.log.length, 0);
  // A scope smuggling an env-shaped field is plain JSON data the store's scope validation never trusts.
  const smuggle = await signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [{ ...chatgpt, env: { x: 1 }, home_id: "home_attacker0001" }] });
  assert.equal(await code(() => handlePrivateCall({ env, envelope: smuggle, createStore: storeFactory(real) })), "scope_must_not_carry_selectors");
});

test("signing does not make a scope trustworthy: the store still enforces Home scope and ownership", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db);
  const factory = storeFactory(db);
  const send = (method, args) => signEnvelope({ key: KEY, caller: GATEWAY, method, args }).then(envelope => handlePrivateCall({ env, envelope, createStore: factory }));
  await send("ensureDefaultHome", [chatgpt]);
  for (const bad of [
    { ...chatgpt, principal_id: "prin_alice_swapped" },
    { ...chatgpt, account_id: "acct_bobby" },
    { ...chatgpt, tenant_id: "ten_bobby" },
    sc("mallory", "chatgpt")
  ]) {
    assert.equal(await code(() => send("listInboxes", [bad])), "scope_not_authorized");
  }
  assert.equal(await code(() => send("readInbox", [chatgpt, { inboxId: "ibx_doesnotexist" }])), "capability_denied");
});

test("only the 12 store methods are callable, and only as own properties", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db);
  for (const method of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype", "authorize", "audit", "handleStoreCall", ""]) {
    const envelope = await signEnvelope({ key: KEY, caller: GATEWAY, method, args: [chatgpt] });
    assert.equal(await code(() => handlePrivateCall({ env, envelope, createStore: storeFactory(db) })), "unknown_store_method", method);
  }
  assert.equal(db.log.length, 0);
  for (const method of STORE_METHODS) {
    const envelope = await signEnvelope({ key: KEY, caller: GATEWAY, method, args: [sc("alice", "nobody")] });
    const result = await code(() => handlePrivateCall({ env, envelope, createStore: storeFactory(db) }));
    assert.ok(result === null || /^(scope_not_authorized|capability_denied|invalid_[a-z_]+)$/.test(result), `${method}: ${result}`);
  }
});

test("arguments must be plain JSON of bounded size; hostile shapes never reach the store", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db);
  class Evil { constructor() { this.account_id = "acct_alice"; } }
  for (const args of [
    [new Evil()],
    [JSON.parse('{"__proto__": {"polluted": true}}')],
    [{ constructor: { prototype: {} } }],
    [{ a: undefined }],
    [{ a: () => 1 }],
    [{ a: Number.NaN }],
    [{ a: "x".repeat(70001) }],
    [Array.from({ length: 51 }, () => 1)],
    [{ a: { b: { c: { d: { e: { f: { g: {} } } } } } } }]
  ]) {
    await assert.rejects(() => signEnvelope({ key: KEY, caller: GATEWAY, method: "listInboxes", args }), error => error instanceof PrivateRealmError && error.code === "invalid_arguments");
    assert.throws(() => assertPlainJson(args), error => error.code === "invalid_arguments");
  }
  assert.equal(({}).polluted, undefined);
  // Zero or too many positional arguments.
  for (const args of [[], [chatgpt, null, null, null]]) {
    assert.equal(await code(async () => handlePrivateCall({ env, envelope: await signEnvelope({ key: KEY, caller: GATEWAY, method: "listInboxes", args }), createStore: storeFactory(db) })), "invalid_arguments");
  }
});

test("store failures leave the worker as typed codes only: SQL, D1 and R2 errors never cross the boundary", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db);
  const leaky = () => ({ listInboxes: async () => { throw new Error("D1_ERROR: UNIQUE constraint failed: priv_messages.body_text SECRET-ROW"); } });
  const detail = () => ({ listInboxes: async () => { throw new PrivateRealmError("capability_denied", { reason: "internal-detail" }); } });
  const mk = () => signEnvelope({ key: KEY, caller: GATEWAY, method: "listInboxes", args: [chatgpt] });
  const raw = await handlePrivateCall({ env, envelope: await mk(), createStore: leaky }).catch(e => e);
  assert.ok(raw instanceof PrivateRealmError);
  assert.equal(raw.code, "private_store_error");
  assert.ok(!JSON.stringify([raw.message, raw.code, raw.detail]).includes("SECRET-ROW"));
  const typed = await handlePrivateCall({ env, envelope: await mk(), createStore: detail }).catch(e => e);
  assert.equal(typed.code, "capability_denied");
  assert.equal(typed.detail, undefined, "internal detail is stripped");
  // A store that only inherits a method (prototype) is not callable.
  const inherited = () => Object.create({ listInboxes: async () => "leak" });
  assert.equal(await code(async () => handlePrivateCall({ env, envelope: await mk(), createStore: inherited })), "unknown_store_method");
});

test("misconfiguration fails closed and is distinct only to the operator", { skip }, async () => {
  const db = createSqliteD1();
  const envelope = () => signEnvelope({ key: KEY, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] });
  for (const env of [
    { CAIRNSTONE_PRIVATE_DB: db },
    { CAIRNSTONE_PRIVATE_DB: db, PRIVATE_GATEWAY_HMAC_KEY: "short", PRIVATE_ALLOWED_CALLERS: GATEWAY },
    { CAIRNSTONE_PRIVATE_DB: db, PRIVATE_GATEWAY_HMAC_KEY: KEY },
    { CAIRNSTONE_PRIVATE_DB: db, PRIVATE_GATEWAY_HMAC_KEY: KEY, PRIVATE_ALLOWED_CALLERS: "Bad Caller!" },
    { CAIRNSTONE_PRIVATE_DB: db, PRIVATE_GATEWAY_HMAC_KEY: KEY, PRIVATE_GATEWAY_HMAC_KEY_PREVIOUS: "short", PRIVATE_ALLOWED_CALLERS: GATEWAY }
  ]) {
    assert.equal(await code(async () => handlePrivateCall({ env, envelope: await envelope(), createStore: storeFactory(db) })), "private_worker_unconfigured");
  }
  assert.equal(db.log.length, 0);
  await assert.rejects(() => signEnvelope({ key: "short", caller: GATEWAY, method: "listInboxes", args: [] }), error => error.code === "private_worker_unconfigured");
});

test("key rotation: the previous key still verifies during the overlap, the retired key does not", { skip }, async () => {
  const db = createSqliteD1();
  const env = envFor(db, { PRIVATE_GATEWAY_HMAC_KEY: "n".repeat(40), PRIVATE_GATEWAY_HMAC_KEY_PREVIOUS: OLD_KEY });
  const withKey = key => signEnvelope({ key, caller: GATEWAY, method: "ensureDefaultHome", args: [chatgpt] });
  const ok = await handlePrivateCall({ env, envelope: await withKey(OLD_KEY), createStore: storeFactory(db) });
  assert.equal(ok.created, true);
  assert.equal((await handlePrivateCall({ env, envelope: await withKey("n".repeat(40)), createStore: storeFactory(db) })).created, false);
  assert.equal(await code(async () => handlePrivateCall({ env, envelope: await withKey(KEY), createStore: storeFactory(db) })), "caller_not_authorized");
});

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("verifyEnvelope never accepts a missing nonce, malformed nonce or non-integer iat", { skip }, async () => {
  const env = envFor(createSqliteD1());
  for (const patch of [{ nonce: undefined }, { nonce: "short" }, { nonce: "has spaces and is long enough!!" }, { iat: 1.5 }, { iat: "1" }]) {
    const e = { ...(await signEnvelope({ key: KEY, caller: GATEWAY, method: "listInboxes", args: [chatgpt] })), ...patch };
    assert.equal(await verifyEnvelope({ env, envelope: e }).then(() => null, x => x.code), "caller_not_authorized");
  }
});

test("worker glue: single RPC method, no fetch handler, no env parameter, no other imports", () => {
  const src = readFileSync(new URL("../src/private-realm/private-worker.js", import.meta.url), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  assert.deepEqual([...code.matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]).sort(), ["./private-worker-core.js", "cloudflare:workers"]);
  assert.doesNotMatch(code, /\bfetch\b|\bscheduled\b|\bqueue\b|\bemail\b/, "no HTTP/cron/queue/email surface");
  assert.deepEqual([...code.matchAll(/^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm)].map(m => m[1]).filter(n => n !== "if"), ["call"]);
  assert.match(code, /async call\(envelope\)/, "the RPC method takes only the signed envelope");
  assert.match(code, /env: this\.env/, "env is the worker's own");
});
