// S0b-1 private-realm store tests. In-memory fake only: no binding, no migration, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CAPABILITIES,
  HOME_STORE_BOUNDARY,
  PrivateRealmError,
  STORE_METHODS,
  assertHomeScope,
  assertSelector,
  createInMemoryHomeStore,
  resolveHomeStore
} from "../src/private-realm/index.js";
import { isPrivateRealmActor } from "../src/realm-guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const SECRET = "PRIVATE-BODY-SENTINEL-7f3a";

const chatgpt = { account_id: "acct_alice", tenant_id: "ten_alice", principal_id: "prin_alice_chatgpt", connection_id: "conn_alice_chatgpt", provider_label: "chatgpt" };
const grok = { account_id: "acct_alice", tenant_id: "ten_alice", principal_id: "prin_alice_grok", connection_id: "conn_alice_grok", provider_label: "grok" };
const chatgpt2 = { account_id: "acct_alice", tenant_id: "ten_alice", principal_id: "prin_alice_chatgpt2", connection_id: "conn_alice_chatgpt2", provider_label: "chatgpt" };
const bob = { account_id: "acct_bobby", tenant_id: "ten_bobby", principal_id: "prin_bobby_chatgpt", connection_id: "conn_bobby_chatgpt", provider_label: "chatgpt" };

function makeStore() {
  let tick = 0;
  return createInMemoryHomeStore({ testHooks: true, now: () => `2026-10-10T00:00:${String(tick++).padStart(2, "0")}.000Z` });
}

async function aliceHome(store) {
  const created = await store.ensureDefaultHome(chatgpt);
  await store.ensureDefaultHome(grok);
  return created.home_id;
}

const rejectsWith = (fn, code) => assert.rejects(fn, error => error instanceof PrivateRealmError && error.code === code);

// ---------------------------------------------------------------------------------------------
// HomeScope
// ---------------------------------------------------------------------------------------------

test("HomeScope rejects legacy actors, malformed ids and carried selectors", () => {
  assert.throws(() => assertHomeScope(null), /home_scope_required/);
  assert.throws(() => assertHomeScope([]), /home_scope_required/);
  assert.throws(() => assertHomeScope({ ...chatgpt, account_id: "chatgpt:chat" }), /invalid_account_id/);
  assert.throws(() => assertHomeScope({ ...chatgpt, principal_id: "claude:cairnstone-v6" }), /invalid_principal_id/);
  assert.throws(() => assertHomeScope({ ...chatgpt, connection_id: "agent:claude:jared" }), /invalid_connection_id/);
  assert.throws(() => assertHomeScope({ ...chatgpt, tenant_id: undefined }), /invalid_tenant_id/);
  assert.throws(() => assertHomeScope({ ...chatgpt, home_role: "root" }), /invalid_home_role/);
  assert.throws(() => assertHomeScope({ ...chatgpt, home_id: "home_attacker0001" }), /scope_must_not_carry_selectors/);
  assert.throws(() => assertHomeScope({ ...chatgpt, inbox_id: "ibx_attacker0001" }), /scope_must_not_carry_selectors/);
  const ok = assertHomeScope(chatgpt);
  assert.ok(Object.isFrozen(ok));
  assert.equal(ok.home_role, "member");
});

test("selectors are validated and never authority", () => {
  assert.equal(assertSelector(undefined).homeId, null);
  assert.throws(() => assertSelector({ homeId: "acct_alice" }), /invalid_selector/);
  assert.throws(() => assertSelector("home_x"), /invalid_selector/);
});

// ---------------------------------------------------------------------------------------------
// Idempotent Home creation
// ---------------------------------------------------------------------------------------------

test("ensureDefaultHome is idempotent per connection and per account", async () => {
  const store = makeStore();
  const a = await store.ensureDefaultHome(chatgpt);
  const b = await store.ensureDefaultHome(chatgpt);
  assert.equal(a.created, true);
  assert.equal(a.connection_attached, true);
  assert.equal(a.role, "admin");
  assert.equal(b.created, false);
  assert.equal(b.connection_attached, false);
  assert.equal(a.home_id, b.home_id);
  const g = await store.ensureDefaultHome(grok);
  assert.equal(g.home_id, a.home_id);
  assert.equal(g.created, false);
  assert.equal(g.connection_attached, true);
  assert.equal(g.role, "member");
});

test("concurrent ensureDefaultHome yields exactly one Home per account", async () => {
  const store = makeStore();
  const results = await Promise.all(Array.from({ length: 25 }, () => store.ensureDefaultHome(chatgpt)));
  assert.equal(new Set(results.map(r => r.home_id)).size, 1);
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(store.__inspect().homes.length, 1);
});

test("different accounts get different Homes even with the same provider label", async () => {
  const store = makeStore();
  const a = await store.ensureDefaultHome(chatgpt);
  const b = await store.ensureDefaultHome(bob);
  assert.notEqual(a.home_id, b.home_id);
});

test("same account under a different tenant fails closed instead of minting a second Home", async () => {
  const store = makeStore();
  await store.ensureDefaultHome(chatgpt);
  await rejectsWith(() => store.ensureDefaultHome({ ...grok, tenant_id: "ten_other" }), "scope_not_authorized");
  assert.equal(store.__inspect().homes.length, 1);
  assert.ok(store.__inspect().audit.some(a => a.reason === "account_tenant_mismatch"));
});

test("a connection id cannot be claimed by another account or principal", async () => {
  const store = makeStore();
  await store.ensureDefaultHome(chatgpt);
  await rejectsWith(() => store.ensureDefaultHome({ ...bob, connection_id: chatgpt.connection_id }), "scope_not_authorized");
  await rejectsWith(() => store.ensureDefaultHome({ ...chatgpt, principal_id: "prin_someone_else" }), "scope_not_authorized");
  await rejectsWith(() => store.ensureDefaultHome({ ...grok, principal_id: chatgpt.principal_id }), "scope_not_authorized");
});

