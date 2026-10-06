import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";
import { bootstrapAccountConnection, oauthResourcesMatch } from "../src/core-auth.js";
import {
  canonicalizeCoreTransportResource,
  isCanonicalCoreResource,
  resolveResourceScopePolicy
} from "../src/resource-scope-policy.js";
import { FakeAuthD1 } from "./helpers/fake-auth-d1.js";

const ORIGIN = "https://cairnstone.test";
const RESOURCE = `${ORIGIN}/mcp/core-auth`;
const TWIN = `${ORIGIN}/mcp/core-auth-b`;
const ISSUER = `${ORIGIN}/oauth`;

function envFor(db, extra = {}) {
  return {
    CAIRNSTONE_DB: db,
    CORE_AUTH_RESOURCE: RESOURCE,
    CORE_AUTH_ISSUER: ISSUER,
    CORE_AUTH_ENFORCEMENT: "canary",
    ...extra
  };
}

function rpc(method, id = 1, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function post(path, body, env, headers = {}) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body
  }), env);
}

test("A primary /mcp/core-auth keeps anonymous initialize and tools/list", async () => {
  const env = envFor(new FakeAuthD1());
  const init = await post("/mcp/core-auth", rpc("initialize"), env);
  assert.equal(init.status, 200);
  const list = await post("/mcp/core-auth", rpc("tools/list"), env);
  assert.equal(list.status, 200);
  const call = await post("/mcp/core-auth", rpc("tools/call", 2, {
    name: "cairnstone_health",
    arguments: {}
  }), env);
  assert.equal(call.status, 401);
  const www = call.headers.get("WWW-Authenticate") || "";
  assert.match(www, /resource_metadata=/);
  assert.match(www, /oauth-protected-resource\/mcp\/core-auth/);
  assert.doesNotMatch(www, /core-auth-b/);
});

test("B twin connect-time: anonymous initialize/tools/list/tools/call are 401", async () => {
  const env = envFor(new FakeAuthD1());
  for (const method of ["initialize", "tools/list", "tools/call"]) {
    const params = method === "tools/call"
      ? { name: "cairnstone_health", arguments: {} }
      : {};
    const response = await post("/mcp/core-auth-b", rpc(method, 1, params), env);
    assert.equal(response.status, 401, method);
    const www = response.headers.get("WWW-Authenticate") || "";
    assert.match(www, /Bearer/i, method);
    assert.match(www, /resource_metadata=/);
    assert.match(www, /\/\.well-known\/oauth-protected-resource\/mcp\/core-auth"/);
    assert.match(www, new RegExp(`resource="${RESOURCE}"`));
    assert.doesNotMatch(www, /core-auth-b/);
  }
});

test("B twin GET stays diagnostic and advertises connect_time", async () => {
  const env = envFor(new FakeAuthD1());
  const response = await worker.fetch(new Request(`${ORIGIN}/mcp/core-auth-b`), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.auth_bootstrap, "connect_time");
  assert.equal(body.resource, RESOURCE);
  assert.equal(body.logical_resource, RESOURCE);
  assert.equal(body.endpoint, TWIN);
  const names = body.tools.map((tool) => tool.name);
  assert.ok(names.includes("cairnstone_event_list"));
  assert.ok(names.includes("cairnstone_unified_conversations"));
});

test("B bearer on canonical Core resource works on the twin", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const boot = await bootstrapAccountConnection(env, {
    clientFamily: "grok",
    resource: RESOURCE,
    admitCanary: true,
    canaryLabel: "grok-connect-time"
  });
  assert.equal(boot.ok, true);
  const headers = { authorization: `Bearer ${boot.access_token}` };
  for (const method of ["initialize", "tools/list"]) {
    const response = await post("/mcp/core-auth-b", rpc(method), env, headers);
    assert.equal(response.status, 200, method);
  }
  const call = await post("/mcp/core-auth-b", rpc("tools/call", 3, {
    name: "cairnstone_health",
    arguments: {}
  }), env, headers);
  assert.equal(call.status, 200);
  const body = await call.json();
  const tool = JSON.parse(body.result.content[0].text);
  assert.equal(tool.ok, true);
  const listed = await post("/mcp/core-auth-b", rpc("tools/list"), env, headers);
  const tools = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("cairnstone_event_list"));
});

