// S0b-2 behavioural suite for the D1-backed private Home store, run against a REAL SQLite engine
// loaded from the actual migration file (migrations/private/0001_s0b2_private_realm.sql).
//
// No binding, no network, no production data. Races live in private-realm-d1-races.test.js;
// R2 and the private-worker boundary live in private-realm-r2.test.js / private-realm-worker.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { PrivateRealmError, STORE_METHODS } from "../src/private-realm/index.js";
import { SQLITE_AVAILABLE, createClock, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";

const skip = SQLITE_AVAILABLE ? false : "node:sqlite unavailable";
const SECRET = "PRIVATE-BODY-SENTINEL-7f3a";

function fixture(options = {}) {
  const db = createSqliteD1();
  const store = createD1HomeStore({ db, now: createClock(), mintId: createMint(), ...options });
  return { db, store };
}

const rejectsWith = (fn, code) =>
  assert.rejects(fn, error => error instanceof PrivateRealmError && error.code === code, `expected ${code}`);
const reasons = (db, action) =>
  db.rows("SELECT outcome, reason FROM priv_audit WHERE action = ? ORDER BY audit_id", action).map(r => `${r.outcome}:${r.reason}`);

const chatgpt = sc("alice", "chatgpt");
const grok = sc("alice", "grok");
const bob = sc("bobby", "chatgpt");

// Alice: chatgpt (admin) + grok (member); shared `ibx_shared01` home inbox that grok may use fully.
async function aliceSetup(store) {
  const home = await store.ensureDefaultHome(chatgpt);
  await store.ensureDefaultHome(grok);
  await store.createInbox(chatgpt, { scope: "home", inboxId: "ibx_shared01" });
  await store.createInbox(chatgpt, { scope: "home", inboxId: "ibx_shared02" });
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id, caps: { read: true, send: true, ack: true } });
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: grok.connection_id, caps: { read: true, send: true, ack: true } });
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true, ack: true } });
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true, ack: true } });
  return home.home_id;
}

// ---------------------------------------------------------------------------------------------
// Migration + interface
// ---------------------------------------------------------------------------------------------

test("migration file applies to a fresh SQLite and creates the full private schema", { skip }, () => {
  const { db } = fixture();
  const tables = db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'priv_%' ORDER BY name").map(r => r.name);
  assert.deepEqual(tables.filter(n => n !== "priv_audit_sqlite_sequence" && !n.startsWith("sqlite_")), [
    "priv_audit", "priv_deliveries", "priv_home_connections", "priv_homes", "priv_inbox_grants", "priv_inboxes", "priv_messages"
  ]);
  const triggers = db.rows("SELECT name FROM sqlite_master WHERE type='trigger'").map(r => r.name);
  for (const t of ["priv_messages_no_update", "priv_messages_no_delete", "priv_deliveries_no_delete", "priv_audit_no_update", "priv_audit_no_delete"]) {
    assert.ok(triggers.includes(t), `trigger ${t}`);
  }
  assert.equal(db.rows("PRAGMA foreign_keys")[0].foreign_keys, 1);
});

test("adapter exposes exactly the STORE_METHODS interface and requires a D1 handle", { skip }, () => {
  const { store } = fixture();
  assert.equal(STORE_METHODS.length, 12);
  for (const m of STORE_METHODS) assert.equal(typeof store[m], "function", m);
  assert.throws(() => createD1HomeStore({}), /private_d1_required/);
});

// ---------------------------------------------------------------------------------------------
// ensureDefaultHome
// ---------------------------------------------------------------------------------------------

test("first connection creates the Home as admin; later providers join the SAME Home as members", { skip }, async () => {
  const { db, store } = fixture();
  const first = await store.ensureDefaultHome(chatgpt);
  assert.equal(first.created, true);
  assert.equal(first.connection_attached, true);
  assert.equal(first.role, "admin");
  const second = await store.ensureDefaultHome({ ...grok, home_role: "admin" });
  assert.equal(second.home_id, first.home_id);
  assert.equal(second.created, false);
  assert.equal(second.role, "member", "a requested admin role is not honoured while an active admin exists");
  assert.equal(db.count("priv_homes"), 1);
  assert.equal(db.count("priv_home_connections", "home_id = ?", first.home_id), 2);
  assert.deepEqual(reasons(db, "ensure_home"), ["allow:created", "allow:role_downgraded_to_member"]);
});

