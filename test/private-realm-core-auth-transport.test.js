// S1-2b dormant Core-auth transport adapter for the private inbox tools.
// Test-only injected host harness (a minimal stand-in for handleMcp's fall-through) on BOTH the in-memory store
// and real-SQLite D1 (when node:sqlite exists). No network, no binding, no production module is imported.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIdentityHomeBridge } from "../src/private-realm/identity-home-bridge.js";
import { PrivateRealmError, createInMemoryHomeStore } from "../src/private-realm/index.js";
import { PRIVATE_INBOX_TOOL_DEFINITIONS, PRIVATE_INBOX_TOOL_NAMES, createPrivateInboxTools } from "../src/private-realm/private-inbox-tools.js";
import {
  PRIVATE_CORE_AUTH_ENDPOINT_PATH, PRIVATE_INBOX_MCP_DESCRIPTORS, PRIVATE_INBOX_TOOL_EFFECTS,
  bearerFromHeaders, createPrivateCoreAuthTransport
} from "../src/private-realm/private-core-auth-transport.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { SQLITE_AVAILABLE, createClock, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";

const RESOURCE = "https://cairnstone.example/mcp/core-auth";
const KEY = "test-only-inbox-derivation-secret-32-chars-min";
const PATH = PRIVATE_CORE_AUTH_ENDPOINT_PATH;
const one = sc("alice", "one");
const two = sc("alice", "two");
const eve = sc("mallory", "evil");
const SECRET = "BODY-SENTINEL-s1-2b-91c4";

const ctx = (scope, o = {}) => ({
  schema: "cairnstone-core-auth-context-v1", realm: "core-auth",
  account_id: scope.account_id, tenant_id: scope.tenant_id, principal_id: scope.principal_id, connection_id: scope.connection_id,
  client_family: scope.provider_label, resource: RESOURCE, authenticator_assurance: "passkey",
  account_status: "active", connection_status: "active", token_family_status: "active",
  token_family_id: "tfam_test1234", authz_version: 1, scopes: ["mcp:core"], ...o
});
const bearer = token => ({ authorization: `Bearer ${token}` });
const call = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const frame = f => JSON.parse(f.result.content[0].text);

// Stand-in for the unchanged legacy host path: a tiny "legacy" tool and the existing unknown-tool denial.
const LEGACY_TOOLS = [{ name: "cairnstone_health", description: "legacy" }];
async function host(adapter, path, rpc, headers) {
  const own = await adapter.handleRpc(rpc, { endpointPath: path, headers });
  if (own) return own;
  if (rpc.method === "tools/list") return { jsonrpc: "2.0", id: rpc.id, result: { tools: [...LEGACY_TOOLS, ...adapter.listTools({ endpointPath: path })] } };
  if (rpc.method === "tools/call") {
    const known = LEGACY_TOOLS.some(t => t.name === rpc.params.name);
    const out = known ? { ok: true } : { ok: false, error: "tool_not_in_core_profile" };
    return { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(out) }], isError: !known } };
  }
  return { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } };
}

function make(kind, { activate = true, enabled = true } = {}) {
  const db = kind === "sqlite" ? createSqliteD1() : null;
  const store = db
    ? createD1HomeStore({ db, now: createClock(), mintId: createMint() })
    : createInMemoryHomeStore({ testHooks: true, now: createClock(), mintId: createMint() });
  const contexts = { csat_one: ctx(one), csat_two: ctx(two), csat_eve: ctx(eve) };
  const seen = { tokens: [], resources: [] };
  const bridge = createIdentityHomeBridge({
    store, expectedResource: RESOURCE, inboxDerivationKey: KEY,
    validateToken: async (token, resource) => {
      seen.tokens.push(token); seen.resources.push(resource);
      return { ok: resource === RESOURCE && token in contexts, context: structuredClone(contexts[token]) };
    },
    admitOnboarding: async () => true, admitAdminRecovery: async () => false
  });
  const tools = createPrivateInboxTools({ bridge, store, enabled });
  const adapter = createPrivateCoreAuthTransport({ tools, activate });
  return { db, store, bridge, tools, adapter, contexts, seen };
}
const kinds = SQLITE_AVAILABLE ? ["memory", "sqlite"] : ["memory"];
const mine = { plane: "chat", kind: "connection" };
const home = { plane: "chat", kind: "home" };
const MSG = "msg_aaaaaaaa";