// ---------------------------------------------------------------------------------------------
// Connection-private sibling denial
// ---------------------------------------------------------------------------------------------

test("connection-private inbox is unreachable by a sibling in the same Home, for every capability", async () => {
  const store = makeStore();
  const home_id = await aliceHome(store);
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "connection", plane: "chat" });
  for (const cap of CAPABILITIES) {
    assert.equal(await store.can(chatgpt, inbox_id, cap), true, `owner ${cap}`);
    assert.equal(await store.can(grok, inbox_id, cap), false, `sibling ${cap}`);
  }
  // Even the Home admin cannot grant or revoke on it, and the sibling cannot discover it.
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true } }), "capability_denied");
  await rejectsWith(() => store.revokeGrant(chatgpt, { inboxId: inbox_id, targetConnectionId: chatgpt.connection_id }), "capability_denied");
  assert.deepEqual((await store.listInboxes(grok)).map(i => i.inbox_id), []);
  assert.deepEqual((await store.listInboxes(chatgpt)).map(i => i.inbox_id), [inbox_id]);
  const reasons = store.__inspect().audit.map(a => a.reason);
  assert.ok(reasons.includes("connection_private_sibling_denied"));
  assert.ok(home_id);
});

test("an admin sibling still cannot read a connection-private inbox it does not own", async () => {
  const store = makeStore();
  await store.ensureDefaultHome(chatgpt);
  await store.ensureDefaultHome(grok);
  await store.setConnectionRole(chatgpt, grok.connection_id, "admin");
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "connection" });
  assert.equal(await store.can(grok, inbox_id, "read"), false);
  await rejectsWith(() => store.grantInbox(grok, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true } }), "capability_denied");
});

test("only the owner connection may create connection-scope inboxes, with itself as owner", async () => {
  const store = makeStore();
  await aliceHome(store);
  const mine = await store.createInbox(grok, { scope: "connection", label: "grok private" });
  const dump = store.__inspect().homes[0].inboxes.find(i => i.inbox_id === mine.inbox_id);
  assert.equal(dump.owner_connection_id, grok.connection_id);
  assert.equal(await store.can(chatgpt, mine.inbox_id, "read"), false);
});

// ---------------------------------------------------------------------------------------------
// Home-owned inbox grants and escalation
// ---------------------------------------------------------------------------------------------

test("home-owned inboxes are admin-created and shared only by explicit grant", async () => {
  const store = makeStore();
  await aliceHome(store);
  await rejectsWith(() => store.createInbox(grok, { scope: "home", plane: "work" }), "capability_denied");
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "home", plane: "work", label: "shared work" });
  // Creating the inbox grants nobody anything, including its admin creator.
  assert.equal(await store.can(chatgpt, inbox_id, "read"), false);
  assert.equal(await store.can(grok, inbox_id, "read"), false);
  await store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true, send: true } });
  assert.equal(await store.can(grok, inbox_id, "read"), true);
  assert.equal(await store.can(grok, inbox_id, "send"), true);
  assert.equal(await store.can(grok, inbox_id, "ack"), false);
});

test("a member cannot grant itself access, revoke others, or promote itself", async () => {
  const store = makeStore();
  await aliceHome(store);
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "home" });
  await rejectsWith(() => store.grantInbox(grok, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true } }), "capability_denied");
  await rejectsWith(() => store.revokeConnection(grok, chatgpt.connection_id), "capability_denied");
  await rejectsWith(() => store.setConnectionRole(grok, grok.connection_id, "admin"), "capability_denied");
  await rejectsWith(() => store.revokeGrant(grok, { inboxId: inbox_id, targetConnectionId: chatgpt.connection_id }), "capability_denied");
  assert.equal(await store.can(grok, inbox_id, "read"), false);
});

test("a new connection requesting admin is downgraded while an active admin exists", async () => {
  const store = makeStore();
  await store.ensureDefaultHome(chatgpt);
  const joined = await store.ensureDefaultHome({ ...grok, home_role: "admin" });
  assert.equal(joined.role, "member");
  assert.ok(store.__inspect().audit.some(a => a.reason === "role_downgraded_to_member"));
});

test("capabilities are a closed whitelist: property-name tricks and unknown names deny", async () => {
  const store = makeStore();
  await aliceHome(store);
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true } });
  for (const cap of ["granted_at", "revoked_at", "constructor", "__proto__", "toString", "can_read", "READ", "", null, undefined, 1, {}, ["read"]]) {
    assert.equal(await store.can(grok, inbox_id, cap), false, `capability ${String(cap)}`);
  }
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { granted_at: true } }), "invalid_caps");
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: {} }), "invalid_caps");
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: false } }), "invalid_caps");
});

test("grants cannot target a connection outside the Home or a revoked connection", async () => {
  const store = makeStore();
  await aliceHome(store);
  await store.ensureDefaultHome(bob);
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "home" });
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: bob.connection_id, caps: { read: true } }), "capability_denied");
  await store.revokeConnection(chatgpt, grok.connection_id);
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true } }), "capability_denied");
});

// ---------------------------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------------------------

