// S1-1: real Core-auth-shaped contexts through a trusted verifier into both
// SQLite-backed D1 and S0b's in-memory adapter. No private bindings or network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createIdentityHomeBridge } from "../src/private-realm/identity-home-bridge.js";
import { PrivateRealmError, createInMemoryHomeStore } from "../src/private-realm/index.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { SQLITE_AVAILABLE, createClock, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";

const RESOURCE = "https://cairnstone.example/mcp/core-auth";
const KEY = "test-only-inbox-derivation-secret-32-chars-min";
const a = sc("alice", "chatgpt");
const g = sc("alice", "grok");
const a2 = sc("alice", "chatgpt2");
const b = sc("bobby", "chatgpt");
const b2 = sc("bobby", "chatgpt2");
const token = new Map();
function ctx(scope, overrides = {}) {
  return {
    schema: "cairnstone-core-auth-context-v1", realm: "core-auth",
    account_id: scope.account_id, tenant_id: scope.tenant_id,
    principal_id: scope.principal_id, connection_id: scope.connection_id,
    client_family: scope.provider_label, resource: RESOURCE,
    account_status: "active", connection_status: "active", token_family_status: "active",
    token_family_id: "tfam_test1234", scopes: ["mcp:core"],
    ...overrides
  };
}
for (const [key, scope] of [["csat_alice", a], ["csat_grok", g], ["csat_alice2", a2], ["csat_bobby", b], ["csat_bobby2", b2]]) token.set(key, ctx(scope));

function fixture({ sqlite = false, admitted = true, verifier } = {}) {
  const db = sqlite ? createSqliteD1() : null;
  const store = sqlite
    ? createD1HomeStore({ db, now: createClock(), mintId: createMint() })
    : createInMemoryHomeStore({ testHooks: true, now: createClock(), mintId: createMint() });
  const bridge = createIdentityHomeBridge({
    validateToken: verifier || (async key => ({ ok: token.has(key), context: token.get(key) })),
    store, expectedResource: RESOURCE, inboxDerivationKey: KEY,
    admitOnboarding: async () => admitted
  });
  return { bridge, db, store };
}
const denies = (promise, code) => assert.rejects(promise, e =>
  e instanceof PrivateRealmError && e.code === code, `expected ${code}`);

test("S1-1 is dormant: default admission denies even valid Core-auth token", async () => {
  const store = createInMemoryHomeStore({ testHooks: true });
  const bridge = createIdentityHomeBridge({
    store, expectedResource: RESOURCE, inboxDerivationKey: KEY,
    validateToken: async t => ({ ok: token.has(t), context: token.get(t) })
  });
  await denies(bridge.onboard("csat_alice"), "onboarding_not_admitted");
  assert.equal(store.__inspect().homes.length, 0);
});

test("first trusted connection creates exactly one account-owned Home, with separated chat/work private and Home inboxes", async () => {
  const { bridge, store } = fixture();
  const first = await bridge.onboard("csat_alice");
  assert.equal(first.created, true);
  assert.equal(first.role, "admin");
  assert.equal(store.__inspect().homes.length, 1);
  assert.equal((await store.listInboxes(a)).length, 4);
  for (const plane of ["chat", "work"]) {
    for (const kind of ["home", "connection"]) {
      const box = first.inboxes[plane][kind];
      assert.match(box.inbox_id, /^ibx_[a-f0-9]{32}$/);
      assert.equal(box.address, "inbox:" + box.inbox_id);
      assert.deepEqual(box.capabilities, { read: true, send: true, ack: true });
    }
  }
  assert.notEqual(first.inboxes.chat.home.inbox_id, first.inboxes.work.home.inbox_id);
  assert.notEqual(first.inboxes.chat.connection.inbox_id, first.inboxes.work.connection.inbox_id);
});

test("second provider joins same Home without inherited content grants and cannot read any sibling private inbox", async () => {
  const { bridge, store } = fixture();
  const alice = await bridge.onboard("csat_alice");
  const grok = await bridge.onboard("csat_grok");
  assert.equal(grok.home_id, alice.home_id);
  assert.equal(grok.role, "member");
  assert.equal(grok.connection_attached, true);
  assert.equal(store.__inspect().homes.length, 1);
  for (const plane of ["chat", "work"]) {
    assert.equal(grok.inboxes[plane].home.inbox_id, alice.inboxes[plane].home.inbox_id);
    assert.deepEqual(grok.inboxes[plane].home.capabilities, { read: false, send: false, ack: false });
    assert.deepEqual(grok.inboxes[plane].connection.capabilities, { read: true, send: true, ack: true });
    assert.notEqual(grok.inboxes[plane].connection.inbox_id, alice.inboxes[plane].connection.inbox_id);
    for (const cap of ["read", "send", "ack"]) assert.equal(await store.can(g, alice.inboxes[plane].connection.inbox_id, cap), false);
  }
  assert.equal((await store.listInboxes(g)).length, 2);
  await denies(store.grantInbox(a, {
    inboxId: alice.inboxes.chat.connection.inbox_id, targetConnectionId: g.connection_id, caps: { read: true }
  }), "capability_denied");
});