// ---------------------------------------------------------------------------------------------
// Absent when off / fail closed (no store needed)
// ---------------------------------------------------------------------------------------------

test("off means ABSENT: nothing is listed, handled or reachable, for every endpoint, even with enabled tools injected", async () => {
  for (const activate of [undefined, false, 0, 1, "true", "yes", null, {}]) {
    let called = 0;
    const tools = { enabled: true, definitions: PRIVATE_INBOX_TOOL_DEFINITIONS, call: async () => { called += 1; return {}; } };
    const adapter = createPrivateCoreAuthTransport({ tools, activate });
    assert.equal(adapter.active, false);
    for (const path of [PATH, "/mcp", "/mcp/core", undefined]) {
      assert.deepEqual([...adapter.listTools({ endpointPath: path })], []);
      assert.equal(adapter.handlesTool("private_inbox_get", { endpointPath: path }), false);
      for (const name of PRIVATE_INBOX_TOOL_NAMES) {
        assert.equal(await adapter.handleRpc(call(name, {}), { endpointPath: path, headers: bearer("csat_one") }), null);
      }
      const listing = await host(adapter, path, { jsonrpc: "2.0", id: 7, method: "tools/list" });
      assert.deepEqual(listing.result.tools.map(t => t.name), ["cairnstone_health"]);
    }
    assert.equal(called, 0, "tools.call never reached while inactive");
  }
  // A private name is exactly as unknown as any other unregistered name (no 'disabled' tell).
  const adapter = createPrivateCoreAuthTransport({});
  const a = frame(await host(adapter, PATH, call("private_inbox_get", {}), bearer("csat_one")));
  const b = frame(await host(adapter, PATH, call("totally_unknown_tool", {}), bearer("csat_one")));
  assert.deepEqual(a, b);
  assert.equal(a.error, "tool_not_in_core_profile");
  assert.equal(createPrivateCoreAuthTransport().active, false);
});

test("activation fails closed without real, enabled, interface-identical tools", () => {
  const good = { enabled: true, definitions: PRIVATE_INBOX_TOOL_DEFINITIONS, call: async () => ({}) };
  assert.equal(createPrivateCoreAuthTransport({ tools: good, activate: true }).active, true);
  const code = fn => { try { fn(); return null; } catch (e) { return e instanceof PrivateRealmError ? e.code : `RAW:${e.message}`; } };
  assert.equal(code(() => createPrivateCoreAuthTransport({ activate: true })), "private_transport_bindings_required");
  assert.equal(code(() => createPrivateCoreAuthTransport({ tools: {}, activate: true })), "private_transport_bindings_required");
  assert.equal(code(() => createPrivateCoreAuthTransport({ tools: { ...good, call: "x" }, activate: true })), "private_transport_bindings_required");
  assert.equal(code(() => createPrivateCoreAuthTransport({ tools: { ...good, enabled: false }, activate: true })), "private_transport_tools_not_enabled");
  assert.equal(code(() => createPrivateCoreAuthTransport({ tools: { ...good, enabled: "true" }, activate: true })), "private_transport_tools_not_enabled");
  assert.equal(code(() => createPrivateCoreAuthTransport({ tools: { ...good, definitions: PRIVATE_INBOX_TOOL_DEFINITIONS.slice(1) }, activate: true })), "private_transport_interface_mismatch");
  const loosened = PRIVATE_INBOX_TOOL_DEFINITIONS.map(d => ({ ...d, inputSchema: { ...d.inputSchema, additionalProperties: true } }));
  assert.equal(code(() => createPrivateCoreAuthTransport({ tools: { ...good, definitions: loosened }, activate: true })), "private_transport_interface_mismatch");
  // Default-off S1-2 tools (enabled:false) cannot be activated through the transport.
  const off = createPrivateInboxTools({ bridge: { authorizeHome() {} }, store: createInMemoryHomeStore() });
  assert.equal(code(() => createPrivateCoreAuthTransport({ tools: off, activate: true })), "private_transport_tools_not_enabled");
});