test("revoked connection fails effective auth everywhere even though its rows are retained", async () => {
  const store = makeStore();
  await aliceHome(store);
  const shared = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true, ack: true } });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: grok.connection_id, caps: { read: true, send: true, ack: true } });
  const priv = await store.createInbox(chatgpt, { scope: "connection" });
  assert.equal(await store.can(chatgpt, shared.inbox_id, "read"), true);
  await store.revokeConnection(grok, undefined); // Grok revokes itself
  assert.equal(await store.can(grok, shared.inbox_id, "read"), false);
  await rejectsWith(() => store.readInbox(grok, { inboxId: shared.inbox_id }), "scope_not_authorized");
  await rejectsWith(() => store.send(grok, { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-revoked-1", body: "x" }), "scope_not_authorized");
  await rejectsWith(() => store.createInbox(grok, { scope: "connection" }), "scope_not_authorized");
  const dump = store.__inspect().homes[0];
  assert.ok(dump.connections.find(c => c.connection_id === grok.connection_id && c.status === "revoked"));
  assert.ok(dump.grants.find(([k, g]) => k.endsWith(`|${grok.connection_id}`) && g.revoked_at));
  assert.equal(await store.can(chatgpt, priv.inbox_id, "read"), true);
});

test("revoking a connection does not remove the Home or other connections' access", async () => {
  const store = makeStore();
  const home_id = await aliceHome(store);
  const shared = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: grok.connection_id, caps: { read: true, send: true } });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true } });
  await store.send(chatgpt, { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-before-revoke", body: SECRET });
  await store.revokeConnection(chatgpt, undefined);
  assert.equal(await store.can(chatgpt, shared.inbox_id, "read"), false);
  assert.equal(await store.can(grok, shared.inbox_id, "read"), true);
  const read = await store.readInbox(grok, { inboxId: shared.inbox_id }, { homeId: home_id });
  assert.equal(read.length, 1);
  assert.equal(read[0].body, SECRET);
});

test("a revoked connection cannot be resurrected by re-attaching or re-ensuring it", async () => {
  const store = makeStore();
  await aliceHome(store);
  await store.revokeConnection(chatgpt, grok.connection_id);
  await rejectsWith(() => store.ensureDefaultHome(grok), "scope_not_authorized");
  assert.ok(store.__inspect().audit.some(a => a.reason === "connection_revoked"));
});

test("revoking one grant removes only that grant; revoking twice is a no-op", async () => {
  const store = makeStore();
  await aliceHome(store);
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true } });
  assert.equal((await store.revokeGrant(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id })).changed, true);
  assert.equal((await store.revokeGrant(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id })).changed, false);
  assert.equal(await store.can(grok, inbox_id, "read"), false);
  // A fresh grant after revocation works and is a new live grant.
  await store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: grok.connection_id, caps: { read: true } });
  assert.equal(await store.can(grok, inbox_id, "read"), true);
});

test("the last admin cannot be demoted; with no active admin a recovery-consent connection becomes admin", async () => {
  const store = makeStore();
  await aliceHome(store);
  await rejectsWith(() => store.setConnectionRole(chatgpt, chatgpt.connection_id, "member"), "capability_denied");
  await store.revokeConnection(chatgpt, undefined); // sole admin self-revokes
  assert.equal(await store.can(grok, "ibx_does_not_exist", "read"), false);
  const recovered = await store.ensureDefaultHome({ ...chatgpt2, home_role: "admin" });
  assert.equal(recovered.role, "admin");
  assert.equal(recovered.created, false);
});

// ---------------------------------------------------------------------------------------------
// Cross-Home isolation and selectors
// ---------------------------------------------------------------------------------------------

test("cross-Home access is denied for every operation and leaks no existence information", async () => {
  const store = makeStore();
  const alice = await store.ensureDefaultHome(chatgpt);
  const carol = await store.ensureDefaultHome(bob);
  const aliceInbox = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: aliceInbox.inbox_id, targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true, ack: true } });
  await store.send(chatgpt, { fromInboxId: aliceInbox.inbox_id, toInboxIds: [aliceInbox.inbox_id], messageId: "msg-alice-1", body: SECRET });

  assert.equal(await store.can(bob, aliceInbox.inbox_id, "read"), false);
  await rejectsWith(() => store.readInbox(bob, { inboxId: aliceInbox.inbox_id }), "capability_denied");
  await rejectsWith(() => store.listInbox(bob, { inboxId: aliceInbox.inbox_id }), "capability_denied");
  await rejectsWith(() => store.ack(bob, { inboxId: aliceInbox.inbox_id, messageId: "msg-alice-1" }), "capability_denied");
  await rejectsWith(() => store.grantInbox(bob, { inboxId: aliceInbox.inbox_id, targetConnectionId: bob.connection_id, caps: { read: true } }), "capability_denied");
  await rejectsWith(() => store.send(bob, { fromInboxId: aliceInbox.inbox_id, toInboxIds: [aliceInbox.inbox_id], messageId: "msg-bob-1", body: "intrude" }), "capability_denied");
  // Bob's own Home is untouched and sees nothing of Alice's.
  assert.deepEqual(await store.listInboxes(bob), []);
  assert.notEqual(alice.home_id, carol.home_id);
  const both = store.__inspect().homes;
  assert.equal(both.find(h => h.home_id === carol.home_id).messages.length, 0);
  // Denial for "no such inbox" and "someone else's inbox" is the same external code.
  await assert.rejects(() => store.readInbox(bob, { inboxId: "ibx_totally_missing" }), error => error.code === "capability_denied");
});

test("a foreign or forged home id selector never grants access", async () => {
  const store = makeStore();
  const alice = await store.ensureDefaultHome(chatgpt);
  const carol = await store.ensureDefaultHome(bob);
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "home" });
  await rejectsWith(() => store.createInbox(bob, { scope: "home" }, { homeId: alice.home_id }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes(chatgpt, { homeId: carol.home_id }), "scope_not_authorized");
  assert.equal(await store.can(chatgpt, inbox_id, "read", { homeId: carol.home_id }), false);
  const matching = await store.listInboxes(chatgpt, { homeId: alice.home_id });
  assert.deepEqual(matching.map(i => [i.inbox_id, i.granted]), [[inbox_id, false]]); // matching selector works; admin sees metadata only
  assert.ok(store.__inspect().audit.some(a => a.reason === "selector_mismatch"));
  await assert.rejects(() => store.listInboxes(chatgpt, { homeId: "not-a-home" }), /invalid_selector/);
});