test("same provider with two accounts gets disjoint Homes and cannot cross-read", async () => {
  const { bridge, store } = fixture();
  const alice = await bridge.onboard("csat_alice");
  const bob = await bridge.onboard("csat_bobby");
  assert.notEqual(alice.home_id, bob.home_id);
  assert.notEqual(alice.inboxes.chat.home.inbox_id, bob.inboxes.chat.home.inbox_id);
  assert.equal(await store.can(b, alice.inboxes.chat.connection.inbox_id, "read"), false);
  assert.equal(store.__inspect().homes.length, 2);
});

test("same provider with two accounts in one tenant still cannot reuse Home or connection", async () => {
  const { bridge, store } = fixture();
  const alice = await bridge.onboard("csat_alice");
  token.set("csat_same_tenant_bob", ctx(b, { tenant_id: a.tenant_id }));
  try {
    const bob = await bridge.onboard("csat_same_tenant_bob");
    assert.notEqual(alice.home_id, bob.home_id);
    await denies(store.ensureDefaultHome({ ...b, account_id: a.account_id, tenant_id: b.tenant_id }), "scope_not_authorized");
  } finally {
    token.delete("csat_same_tenant_bob");
  }
});

test("repeated bootstrap preserves stable addresses, roles, and explicit grant revocations", async () => {
  const { bridge, store } = fixture();
  const alice = await bridge.onboard("csat_alice");
  const again = await bridge.onboard("csat_alice");
  assert.equal(again.created, false);
  assert.equal(again.home_id, alice.home_id);
  assert.deepEqual(again.inboxes, alice.inboxes);
  await store.revokeGrant(a, { inboxId: alice.inboxes.chat.home.inbox_id, targetConnectionId: a.connection_id });
  const rerun = await bridge.onboard("csat_alice");
  assert.deepEqual(rerun.inboxes.chat.home.capabilities, { read: false, send: false, ack: false });
  assert.deepEqual(rerun.inboxes.work.home.capabilities, { read: true, send: true, ack: true });
});

test("no id or ownership authority is taken from request selectors, actors or caller-supplied identity", async () => {
  const { bridge, store } = fixture();
  await bridge.onboard("csat_alice");
  for (const extra of [
    { account_id: b.account_id }, { tenant_id: b.tenant_id },
    { principal_id: b.principal_id }, { connection_id: b.connection_id },
    { home_id: "home_intruder0001" }, { inbox_id: "ibx_intruder0001" },
    { actor_id: "chatgpt:chat" }, { from: "chatgpt:chat" }, { selector: {} },
    {}
  ]) await denies(bridge.onboard("csat_alice", extra), "caller_selectors_forbidden");
  await denies(bridge.inspect("csat_alice", { home_id: "home_fake0001" }), "caller_selectors_forbidden");
  assert.equal(store.__inspect().homes.length, 1);
});

test("malformed and forged Core-auth contexts fail closed before any Home creation", async () => {
  const { store } = fixture();
  const bad = [
    { realm: "messages" }, { schema: "other" }, { resource: "https://evil.invalid/mcp/core-auth" },
    { account_status: "suspended" }, { connection_status: "revoked" },
    { token_family_status: "revoked" }, { scopes: ["messages.read"] },
    { principal_id: "chatgpt:chat" }, { account_id: b.account_id, connection_id: "chatgpt:chat" },
    { token_family_id: "bad" }, { tenant_id: null }, { connection_id: null }
  ];
  for (const change of bad) {
    const bridge = createIdentityHomeBridge({
      store, expectedResource: RESOURCE, inboxDerivationKey: KEY, admitOnboarding: async () => true,
      validateToken: async () => ({ ok: true, context: ctx(a, change) })
    });
    await denies(bridge.onboard("csat_forgery"), "scope_not_authorized");
  }
  assert.equal(store.__inspect().homes.length, 0);
});

test("unverified, foreign, malformed or wrong-audience bearer is never an identity", async () => {
  const { bridge } = fixture();
  for (const t of ["", "bearer", "jwt.a.b", "csat_nonexistent", null]) {
    await denies(bridge.onboard(t), "scope_not_authorized");
  }
  assert.throws(() => createIdentityHomeBridge({ expectedResource: "/mcp-b" }), /core_auth_resource_required/);
});

test("revoked connection cannot reattach, read, or inherit grants from a still-active Home", async () => {
  const { bridge, store } = fixture();
  await bridge.onboard("csat_alice");
  await bridge.onboard("csat_grok");
  await store.revokeConnection(a, g.connection_id);
  await denies(bridge.onboard("csat_grok"), "scope_not_authorized");
  await denies(bridge.inspect("csat_grok"), "scope_not_authorized");
  assert.equal(store.__inspect().homes.length, 1);
});

