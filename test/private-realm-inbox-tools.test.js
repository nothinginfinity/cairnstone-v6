// S1-2 dormant private inbox tools. Runs on BOTH the in-memory store and real-SQLite D1 (when node:sqlite exists).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIdentityHomeBridge } from "../src/private-realm/identity-home-bridge.js";
import { PrivateRealmError, createInMemoryHomeStore } from "../src/private-realm/index.js";
import {
  PRIVATE_INBOX_TOOL_DEFINITIONS, PRIVATE_INBOX_TOOL_NAMES, createPrivateInboxTools
} from "../src/private-realm/private-inbox-tools.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { SQLITE_AVAILABLE, createClock, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";

const RESOURCE = "https://cairnstone.example/mcp/core-auth";
const KEY = "test-only-inbox-derivation-secret-32-chars-min";
const one = sc("alice", "one");
const two = sc("alice", "two");
const eve = sc("mallory", "evil");

const ctx = (scope, o = {}) => ({
  schema: "cairnstone-core-auth-context-v1", realm: "core-auth",
  account_id: scope.account_id, tenant_id: scope.tenant_id, principal_id: scope.principal_id, connection_id: scope.connection_id,
  client_family: scope.provider_label, resource: RESOURCE, authenticator_assurance: "passkey",
  account_status: "active", connection_status: "active", token_family_status: "active",
  token_family_id: "tfam_test1234", authz_version: 1, scopes: ["mcp:core"], ...o
});
const codeOf = p => p.then(() => null, e => (e instanceof PrivateRealmError ? e.code : `RAW:${e && e.message}`));

function make(kind, { enabled = true } = {}) {
  const db = kind === "sqlite" ? createSqliteD1() : null;
  const store = db
    ? createD1HomeStore({ db, now: createClock(), mintId: createMint() })
    : createInMemoryHomeStore({ testHooks: true, now: createClock(), mintId: createMint() });
  const contexts = { csat_one: ctx(one), csat_two: ctx(two), csat_eve: ctx(eve) };
  const calls = { validate: 0 };
  const bridge = createIdentityHomeBridge({
    store, expectedResource: RESOURCE, inboxDerivationKey: KEY,
    validateToken: async token => { calls.validate += 1; return { ok: token in contexts, context: structuredClone(contexts[token]) }; },
    admitOnboarding: async () => true, admitAdminRecovery: async () => false
  });
  const tools = createPrivateInboxTools({ bridge, store, enabled });
  return { db, store, bridge, tools, contexts, calls };
}
const kinds = SQLITE_AVAILABLE ? ["memory", "sqlite"] : ["memory"];
const mine = { plane: "chat", kind: "connection" };
const home = { plane: "chat", kind: "home" };
const MSG = "msg_aaaaaaaa";

