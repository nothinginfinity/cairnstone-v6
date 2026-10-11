// S0b-2 race and isolation suite: real SQLite, real migration, deterministic interleavings.
//
// Two techniques:
//  1. Promise.all() fan-out. The harness yields to the event loop before every statement/batch, so
//     concurrent store calls interleave at exactly the granularity real D1 requests do.
//  2. Statement-level SWEEP. For every position k in a store method's statement sequence, a
//     revocation/demotion is committed immediately BEFORE statement k. The invariant is physical,
//     not logical: no effective write by the revoked/demoted actor may COMMIT after the revocation
//     (db.writes[].seq is the real commit order). This is what "fail closed" means here.

import test from "node:test";
import assert from "node:assert/strict";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { PrivateRealmError } from "../src/private-realm/index.js";
import { SQLITE_AVAILABLE, createClock, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";

const skip = SQLITE_AVAILABLE ? false : "node:sqlite unavailable";
const AUTH_CODES = new Set(["scope_not_authorized", "capability_denied"]);

const chatgpt = sc("alice", "chatgpt");
const grok = sc("alice", "grok");
const claude = sc("alice", "claude");

function fixture() {
  const db = createSqliteD1();
  const store = createD1HomeStore({ db, now: createClock(), mintId: createMint() });
  return { db, store };
}

const full = { read: true, send: true, ack: true };

// chatgpt = admin; grok, claude = members; grokAdmin promotes grok. Two shared inboxes everyone may use.
async function world({ grokAdmin = false } = {}) {
  const fx = fixture();
  const { store } = fx;
  await store.ensureDefaultHome(chatgpt);
  await store.ensureDefaultHome(grok);
  await store.ensureDefaultHome(claude);
  for (const inbox of ["ibx_shared01", "ibx_shared02"]) {
    await store.createInbox(chatgpt, { scope: "home", inboxId: inbox });
    for (const c of [chatgpt, grok, claude]) await store.grantInbox(chatgpt, { inboxId: inbox, targetConnectionId: c.connection_id, caps: full });
  }
  if (grokAdmin) await store.setConnectionRole(chatgpt, grok.connection_id, "admin");
  return fx;
}

// Every rejection from a store method must be a typed authorization error, never a raw SQL/D1 error.
function settledOutcome(results) {
  return results.map(r => {
    if (r.status === "fulfilled") return { ok: true, value: r.value };
    assert.ok(r.reason instanceof PrivateRealmError, `raw error leaked: ${r.reason && r.reason.message}`);
    assert.ok(AUTH_CODES.has(r.reason.code), `unexpected code ${r.reason.code}`);
    return { ok: false, code: r.reason.code };
  });
}

// ---------------------------------------------------------------------------------------------
// Home creation and scoped recovery
// ---------------------------------------------------------------------------------------------

test("25 concurrent first-time connections of one account create exactly ONE default Home with ONE admin", { skip }, async () => {
  const { db, store } = fixture();
  const scopes = Array.from({ length: 25 }, (_, i) => sc("alice", `prov${String(i).padStart(2, "0")}`));
  const results = await Promise.allSettled(scopes.map(s => store.ensureDefaultHome(s)));
  const out = settledOutcome(results);
  assert.ok(out.every(o => o.ok), "every connection attaches; none may fail on the default-Home collision");
  const homes = new Set(out.map(o => o.value.home_id));
  assert.equal(homes.size, 1);
  assert.equal(out.filter(o => o.value.created).length, 1);
  assert.equal(db.count("priv_homes"), 1);
  assert.equal(db.count("priv_home_connections"), 25);
  assert.equal(db.count("priv_home_connections", "role = 'admin'"), 1);
  assert.equal(out.filter(o => o.value.role === "admin").length, 1);
});

test("concurrent first-time connections of DIFFERENT accounts get distinct Homes", { skip }, async () => {
  const { db, store } = fixture();
  const scopes = ["alice", "bobby", "carol", "dave1"].map(a => sc(a, "chatgpt"));
  const out = settledOutcome(await Promise.allSettled(scopes.map(s => store.ensureDefaultHome(s))));
  assert.ok(out.every(o => o.ok && o.value.created && o.value.role === "admin"));
  assert.equal(new Set(out.map(o => o.value.home_id)).size, 4);
  assert.equal(db.count("priv_homes"), 4);
});

test("the SAME connection ensured 10 times concurrently is one row and 10 idempotent answers", { skip }, async () => {
  const { db, store } = fixture();
  const out = settledOutcome(await Promise.allSettled(Array.from({ length: 10 }, () => store.ensureDefaultHome(chatgpt))));
  assert.ok(out.every(o => o.ok));
  assert.equal(new Set(out.map(o => o.value.home_id)).size, 1);
  assert.equal(out.filter(o => o.value.connection_attached).length, 1);
  assert.equal(db.count("priv_homes"), 1);
  assert.equal(db.count("priv_home_connections"), 1);
});

test("scoped recovery re-authorizes: the loser of a default-Home race with a different tenant is DENIED, not attached", { skip }, async () => {
  const { db, store } = fixture();
  const intruder = { ...sc("alice", "intruder"), tenant_id: "ten_other" };
  const out = settledOutcome(await Promise.allSettled([store.ensureDefaultHome(chatgpt), store.ensureDefaultHome(intruder)]));
  const winners = out.filter(o => o.ok);
  assert.equal(winners.length, 1, "exactly one tenant owns the account's Home");
  assert.equal(db.count("priv_homes"), 1);
  assert.equal(db.count("priv_home_connections"), 1);
  const home = db.rows("SELECT tenant_id FROM priv_homes")[0];
  const conn = db.rows("SELECT connection_id FROM priv_home_connections")[0];
  assert.equal(conn.connection_id, winners[0].value.role === "admin" && home.tenant_id === "ten_alice" ? chatgpt.connection_id : intruder.connection_id);
  assert.equal(out.find(o => !o.ok).code, "scope_not_authorized");
});

test("scoped recovery re-checks the principal: two connections with the SAME principal cannot both attach", { skip }, async () => {
  const { db, store } = fixture();
  const a = { ...sc("alice", "one"), principal_id: "prin_alice_shared" };
  const b = { ...sc("alice", "two"), principal_id: "prin_alice_shared" };
  const out = settledOutcome(await Promise.allSettled([store.ensureDefaultHome(a), store.ensureDefaultHome(b)]));
  assert.equal(out.filter(o => o.ok).length, 1);
  assert.equal(out.find(o => !o.ok).code, "scope_not_authorized");
  assert.equal(db.count("priv_home_connections"), 1);
});

test("the same connection id claimed by two accounts concurrently: one wins, the other is denied, no raw error", { skip }, async () => {
  const { db, store } = fixture();
  const a = sc("alice", "chatgpt");
  const b = { ...sc("bobby", "chatgpt"), connection_id: a.connection_id };
  const out = settledOutcome(await Promise.allSettled([store.ensureDefaultHome(a), store.ensureDefaultHome(b)]));
  assert.equal(out.filter(o => o.ok).length, 1);
  assert.equal(db.count("priv_home_connections", "connection_id = ?", a.connection_id), 1);
  const home = db.rows("SELECT h.account_id FROM priv_home_connections c JOIN priv_homes h ON h.home_id = c.home_id")[0];
  const winner = out.findIndex(o => o.ok) === 0 ? "acct_alice" : "acct_bobby";
  assert.equal(home.account_id, winner);
});

test("concurrent admin-recovery attaches mint at most ONE recovery admin", { skip }, async () => {
  const { db, store } = fixture();
  await store.ensureDefaultHome(chatgpt);
  db.exec("UPDATE priv_home_connections SET role = 'member'");
  const scopes = Array.from({ length: 6 }, (_, i) => ({ ...sc("alice", `rec${i}`), home_role: "admin" }));
  const out = settledOutcome(await Promise.allSettled(scopes.map(s => store.ensureDefaultHome(s))));
  assert.ok(out.every(o => o.ok));
  assert.equal(out.filter(o => o.value.role === "admin").length, 1);
  assert.equal(db.count("priv_home_connections", "role = 'admin' AND status = 'active'"), 1);
});

// ---------------------------------------------------------------------------------------------
// concurrent duplicate / conflicting sends
// ---------------------------------------------------------------------------------------------

const baseSend = { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02", "ibx_shared01"], messageId: "msg_race_0001", threadId: "thr_race_01", body: "payload" };

test("12 concurrent IDENTICAL sends: one message, one delivery set, one created=true, the rest idempotent", { skip }, async () => {
  const { db, store } = await world();
  const out = settledOutcome(await Promise.allSettled(Array.from({ length: 12 }, () => store.send(grok, baseSend))));
  assert.ok(out.every(o => o.ok), "same payload from the same sender is a replay, never an error");
  assert.equal(out.filter(o => o.value.created).length, 1);
  assert.equal(db.count("priv_messages"), 1);
  assert.deepEqual(db.rows("SELECT inbox_id FROM priv_deliveries ORDER BY inbox_id").map(r => r.inbox_id), ["ibx_shared01", "ibx_shared02"]);
});

test("concurrent identical sends with permuted/duplicated recipient lists collapse to the same exact set", { skip }, async () => {
  const { db, store } = await world();
  const lists = [["ibx_shared01", "ibx_shared02"], ["ibx_shared02", "ibx_shared01"], ["ibx_shared02", "ibx_shared02", "ibx_shared01"], ["ibx_shared01", "ibx_shared01", "ibx_shared02"]];
  const out = settledOutcome(await Promise.allSettled(lists.map(toInboxIds => store.send(grok, { ...baseSend, toInboxIds }))));
  assert.ok(out.every(o => o.ok));
  assert.equal(out.filter(o => o.value.created).length, 1);
  assert.equal(db.count("priv_deliveries"), 2);
});

test("6 concurrent CONFLICTING sends (same id, different bodies): exactly one wins, losers get capability_denied, no partial delivery", { skip }, async () => {
  const { db, store } = await world();
  const bodies = Array.from({ length: 6 }, (_, i) => `body-variant-${i}`);
  const out = settledOutcome(await Promise.allSettled(bodies.map(body => store.send(grok, { ...baseSend, body }))));
  assert.equal(out.filter(o => o.ok).length, 1);
  assert.ok(out.filter(o => !o.ok).every(o => o.code === "capability_denied"));
  const winnerBody = bodies[out.findIndex(o => o.ok)];
  assert.equal(db.rows("SELECT body_text FROM priv_messages")[0].body_text, winnerBody, "the stored body is the winner's, untouched by losers");
  assert.equal(db.count("priv_messages"), 1);
  assert.equal(db.count("priv_deliveries"), 2, "exactly the winner's recipient set, no more");
  assert.equal(db.count("priv_audit", "action = 'send' AND outcome = 'deny' AND reason = 'idempotency_conflict'"), 5);
});

test("conflicting recipient sets raced under one id: one set wins and the other never leaves a partial delivery", { skip }, async () => {
  const { db, store } = await world();
  const out = settledOutcome(await Promise.allSettled([
    store.send(grok, { ...baseSend, toInboxIds: ["ibx_shared01"] }),
    store.send(grok, { ...baseSend, toInboxIds: ["ibx_shared02"] }),
    store.send(grok, { ...baseSend, toInboxIds: ["ibx_shared01", "ibx_shared02"] })
  ]));
  assert.equal(out.filter(o => o.ok).length, 1);
  const delivered = db.rows("SELECT inbox_id FROM priv_deliveries ORDER BY inbox_id").map(r => r.inbox_id);
  const winnerIndex = out.findIndex(o => o.ok);
  const expected = [["ibx_shared01"], ["ibx_shared02"], ["ibx_shared01", "ibx_shared02"]][winnerIndex];
  assert.deepEqual(delivered, expected);
});

test("another connection racing to reuse a message id never takes it over", { skip }, async () => {
  const { db, store } = await world();
  const out = settledOutcome(await Promise.allSettled([store.send(grok, baseSend), store.send(claude, baseSend), store.send(chatgpt, baseSend)]));
  assert.equal(out.filter(o => o.ok).length, 1);
  const winner = [grok, claude, chatgpt][out.findIndex(o => o.ok)];
  assert.equal(db.rows("SELECT sender_connection_id FROM priv_messages")[0].sender_connection_id, winner.connection_id);
});

test("distinct concurrent sends all succeed with independent exact delivery sets", { skip }, async () => {
  const { db, store } = await world();
  const out = settledOutcome(await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    store.send([grok, claude, chatgpt][i % 3], { ...baseSend, messageId: `msg_many_${String(i).padStart(4, "0")}`, threadId: undefined, body: `b${i}` }))));
  assert.ok(out.every(o => o.ok && o.value.created));
  assert.equal(db.count("priv_messages"), 20);
  assert.equal(db.count("priv_deliveries"), 40);
});

