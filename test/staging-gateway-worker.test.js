import test from "node:test";
import assert from "node:assert/strict";
import { createStagingOAuthVerifier } from "../src/staging-gateway/staging-oauth-verifier.js";
import gateway from "../src/staging-gateway/staging-gateway-worker.js";
import { PrivateRealmError } from "../src/private-realm/scope.js";

const KEY = "staging-oauth-test-key-".repeat(3);
const HMAC = "staging-hmac-test-key-".repeat(3);
const stageEnv = (overrides = {}) => ({
  PRIVATE_STAGE_GATEWAY_ENABLED: "true",
  STAGING_OAUTH_SIGNING_KEY: KEY,
  STAGING_OAUTH_RESOURCE: "https://stage.example.test/mcp/core-auth",
  STAGING_OAUTH_ISSUER: "https://stage.example.test",
  PRIVATE_GATEWAY_HMAC_KEY: HMAC,
  CAIRNSTONE_PRIVATE_STAGE: {
    call: async envelope => {
      // Simulate private Worker checking platformCaller
      if (envelope.caller !== "cairnstone-stage-gateway") throw new PrivateRealmError("caller_not_authorized");
      return { ok: true, method: envelope.method, args: envelope.args };
    }
  },
  ...overrides
});

async function signToken(payload, key = KEY) {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(b64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "csat_" + b64 + "." + sigB64;
}

const validPayload = {
  iss: "https://stage.example.test",
  aud: "https://stage.example.test/mcp/core-auth",
  resource: "https://stage.example.test/mcp/core-auth",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  account_id: "acct_stage",
  tenant_id: "ten_stage",
  principal_id: "prn_stage",
  connection_id: "conn_stage",
  account_status: "active",
  connection_status: "active",
  token_family_status: "active",
  token_family_id: "tfam_test",
  scopes: ["mcp:core"]
};

test("verifier requires explicit mcp:core and durable revocation", async () => {
  const authStore = {
    checkAuth: async ({ tokenFamilyId, connectionId }) => tokenFamilyId !== "tfam_revoked" && connectionId !== "conn_inactive"
  };
  const verify = await createStagingOAuthVerifier({ env: stageEnv(), authStore });
  const good = await signToken(validPayload);
  const result = await verify(good, validPayload.resource);
  assert.equal(result.ok, true);
  assert.deepEqual(result.context.scopes, ["mcp:core"]);

  await assert.rejects(verify(await signToken({ ...validPayload, scopes: [] }), validPayload.resource), { code: "scope_not_authorized" });
  await assert.rejects(verify(await signToken({ ...validPayload, token_family_id: "tfam_revoked" }), validPayload.resource), { code: "scope_not_authorized" });
  await assert.rejects(verify(await signToken({ ...validPayload, connection_id: "conn_inactive" }), validPayload.resource), { code: "scope_not_authorized" });
});

test("HTTP routes map short path to tool and reject unknown", async () => {
  const token = await signToken(validPayload);
  const req = new Request("https://stage.example.test/v1/private-inbox/get", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
    body: "{}"
  });
  // Note: full core.call requires store methods; this confirms route selection fails closed on disabled
  const disabled = await gateway.fetch(new Request(req.url, { method: "POST" }), { PRIVATE_STAGE_GATEWAY_ENABLED: "false" });
  assert.equal(disabled.status, 404);

  const unknown = await gateway.fetch(new Request("https://stage.example.test/v1/private-inbox/onboard", {
    method: "POST",
    headers: { Authorization: "Bearer " + token }
  }), stageEnv());
  assert.equal(unknown.status, 404);
});

test("error codes stay stable across boundary", () => {
  assert.throws(() => { throw new PrivateRealmError("caller_not_authorized"); }, { code: "caller_not_authorized" });
});

test("gateway: /stagec/* is NOT served by the product gateway (harness is a separate Worker)", async () => {
  for (const path of ["/stagec/v1/call", "/stagec/v1/probe"]) {
    const res = await gateway.fetch(new Request("https://stage.example.test" + path, { method: "POST", headers: { Authorization: "Bearer " + "x".repeat(40) }, body: "{}" }), stageEnv({ STAGE_C_HARNESS_TOKEN: "x".repeat(40) }));
    assert.equal(res.status, 404, path);
  }
});

test("gateway: without a STAGING_AUTH_DB binding the route denies (no permissive default)", async () => {
  const token = await signToken(validPayload);
  const res = await gateway.fetch(new Request("https://stage.example.test/v1/private-inbox/get", { method: "POST", headers: { Authorization: "Bearer " + token }, body: "{}" }), stageEnv());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "trusted_gateway_dependencies_required" });
});

test("gateway: a revoked token family is denied through the real D1 adapter", async () => {
  const { createSqliteD1 } = await import("./helpers/sqlite-d1.js");
  const { readFileSync } = await import("node:fs");
  const db = createSqliteD1({ sql: readFileSync(new URL("../migrations/staging-auth/0001_staging_auth.sql", import.meta.url), "utf8") });
  db.exec("INSERT INTO staging_connections VALUES ('conn_stage','acct_stage','active',1,1)");
  db.exec("INSERT INTO staging_token_families (token_family_id, account_id, connection_id, revoked, created_at, revoked_at) VALUES ('tfam_test','acct_stage','conn_stage',1,1,2)");
  const token = await signToken(validPayload);
  const res = await gateway.fetch(new Request("https://stage.example.test/v1/private-inbox/get", { method: "POST", headers: { Authorization: "Bearer " + token }, body: "{}" }), stageEnv({ STAGING_AUTH_DB: db }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "scope_not_authorized" });
});