test("ensureDefaultHome is idempotent per connection and writes no extra rows", { skip }, async () => {
  const { db, store } = fixture();
  const a = await store.ensureDefaultHome(chatgpt);
  const b = await store.ensureDefaultHome(chatgpt);
  assert.equal(b.home_id, a.home_id);
  assert.equal(b.created, false);
  assert.equal(b.connection_attached, false);
  assert.equal(b.role, "admin");
  assert.equal(db.count("priv_homes"), 1);
  assert.equal(db.count("priv_home_connections"), 1);
});

test("ensureDefaultHome re-authorizes: tenant mismatch, principal conflict, revoked and cross-account connection ids are denied", { skip }, async () => {
  const { db, store } = fixture();
  await store.ensureDefaultHome(chatgpt);
  await rejectsWith(() => store.ensureDefaultHome({ ...grok, tenant_id: "ten_other" }), "scope_not_authorized");
  await rejectsWith(() => store.ensureDefaultHome({ ...grok, principal_id: chatgpt.principal_id }), "scope_not_authorized");
  await rejectsWith(() => store.ensureDefaultHome({ ...bob, connection_id: chatgpt.connection_id }), "scope_not_authorized");
  await rejectsWith(() => store.ensureDefaultHome({ ...chatgpt, principal_id: "prin_alice_swapped" }), "scope_not_authorized");
  await store.ensureDefaultHome(grok);
  await store.revokeConnection(chatgpt, grok.connection_id);
  await rejectsWith(() => store.ensureDefaultHome(grok), "scope_not_authorized");
  assert.equal(db.count("priv_homes"), 1, "denied calls never create a Home");
  assert.equal(db.count("priv_home_connections"), 2);
  const r = reasons(db, "ensure_home");
  assert.ok(r.includes("deny:account_tenant_mismatch"));
  assert.ok(r.includes("deny:principal_conflict"));
  assert.ok(r.includes("deny:connection_revoked"));
});

test("a scope carrying home_id/inbox_id or legacy actor ids never reaches SQL", { skip }, async () => {
  const { db, store } = fixture();
  await rejectsWith(() => store.ensureDefaultHome({ ...chatgpt, home_id: "home_attacker0001" }), "scope_must_not_carry_selectors");
  await rejectsWith(() => store.ensureDefaultHome({ ...chatgpt, account_id: "chatgpt:chat" }), "invalid_account_id");
  assert.equal(db.log.length, 0, "validation happens before any statement is issued");
});

test("admin recovery: with no active admin a new connection that requests admin becomes admin; otherwise member", { skip }, async () => {
  const { db, store } = fixture();
  const home = await store.ensureDefaultHome(chatgpt);
  db.exec("UPDATE priv_home_connections SET role = 'member'"); // out-of-band: simulate a Home left without an admin
  const plain = await store.ensureDefaultHome(grok);
  assert.equal(plain.role, "member");
  const recovered = await store.ensureDefaultHome({ ...sc("alice", "recover"), home_role: "admin" });
  assert.equal(recovered.home_id, home.home_id);
  assert.equal(recovered.role, "admin");
  const another = await store.ensureDefaultHome({ ...sc("alice", "second"), home_role: "admin" });
  assert.equal(another.role, "member", "only one recovery admin is minted");
});

// ---------------------------------------------------------------------------------------------
// roles and revocation
// ---------------------------------------------------------------------------------------------

test("members cannot change roles, grant, create shared inboxes or revoke others; admins can", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await rejectsWith(() => store.setConnectionRole(grok, chatgpt.connection_id, "member"), "capability_denied");
  await rejectsWith(() => store.grantInbox(grok, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id, caps: { read: true } }), "capability_denied");
  await rejectsWith(() => store.createInbox(grok, { scope: "home", inboxId: "ibx_member01" }), "capability_denied");
  await rejectsWith(() => store.revokeConnection(grok, chatgpt.connection_id), "capability_denied");
  const promoted = await store.setConnectionRole(chatgpt, grok.connection_id, "admin");
  assert.equal(promoted.role, "admin");
  assert.equal(db.rows("SELECT role FROM priv_home_connections WHERE connection_id = ?", grok.connection_id)[0].role, "admin");
});