test("unknown connection and unknown Home are clean denials, not crashes", async () => {
  const store = makeStore();
  await rejectsWith(() => store.createInbox(chatgpt, { scope: "connection" }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes(chatgpt), "scope_not_authorized");
  await rejectsWith(() => store.revokeConnection(chatgpt), "scope_not_authorized");
  assert.equal(await store.can(chatgpt, "ibx_whatever_1", "read"), false);
  await rejectsWith(() => store.listInboxes(chatgpt, { homeId: "home_0000000000000000" }), "scope_not_authorized");
});

test("a connection bound to one account cannot act with another account's identity", async () => {
  const store = makeStore();
  await store.ensureDefaultHome(chatgpt);
  await store.ensureDefaultHome(bob);
  await rejectsWith(() => store.listInboxes({ ...bob, connection_id: chatgpt.connection_id }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes({ ...chatgpt, account_id: "acct_bobby", tenant_id: "ten_bobby" }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes({ ...chatgpt, principal_id: grok.principal_id }), "scope_not_authorized");
});

// ---------------------------------------------------------------------------------------------
// Portability: the Home belongs to the user, not the provider
// ---------------------------------------------------------------------------------------------

test("portability: switching providers keeps one Home; Grok joins it with its own principal and no inherited access", async () => {
  const store = makeStore();
  const first = await store.ensureDefaultHome(chatgpt);
  const shared = await store.createInbox(chatgpt, { scope: "home", plane: "work", label: "portable context" });
  const priv = await store.createInbox(chatgpt, { scope: "connection", plane: "chat" });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true, ack: true } });
  await store.send(chatgpt, { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-portable-1", body: "portable note" });

  const joined = await store.ensureDefaultHome(grok);
  assert.equal(joined.home_id, first.home_id);
  assert.equal(joined.created, false);
  // Fresh connection: no grants, cannot see the portable inbox or the ChatGPT private one.
  assert.deepEqual(await store.listInboxes(grok), []);
  assert.equal(await store.can(grok, shared.inbox_id, "read"), false);
  assert.equal(await store.can(grok, priv.inbox_id, "read"), false);
  // Explicit owner-side grant makes the portable inbox available to Grok.
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: grok.connection_id, caps: { read: true, ack: true } });
  const read = await store.readInbox(grok, { inboxId: shared.inbox_id });
  assert.equal(read[0].body, "portable note");
  assert.equal(await store.can(grok, priv.inbox_id, "read"), false);
});

test("portability: revoking ChatGPT keeps the Home, Grok's access and the portable data; private ChatGPT data stays private", async () => {
  const store = makeStore();
  const first = await store.ensureDefaultHome(chatgpt);
  await store.ensureDefaultHome(grok);
  const shared = await store.createInbox(chatgpt, { scope: "home" });
  const priv = await store.createInbox(chatgpt, { scope: "connection" });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: grok.connection_id, caps: { read: true, send: true, ack: true } });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true, ack: true } });
  await store.send(chatgpt, { fromInboxId: priv.inbox_id, toInboxIds: [priv.inbox_id], messageId: "msg-chatgpt-private", body: "chatgpt only" });
  await store.send(chatgpt, { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-home-owned-1", body: "home owned" });

  await store.setConnectionRole(chatgpt, grok.connection_id, "admin"); // owner keeps Home administrable
  await store.revokeConnection(grok, chatgpt.connection_id);

  assert.equal(await store.can(chatgpt, shared.inbox_id, "read"), false);
  assert.equal((await store.ensureDefaultHome(grok)).home_id, first.home_id);
  const read = await store.readInbox(grok, { inboxId: shared.inbox_id });
  assert.deepEqual(read.map(m => m.body), ["home owned"]);
  assert.equal(await store.can(grok, priv.inbox_id, "read"), false);
  await rejectsWith(() => store.readInbox(grok, { inboxId: priv.inbox_id }), "capability_denied");
  // History is retained, not deleted.
  assert.equal(store.__inspect().homes[0].messages.length, 2);
});

test("portability: a second ChatGPT connection is a new principal and does not inherit the first one's private inbox", async () => {
  const store = makeStore();
  const first = await store.ensureDefaultHome(chatgpt);
  const priv = await store.createInbox(chatgpt, { scope: "connection" });
  await store.ensureDefaultHome(grok);
  await store.setConnectionRole(chatgpt, grok.connection_id, "admin");
  await store.revokeConnection(grok, chatgpt.connection_id);
  const second = await store.ensureDefaultHome(chatgpt2);
  assert.equal(second.home_id, first.home_id);
  assert.equal(second.role, "member");
  assert.equal(await store.can(chatgpt2, priv.inbox_id, "read"), false);
  assert.deepEqual(await store.listInboxes(chatgpt2), []);
});

// ---------------------------------------------------------------------------------------------
// Messages: privacy, immutability, forward-only delivery
// ---------------------------------------------------------------------------------------------