test("tools exist ONLY on the exact /mcp/core-auth path: /mcp, /mcp/core and every path variant get nothing", async () => {
  let called = 0;
  const tools = { enabled: true, definitions: PRIVATE_INBOX_TOOL_DEFINITIONS, call: async () => { called += 1; return {}; } };
  const adapter = createPrivateCoreAuthTransport({ tools, activate: true });
  assert.equal(adapter.listTools({ endpointPath: PATH }).length, 5);
  for (const path of ["/mcp", "/mcp/core", "/mcp-b", "/mcp/core-auth/", "/MCP/CORE-AUTH", "/mcp/core-auth?x=1", "//mcp/core-auth", " /mcp/core-auth", "", undefined, null, 5]) {
    assert.deepEqual([...adapter.listTools({ endpointPath: path })], [], String(path));
    assert.equal(adapter.handlesTool("private_inbox_get", { endpointPath: path }), false, String(path));
    assert.equal(await adapter.handleRpc(call("private_inbox_get", {}), { endpointPath: path, headers: bearer("csat_one") }), null, String(path));
  }
  assert.deepEqual([...adapter.listTools()], []);
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------------------------
// Interface parity and effect classes
// ---------------------------------------------------------------------------------------------

test("descriptors are exact-parity with the S1-2 definitions and every tool has a distinct effect class", () => {
  assert.deepEqual(PRIVATE_INBOX_MCP_DESCRIPTORS.map(d => d.name), [...PRIVATE_INBOX_TOOL_NAMES]);
  assert.deepEqual(Object.keys(PRIVATE_INBOX_TOOL_EFFECTS).sort(), [...PRIVATE_INBOX_TOOL_NAMES].sort());
  for (const [i, d] of PRIVATE_INBOX_MCP_DESCRIPTORS.entries()) {
    assert.equal(JSON.stringify(d.inputSchema), JSON.stringify(PRIVATE_INBOX_TOOL_DEFINITIONS[i].inputSchema));
    assert.equal(d.description, PRIVATE_INBOX_TOOL_DEFINITIONS[i].description);
    assert.equal(d.inputSchema.additionalProperties, false);
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.annotations) && Object.isFrozen(d._meta));
  }
  const by = Object.fromEntries(PRIVATE_INBOX_MCP_DESCRIPTORS.map(d => [d.name, d]));
  for (const name of ["private_inbox_get", "private_inbox_list"]) {
    assert.equal(by[name]._meta["cairnstone/effect"], "metadata_read");
    assert.equal(by[name].annotations.readOnlyHint, true);
  }
  assert.equal(by.private_inbox_read._meta["cairnstone/effect"], "body_read");
  assert.equal(by.private_inbox_read.annotations.readOnlyHint, false, "a body read stamps read state, so it is not read-only");
  for (const name of ["private_inbox_send", "private_inbox_ack"]) {
    assert.equal(by[name]._meta["cairnstone/effect"], "mutation");
    assert.equal(by[name].annotations.readOnlyHint, false);
  }
  const text = JSON.stringify(PRIVATE_INBOX_MCP_DESCRIPTORS);
  for (const word of ["access_token", "inbox_id", "home_id", "account_id", "connection_id", "actor", "tenant_id", "authorization"]) assert.ok(!text.includes(`"${word}"`), word);
});

// ---------------------------------------------------------------------------------------------
// Bearer handling (transport only)
// ---------------------------------------------------------------------------------------------

test("bearerFromHeaders accepts exactly one well-formed Bearer csat_ credential from the Authorization header", () => {
  assert.equal(bearerFromHeaders({ authorization: "Bearer csat_abc123" }), "csat_abc123");
  assert.equal(bearerFromHeaders({ Authorization: "Bearer csat_abc123" }), "csat_abc123");
  assert.equal(bearerFromHeaders(new Headers({ Authorization: "Bearer csat_abc123" })), "csat_abc123");
  for (const bad of [
    undefined, null, "", "csat_abc", {}, { authorization: "" }, { authorization: "Bearer" }, { authorization: "Bearer " },
    { authorization: "bearer csat_abc" }, { authorization: "Basic csat_abc" }, { authorization: "Bearer notcsat_abc" },
    { authorization: "Bearer csat_a csat_b" }, { authorization: "Bearer csat_a\nX: y" }, { authorization: ["Bearer csat_a"] },
    { authorization: `Bearer csat_${"a".repeat(3000)}` }, { authorization: "Bearer csat_a", Authorization: "Bearer csat_b" },
    { "x-authorization": "Bearer csat_abc" }, { cookie: "Bearer csat_abc" }
  ]) assert.equal(bearerFromHeaders(bad), null, JSON.stringify(bad));
});