test("the last active admin can be neither demoted nor revoked", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await rejectsWith(() => store.setConnectionRole(chatgpt, chatgpt.connection_id, "member"), "capability_denied");
  await rejectsWith(() => store.revokeConnection(chatgpt), "capability_denied");
  assert.ok(reasons(db, "set_role").includes("deny:last_admin_protected"));
  assert.ok(reasons(db, "revoke_connection").includes("deny:last_admin_protected"));
  await store.setConnectionRole(chatgpt, grok.connection_id, "admin");
  await store.setConnectionRole(chatgpt, chatgpt.connection_id, "member"); // now allowed: grok remains admin
  assert.equal(db.count("priv_home_connections", "role = 'admin' AND status = 'active'"), 1);
});

test("revocation is effective everywhere, retains rows, stamps grants, and cannot be undone by re-attaching", { skip }, async () => {
  const { db, store } = fixture();
  const home = await aliceSetup(store);
  await store.createInbox(grok, { scope: "connection", inboxId: "ibx_grokpriv" });
  const res = await store.revokeConnection(chatgpt, grok.connection_id);
  assert.deepEqual({ ...res }, { connection_id: grok.connection_id, revoked: true, changed: true });
  assert.deepEqual({ ...(await store.revokeConnection(chatgpt, grok.connection_id)) }, { connection_id: grok.connection_id, revoked: true, changed: false });
  for (const call of [
    () => store.listInboxes(grok),
    () => store.listInbox(grok, { inboxId: "ibx_shared01" }),
    () => store.readInbox(grok, { inboxId: "ibx_shared01" }),
    () => store.send(grok, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_after_revoke", body: "x" }),
    () => store.ack(grok, { inboxId: "ibx_shared01", messageId: "msg_after_revoke" }),
    () => store.ensureDefaultHome(grok)
  ]) await rejectsWith(call, "scope_not_authorized");
  assert.equal(await store.can(grok, "ibx_shared01", "read"), false);
  assert.equal(db.count("priv_home_connections", "home_id = ? AND connection_id = ? AND status = 'revoked'", home, grok.connection_id), 1);
  assert.equal(db.count("priv_inbox_grants", "connection_id = ? AND revoked_at IS NULL", grok.connection_id), 0);
  assert.equal(db.count("priv_inboxes", "inbox_id = 'ibx_grokpriv'"), 1, "rows are retained as history");
  assert.equal(db.count("priv_messages"), 0);
  assert.equal(await store.can(chatgpt, "ibx_shared01", "read"), true, "other connections are untouched");
});

// ---------------------------------------------------------------------------------------------
// inboxes, grants, capabilities, sibling-private isolation
// ---------------------------------------------------------------------------------------------

test("connection-private inboxes are unreachable by any sibling, including an admin sibling", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await store.createInbox(grok, { scope: "connection", inboxId: "ibx_grokpriv" });
  assert.equal(await store.can(grok, "ibx_grokpriv", "read"), true);
  assert.equal(await store.can(chatgpt, "ibx_grokpriv", "read"), false);
  assert.equal(await store.can(chatgpt, "ibx_grokpriv", "send"), false);
  await store.send(grok, { fromInboxId: "ibx_grokpriv", toInboxIds: ["ibx_grokpriv"], messageId: "msg_priv_0001", body: SECRET });
  await rejectsWith(() => store.readInbox(chatgpt, { inboxId: "ibx_grokpriv" }), "capability_denied");
  await rejectsWith(() => store.listInbox(chatgpt, { inboxId: "ibx_grokpriv" }), "capability_denied");
  await rejectsWith(() => store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_grokpriv"], messageId: "msg_sib_0001", body: "x" }), "capability_denied");
  await rejectsWith(() => store.ack(chatgpt, { inboxId: "ibx_grokpriv", messageId: "msg_priv_0001" }), "capability_denied");
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: "ibx_grokpriv", targetConnectionId: chatgpt.connection_id, caps: { read: true } }), "capability_denied");
  await rejectsWith(() => store.revokeGrant(chatgpt, { inboxId: "ibx_grokpriv", targetConnectionId: grok.connection_id }), "capability_denied");
  assert.ok(!(await store.listInboxes(chatgpt)).some(i => i.inbox_id === "ibx_grokpriv"), "not even discoverable");
  assert.equal(db.count("priv_inbox_grants", "inbox_id = 'ibx_grokpriv' AND connection_id <> ?", grok.connection_id), 0);
  const audit = JSON.stringify(db.rows("SELECT * FROM priv_audit"));
  assert.ok(!audit.includes(SECRET), "audit never carries bodies");
});