test("send/read/ack round trip with forward-only delivery state and metadata-only listing", async () => {
  const store = makeStore();
  await aliceHome(store);
  const shared = await store.createInbox(chatgpt, { scope: "home" });
  for (const target of [chatgpt, grok]) {
    await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: target.connection_id, caps: { read: true, send: true, ack: true } });
  }
  const sent = await store.send(grok, { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-roundtrip-1", threadId: "thread:alpha", body: SECRET });
  assert.equal(sent.created, true);
  const meta = await store.listInbox(chatgpt, { inboxId: shared.inbox_id });
  assert.equal(meta.length, 1);
  assert.equal("body" in meta[0], false);
  assert.equal(meta[0].read_at, null);
  assert.equal(JSON.stringify(meta).includes(SECRET), false);
  const read = await store.readInbox(chatgpt, { inboxId: shared.inbox_id });
  assert.equal(read[0].body, SECRET);
  const firstRead = read[0].read_at;
  assert.ok(firstRead);
  const again = await store.readInbox(chatgpt, { inboxId: shared.inbox_id });
  assert.equal(again[0].read_at, firstRead); // never moves
  const ack = await store.ack(chatgpt, { inboxId: shared.inbox_id, messageId: "msg-roundtrip-1" });
  assert.equal(ack.changed, true);
  assert.equal((await store.ack(chatgpt, { inboxId: shared.inbox_id, messageId: "msg-roundtrip-1" })).changed, false);
  const d = store.__inspect().homes[0].deliveries[0];
  assert.ok(d.delivered_at <= d.read_at && d.read_at <= d.acked_at);
});

test("send requires send on the sender inbox and every target inbox", async () => {
  const store = makeStore();
  await aliceHome(store);
  const a = await store.createInbox(chatgpt, { scope: "home" });
  const b = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: a.inbox_id, targetConnectionId: grok.connection_id, caps: { send: true } });
  await rejectsWith(() => store.send(grok, { fromInboxId: a.inbox_id, toInboxIds: [b.inbox_id], messageId: "msg-no-target-grant", body: "x" }), "capability_denied");
  await rejectsWith(() => store.send(grok, { fromInboxId: b.inbox_id, toInboxIds: [a.inbox_id], messageId: "msg-no-sender-grant", body: "x" }), "capability_denied");
  assert.equal(store.__inspect().homes[0].messages.length, 0);
});

test("send is idempotent per message id; a conflicting replay or foreign reuse is rejected", async () => {
  const store = makeStore();
  await aliceHome(store);
  const shared = await store.createInbox(chatgpt, { scope: "home" });
  for (const target of [chatgpt, grok]) {
    await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: target.connection_id, caps: { read: true, send: true } });
  }
  const msg = { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-idem-0001", body: "same" };
  assert.equal((await store.send(chatgpt, msg)).created, true);
  assert.equal((await store.send(chatgpt, msg)).created, false);
  await rejectsWith(() => store.send(chatgpt, { ...msg, body: "different" }), "capability_denied");
  await rejectsWith(() => store.send(grok, msg), "capability_denied");
  assert.equal(store.__inspect().homes[0].messages.length, 1);
  assert.equal((await store.readInbox(chatgpt, { inboxId: shared.inbox_id })).length, 1);
});

test("messages are immutable: callers cannot mutate stored state through returned objects", async () => {
  const store = makeStore();
  await aliceHome(store);
  const shared = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true } });
  await store.send(chatgpt, { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-immutable-1", body: "original" });
  const read = await store.readInbox(chatgpt, { inboxId: shared.inbox_id });
  assert.throws(() => { "use strict"; read[0].body = "tampered"; }, TypeError);
  assert.throws(() => { "use strict"; read.push({}); }, TypeError);
  const again = await store.readInbox(chatgpt, { inboxId: shared.inbox_id });
  assert.equal(again[0].body, "original");
  assert.ok(Object.isFrozen(store.__inspect().homes[0].messages[0]) === false); // inspect returns copies
});

test("private bodies never appear in audit rows, error messages, listings, or discovery", async () => {
  const store = makeStore();
  await aliceHome(store);
  await store.ensureDefaultHome(bob);
  const priv = await store.createInbox(chatgpt, { scope: "connection" });
  await store.send(chatgpt, { fromInboxId: priv.inbox_id, toInboxIds: [priv.inbox_id], messageId: "msg-secret-0001", body: SECRET });
  const probes = [
    () => store.readInbox(grok, { inboxId: priv.inbox_id }),
    () => store.readInbox(bob, { inboxId: priv.inbox_id }),
    () => store.listInbox(grok, { inboxId: priv.inbox_id }),
    () => store.send(grok, { fromInboxId: priv.inbox_id, toInboxIds: [priv.inbox_id], messageId: "msg-secret-0002", body: "probe" })
  ];
  for (const probe of probes) {
    await assert.rejects(probe, error => {
      assert.equal(JSON.stringify({ message: error.message, code: error.code, detail: error.detail }).includes(SECRET), false);
      return true;
    });
  }
  const dump = store.__inspect();
  assert.equal(JSON.stringify(dump.audit).includes(SECRET), false);
  assert.equal(JSON.stringify(await store.listInboxes(grok)).includes(SECRET), false);
  assert.equal(JSON.stringify(await store.listInboxes(bob)).includes(SECRET), false);
  assert.equal(JSON.stringify(await store.listInbox(chatgpt, { inboxId: priv.inbox_id })).includes(SECRET), false);
  assert.ok(dump.audit.every(a => Object.keys(a).sort().join() === "action,connection_id,created_at,home_id,outcome,principal_id,reason"));
});