test("C GET and tools/list catalogs match; /mcp/core stays at nine", async () => {
  const db = new FakeAuthD1();
  const env = envFor(db);
  const boot = await bootstrapAccountConnection(env, {
    clientFamily: "grok",
    resource: RESOURCE,
    admitCanary: true
  });
  assert.equal(boot.ok, true);
  const primaryGet = await worker.fetch(new Request(`${ORIGIN}/mcp/core-auth`), env);
  const primaryNames = (await primaryGet.json()).tools.map((tool) => tool.name);
  assert.ok(primaryNames.includes("cairnstone_event_list"));
  const primaryList = await post("/mcp/core-auth", rpc("tools/list"), env, {
    authorization: `Bearer ${boot.access_token}`
  });
  const listed = (await primaryList.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(listed.filter((name) => primaryNames.includes(name)).sort(), [...primaryNames].sort());
  assert.ok(listed.includes("cairnstone_event_list"));

  const coreGet = await worker.fetch(new Request(`${ORIGIN}/mcp/core`), env);
  const coreNames = (await coreGet.json()).tools.map((tool) => tool.name);
  assert.equal(coreNames.length, 9);
  assert.equal(coreNames.includes("cairnstone_event_list"), false);
  const coreList = await post("/mcp/core", rpc("tools/list"), env);
  const coreListed = (await coreList.json()).result.tools.map((tool) => tool.name);
  assert.equal(coreListed.includes("cairnstone_event_list"), false);
});

test("C twin PRM alias is the same canonical Core metadata", async () => {
  const env = envFor(new FakeAuthD1());
  const primary = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/core-auth`), env);
  const twin = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/core-auth-b`), env);
  assert.equal(primary.status, 200);
  assert.equal(twin.status, 200);
  const primaryBody = await primary.json();
  const twinBody = await twin.json();
  assert.equal(primaryBody.resource, RESOURCE);
  assert.equal(twinBody.resource, RESOURCE);
  assert.deepEqual(twinBody.authorization_servers, primaryBody.authorization_servers);
});

test("D legacy /mcp and /mcp-b stay anonymous and unchanged", async () => {
  const env = envFor(new FakeAuthD1());
  for (const path of ["/mcp", "/mcp-b", "/mcp/core"]) {
    const response = await post(path, rpc("initialize"), env);
    assert.equal(response.status, 200, path);
    const get = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
    const body = await get.json();
    assert.equal(body.auth_bootstrap, "none", path);
    assert.equal(body.profile === "deferred_tool_vault_core_auth", false, path);
  }
  const core = await worker.fetch(new Request(`${ORIGIN}/mcp/core`), env);
  const names = (await core.json()).tools.map((tool) => tool.name);
  assert.equal(names.includes("cairnstone_event_list"), false);
  assert.equal(names.length, 9);
});

test("twin resource canonicalizes to core-auth and matches token audience", () => {
  assert.equal(canonicalizeCoreTransportResource(TWIN), RESOURCE);
  assert.equal(isCanonicalCoreResource(TWIN, { CORE_AUTH_RESOURCE: RESOURCE }, new URL(ORIGIN)), true);
  assert.equal(oauthResourcesMatch(RESOURCE, TWIN), true);
  const policy = resolveResourceScopePolicy(TWIN, "mcp:core", { CORE_AUTH_RESOURCE: RESOURCE }, new URL(ORIGIN));
  assert.equal(policy.ok, true);
  assert.equal(policy.resource_class, "core");
  const evil = resolveResourceScopePolicy("https://evil.example/mcp/core-auth-b", "mcp:core", { CORE_AUTH_RESOURCE: RESOURCE }, new URL(ORIGIN));
  assert.equal(evil.ok, false);
  assert.equal(evil.error, "invalid_target");
});