test("without a valid transport bearer no tool is invoked; a token in the body, params, _meta or arguments is never used", async () => {
  const seen = [];
  const tools = { enabled: true, definitions: PRIVATE_INBOX_TOOL_DEFINITIONS, call: async (token, name, args) => { seen.push([token, name, args]); return { ok: 1 }; } };
  const adapter = createPrivateCoreAuthTransport({ tools, activate: true });
  const opts = headers => ({ endpointPath: PATH, headers });
  const smuggled = {
    ...call("private_inbox_get", {}), access_token: "csat_one", authorization: "Bearer csat_one",
    params: { name: "private_inbox_get", arguments: {}, _meta: { authorization: "Bearer csat_one", access_token: "csat_one" }, access_token: "csat_one" }
  };
  for (const headers of [undefined, {}, { authorization: "Bearer nope" }, { authorization: "Basic csat_one" }]) {
    const out = frame(await adapter.handleRpc(smuggled, opts(headers)));
    assert.deepEqual(out, { ok: false, error: "scope_not_authorized" });
  }
  assert.equal(seen.length, 0);
  await adapter.handleRpc(smuggled, opts(bearer("csat_two")));
  assert.deepEqual(seen.map(s => s[0]), ["csat_two"], "identity is the header bearer only");
  assert.deepEqual(seen[0][2], {}, "arguments are passed through unmodified; no token merged in");
});

// ---------------------------------------------------------------------------------------------
// End-to-end through the real bridge + store (memory and real SQLite)
// ---------------------------------------------------------------------------------------------