test("the last admin remains protected; admin role cannot magically grant connection-private access", { skip: !SQLITE_AVAILABLE }, async () => {
  const { bridge, store } = fixture({ sqlite: true });
  const alice = await bridge.onboard("csat_alice");
  const grok = await bridge.onboard("csat_grok");
  await denies(store.revokeConnection(a, a.connection_id), "capability_denied");
  await store.setConnectionRole(a, g.connection_id, "admin");
  assert.equal(await store.can(g, alice.inboxes.chat.connection.inbox_id, "read"), false);
  await store.revokeConnection(a, a.connection_id);
  await denies(bridge.onboard("csat_alice"), "scope_not_authorized");
  assert.equal((await bridge.onboard("csat_grok")).role, "admin");
  assert.equal(grok.home_id, alice.home_id);
});

test("an explicit Home grant is needed before a second provider may see shared messages", async () => {
  const { bridge, store } = fixture();
  const alice = await bridge.onboard("csat_alice");
  await bridge.onboard("csat_grok");
  const shared = alice.inboxes.work.home.inbox_id;
  assert.equal(await store.can(g, shared, "read"), false);
  await store.grantInbox(a, { inboxId: shared, targetConnectionId: g.connection_id, caps: { read: true } });
  const grok = await bridge.onboard("csat_grok");
  assert.deepEqual(grok.inboxes.work.home.capabilities, { read: true, send: false, ack: false });
});

test("two simultaneous calls produce one Home and a bounded stable inbox set", async () => {
  const { bridge, store } = fixture();
  const all = await Promise.all(Array.from({ length: 12 }, () => bridge.onboard("csat_alice")));
  assert.equal(new Set(all.map(x => x.home_id)).size, 1);
  assert.equal(store.__inspect().homes.length, 1);
  assert.equal((await store.listInboxes(a)).length, 4);
});

test("revalidates token immediately before mutation and detects identity substitution", async () => {
  let checks = 0;
  const fx = fixture({ verifier: async () => ({
    ok: true, context: ctx(checks++ === 0 ? a : b)
  }) });
  await denies(fx.bridge.onboard("csat_alice"), "scope_not_authorized");
  assert.equal(fx.store.__inspect().homes.length, 0);
});

test("private realm never imports legacy public storage paths or exposes private bodies to shared objects", async () => {
  const source = readFileSync(new URL("../src/private-realm/identity-home-bridge.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /env\.CAIRNSTONE_DB|env\.CAIRNSTONE_R2|cairnstone_create_stone|cairnstone_find_v2|cairnstone_send_message/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bwrangler\b|\/mcp-b/);
});

for (const [name, sqlite] of [["real SQLite D1 migration", true]]) {
  test(`${name}: first two distinct providers attach to ONE Home with isolated private inboxes`,
    { skip: sqlite && !SQLITE_AVAILABLE }, async () => {
      const { bridge, db } = fixture({ sqlite });
      const alice = await bridge.onboard("csat_alice");
      const grok = await bridge.onboard("csat_grok");
      assert.equal(alice.home_id, grok.home_id);
      assert.equal(db.count("priv_homes"), 1);
      assert.equal(db.count("priv_home_connections"), 2);
      assert.equal(db.count("priv_inboxes"), 6);
      assert.equal(db.count("priv_inbox_grants"), 6);
      assert.deepEqual(grok.inboxes.work.home.capabilities, { read: false, send: false, ack: false });
    });

  test(`${name}: concurrent first-use creates exactly one Home with deterministic inbox IDs`,
    { skip: sqlite && !SQLITE_AVAILABLE }, async () => {
      const { bridge, db } = fixture({ sqlite });
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => bridge.onboard("csat_alice")));
      const failures = attempts.filter(x => x.status === "rejected");
      assert.deepEqual(failures.map(x => x.reason?.code || x.reason?.message), []);
      assert.equal(new Set(attempts.map(x => x.value.home_id)).size, 1);
      assert.equal(db.count("priv_homes"), 1);
      assert.equal(db.count("priv_inboxes"), 4);
    });

  test(`${name}: tenant substitution and revoked-connection replay are rejected`,
    { skip: sqlite && !SQLITE_AVAILABLE }, async () => {
      const { bridge, store, db } = fixture({ sqlite });
      await bridge.onboard("csat_alice");
      await bridge.onboard("csat_grok");
      await store.revokeConnection(a, g.connection_id);
      await denies(bridge.onboard("csat_grok"), "scope_not_authorized");
      token.set("csat_tenant_forbidden", ctx(a, { tenant_id: b.tenant_id, connection_id: g.connection_id }));
      try { await denies(bridge.onboard("csat_tenant_forbidden"), "scope_not_authorized"); }
      finally { token.delete("csat_tenant_forbidden"); }
      assert.equal(db.count("priv_homes"), 1);
    });
}