test("concurrent createInbox of one id: same definition is idempotent for all; conflicting definitions yield one winner", { skip }, async () => {
  const { db, store } = await world();
  const same = settledOutcome(await Promise.allSettled(Array.from({ length: 8 }, () => store.createInbox(chatgpt, { scope: "home", inboxId: "ibx_newbox01" }))));
  assert.ok(same.every(o => o.ok));
  assert.equal(same.filter(o => o.value.created).length, 1);
  const mixed = settledOutcome(await Promise.allSettled(["chat", "work", "control"].map(plane => store.createInbox(chatgpt, { scope: "home", plane, inboxId: "ibx_newbox02" }))));
  assert.equal(mixed.filter(o => o.ok && o.value.created).length, 1);
  assert.equal(db.count("priv_inboxes", "inbox_id IN ('ibx_newbox01','ibx_newbox02')"), 2);
});

test("a connection-private inbox created concurrently by the same owner gets exactly one owner grant", { skip }, async () => {
  const { db, store } = await world();
  const out = settledOutcome(await Promise.allSettled(Array.from({ length: 6 }, () => store.createInbox(grok, { scope: "connection", inboxId: "ibx_grokpriv" }))));
  assert.ok(out.every(o => o.ok));
  assert.equal(db.count("priv_inbox_grants", "inbox_id = 'ibx_grokpriv'"), 1);
});