for (const kind of kinds) {
  test(`[${kind}] tools/list on core-auth adds exactly the five private tools; legacy listing is untouched elsewhere`, async () => {
    const { adapter } = make(kind);
    const onAuth = await host(adapter, PATH, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(onAuth.result.tools.map(t => t.name), ["cairnstone_health", ...PRIVATE_INBOX_TOOL_NAMES]);
    for (const path of ["/mcp", "/mcp/core"]) {
      const other = await host(adapter, path, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      assert.deepEqual(other.result.tools.map(t => t.name), ["cairnstone_health"]);
      const denied = frame(await host(adapter, path, call("private_inbox_get", {}), bearer("csat_one")));
      assert.equal(denied.error, "tool_not_in_core_profile");
    }
    // Legacy traffic and non-private methods fall straight through with the same results as an inactive adapter.
    const inactive = createPrivateCoreAuthTransport({});
    for (const rpc of [call("cairnstone_health", {}), { jsonrpc: "2.0", id: 3, method: "ping" }, { jsonrpc: "2.0", id: 4, method: "resources/list" }]) {
      assert.deepEqual(await host(adapter, PATH, rpc, bearer("csat_one")), await host(inactive, PATH, rpc, bearer("csat_one")));
    }
  });

  test(`[${kind}] full round trip through the transport; effects reported; replay idempotent; conflict refused`, async () => {
    const { adapter, bridge } = make(kind);
    await bridge.onboard("csat_one");
    const run = (name, args) => host(adapter, PATH, call(name, args), bearer("csat_one"));
    const got = frame(await run("private_inbox_get", {}));
    assert.equal(got.ok, true); assert.equal(got.effect, "metadata_read"); assert.equal(got.result.role, "admin");
    const sent = frame(await run("private_inbox_send", { from_inbox: mine, to_inboxes: [mine, home], message_id: MSG, body: SECRET }));
    assert.equal(sent.ok, true); assert.equal(sent.effect, "mutation"); assert.equal(sent.result.created, true);
    assert.equal(frame(await run("private_inbox_send", { from_inbox: mine, to_inboxes: [home, mine], message_id: MSG, body: SECRET })).result.created, false);
    const conflict = frame(await run("private_inbox_send", { from_inbox: mine, to_inboxes: [mine], message_id: MSG, body: "different" }));
    assert.deepEqual(conflict, { ok: false, error: "capability_denied" });
    const listed = await run("private_inbox_list", { inbox: mine });
    assert.equal(listed.result.isError, false);
    assert.equal(frame(listed).effect, "metadata_read");
    assert.ok(!JSON.stringify(listed).includes(SECRET), "list is metadata only: no body");
    assert.equal(frame(listed).result.messages[0].read_at, null);
    const read = frame(await run("private_inbox_read", { inbox: mine }));
    assert.equal(read.effect, "body_read");
    assert.equal(read.result.messages[0].body, SECRET);
    assert.ok(read.result.messages[0].read_at);
    const ack = frame(await run("private_inbox_ack", { inbox: mine, message_id: MSG }));
    assert.equal(ack.effect, "mutation"); assert.equal(ack.result.changed, true);
    assert.equal(frame(await run("private_inbox_ack", { inbox: mine, message_id: MSG })).result.changed, false);
    assert.equal((await run("private_inbox_ack", { inbox: mine, message_id: "msg_missing1" })).result.isError, true);
  });

  test(`[${kind}] grant and revoke: a member needs an explicit grant for the Home inbox and loses it on revoke`, async () => {
    const { adapter, bridge, store } = make(kind);
    const adminHome = await bridge.onboard("csat_one");
    await bridge.onboard("csat_two");
    const homeInboxId = Object.values(adminHome.inboxes.chat).find(i => i.scope === "home").inbox_id;
    const asTwo = (name, args) => host(adapter, PATH, call(name, args), bearer("csat_two"));
    const asOne = (name, args) => host(adapter, PATH, call(name, args), bearer("csat_one"));
    await asOne("private_inbox_send", { from_inbox: home, to_inboxes: [home], message_id: MSG, body: SECRET });
    assert.deepEqual(frame(await asTwo("private_inbox_read", { inbox: home })), { ok: false, error: "capability_denied" });
    await store.grantInbox(one, { inboxId: homeInboxId, targetConnectionId: two.connection_id, caps: { read: true } }, { homeId: adminHome.home_id });
    assert.equal(frame(await asTwo("private_inbox_read", { inbox: home })).result.messages[0].body, SECRET);
    assert.equal(frame(await asTwo("private_inbox_send", { from_inbox: mine, to_inboxes: [home], message_id: "msg_bbbbbbbb", body: "x" })).error, "capability_denied", "read grant does not allow send");
    await store.revokeGrant(one, { inboxId: homeInboxId, targetConnectionId: two.connection_id }, { homeId: adminHome.home_id });
    assert.deepEqual(frame(await asTwo("private_inbox_read", { inbox: home })), { ok: false, error: "capability_denied" });
  });

  test(`[${kind}] isolation: sibling-private and separate-tenant callers never see another caller's inbox or bodies`, async () => {
    const { adapter, bridge } = make(kind);
    await bridge.onboard("csat_one"); await bridge.onboard("csat_two"); await bridge.onboard("csat_eve");
    await host(adapter, PATH, call("private_inbox_send", { from_inbox: mine, to_inboxes: [mine], message_id: MSG, body: SECRET }), bearer("csat_one"));
    await host(adapter, PATH, call("private_inbox_send", { from_inbox: home, to_inboxes: [home], message_id: "msg_cccccccc", body: SECRET }), bearer("csat_one"));
    const frames = [];
    for (const token of ["csat_two", "csat_eve"]) {
      for (const inbox of [mine, home]) {
        for (const name of ["private_inbox_list", "private_inbox_read"]) frames.push(await host(adapter, PATH, call(name, { inbox }), bearer(token)));
      }
    }
    assert.ok(!JSON.stringify(frames).includes(SECRET), "no other caller ever receives the body");
    assert.equal(frame(frames[0]).result.messages.length, 0);
  });

  test(`[${kind}] token audience/realm, stale and revoked accounts are denied; wrong resource never reaches the store`, async () => {
    const { adapter, bridge, contexts, seen, store } = make(kind);
    await bridge.onboard("csat_one"); await bridge.onboard("csat_two");
    const run = token => host(adapter, PATH, call("private_inbox_get", {}), bearer(token));
    const denied = async token => assert.deepEqual(frame(await run(token)), { ok: false, error: "scope_not_authorized" });
    assert.equal(frame(await run("csat_one")).ok, true);
    assert.ok(seen.resources.every(r => r === RESOURCE), "verifier is always asked for the exact core-auth resource");
    await denied("csat_unknown");
    contexts.csat_two = ctx(two, { resource: "https://cairnstone.example/mcp/core" }); await denied("csat_two");
    contexts.csat_two = ctx(two, { resource: "https://cairnstone.example/mcp" }); await denied("csat_two");
    contexts.csat_two = ctx(two, { realm: "legacy" }); await denied("csat_two");
    contexts.csat_two = ctx(two, { schema: "other" }); await denied("csat_two");
    contexts.csat_two = ctx(two, { scopes: ["mcp:other"] }); await denied("csat_two");
    contexts.csat_two = ctx(two, { account_status: "suspended" }); await denied("csat_two");
    contexts.csat_two = ctx(two, { connection_status: "revoked" }); await denied("csat_two");
    contexts.csat_two = ctx(two, { token_family_status: "revoked" }); await denied("csat_two");
    contexts.csat_two = ctx(two);
    assert.equal(frame(await run("csat_two")).ok, true);
    await store.revokeConnection(one, two.connection_id);
    assert.ok(["scope_not_authorized", "capability_denied"].includes(frame(await run("csat_two")).error));
  });

  test(`[${kind}] no automatic first-use onboarding: an unprovisioned caller is denied and nothing is created`, async () => {
    const { adapter, store, db } = make(kind);
    for (const name of PRIVATE_INBOX_TOOL_NAMES) {
      const args = name === "private_inbox_get" ? {} : name === "private_inbox_send"
        ? { from_inbox: mine, to_inboxes: [mine], message_id: MSG, body: "x" } : name === "private_inbox_ack" ? { inbox: mine, message_id: MSG } : { inbox: mine };
      assert.deepEqual(frame(await host(adapter, PATH, call(name, args), bearer("csat_one"))), { ok: false, error: "scope_not_authorized" });
    }
    if (db) { assert.equal(db.count("priv_homes"), 0); assert.equal(db.count("priv_messages"), 0); }
    else { assert.equal(store.__inspect().homes.length, 0); }
  });

  test(`[${kind}] bypass attempts: forged selectors/identities, name tricks, malformed envelopes and unknown methods`, async () => {
    const { adapter, bridge } = make(kind);
    await bridge.onboard("csat_one");
    const run = (name, args) => host(adapter, PATH, call(name, args), bearer("csat_one"));
    for (const extra of [{ inbox_id: "ibx_abcdef12" }, { home_id: "home_12345678" }, { account_id: "acct_x" }, { connection_id: two.connection_id },
      { actor: "claude:cairnstone-v6" }, { role: "admin" }, { access_token: "csat_two" }, { token: "csat_two" }, { authorization: "Bearer csat_two" }, { capabilities: { read: true } }]) {
      assert.deepEqual(frame(await run("private_inbox_read", { inbox: mine, ...extra })), { ok: false, error: "caller_selectors_forbidden" });
    }
    assert.equal(frame(await run("private_inbox_read", { inbox: mine, surprise: 1 })).error, "invalid_arguments");
    // Name tricks are simply not ours: they fall through to the host's unknown-tool denial.
    for (const name of ["PRIVATE_INBOX_GET", "Private_Inbox_Get", " private_inbox_get", "private_inbox_get ", "private_inbox_get\u0000", "private_inbox_get.", "private-inbox-get",
      "private_inbox_", "__proto__", "constructor", "toString", "hasOwnProperty", "private_inbox_get/../x"]) {
      assert.equal(await adapter.handleRpc(call(name, {}), { endpointPath: PATH, headers: bearer("csat_one") }), null, JSON.stringify(name));
      assert.equal(adapter.handlesTool(name, { endpointPath: PATH }), false);
    }
    for (const name of [undefined, null, 5, {}, [], ["private_inbox_get"]]) {
      assert.equal(await adapter.handleRpc(call(name, {}), { endpointPath: PATH, headers: bearer("csat_one") }), null);
    }
    // Unknown / non-tool methods are never handled, even when they carry a private tool name.
    for (const method of ["initialize", "ping", "tools/list", "resources/read", "prompts/get", "private_inbox_get", "tools/call ", "TOOLS/CALL", undefined, null, 5]) {
      assert.equal(await adapter.handleRpc({ jsonrpc: "2.0", id: 1, method, params: { name: "private_inbox_get", arguments: {} } }, { endpointPath: PATH, headers: bearer("csat_one") }), null);
    }
    for (const rpc of [null, undefined, "x", 5, [], [call("private_inbox_get", {})], { method: "tools/call" }, { method: "tools/call", params: null }, { method: "tools/call", params: [] }]) {
      assert.equal(await adapter.handleRpc(rpc, { endpointPath: PATH, headers: bearer("csat_one") }), null);
    }
    // Malformed envelopes for a private tool are JSON-RPC errors, never executed.
    const bad = (rpc, code) => adapter.handleRpc(rpc, { endpointPath: PATH, headers: bearer("csat_one") }).then(r => { assert.equal(r.error.code, code); });
    await bad({ ...call("private_inbox_get", {}), jsonrpc: "1.0" }, -32600);
    await bad({ ...call("private_inbox_get", {}), id: { x: 1 } }, -32600);
    await bad({ ...call("private_inbox_get", {}), id: [1] }, -32600);
    await bad(call("private_inbox_get", []), -32602);
    await bad(call("private_inbox_get", "x"), -32602);
    await bad(call("private_inbox_get", 5), -32602);
    // Omitted arguments behave as {} (get takes none).
    const noArgs = await adapter.handleRpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "private_inbox_get" } }, { endpointPath: PATH, headers: bearer("csat_one") });
    assert.equal(frame(noArgs).ok, true);
    assert.equal(noArgs.id, 9);
  });
}