test("input validation fails closed", async () => {
  const store = makeStore();
  await aliceHome(store);
  const shared = await store.createInbox(chatgpt, { scope: "home" });
  await store.grantInbox(chatgpt, { inboxId: shared.inbox_id, targetConnectionId: chatgpt.connection_id, caps: { send: true } });
  const base = { fromInboxId: shared.inbox_id, toInboxIds: [shared.inbox_id], messageId: "msg-validate-1", body: "ok" };
  await rejectsWith(() => store.send(chatgpt, { ...base, body: "" }), "invalid_body");
  await rejectsWith(() => store.send(chatgpt, { ...base, body: "x".repeat(65537) }), "invalid_body");
  await rejectsWith(() => store.send(chatgpt, { ...base, messageId: "bad id with spaces" }), "invalid_message_id");
  await rejectsWith(() => store.send(chatgpt, { ...base, toInboxIds: [] }), "invalid_recipients");
  await rejectsWith(() => store.send(chatgpt, { ...base, toInboxIds: "ibx_x" }), "invalid_recipients");
  await rejectsWith(() => store.createInbox(chatgpt, { scope: "provider" }), "invalid_inbox_scope");
  await rejectsWith(() => store.createInbox(chatgpt, { scope: "home", plane: "inferred-from-suffix" }), "invalid_plane");
  await rejectsWith(() => store.createInbox(chatgpt, { scope: "home", inboxId: "chatgpt:chat" }), "invalid_inbox_id");
  assert.equal(store.__inspect().homes[0].messages.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Legacy compatibility and dormancy
// ---------------------------------------------------------------------------------------------

test("legacy actors cannot become ownership, and every minted private id is reserved by the S0a guard", async () => {
  for (const legacy of ["chatgpt:chat", "chatgpt:cairnstone-v6", "claude:cairnstone-v6", "grok:cairnstone-v6", "agent:claude:jared"]) {
    assert.throws(() => assertHomeScope({ ...chatgpt, account_id: legacy }), /invalid_account_id/, legacy);
    assert.throws(() => assertHomeScope({ ...chatgpt, principal_id: legacy }), /invalid_principal_id/, legacy);
    assert.throws(() => assertHomeScope({ ...chatgpt, connection_id: legacy }), /invalid_connection_id/, legacy);
  }
  const store = makeStore();
  const { home_id } = await store.ensureDefaultHome(chatgpt);
  const { inbox_id } = await store.createInbox(chatgpt, { scope: "home" });
  for (const id of [home_id, inbox_id, chatgpt.connection_id, chatgpt.principal_id, chatgpt.account_id, chatgpt.tenant_id]) {
    assert.equal(isPrivateRealmActor(id), true, `${id} must be unreachable by name from the legacy surface`);
  }
  assert.equal(isPrivateRealmActor("chatgpt:chat"), false);
  assert.equal(isPrivateRealmActor("agent:claude:jared"), false);
});

test("resolveHomeStore is closed unless a test store is injected, even with real-looking bindings", () => {
  const env = { CAIRNSTONE_DB: {}, CAIRNSTONE_AUTH_DB: {}, CAIRNSTONE_R2: {}, CAIRNSTONE_PRIVATE_DB: {}, CAIRNSTONE_PRIVATE_R2: {} };
  assert.throws(() => resolveHomeStore(env), error => error instanceof PrivateRealmError && error.code === "private_home_store_not_bound");
  assert.throws(() => resolveHomeStore(undefined), /private_home_store_not_bound/);
  assert.throws(() => resolveHomeStore({ __PRIVATE_HOME_STORE_TEST__: "string" }), /private_home_store_not_bound/);
  const fake = createInMemoryHomeStore();
  assert.equal(resolveHomeStore({ __PRIVATE_HOME_STORE_TEST__: fake }), fake);
  assert.equal(fake.__inspect, undefined, "test hooks are absent unless requested");
});

test("the store module is dormant: no production import, binding, migration or legacy table reference", () => {
  const srcDir = path.join(root, "src", "private-realm");
  const files = readdirSync(srcDir).filter(f => f.endsWith(".js"));
  // S0b-1/S0b-2 modules, S1-1 bridge, S1-2 tools, S1-2b adapter, and S1-3 STAGING-ONLY private modules.
  // Any other file in this directory fails the isolation inventory gate.
  assert.deepEqual(files.sort(), [
    "boundary.js", "d1-store.js", "hash.js", "identity-home-bridge.js", "index.js", "private-core-auth-transport.js", "private-inbox-tools.js", "private-staging-core.js", "private-staging-worker.js", "private-worker-core.js", "private-worker.js", "r2-body.js", "scope.js", "store.js"
  ]);
  const S0B2 = new Set(["d1-store.js", "hash.js", "private-staging-core.js", "private-staging-worker.js", "private-worker-core.js", "private-worker.js", "r2-body.js"]);
  for (const file of files) {
    const text = readFileSync(path.join(srcDir, file), "utf8");
    const code = text.replace(/\/\/.*$/gm, "");
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]);
    // S1-1 may import ONLY Core-auth's verified-token validator from outside private-realm;
    // no raw legacy storage, public gateway or other auth/adapters may enter private storage.
    // The existing Worker glue may import its Cloudflare runtime base class.
    const allowed = i => i.startsWith("./") ||
      (["private-worker.js", "private-staging-worker.js"].includes(file) && i === "cloudflare:workers") ||
      (file === "identity-home-bridge.js" && i === "../core-auth.js");
    if (file === "identity-home-bridge.js") {
      assert.deepEqual(imports.filter(i => !i.startsWith("./")), ["../core-auth.js"]);
    }
    assert.ok(imports.every(allowed), `${file} imports only private-realm siblings: ${imports.join(",")}`);
    if (["private-worker-core.js", "private-staging-core.js"].includes(file)) {
      // The storage cores may name exactly the two PRIVATE bindings they are handed; never a shared one.
      const bindings = [...code.matchAll(/env\.(DB|CAIRNSTONE_\w+)/g)].map(m => m[1]);
      assert.deepEqual([...new Set(bindings)].sort(), ["CAIRNSTONE_PRIVATE_DB", "CAIRNSTONE_PRIVATE_R2"]);
    } else {
      assert.doesNotMatch(code, /env\.(DB|CAIRNSTONE_\w+)/, `${file} must not touch bindings`);
    }
    assert.doesNotMatch(code, /\b(correspondence_\w+|auth_\w+)\b/, `${file} must not name legacy or auth tables`);
    assert.doesNotMatch(code, /\b(from|join)\s+(stones|refs|chains|stone_edges)\b|\binsert\s+into\s+(stones|refs|chains|stone_edges)\b|\bupdate\s+(stones|refs|chains|stone_edges)\s+set\b/i, `${file} must not run SQL against shared stone tables`);
    assert.doesNotMatch(code, /Math\.random/, `${file} must not use weak randomness`);
    assert.doesNotMatch(code, /\bfetch\b|\bconsole\./, `${file} must not do network I/O or log`);
    assert.ok(S0B2.has(file) || !/priv_(homes|messages|deliveries|inboxes|audit|home_connections|inbox_grants)/.test(code) || file === "index.js", `${file}: only S0b-2 modules may name private tables`);
  }
  for (const entry of ["index.js", "worker.js"]) {
    assert.doesNotMatch(readFileSync(path.join(root, "src", entry), "utf8"), /private-realm\//, `src/${entry} must not import any private-realm module`);
  }
  const index = readFileSync(path.join(srcDir, "index.js"), "utf8");
  assert.doesNotMatch(index, /d1-store|r2-body|private-worker/, "the S0b-1 barrel does not export the S0b-2 adapters");
  const wrangler = readFileSync(path.join(root, "wrangler.toml"), "utf8");
  assert.doesNotMatch(wrangler, /CAIRNSTONE_PRIVATE|private_storage|priv_|migrations\/private/i, "no private binding or migration dir is declared");
  // Applied migration sets are the top-level .sql files of the configured dirs. The private candidate lives in
  // migrations/private/, which no wrangler [[d1_databases]] block points at.
  const applied = readdirSync(path.join(root, "migrations"), { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  assert.ok(applied.every(m => !/private|priv_|home/i.test(m)), "no private-realm migration exists in the applied set");
  assert.deepEqual(readdirSync(path.join(root, "migrations", "private")), ["0001_s0b2_private_realm.sql"]);
});

test("boundary plan: public gateway holds no private binding, storage Worker is internal-only, and the RPC surface equals the store interface", () => {
  const plan = HOME_STORE_BOUNDARY;
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.private_storage_worker.bindings));
  assert.equal(plan.status, "plan-only");
  assert.equal(plan.public_gateway.private_bindings, "none");
  assert.equal(plan.public_gateway.private_db, "absent");
  assert.equal(plan.public_gateway.private_r2, "absent");
  assert.equal(plan.private_storage_worker.public_url, false);
  assert.equal(plan.private_storage_worker.workers_dev, false);
  assert.equal(plan.private_storage_worker.custom_domain, false);
  assert.equal(plan.private_storage_worker.routes, "none");
  assert.deepEqual([...plan.private_storage_worker.bindings].sort(), ["CAIRNSTONE_PRIVATE_DB", "CAIRNSTONE_PRIVATE_R2"]);
  assert.ok(Object.values(plan.decision_state).every(v => v.startsWith("not-")));
  assert.deepEqual(plan.private_storage_worker.methods, [...STORE_METHODS]);
  const store = createInMemoryHomeStore();
  assert.deepEqual(Object.keys(store).sort(), [...STORE_METHODS].sort(), "plan, interface and fake cannot drift");
});

// ---------------------------------------------------------------------------------------------
// send() atomicity (PR #73 review): authorization, idempotency check and the message/delivery
// writes must form one synchronous commit. Any await between them lets a concurrent same-id
// send overwrite an immutable message, split deliveries, or outlive a revocation.
// ---------------------------------------------------------------------------------------------

async function raceFixture() {
  const store = makeStore();
  await aliceHome(store);
  const inboxes = [];
  for (let i = 0; i < 4; i += 1) {
    const { inbox_id } = await store.createInbox(chatgpt, { scope: "home", label: `race ${i}` });
    for (const target of [chatgpt, grok]) {
      await store.grantInbox(chatgpt, { inboxId: inbox_id, targetConnectionId: target.connection_id, caps: { read: true, send: true, ack: true } });
    }
    inboxes.push(inbox_id);
  }
  return { store, inboxes };
}

const homeState = store => store.__inspect().homes[0];

test("race: parallel IDENTICAL same-id sends commit exactly once, the rest are idempotent replays", async () => {
  const { store, inboxes } = await raceFixture();
  const msg = { fromInboxId: inboxes[0], toInboxIds: [inboxes[1], inboxes[2]], messageId: "msg-race-identical", body: SECRET };
  const results = await Promise.all(Array.from({ length: 12 }, () => store.send(chatgpt, msg)));
  assert.equal(results.filter(r => r.created === true).length, 1, "exactly one winner");
  assert.equal(results.filter(r => r.created === false).length, 11, "everyone else replays");
  const state = homeState(store);
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.deliveries.map(d => d.inbox_id).sort(), [inboxes[1], inboxes[2]].sort(), "no duplicate or missing deliveries");
  const audits = store.__inspect().audit.filter(a => a.action === "send");
  assert.equal(audits.filter(a => a.reason === "delivered").length, 1);
  assert.equal(audits.filter(a => a.reason === "idempotent_replay").length, 11);
});

test("race: parallel CONFLICTING same-id sends keep one immutable winner, no overwrite, no split deliveries", async () => {
  const { store, inboxes } = await raceFixture();
  const contenders = [0, 1, 2, 3, 4, 5].map(i => ({
    fromInboxId: inboxes[0],
    toInboxIds: [inboxes[1 + (i % 3)]], // each contender targets a different inbox
    messageId: "msg-race-conflict",
    body: `contender-${i}-${SECRET}`
  }));
  const settled = await Promise.allSettled(contenders.map(c => store.send(chatgpt, c)));
  const winners = settled.map((s, i) => [s, i]).filter(([s]) => s.status === "fulfilled" && s.value.created === true);
  assert.equal(winners.length, 1, "exactly one contender commits");
  const [, winnerIndex] = winners[0];
  for (const s of settled) {
    if (s.status === "rejected") assert.ok(s.reason instanceof PrivateRealmError && s.reason.code === "capability_denied");
  }
  assert.equal(settled.filter(s => s.status === "rejected").length, 5);
  const state = homeState(store);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].body_text, contenders[winnerIndex].body, "stored body is the winner's, never overwritten");
  assert.deepEqual(state.deliveries.map(d => d.inbox_id), contenders[winnerIndex].toInboxIds, "deliveries are exactly the winner's recipients");
  assert.ok(store.__inspect().audit.some(a => a.reason === "idempotency_conflict"));
});