// ---------------------------------------------------------------------------------------------
// last-admin protection under concurrency
// ---------------------------------------------------------------------------------------------

const activeAdmins = db => db.count("priv_home_connections", "status = 'active' AND role = 'admin'");

test("two admins demoting each other concurrently: exactly one demotion lands, one admin remains", { skip }, async () => {
  const { db, store } = await world({ grokAdmin: true });
  const out = settledOutcome(await Promise.allSettled([
    store.setConnectionRole(chatgpt, grok.connection_id, "member"),
    store.setConnectionRole(grok, chatgpt.connection_id, "member")
  ]));
  assert.equal(out.filter(o => o.ok).length, 1);
  assert.equal(activeAdmins(db), 1);
});

test("two admins revoking each other concurrently: exactly one revocation lands, one admin remains", { skip }, async () => {
  const { db, store } = await world({ grokAdmin: true });
  const out = settledOutcome(await Promise.allSettled([store.revokeConnection(chatgpt, grok.connection_id), store.revokeConnection(grok, chatgpt.connection_id)]));
  assert.equal(out.filter(o => o.ok).length, 1);
  assert.equal(activeAdmins(db), 1);
});

test("three admins all self-demoting concurrently: at most two succeed and one admin always remains", { skip }, async () => {
  const { db, store } = await world({ grokAdmin: true });
  await store.setConnectionRole(chatgpt, claude.connection_id, "admin");
  const out = settledOutcome(await Promise.allSettled([chatgpt, grok, claude].map(s => store.setConnectionRole(s, s.connection_id, "member"))));
  assert.equal(out.filter(o => o.ok).length, 2);
  assert.equal(activeAdmins(db), 1);
});