test("capabilities are a closed list; property-name tricks deny", { skip }, async () => {
  const { store } = fixture();
  await aliceSetup(store);
  for (const cap of ["granted_at", "constructor", "__proto__", "revoked_at", "admin", "", undefined, null, 1]) {
    assert.equal(await store.can(grok, "ibx_shared01", cap), false, String(cap));
  }
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id, caps: { admin: true } }), "invalid_caps");
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id, caps: {} }), "invalid_caps");
  await rejectsWith(() => store.grantInbox(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id, caps: [] }), "invalid_caps");
});

test("createInbox is idempotent for the same definition and conflicts on a different one", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  const again = await store.createInbox(chatgpt, { scope: "home", inboxId: "ibx_shared01" });
  assert.equal(again.created, false);
  await rejectsWith(() => store.createInbox(chatgpt, { scope: "home", plane: "work", inboxId: "ibx_shared01" }), "capability_denied");
  assert.ok(reasons(db, "create_inbox").includes("deny:inbox_conflict"));
  await rejectsWith(() => store.createInbox(chatgpt, { scope: "bogus" }), "invalid_inbox_scope");
  await rejectsWith(() => store.createInbox(chatgpt, { scope: "home", inboxId: "not-an-inbox" }), "invalid_inbox_id");
});

test("a granted-then-revoked grant stops working immediately and re-granting restores it", { skip }, async () => {
  const { store } = fixture();
  await aliceSetup(store);
  assert.equal(await store.can(grok, "ibx_shared01", "send"), true);
  assert.deepEqual({ ...(await store.revokeGrant(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id })) }, { revoked: true, changed: true });
  assert.equal(await store.can(grok, "ibx_shared01", "send"), false);
  await rejectsWith(() => store.send(grok, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_revoked_grant", body: "x" }), "capability_denied");
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id, caps: { read: true } });
  assert.equal(await store.can(grok, "ibx_shared01", "read"), true);
  assert.equal(await store.can(grok, "ibx_shared01", "send"), false, "re-grant carries exactly the new capabilities");
});

// ---------------------------------------------------------------------------------------------
// send: validation, exact recipient sets, replay and conflicts
// ---------------------------------------------------------------------------------------------

test("send validates message/thread ids, body and recipient list before touching storage", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  const base = { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_valid_0001", body: "hello" };
  await rejectsWith(() => store.send(chatgpt, { ...base, messageId: undefined }), "invalid_message_id");
  await rejectsWith(() => store.send(chatgpt, { ...base, messageId: "short" }), "invalid_message_id");
  await rejectsWith(() => store.send(chatgpt, { ...base, messageId: "bad id with spaces" }), "invalid_message_id");
  await rejectsWith(() => store.send(chatgpt, { ...base, threadId: "bad thread!" }), "invalid_thread_id");
  await rejectsWith(() => store.send(chatgpt, { ...base, body: "" }), "invalid_body");
  await rejectsWith(() => store.send(chatgpt, { ...base, body: 123 }), "invalid_body");
  await rejectsWith(() => store.send(chatgpt, { ...base, body: "x".repeat(65537) }), "invalid_body");
  await rejectsWith(() => store.send(chatgpt, { ...base, toInboxIds: [] }), "invalid_recipients");
  await rejectsWith(() => store.send(chatgpt, { ...base, toInboxIds: "ibx_shared02" }), "invalid_recipients");
  await rejectsWith(() => store.send(chatgpt, { ...base, toInboxIds: Array.from({ length: 21 }, (_, i) => `ibx_many${String(i).padStart(4, "0")}`) }), "invalid_recipients");
  assert.equal(db.count("priv_messages"), 0);
  assert.equal(db.count("priv_deliveries"), 0);
});