test("race: the same message id sent in parallel by two different connections yields one winner", async () => {
  const { store, inboxes } = await raceFixture();
  const msg = { fromInboxId: inboxes[0], toInboxIds: [inboxes[1]], messageId: "msg-race-two-senders", body: "same content" };
  const settled = await Promise.allSettled([store.send(chatgpt, msg), store.send(grok, msg)]);
  assert.equal(settled.filter(s => s.status === "fulfilled" && s.value.created === true).length, 1);
  assert.equal(settled.filter(s => s.status === "rejected").length, 1);
  const state = homeState(store);
  assert.equal(state.messages.length, 1);
  assert.equal(state.deliveries.length, 1);
  const winnerConnection = settled[0].status === "fulfilled" ? chatgpt.connection_id : grok.connection_id;
  assert.equal(state.messages[0].sender_connection_id, winnerConnection);
});

test("race: revoking the sender connection while send() is in flight commits nothing", async () => {
  const { store, inboxes } = await raceFixture();
  const pending = store.send(grok, { fromInboxId: inboxes[0], toInboxIds: [inboxes[1]], messageId: "msg-revoke-during", body: SECRET });
  await store.revokeConnection(chatgpt, grok.connection_id); // lands while send is awaiting its digest
  await rejectsWith(() => pending, "scope_not_authorized");
  const state = homeState(store);
  assert.equal(state.messages.length, 0);
  assert.equal(state.deliveries.length, 0);
  const denied = store.__inspect().audit.filter(a => a.action === "send" && a.outcome === "deny");
  assert.ok(denied.some(a => a.reason === "connection_revoked"));
  assert.equal(store.__inspect().audit.some(a => a.action === "send" && a.outcome === "allow"), false);
});