test("a demotion racing a revocation of the other admin never leaves zero admins", { skip }, async () => {
  const { db, store } = await world({ grokAdmin: true });
  const out = settledOutcome(await Promise.allSettled([store.setConnectionRole(chatgpt, grok.connection_id, "member"), store.revokeConnection(grok, chatgpt.connection_id)]));
  assert.ok(out.filter(o => o.ok).length <= 1);
  assert.ok(activeAdmins(db) >= 1);
});

test("self-revoke of the last admin is refused even when raced against a member self-revoke", { skip }, async () => {
  const { db, store } = await world();
  const out = settledOutcome(await Promise.allSettled([store.revokeConnection(chatgpt), store.revokeConnection(grok), store.revokeConnection(claude)]));
  assert.equal(out.find((o, i) => i === 0).ok, false, "the sole admin cannot revoke itself");
  assert.equal(activeAdmins(db), 1);
});

// ---------------------------------------------------------------------------------------------
// concurrent read stamps / acks
// ---------------------------------------------------------------------------------------------

test("concurrent reads and acks keep stamps single-valued, ordered and forward-only", { skip }, async () => {
  const { db, store } = await world();
  for (let i = 1; i <= 4; i += 1) await store.send(grok, { ...baseSend, toInboxIds: ["ibx_shared02"], messageId: `msg_stamp_${i}00`, threadId: undefined, body: `b${i}` });
  const out = settledOutcome(await Promise.allSettled([
    store.readInbox(chatgpt, { inboxId: "ibx_shared02" }),
    store.readInbox(claude, { inboxId: "ibx_shared02" }),
    store.readInbox(grok, { inboxId: "ibx_shared02", limit: 2 }),
    store.ack(chatgpt, { inboxId: "ibx_shared02", messageId: "msg_stamp_100" }),
    store.ack(claude, { inboxId: "ibx_shared02", messageId: "msg_stamp_100" })
  ]));
  assert.ok(out.every(o => o.ok));
  assert.equal(out.slice(3).filter(o => o.value.changed).length, 1, "exactly one ack wins");
  for (const row of db.rows("SELECT delivered_at, read_at, acked_at FROM priv_deliveries")) {
    assert.ok(row.read_at && row.delivered_at <= row.read_at);
    if (row.acked_at) assert.ok(row.read_at <= row.acked_at);
  }
  const returned = out.slice(0, 3).flatMap(o => o.value.map(r => `${r.message_id}:${r.read_at}`));
  for (const entry of returned) {
    const [id, stamp] = entry.split(":").concat();
    assert.ok(id.startsWith("msg_stamp_"));
    assert.ok(stamp);
  }
});