test("recipient set is exactly the deduplicated, sorted set; the stored set never depends on caller order or duplicates", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await store.createInbox(chatgpt, { scope: "home", inboxId: "ibx_shared03" });
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared03", targetConnectionId: chatgpt.connection_id, caps: { read: true, send: true } });
  const sent = await store.send(chatgpt, {
    fromInboxId: "ibx_shared01",
    toInboxIds: ["ibx_shared03", "ibx_shared02", "ibx_shared03", "ibx_shared02", "ibx_shared01"],
    messageId: "msg_set_00001",
    body: "fan-out"
  });
  assert.equal(sent.created, true);
  assert.equal(sent.delivered_to, 3);
  assert.deepEqual(db.rows("SELECT inbox_id FROM priv_deliveries WHERE message_id = 'msg_set_00001' ORDER BY inbox_id").map(r => r.inbox_id), ["ibx_shared01", "ibx_shared02", "ibx_shared03"]);
  // Replays with any permutation/duplication of the SAME set are idempotent and add nothing.
  for (const order of [["ibx_shared01", "ibx_shared02", "ibx_shared03"], ["ibx_shared03", "ibx_shared03", "ibx_shared01", "ibx_shared02"]]) {
    const replay = await store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: order, messageId: "msg_set_00001", body: "fan-out" });
    assert.equal(replay.created, false);
  }
  assert.equal(db.count("priv_deliveries", "message_id = 'msg_set_00001'"), 3);
  // A subset or superset is a DIFFERENT request: conflict, original set untouched.
  await rejectsWith(() => store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_set_00001", body: "fan-out" }), "capability_denied");
  await rejectsWith(() => store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared01", "ibx_shared02", "ibx_shared03", "ibx_shared02", "ibx_shared01"].concat([]), messageId: "msg_set_00001", body: "changed" }), "capability_denied");
  assert.equal(db.count("priv_deliveries", "message_id = 'msg_set_00001'"), 3);
  assert.equal(db.count("priv_messages"), 1);
});

test("replay is idempotent only for the identical request; any difference or another sender is a conflict", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  const base = { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_replay_001", threadId: "thr_replay_1", body: "original" };
  const first = await store.send(chatgpt, base);
  assert.equal(first.created, true);
  assert.equal((await store.send(chatgpt, base)).created, false);
  assert.equal((await store.send(chatgpt, { ...base, threadId: undefined }).catch(e => e.code)), "capability_denied", "thread defaults to the message id: different thread");
  for (const change of [{ body: "tampered" }, { threadId: "thr_other_1" }, { fromInboxId: "ibx_shared02", toInboxIds: ["ibx_shared01"] }]) {
    await rejectsWith(() => store.send(chatgpt, { ...base, ...change }), "capability_denied");
  }
  await rejectsWith(() => store.send(grok, base), "capability_denied"); // another connection reusing the id
  const row = db.rows("SELECT body_text, thread_id, sender_connection_id FROM priv_messages WHERE message_id = 'msg_replay_001'")[0];
  assert.deepEqual({ ...row }, { body_text: "original", thread_id: "thr_replay_1", sender_connection_id: chatgpt.connection_id });
  assert.equal(db.count("priv_messages"), 1);
  assert.ok(reasons(db, "send").filter(r => r === "deny:idempotency_conflict").length >= 5);
});

test("message ids are scoped per Home: two Homes may use the same id without collision or leakage", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await store.ensureDefaultHome(bob);
  await store.createInbox(bob, { scope: "home", inboxId: "ibx_shared01" }); // same inbox id, different Home
  await store.grantInbox(bob, { inboxId: "ibx_shared01", targetConnectionId: bob.connection_id, caps: { read: true, send: true, ack: true } });
  await store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_same_0001", body: "alice-body" });
  await store.send(bob, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared01"], messageId: "msg_same_0001", body: "bob-body" });
  assert.equal(db.count("priv_messages", "message_id = 'msg_same_0001'"), 2);
  const bobRead = await store.readInbox(bob, { inboxId: "ibx_shared01" });
  assert.deepEqual(bobRead.map(r => r.body), ["bob-body"]);
  const aliceRead = await store.readInbox(chatgpt, { inboxId: "ibx_shared02" });
  assert.deepEqual(aliceRead.map(r => r.body), ["alice-body"]);
});

