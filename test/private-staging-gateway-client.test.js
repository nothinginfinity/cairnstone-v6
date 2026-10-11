import test from "node:test";
import assert from "node:assert/strict";
import { createStagingPrivateStoreClient, createStagingGatewayCore, STAGING_GATEWAY_CALLER } from "../src/private-realm/private-staging-gateway-client.js";
import { verifyEnvelope, __resetNonceCacheForTests } from "../src/private-realm/private-worker-core.js";

const KEY = "staging-test-secret-".repeat(4);
const stage = () => ({
  PRIVATE_STAGE_GATEWAY_ENABLED: "true",
  PRIVATE_GATEWAY_HMAC_KEY: KEY,
  STAGING_OAUTH_RESOURCE: "https://stage.example.test/mcp/core-auth",
  CAIRNSTONE_PRIVATE_STAGE: { call: async envelope => ({ ok: true, envelope }) }
});

test("dormant by default, fail closed without binding or key", () => {
  assert.throws(() => createStagingPrivateStoreClient({ env: {} }), { code: "private_tools_disabled" });
  assert.throws(() => createStagingPrivateStoreClient({ env: { PRIVATE_STAGE_GATEWAY_ENABLED: "true" } }), { code: "private_worker_unconfigured" });
  assert.throws(() => createStagingPrivateStoreClient({ env: { ...stage(), PRIVATE_GATEWAY_HMAC_KEY: "short" } }), { code: "private_worker_unconfigured" });
});

test("server-side gateway signs exact caller, arguments and unique nonce", async () => {
  __resetNonceCacheForTests();
  const store = createStagingPrivateStoreClient({ env: stage() });
  const scope = { account_id: "acct_stage", connection_id: "conn_stage" };
  const a = (await store.resolveHome(scope)).envelope;
  const b = (await store.resolveHome(scope)).envelope;
  assert.equal(a.caller, STAGING_GATEWAY_CALLER);
  assert.equal(a.method, "resolveHome");
  assert.deepEqual(a.args, [scope]);
  assert.notEqual(a.nonce, b.nonce);
  const verified = await verifyEnvelope({
    env: { PRIVATE_ALLOWED_CALLERS: STAGING_GATEWAY_CALLER, PRIVATE_GATEWAY_HMAC_KEY: KEY },
    envelope: a, platformCaller: STAGING_GATEWAY_CALLER
  });
  assert.equal(verified.method, "resolveHome");
  await assert.rejects(verifyEnvelope({
    env: { PRIVATE_ALLOWED_CALLERS: STAGING_GATEWAY_CALLER, PRIVATE_GATEWAY_HMAC_KEY: KEY },
    envelope: { ...b, args: [{ account_id: "forged" }] }, platformCaller: STAGING_GATEWAY_CALLER
  }), { code: "caller_not_authorized" });
});

test("no free-form dispatch; invalid args fail before service call", async () => {
  let called = 0;
  const env = { ...stage(), CAIRNSTONE_PRIVATE_STAGE: { call: async () => { called++; } } };
  const store = createStagingPrivateStoreClient({ env });
  assert.equal(store.arbitraryMethod, undefined);
  await assert.rejects(store.resolveHome(), { code: "invalid_arguments" });
  await assert.rejects(store.resolveHome({ bad: () => 1 }), { code: "invalid_arguments" });
  assert.equal(called, 0);
});

test("raw Worker exceptions never disclose internals", async () => {
  const env = { ...stage(), CAIRNSTONE_PRIVATE_STAGE: { call: async () => { throw new Error("secret SQL diagnostic"); } } };
  const store = createStagingPrivateStoreClient({ env });
  await assert.rejects(store.resolveHome({ test: 1 }), e => e.code === "private_store_error" && !String(e).includes("secret"));
});

test("gateway core requires a separately injected staging token verifier and exact resource", () => {
  assert.throws(() => createStagingGatewayCore({ env: stage() }), { code: "trusted_gateway_dependencies_required" });
  assert.throws(() => createStagingGatewayCore({
    env: stage(), expectedResource: "https://production.example.test/mcp/core-auth",
    validateStagingToken: async () => ({ ok: false })
  }), { code: "trusted_gateway_dependencies_required" });
  assert.throws(() => createStagingGatewayCore({
    env: { ...stage(), PRIVATE_STAGE_GATEWAY_ENABLED: "false" },
    expectedResource: "https://stage.example.test/mcp/core-auth",
    validateStagingToken: async () => ({ ok: false })
  }), { code: "private_tools_disabled" });
});