// ---------------------------------------------------------------------------------------------
// stale authorization sweep: revoke at EVERY statement boundary of the operation
// ---------------------------------------------------------------------------------------------

async function sweep({ build, op, revoke, protectedWrite }) {
  const probe = await build();
  const start = probe.db.log.length;
  await op(probe).catch(() => {});
  const positions = probe.db.log.length - start;
  assert.ok(positions >= 3, `operation issued only ${positions} statements; the sweep would prove nothing`);
  let blocked = 0;
  for (let k = 0; k < positions; k += 1) {
    const fx = await build();
    let n = 0;
    let revokeSeq = null;
    fx.db.before(() => n++ === k, async () => {
      await revoke(fx);
      revokeSeq = fx.db.seq;
    });
    let failure = null;
    try {
      await op(fx);
    } catch (e) {
      failure = e;
    }
    assert.notEqual(revokeSeq, null, `revocation never fired at position ${k}`);
    if (failure) {
      assert.ok(failure instanceof PrivateRealmError, `position ${k}: raw error leaked: ${failure.message}`);
      assert.ok(AUTH_CODES.has(failure.code), `position ${k}: ${failure.code}`);
      blocked += 1;
    }
    const late = fx.db.writes.filter(w => w.seq > revokeSeq && w.changes > 0 && protectedWrite.test(w.sql));
    assert.deepEqual(late, [], `position ${k}/${positions}: write committed AFTER the revocation: ${late.map(w => w.sql.slice(0, 80)).join(" | ")}`);
  }
  assert.ok(blocked > 0, "at least one position must be blocked, else the revocation never mattered");
  return positions;
}