for (const kind of kinds) {
  test(`[${kind}] tools are default-off: every call is refused before any authentication or store access`, async () => {
    const { tools, calls } = make(kind, { enabled: false });
    for (const name of PRIVATE_INBOX_TOOL_NAMES) assert.equal(await codeOf(tools.call("csat_one", name, {})), "private_tools_disabled");
    assert.equal(calls.validate, 0);
    assert.equal(tools.enabled, false);
  });

  test(`[${kind}] get shows own addresses and store-decided capabilities; admin role alone grants no member access`, async () => {
    const { tools, bridge } = make(kind);
    await bridge.onboard("csat_one");
    await bridge.onboard("csat_two");
    const a = await tools.call("csat_one", "private_inbox_get");
    assert.equal(a.role, "admin");
    assert.deepEqual(a.inboxes.chat.home.capabilities, { read: true, send: true, ack: true });
    assert.deepEqual(a.inboxes.chat.connection.capabilities, { read: true, send: true, ack: true });
    const b = await tools.call("csat_two", "private_inbox_get");
    assert.equal(b.role, "member");
    assert.deepEqual(b.inboxes.chat.home.capabilities, { read: false, send: false, ack: false });
    assert.deepEqual(b.inboxes.work.connection.capabilities, { read: true, send: true, ack: true });
    assert.notEqual(a.inboxes.chat.connection.address, b.inboxes.chat.connection.address);
  });

  test(`[${kind}] send/list/read/ack round trip inside the caller's own inboxes; replay is idempotent, conflict is refused`, async () => {
    const { tools, bridge } = make(kind);
    await bridge.onboard("csat_one");
    const sent = await tools.call("csat_one", "private_inbox_send", { from_inbox: mine, to_inboxes: [mine, home], message_id: MSG, body: "hello" });
    assert.equal(sent.created, true);
    const replay = await tools.call("csat_one", "private_inbox_send", { from_inbox: mine, to_inboxes: [home, mine], message_id: MSG, body: "hello" });
    assert.equal(replay.created, false);
    assert.equal(await codeOf(tools.call("csat_one", "private_inbox_send", { from_inbox: mine, to_inboxes: [mine], message_id: MSG, body: "different" })), "capability_denied");
    const listed = await tools.call("csat_one", "private_inbox_list", { inbox: mine });
    assert.equal(listed.messages.length, 1);
    assert.equal(listed.messages[0].read_at, null);
    assert.ok(!("body" in listed.messages[0]));
    assert.deepEqual({ ...listed.messages[0].sender }, mine);
    const read = await tools.call("csat_one", "private_inbox_read", { inbox: mine, limit: 10 });
    assert.equal(read.messages[0].body, "hello");
    assert.ok(read.messages[0].read_at);
    const ack = await tools.call("csat_one", "private_inbox_ack", { inbox: mine, message_id: MSG });
    assert.equal(ack.changed, true);
    assert.equal((await tools.call("csat_one", "private_inbox_ack", { inbox: mine, message_id: MSG })).changed, false);
    assert.equal(await codeOf(tools.call("csat_one", "private_inbox_ack", { inbox: mine, message_id: "msg_missing1" })), "capability_denied");
  });

  test(`[${kind}] a member without an explicit grant cannot read, send to, or ack the Home inbox`, async () => {
    const { tools, bridge } = make(kind);
    await bridge.onboard("csat_one");
    await bridge.onboard("csat_two");
    await tools.call("csat_one", "private_inbox_send", { from_inbox: home, to_inboxes: [home], message_id: MSG, body: "home only" });
    assert.equal(await codeOf(tools.call("csat_two", "private_inbox_read", { inbox: home })), "capability_denied");
    assert.equal(await codeOf(tools.call("csat_two", "private_inbox_list", { inbox: home })), "capability_denied");
    assert.equal(await codeOf(tools.call("csat_two", "private_inbox_send", { from_inbox: mine, to_inboxes: [home], message_id: "msg_bbbbbbbb", body: "x" })), "capability_denied");
    assert.equal(await codeOf(tools.call("csat_two", "private_inbox_ack", { inbox: home, message_id: MSG })), "capability_denied");
  });

  test(`[${kind}] sibling-private isolation: another connection (even an admin) only ever reaches its own private inbox`, async () => {
    const { tools, bridge } = make(kind);
    await bridge.onboard("csat_one");
    await bridge.onboard("csat_two");
    await tools.call("csat_one", "private_inbox_send", { from_inbox: mine, to_inboxes: [mine], message_id: MSG, body: "one private" });
    const seenByTwo = await tools.call("csat_two", "private_inbox_read", { inbox: mine });
    assert.equal(seenByTwo.messages.length, 0);
    assert.equal((await tools.call("csat_one", "private_inbox_read", { inbox: mine })).messages.length, 1);
  });

  test(`[${kind}] tenant isolation: a different account has its own Home and cannot see this one's data`, async () => {
    const { tools, bridge } = make(kind);
    await bridge.onboard("csat_one");
    await bridge.onboard("csat_eve");
    await tools.call("csat_one", "private_inbox_send", { from_inbox: home, to_inboxes: [home], message_id: MSG, body: "alice home" });
    assert.equal((await tools.call("csat_eve", "private_inbox_read", { inbox: home })).messages.length, 0);
  });

  test(`[${kind}] unauthenticated, unknown, unprovisioned and revoked callers are denied with one stable code`, async () => {
    const { tools, bridge, store, contexts, calls } = make(kind);
    assert.equal(await codeOf(tools.call("csat_one", "private_inbox_get")), "scope_not_authorized"); // not onboarded: no provisioning
    await bridge.onboard("csat_one");
    await bridge.onboard("csat_two");
    for (const bad of [undefined, null, 5, "", "nope", "csat_unknown"]) {
      assert.equal(await codeOf(tools.call(bad, "private_inbox_get")), "scope_not_authorized");
    }
    contexts.csat_two = ctx(two, { connection_status: "revoked" });
    assert.equal(await codeOf(tools.call("csat_two", "private_inbox_get")), "scope_not_authorized");
    contexts.csat_two = ctx(two);
    await store.revokeConnection(one, two.connection_id);
    assert.ok(["scope_not_authorized", "capability_denied"].includes(await codeOf(tools.call("csat_two", "private_inbox_get"))));
    assert.ok(calls.validate > 0);
  });

  test(`[${kind}] caller-supplied selectors, identities and credentials are rejected, never ignored`, async () => {
    const { tools, bridge } = make(kind);
    await bridge.onboard("csat_one");
    const forged = [
      { inbox: mine, inbox_id: "ibx_abcdef12" }, { inbox: mine, home_id: "home_12345678" },
      { inbox: mine, account_id: "acct_bob" }, { inbox: mine, connection_id: two.connection_id },
      { inbox: mine, actor: "claude:cairnstone-v6" }, { inbox: mine, role: "admin" },
      { inbox: mine, access_token: "csat_two" }, { inbox: mine, capabilities: { read: true } }
    ];
    for (const args of forged) assert.equal(await codeOf(tools.call("csat_one", "private_inbox_read", args)), "caller_selectors_forbidden");
    assert.equal(await codeOf(tools.call("csat_one", "private_inbox_get", { home_id: "home_12345678" })), "caller_selectors_forbidden");
    assert.equal(await codeOf(tools.call("csat_one", "private_inbox_send", { from_inbox: mine, to_inboxes: [mine], message_id: MSG, body: "x", from: "x" })), "caller_selectors_forbidden");
    assert.equal(await codeOf(tools.call("csat_one", "private_inbox_read", { inbox: { ...mine, connection_id: two.connection_id } })), "caller_selectors_forbidden");
    assert.equal(await codeOf(tools.call("csat_one", "private_inbox_read", { inbox: mine, surprise: 1 })), "invalid_arguments");
  });

  test(`[${kind}] strict argument validation fails closed with no store write`, async () => {
    const { tools, bridge, store, db } = make(kind);
    await bridge.onboard("csat_one");
    const sent = o => tools.call("csat_one", "private_inbox_send", { from_inbox: mine, to_inboxes: [mine], message_id: MSG, body: "ok", ...o });
    const bad = [
      [() => tools.call("csat_one", "private_inbox_read", "x"), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_read", []), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_read", {}), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_read", { inbox: { plane: "mail", kind: "home" } }), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_read", { inbox: { plane: "chat", kind: "agent_identity" } }), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_read", { inbox: mine, limit: 0 }), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_read", { inbox: mine, limit: 201 }), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_read", { inbox: mine, limit: 1.5 }), "invalid_arguments"],
      [() => sent({ to_inboxes: [] }), "invalid_arguments"],
      [() => sent({ to_inboxes: Array.from({ length: 21 }, () => mine) }), "invalid_arguments"],
      [() => sent({ to_inboxes: "chat" }), "invalid_arguments"],
      [() => sent({ message_id: "short" }), "invalid_arguments"],
      [() => sent({ message_id: "has space in it" }), "invalid_arguments"],
      [() => sent({ thread_id: "bad thread!" }), "invalid_arguments"],
      [() => sent({ body: "" }), "invalid_arguments"],
      [() => sent({ body: "x".repeat(65537) }), "invalid_arguments"],
      [() => sent({ body: 5 }), "invalid_arguments"],
      [() => tools.call("csat_one", "private_inbox_ack", { inbox: mine, message_id: "x" }), "invalid_arguments"],
      [() => tools.call("csat_one", "no_such_tool", {}), "unknown_private_tool"],
      [() => tools.call("csat_one", "__proto__", {}), "unknown_private_tool"]
    ];
    for (const [run, expected] of bad) assert.equal(await codeOf(run()), expected);
    const { messages } = await tools.call("csat_one", "private_inbox_list", { inbox: mine });
    assert.equal(messages.length, 0);
    if (db) assert.equal(db.count("priv_messages"), 0); else assert.equal(store.__inspect().homes[0].messages.length, 0);
  });

  test(`[${kind}] failures are normalised: raw errors and error detail never cross the boundary`, async () => {
    const { tools, bridge, store } = make(kind);
    await bridge.onboard("csat_one");
    const original = store.listInbox;
    const leaky = createPrivateInboxTools({
      bridge, enabled: true,
      store: { ...Object.fromEntries(["listInboxes", "can", "send", "readInbox", "ack"].map(m => [m, store[m].bind(store)])),
        listInbox: async () => { throw new Error("D1_ERROR: secret table priv_homes at /internal/path"); } }
    });
    assert.equal(await codeOf(leaky.call("csat_one", "private_inbox_list", { inbox: mine })), "private_tool_failed");
    const detailed = createPrivateInboxTools({
      bridge, enabled: true,
      store: { ...Object.fromEntries(["listInboxes", "can", "send", "readInbox", "ack"].map(m => [m, store[m].bind(store)])),
        listInbox: async () => { throw new PrivateRealmError("capability_denied", { inbox: "ibx_secret", home: "home_secret" }); } }
    });
    const err = await detailed.call("csat_one", "private_inbox_list", { inbox: mine }).catch(e => e);
    assert.equal(err.code, "capability_denied");
    assert.equal(err.detail, undefined);
    assert.equal(typeof original, "function");
  });
}