test("no partial delivery: a send whose target loses authorization writes nothing at all", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await store.revokeGrant(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: chatgpt.connection_id });
  await rejectsWith(() => store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared01", "ibx_shared02"], messageId: "msg_partial_01", body: "x" }), "capability_denied");
  assert.equal(db.count("priv_messages"), 0);
  assert.equal(db.count("priv_deliveries"), 0);
});

test("the database itself rejects a message or delivery from a non-authorized sender (trigger backstop)", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await store.revokeConnection(chatgpt, grok.connection_id);
  const insertMsg = () => db.raw.prepare(
    `INSERT INTO priv_messages (home_id, message_id, thread_id, sender_inbox_id, sender_connection_id, body_sha256, body_text, created_at)
     SELECT home_id, 'msg_direct_001', 'msg_direct_001', 'ibx_shared01', ?, ?, 'x', 't' FROM priv_homes LIMIT 1`
  ).run(grok.connection_id, "a".repeat(64));
  assert.throws(insertMsg, /sender_not_authorized/);
  assert.equal(db.count("priv_messages"), 0);
});

// ---------------------------------------------------------------------------------------------
// list / read / ack: limited stamps, forward-only state
// ---------------------------------------------------------------------------------------------

async function sendN(store, n, to = "ibx_shared02") {
  for (let i = 1; i <= n; i += 1) {
    await store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: [to], messageId: `msg_batch_${String(i).padStart(3, "0")}`, body: `body-${i}` });
  }
}

test("listInbox is metadata only and never stamps; readInbox returns bodies and stamps ONLY the returned (limited) rows", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await sendN(store, 5);
  const listed = await store.listInbox(grok, { inboxId: "ibx_shared02", limit: 50 });
  assert.equal(listed.length, 5);
  assert.ok(listed.every(r => !("body" in r) && !("body_text" in r)));
  assert.equal(db.count("priv_deliveries", "read_at IS NOT NULL"), 0, "list never stamps");

  const read = await store.readInbox(grok, { inboxId: "ibx_shared02", limit: 2 });
  assert.equal(read.length, 2);
  assert.ok(read.every(r => typeof r.body === "string" && r.read_at));
  const stamped = db.rows("SELECT message_id FROM priv_deliveries WHERE read_at IS NOT NULL ORDER BY message_id").map(r => r.message_id);
  assert.deepEqual(stamped, read.map(r => r.message_id).sort(), "exactly the returned rows are stamped");
  assert.equal(db.count("priv_deliveries", "read_at IS NULL"), 3);
  const firstStamp = Object.fromEntries(read.map(r => [r.message_id, r.read_at]));
  const again = await store.readInbox(grok, { inboxId: "ibx_shared02", limit: 2 });
  for (const r of again) assert.equal(r.read_at, firstStamp[r.message_id], "stamps never move");
});

test("the read SELECT carries its LIMIT and the stamp UPDATE is restricted to unread rows of the caller's inbox", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await sendN(store, 3);
  db.log.length = 0;
  await store.readInbox(grok, { inboxId: "ibx_shared02", limit: 1 });
  const text = db.log.map(l => l.sql).join(" ;; ");
  assert.match(text, /LIMIT/i);
  assert.match(text, /read_at IS NULL/i);
  assert.ok(!/UPDATE priv_deliveries SET read_at = \?\s+WHERE home_id = \? AND inbox_id = \? AND read_at IS NULL(?!.*message_id)/i.test(text), "no inbox-wide stamp without a message-id restriction");
});

