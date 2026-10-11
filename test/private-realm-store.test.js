// S0b-1 private realm store tests. In-memory fake only. No binding, no migration.

import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryHomeStore, assertHomeScope, resolveHomeStore } from "../src/private-realm/store.js";

const base = {
  account_id: "acct_a1",
  tenant_id: "ten_a1",
  principal_id: "prin_a_chatgpt",
  connection_id: "conn_a_chatgpt",
  provider_label: "chatgpt",
};

const sibling = {
  ...base,
  principal_id: "prin_a_claude",
  connection_id: "conn_a_claude",
  provider_label: "claude",
};

const otherHome = {
  account_id: "acct_b1",
  tenant_id: "ten_b1",
  principal_id: "prin_b_chatgpt",
  connection_id: "conn_b_chatgpt",
  provider_label: "chatgpt",
};

test("HomeScope rejects raw or mismatched identifiers", () => {
  assert.throws(() => assertHomeScope({ account_id: "chatgpt:chat" }), /invalid_account_id/);
  assert.throws(() => assertHomeScope(null), /home_scope_required/);
  assert.throws(() => assertHomeScope({ ...base, home_id: "not-a-home" }), /invalid_home_id/);
});

test("ensureDefaultHome is idempotent for the same account", async () => {
  const store = createInMemoryHomeStore();
  const a = await store.ensureDefaultHome(base);
  const b = await store.ensureDefaultHome(base);
  assert.equal(a.home_id, b.home_id);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  const other = await store.ensureDefaultHome(otherHome);
  assert.notEqual(other.home_id, a.home_id);
});

test("connection-private inbox denies sibling of the same Home", async () => {
  const store = createInMemoryHomeStore();
  const { home_id } = await store.ensureDefaultHome(base);
  await store.attachConnection(base, home_id);
  await store.attachConnection(sibling, home_id);
  const { inbox_id } = await store.createInbox(base, home_id, { scope: "connection", plane: "chat" });
  await assert.rejects(
    () => store.grant(base, home_id, inbox_id, sibling.connection_id, { can_read: 1 }),
    /connection_private_sibling_denied/
  );
  assert.equal(await store.can(sibling, home_id, inbox_id, "can_read"), false);
  assert.equal(await store.can(base, home_id, inbox_id, "can_read"), true);
});

test("home-owned inbox can be granted independently; sibling of connection-private cannot", async () => {
  const store = createInMemoryHomeStore();
  const { home_id } = await store.ensureDefaultHome(base);
  await store.attachConnection(base, home_id);
  await store.attachConnection(sibling, home_id);
  const homeInbox = await store.createInbox(base, home_id, { scope: "home", plane: "work" });
  await store.grant(base, home_id, homeInbox.inbox_id, sibling.connection_id, { can_read: 1, can_send: 1 });
  assert.equal(await store.can(sibling, home_id, homeInbox.inbox_id, "can_read"), true);
});

test("revoked connection loses access; Home data remains for other connections", async () => {
  const store = createInMemoryHomeStore();
  const { home_id } = await store.ensureDefaultHome(base);
  await store.attachConnection(base, home_id);
  await store.attachConnection(sibling, home_id);
  const homeInbox = await store.createInbox(base, home_id, { scope: "home" });
  await store.grant(base, home_id, homeInbox.inbox_id, base.connection_id, { can_read: 1 });
  await store.grant(base, home_id, homeInbox.inbox_id, sibling.connection_id, { can_read: 1 });
  assert.equal(await store.can(base, home_id, homeInbox.inbox_id, "can_read"), true);
  await store.revokeConnection(base, home_id);
  assert.equal(await store.can(base, home_id, homeInbox.inbox_id, "can_read"), false);
  assert.equal(await store.can(sibling, home_id, homeInbox.inbox_id, "can_read"), true);
});

test("cross-Home access is denied", async () => {
  const store = createInMemoryHomeStore();
  const a = await store.ensureDefaultHome(base);
  const b = await store.ensureDefaultHome(otherHome);
  await store.attachConnection(base, a.home_id);
  await store.attachConnection(otherHome, b.home_id);
  const inbox = await store.createInbox(base, a.home_id, { scope: "home" });
  assert.equal(await store.can(otherHome, a.home_id, inbox.inbox_id, "can_read"), false);
  await assert.rejects(() => store.createInbox(otherHome, a.home_id, { scope: "home" }), /home_mismatch|connection_inactive/);
});

test("resolveHomeStore refuses when no test store is injected", () => {
  assert.throws(() => resolveHomeStore({}, base), /private_home_store_not_bound/);
  const fake = { tag: "test" };
  assert.equal(resolveHomeStore({ __PRIVATE_HOME_STORE_TEST__: fake }, base), fake);
});