test("tool definitions are strict, selector-free and never take a token", () => {
  assert.deepEqual(PRIVATE_INBOX_TOOL_DEFINITIONS.map(d => d.name), [...PRIVATE_INBOX_TOOL_NAMES]);
  const text = JSON.stringify(PRIVATE_INBOX_TOOL_DEFINITIONS);
  for (const word of ["access_token", "inbox_id", "home_id", "account_id", "connection_id", "actor", "tenant_id"]) assert.ok(!text.includes(`"${word}"`), word);
  for (const d of PRIVATE_INBOX_TOOL_DEFINITIONS) assert.equal(d.inputSchema.additionalProperties, false);
});

test("constructor fails closed without the bridge seam or store methods", () => {
  assert.throws(() => createPrivateInboxTools({ store: createInMemoryHomeStore() }), { code: "private_inbox_bridge_required" });
  assert.throws(() => createPrivateInboxTools({ bridge: { authorizeHome() {} }, store: {} }), { code: "private_home_store_required" });
  assert.equal(createPrivateInboxTools({ bridge: { authorizeHome() {} }, store: createInMemoryHomeStore() }).enabled, false);
});

test("dormant: no production entrypoint imports or registers the private inbox tools", () => {
  for (const file of ["src/index.js", "src/worker.js", "src/core-auth.js"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/private-inbox-tools|private_inbox_/.test(source), file);
  }
});
