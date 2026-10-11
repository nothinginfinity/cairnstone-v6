import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { signEnvelope, __resetNonceCacheForTests } from "../src/private-realm/private-worker-core.js";
import { handleStagingPrivateCall } from "../src/private-realm/private-staging-core.js";

const key = "synthetic-staging-hmac-key-32characters-plus";
const caller = "cairnstone-stage-gateway";
function fixture() {
  const used = new Set();
  let commits = 0;
  const db = { prepare(sql) {
    assert.match(sql, /^INSERT INTO priv_service_nonces /);
    return { bind(c, n, iat) {
      assert.equal(c, caller);
      assert.equal(typeof iat, "number");
      return { async run() {
        const k = c + ":" + n;
        if (used.has(k)) return { success: true, meta: { changes: 0 } };
        used.add(k);
        commits++;
        return { success: true, meta: { changes: 1 } };
      }};
    }};
  }};
  const env = {
    PRIVATE_STAGE_ENABLED: "true",
    PRIVATE_STAGE_CALLER: caller,
    PRIVATE_ALLOWED_CALLERS: caller,
    PRIVATE_GATEWAY_HMAC_KEY: key,
    CAIRNSTONE_PRIVATE_DB: db,
    CAIRNSTONE_PRIVATE_R2: { put: async () => {} }
  };
  const createStore = () => ({ listInboxes: async (scope) => ({ ok: true, scope }) });
  const signed = (nonce) => signEnvelope({
    key, caller, method: "listInboxes",
    args: [{ homeId: "home_SYNTHETIC_00001" }],
    nonce
  });
  const invoke = (envelope, other = {}) => handleStagingPrivateCall({
    env, envelope, createStore, platformCaller: caller, ...other
  });
  return { env, db, used, signed, invoke, commits: () => commits };
}
test("valid signed RPC needs durable D1 uniqueness", async () => {
  __resetNonceCacheForTests();
  const f = fixture();
  const envelope = await f.signed("synthetic_nonce_1234567890");
  assert.equal((await f.invoke(envelope)).ok, true);
  assert.equal(f.commits(), 1);
  __resetNonceCacheForTests(); // emulate a different isolate
  await assert.rejects(f.invoke(envelope), { code: "caller_not_authorized" });
  assert.equal(f.commits(), 1);
});
test("tampering with signed payload denies before storage", async () => {
  __resetNonceCacheForTests();
  const f = fixture();
  const e = await f.signed("tampered_nonce_1234567890");
  e.args[0].homeId = "home_ATTACKER";
  await assert.rejects(f.invoke(e), { code: "caller_not_authorized" });
  assert.equal(f.commits(), 0);
});
test("signed caller required; optional platform caller mismatch denies", async () => {
  __resetNonceCacheForTests();
  const f = fixture();
  const e = await f.signed("no_platform_nonce_123456789");
  await assert.rejects(f.invoke(e, { platformCaller: "legacy-gateway" }), { code: "caller_not_authorized" });
  assert.equal(f.commits(), 0);
  // Cross-worker service binding provides no ctx.props; signed exact caller is authoritative.
  assert.equal((await f.invoke(e, { platformCaller: null })).ok, true);
  assert.equal(f.commits(), 1);
});
test("storage uncertainty or missing schema denies", async () => {
  __resetNonceCacheForTests();
  const f = fixture();
  const e = await f.signed("db_failure_nonce_123456789");
  const db = { prepare: () => ({ bind: () => ({ run: async () => { throw Error("sensitive db failure"); } }) }) };
  await assert.rejects(f.invoke(e, { env: { ...f.env, CAIRNSTONE_PRIVATE_DB: db } }), { code: "caller_not_authorized" });
});
test("staging disabled or private bindings absent fail closed", async () => {
  __resetNonceCacheForTests();
  const f = fixture();
  const e = await f.signed("stage_off_nonce_123456789");
  await assert.rejects(f.invoke(e, { env: { ...f.env, PRIVATE_STAGE_ENABLED: "false" } }), { code: "private_worker_unconfigured" });
  await assert.rejects(f.invoke(e, { env: { ...f.env, CAIRNSTONE_PRIVATE_R2: undefined } }), { code: "private_worker_unconfigured" });
});
test("production entrypoints and bindings have no staging activation", () => {
  const prodFiles = ["src/index.js", "src/worker.js", "src/core-auth.js"];
  for (const p of prodFiles) {
    const body = readFileSync(new URL("../" + p, import.meta.url), "utf8");
    assert.doesNotMatch(body, /private-staging-(core|worker)/);
  }
  const prod = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(prod, /CAIRNSTONE_PRIVATE_DB|CAIRNSTONE_PRIVATE_R2|cairnstone-private-staging/);
});

test("correct key but non-stage caller is rejected by exact caller binding", async () => {
  __resetNonceCacheForTests();
  const f = fixture();
  const envelope = await signEnvelope({ key, caller: "unlisted-but-signed", method: "listInboxes",
    args: [{ homeId: "home_SYNTHETIC_00001" }], nonce: "wrong_caller_nonce_123456" });
  await assert.rejects(f.invoke(envelope, { env: {
    ...f.env, PRIVATE_ALLOWED_CALLERS: "cairnstone-stage-gateway,unlisted-but-signed"
  }, platformCaller: null }), { code: "caller_not_authorized" });
  assert.equal(f.commits(), 0);
});

test("staging HTTP handler remains an inert 404 deployment prerequisite", () => {
  const worker = readFileSync(new URL("../src/private-realm/private-staging-worker.js", import.meta.url), "utf8");
  assert.match(worker, /async fetch\(\)\s*\{\s*return new Response\(null,\s*\{ status: 404 \}\);\s*\}/);
  assert.doesNotMatch(worker, /fetch\(request\)|\.get\(\s*request\)|handlePrivateCall\(\s*\{\s*request/);
});