const MSG_WRITES = /INSERT INTO priv_(messages|deliveries)\b/i;
const READ_STAMP = /UPDATE priv_deliveries SET read_at/i;
const ACK_STAMP = /UPDATE priv_deliveries SET (read_at = COALESCE\(read_at, \?\), )?acked_at/i;
const sendOp = fx => fx.store.send(grok, { ...baseSend, messageId: "msg_sweep_001" });

test("SWEEP send vs revoking the sender's CONNECTION at every statement boundary", { skip }, async () => {
  await sweep({ build: world, op: sendOp, revoke: fx => fx.store.revokeConnection(chatgpt, grok.connection_id), protectedWrite: MSG_WRITES });
});

test("SWEEP send vs revoking the sender's grant on its FROM inbox at every boundary", { skip }, async () => {
  await sweep({ build: world, op: sendOp, revoke: fx => fx.store.revokeGrant(chatgpt, { inboxId: "ibx_shared01", targetConnectionId: grok.connection_id }), protectedWrite: MSG_WRITES });
});

test("SWEEP send vs revoking the sender's grant on a TARGET inbox at every boundary (no partial delivery)", { skip }, async () => {
  await sweep({ build: world, op: sendOp, revoke: fx => fx.store.revokeGrant(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: grok.connection_id }), protectedWrite: MSG_WRITES });
});

test("SWEEP send vs the whole Home becoming unusable (target inbox archived) leaves zero partial rows", { skip }, async () => {
  const positions = await sweep({
    build: world,
    op: sendOp,
    revoke: async fx => { fx.db.exec("UPDATE priv_inboxes SET status = 'archived' WHERE inbox_id = 'ibx_shared02'"); },
    protectedWrite: MSG_WRITES
  });
  assert.ok(positions >= 3);
});

test("SWEEP readInbox vs revoking the reader's connection: no stamp commits after the revocation", { skip }, async () => {
  const build = async () => {
    const fx = await world();
    await fx.store.send(chatgpt, { ...baseSend, toInboxIds: ["ibx_shared02"], messageId: "msg_sweep_r01", threadId: undefined, body: "a" });
    await fx.store.send(chatgpt, { ...baseSend, toInboxIds: ["ibx_shared02"], messageId: "msg_sweep_r02", threadId: undefined, body: "b" });
    return fx;
  };
  await sweep({ build, op: fx => fx.store.readInbox(grok, { inboxId: "ibx_shared02" }), revoke: fx => fx.store.revokeConnection(chatgpt, grok.connection_id), protectedWrite: READ_STAMP });
});

test("SWEEP readInbox vs revoking the reader's READ grant: no stamp commits after the revocation", { skip }, async () => {
  const build = async () => {
    const fx = await world();
    await fx.store.send(chatgpt, { ...baseSend, toInboxIds: ["ibx_shared02"], messageId: "msg_sweep_r01", threadId: undefined, body: "a" });
    return fx;
  };
  await sweep({ build, op: fx => fx.store.readInbox(grok, { inboxId: "ibx_shared02" }), revoke: fx => fx.store.revokeGrant(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: grok.connection_id }), protectedWrite: READ_STAMP });
});

test("SWEEP ack vs revoking the acker's connection: no ack stamp commits after the revocation", { skip }, async () => {
  const build = async () => {
    const fx = await world();
    await fx.store.send(chatgpt, { ...baseSend, toInboxIds: ["ibx_shared02"], messageId: "msg_sweep_a01", threadId: undefined, body: "a" });
    return fx;
  };
  await sweep({ build, op: fx => fx.store.ack(grok, { inboxId: "ibx_shared02", messageId: "msg_sweep_a01" }), revoke: fx => fx.store.revokeConnection(chatgpt, grok.connection_id), protectedWrite: ACK_STAMP });
});

test("SWEEP ack vs revoking the ACK grant: no ack stamp commits after the revocation", { skip }, async () => {
  const build = async () => {
    const fx = await world();
    await fx.store.send(chatgpt, { ...baseSend, toInboxIds: ["ibx_shared02"], messageId: "msg_sweep_a01", threadId: undefined, body: "a" });
    return fx;
  };
  await sweep({ build, op: fx => fx.store.ack(grok, { inboxId: "ibx_shared02", messageId: "msg_sweep_a01" }), revoke: fx => fx.store.revokeGrant(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: grok.connection_id }), protectedWrite: ACK_STAMP });
});