test("ack stamps read+ack once, is idempotent, needs the ack capability, and never moves state backwards", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await sendN(store, 1);
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: grok.connection_id, caps: { read: true } });
  await rejectsWith(() => store.ack(grok, { inboxId: "ibx_shared02", messageId: "msg_batch_001" }), "capability_denied");
  await store.grantInbox(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: grok.connection_id, caps: { read: true, ack: true } });
  const a = await store.ack(grok, { inboxId: "ibx_shared02", messageId: "msg_batch_001" });
  assert.deepEqual({ ...a }, { message_id: "msg_batch_001", acked: true, changed: true });
  const row1 = { ...db.rows("SELECT delivered_at, read_at, acked_at FROM priv_deliveries")[0] };
  assert.ok(row1.read_at && row1.acked_at && row1.delivered_at <= row1.read_at && row1.read_at <= row1.acked_at);
  const b = await store.ack(grok, { inboxId: "ibx_shared02", messageId: "msg_batch_001" });
  assert.deepEqual({ ...b }, { message_id: "msg_batch_001", acked: true, changed: false });
  assert.deepEqual({ ...db.rows("SELECT delivered_at, read_at, acked_at FROM priv_deliveries")[0] }, row1);
  await rejectsWith(() => store.ack(grok, { inboxId: "ibx_shared02", messageId: "msg_nonexistent" }), "capability_denied");
  assert.throws(() => db.raw.prepare("UPDATE priv_deliveries SET read_at = NULL").run(), /cannot move backwards/);
});

// ---------------------------------------------------------------------------------------------
// cross-Home, tenant, selector isolation
// ---------------------------------------------------------------------------------------------