// ---------------------------------------------------------------------------------------------
// Error normalisation, body-leak isolation, dormancy
// ---------------------------------------------------------------------------------------------

test("errors are normalised twice: raw errors and detail never reach the frame", async () => {
  const mk = thrower => createPrivateCoreAuthTransport({ tools: { enabled: true, definitions: PRIVATE_INBOX_TOOL_DEFINITIONS, call: async () => { throw thrower(); } }, activate: true });
  const run = adapter => adapter.handleRpc(call("private_inbox_read", { inbox: mine }), { endpointPath: PATH, headers: bearer("csat_one") });
  const raw = await run(mk(() => new Error(`D1_ERROR priv_homes /internal/path ${SECRET}`)));
  assert.deepEqual(frame(raw), { ok: false, error: "private_tool_failed" });
  const detailed = await run(mk(() => new PrivateRealmError("capability_denied", { inbox: "ibx_secret", home: "home_secret", body: SECRET })));
  assert.deepEqual(frame(detailed), { ok: false, error: "capability_denied" });
  const weird = await run(mk(() => Object.assign(new PrivateRealmError("x"), { code: "Not A Code!" })));
  assert.deepEqual(frame(weird), { ok: false, error: "private_tool_failed" });
  const stringThrown = await run(mk(() => "boom"));
  assert.deepEqual(frame(stringThrown), { ok: false, error: "private_tool_failed" });
  for (const out of [raw, detailed, weird, stringThrown]) {
    const text = JSON.stringify(out);
    for (const leak of [SECRET, "priv_homes", "/internal", "ibx_secret", "home_secret", "D1_ERROR", "boom"]) assert.ok(!text.includes(leak), leak);
    assert.equal(out.result.isError, true);
  }
});

test("the transport module is dormant and boundary-only: not imported by production, no bindings, no onboarding, no network", () => {
  for (const file of ["src/index.js", "src/worker.js", "src/core-auth.js"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/private-core-auth-transport|createPrivateCoreAuthTransport|private-inbox-tools|private_inbox_/.test(source), file);
  }
  const code = readFileSync(new URL("../src/private-realm/private-core-auth-transport.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.deepEqual([...code.matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]), ["./scope.js", "./private-inbox-tools.js"]);
  assert.doesNotMatch(code, /\bonboard\b|ensureDefaultHome|createInbox|\benv\b|\bfetch\b|\bconsole\b|process\.|Math\.random|resolveHome|inboxDerivationKey/);
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /CAIRNSTONE_PRIVATE|private_storage|PRIVATE_INBOX|ACTIVATE/i, "no binding or activation switch in config");
});