// Admin operations: an admin demoted or revoked mid-call must not complete the privileged write.
const demoteGrok = fx => fx.store.setConnectionRole(chatgpt, grok.connection_id, "member");
const revokeGrokAdmin = fx => fx.store.revokeConnection(chatgpt, grok.connection_id);
const adminWorld = () => world({ grokAdmin: true });

test("SWEEP grantInbox by an admin vs that admin being demoted: no grant commits afterwards", { skip }, async () => {
  const op = fx => fx.store.grantInbox(grok, { inboxId: "ibx_shared01", targetConnectionId: claude.connection_id, caps: { read: true } });
  await sweep({ build: adminWorld, op, revoke: demoteGrok, protectedWrite: /INSERT INTO priv_inbox_grants\b/i });
});

test("SWEEP grantInbox by an admin vs that admin being revoked: no grant commits afterwards", { skip }, async () => {
  const op = fx => fx.store.grantInbox(grok, { inboxId: "ibx_shared01", targetConnectionId: claude.connection_id, caps: { read: true } });
  await sweep({ build: adminWorld, op, revoke: revokeGrokAdmin, protectedWrite: /INSERT INTO priv_inbox_grants\b/i });
});

test("SWEEP revokeGrant by a demoted admin commits nothing afterwards", { skip }, async () => {
  const op = fx => fx.store.revokeGrant(grok, { inboxId: "ibx_shared01", targetConnectionId: claude.connection_id });
  await sweep({ build: adminWorld, op, revoke: demoteGrok, protectedWrite: /UPDATE priv_inbox_grants SET revoked_at/i });
});

test("SWEEP setConnectionRole by a demoted admin commits nothing afterwards", { skip }, async () => {
  const op = fx => fx.store.setConnectionRole(grok, claude.connection_id, "admin");
  await sweep({ build: adminWorld, op, revoke: demoteGrok, protectedWrite: /UPDATE priv_home_connections SET role/i });
});

test("SWEEP revokeConnection by a demoted admin commits nothing afterwards", { skip }, async () => {
  const op = fx => fx.store.revokeConnection(grok, claude.connection_id);
  await sweep({ build: adminWorld, op, revoke: demoteGrok, protectedWrite: /UPDATE priv_home_connections SET status = 'revoked'/i });
});

test("SWEEP createInbox(scope: home) by a demoted admin commits nothing afterwards", { skip }, async () => {
  const op = fx => fx.store.createInbox(grok, { scope: "home", inboxId: "ibx_sweepnew1" });
  await sweep({ build: adminWorld, op, revoke: demoteGrok, protectedWrite: /INSERT INTO priv_inboxes\b/i });
});

// Whole-call linearizability under free-running concurrency: if a send succeeds, it committed BEFORE
// the revocation did. Repeated with every start order.
test("free-running send vs revoke: a successful send always committed before the revocation", { skip }, async () => {
  for (const order of [0, 1]) {
    for (let delay = 0; delay < 8; delay += 1) {
      const { db, store } = await world();
      const send = async () => { for (let i = 0; i < delay; i += 1) await new Promise(r => setImmediate(r)); return store.send(grok, { ...baseSend, messageId: "msg_free_0001" }); };
      const revoke = () => store.revokeConnection(chatgpt, grok.connection_id);
      const tasks = order === 0 ? [send(), revoke()] : [revoke(), send()];
      const results = await Promise.allSettled(tasks);
      settledOutcome(results.slice().sort(() => 0));
      const revokeWrite = db.writes.find(w => /UPDATE priv_home_connections SET status = 'revoked'/i.test(w.sql) && w.changes > 0);
      assert.ok(revokeWrite, "the revocation committed");
      const late = db.writes.filter(w => MSG_WRITES.test(w.sql) && w.changes > 0 && w.seq > revokeWrite.seq);
      assert.deepEqual(late, [], `order=${order} delay=${delay}`);
    }
  }
});