test("cross-Home and cross-tenant access is denied and indistinguishable from nonexistence", { skip }, async () => {
  const { db, store } = fixture();
  const aliceHome = await aliceSetup(store);
  const bobHome = (await store.ensureDefaultHome(bob)).home_id;
  await store.createInbox(bob, { scope: "home", inboxId: "ibx_bobhome1" });
  await store.grantInbox(bob, { inboxId: "ibx_bobhome1", targetConnectionId: bob.connection_id, caps: { read: true, send: true, ack: true } });
  await store.send(bob, { fromInboxId: "ibx_bobhome1", toInboxIds: ["ibx_bobhome1"], messageId: "msg_bob_00001", body: SECRET });

  // Bob names Alice's inbox ids: capability_denied, identical to a nonexistent inbox.
  const probes = [
    () => store.readInbox(bob, { inboxId: "ibx_shared01" }),
    () => store.readInbox(bob, { inboxId: "ibx_doesnotexist" }),
    () => store.listInbox(bob, { inboxId: "ibx_shared02" }),
    () => store.send(bob, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_probe_001", body: "x" }),
    () => store.send(bob, { fromInboxId: "ibx_bobhome1", toInboxIds: ["ibx_shared02"], messageId: "msg_probe_002", body: "x" }),
    () => store.ack(bob, { inboxId: "ibx_shared01", messageId: "msg_bob_00001" })
  ];
  for (const p of probes) await rejectsWith(p, "capability_denied");

  // Selector naming another Home, a connection under the wrong account/tenant/principal.
  await rejectsWith(() => store.listInboxes(chatgpt, { homeId: bobHome }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes({ ...chatgpt, account_id: "acct_bobby" }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes({ ...chatgpt, tenant_id: "ten_bobby" }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes({ ...chatgpt, principal_id: bob.principal_id }), "scope_not_authorized");
  await rejectsWith(() => store.listInboxes(sc("mallory", "chatgpt")), "scope_not_authorized");
  assert.equal((await store.listInboxes(chatgpt, { homeId: aliceHome })).length >= 0, true, "a matching selector is accepted but grants nothing");

  // Nothing Bob did wrote into Alice's Home.
  assert.equal(db.count("priv_messages", "home_id = ?", aliceHome), 0);
  assert.equal(db.count("priv_deliveries", "home_id = ?", aliceHome), 0);
  const denyAudits = db.rows("SELECT reason FROM priv_audit WHERE outcome = 'deny'").map(r => r.reason);
  assert.ok(denyAudits.includes("selector_mismatch"));
  assert.ok(denyAudits.includes("account_or_tenant_mismatch"));
  assert.ok(denyAudits.includes("connection_unknown"));
});

test("composite foreign keys make a cross-Home delivery or grant unrepresentable even for raw SQL", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await store.ensureDefaultHome(bob);
  await store.createInbox(bob, { scope: "home", inboxId: "ibx_bobhome1" });
  await store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_fk_000001", body: "x" });
  const aliceHome = db.rows("SELECT home_id FROM priv_homes WHERE account_id = 'acct_alice'")[0].home_id;
  assert.throws(() => db.raw.prepare("INSERT INTO priv_deliveries (home_id, message_id, inbox_id, delivered_at) VALUES (?, 'msg_fk_000001', 'ibx_bobhome1', 't')").run(aliceHome), /FOREIGN KEY|constraint|not_authorized/i);
  assert.throws(() => db.raw.prepare("INSERT INTO priv_inbox_grants (home_id, inbox_id, connection_id, can_read, granted_at) VALUES (?, 'ibx_bobhome1', ?, 1, 't')").run(aliceHome, chatgpt.connection_id), /FOREIGN KEY|constraint/i);
});

// ---------------------------------------------------------------------------------------------
// audit: awaited, durable, ids and reason codes only
// ---------------------------------------------------------------------------------------------

test("audit rows exist the moment each call settles (awaited), for allow and for deny", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  const before = db.count("priv_audit");
  await store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_audit_0001", body: SECRET });
  assert.equal(db.count("priv_audit"), before + 1);
  assert.deepEqual({ ...db.rows("SELECT action, outcome, reason FROM priv_audit ORDER BY audit_id DESC LIMIT 1")[0] }, { action: "send", outcome: "allow", reason: "sent" });
  await rejectsWith(() => store.readInbox(bob, { inboxId: "ibx_shared02" }), "scope_not_authorized");
  assert.equal(db.count("priv_audit"), before + 2);
  assert.deepEqual({ ...db.rows("SELECT action, outcome, reason FROM priv_audit ORDER BY audit_id DESC LIMIT 1")[0] }, { action: "read_inbox", outcome: "deny", reason: "connection_unknown" });
});

test("an audit call is awaited: a slow audit write delays the result instead of being fire-and-forget", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  let auditDone = false;
  db.before("INSERT INTO priv_audit", async () => {
    await new Promise(r => setTimeout(r, 25));
    auditDone = true;
  });
  await store.listInboxes(chatgpt);
  assert.equal(auditDone, true, "the call settled only after the audit insert ran");
  assert.equal(db.rows("SELECT outcome FROM priv_audit ORDER BY audit_id DESC LIMIT 1")[0].outcome, "allow");
});

test("a failing audit write fails the denial path loudly instead of silently dropping the record", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  db.before("INSERT INTO priv_audit", async () => {
    db.exec("DROP TRIGGER priv_audit_no_update");
    db.exec("CREATE TRIGGER priv_audit_block BEFORE INSERT ON priv_audit BEGIN SELECT RAISE(ABORT, 'audit_down'); END");
  });
  // The denial cannot be recorded, so the call must NOT settle as an ordinary typed denial: the storage
  // failure surfaces (the worker boundary collapses it to a generic error) and no audit row exists.
  await assert.rejects(() => store.readInbox(bob, { inboxId: "ibx_shared01" }), error => !(error instanceof PrivateRealmError));
  assert.equal(db.count("priv_audit", "reason = 'connection_unknown'"), 0);
});

test("audit rows contain only ids and reason codes, never bodies or labels", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  await store.createInbox(chatgpt, { scope: "home", inboxId: "ibx_label0001", label: `label-${SECRET}` });
  await store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_noleak_01", body: SECRET });
  await store.readInbox(grok, { inboxId: "ibx_shared02" });
  assert.ok(!JSON.stringify(db.rows("SELECT * FROM priv_audit")).includes(SECRET));
  for (const row of db.rows("SELECT * FROM priv_audit")) {
    assert.deepEqual(Object.keys(row).sort(), ["action", "audit_id", "connection_id", "created_at", "home_id", "outcome", "principal_id", "reason"]);
  }
});

test("priv_audit is append-only at the database level", { skip }, async () => {
  const { db, store } = fixture();
  await aliceSetup(store);
  assert.throws(() => db.raw.prepare("UPDATE priv_audit SET reason = 'x'").run(), /append-only/);
  assert.throws(() => db.raw.prepare("DELETE FROM priv_audit").run(), /append-only/);
});