test("race: revoking a target or sender grant while send() is in flight commits nothing", async () => {
  for (const which of ["target", "sender"]) {
    const { store, inboxes } = await raceFixture();
    const pending = store.send(grok, { fromInboxId: inboxes[0], toInboxIds: [inboxes[1]], messageId: `msg-grant-during-${which}`, body: SECRET });
    await store.revokeGrant(chatgpt, { inboxId: which === "target" ? inboxes[1] : inboxes[0], targetConnectionId: grok.connection_id });
    await rejectsWith(() => pending, "capability_denied");
    const state = homeState(store);
    assert.equal(state.messages.length, 0, `${which} grant revoked mid-send`);
    assert.equal(state.deliveries.length, 0, `${which} grant revoked mid-send`);
  }
});

test("race: an unrelated change while send() is in flight does not block a legitimately authorized send", async () => {
  const { store, inboxes } = await raceFixture();
  await store.ensureDefaultHome(chatgpt2);
  const pending = store.send(grok, { fromInboxId: inboxes[0], toInboxIds: [inboxes[1]], messageId: "msg-unrelated-change", body: "fine" });
  await store.revokeConnection(chatgpt, chatgpt2.connection_id);
  await store.revokeGrant(chatgpt, { inboxId: inboxes[2], targetConnectionId: grok.connection_id });
  assert.equal((await pending).created, true);
  assert.equal(homeState(store).deliveries.length, 1);
});

test("send(): the authoritative commit section contains no await, and it is the only place state is written", () => {
  const text = readFileSync(path.join(root, "src", "private-realm", "store.js"), "utf8");
  const begin = text.match(/COMMIT-SECTION-BEGIN/g) || [];
  const end = text.match(/COMMIT-SECTION-END/g) || [];
  assert.equal(begin.length, 1, "exactly one marked commit section");
  assert.equal(end.length, 1);
  const section = text.slice(text.indexOf("COMMIT-SECTION-BEGIN"), text.indexOf("COMMIT-SECTION-END"));
  assert.doesNotMatch(section, /\bawait\b/, "no await inside the commit section");
  assert.match(section, /authorize\(/, "authorization is re-evaluated inside the commit section");
  assert.match(section, /checkCapability\(/, "capabilities are re-evaluated inside the commit section");
  assert.match(section, /messages\.get\(/, "the idempotency lookup is inside the commit section");
  assert.match(section, /messages\.set\(/, "the message write is inside the commit section");
  assert.match(section, /deliveries\.set\(/, "delivery writes are inside the commit section");
  // Nothing outside the section may write messages or deliveries.
  const outside = text.replace(section, "");
  assert.doesNotMatch(outside, /\bmessages\.set\(|\bdeliveries\.set\(/, "message/delivery writes live only in the commit section");
});
