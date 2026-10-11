// Draft private-realm schema (docs/private-realm/schema.sql.draft). Not a migration; never applied.
// Verifies isolation and immutability invariants in an in-memory SQLite database.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* unavailable */ }
const skip = DatabaseSync ? false : "node:sqlite unavailable";

const ddl = readFileSync(new URL("../docs/private-realm/schema.sql.draft", import.meta.url), "utf8");
const T = "2026-10-10T00:00:00Z";

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}
function seed(db) {
  const home = db.prepare("INSERT INTO priv_homes (home_id,account_id,tenant_id,is_default,created_at) VALUES (?,?,?,?,?)");
  home.run("home_alpha000001", "acct_a", "ten_a", 1, T);
  home.run("home_beta0000001", "acct_b", "ten_b", 1, T);
  const conn = db.prepare("INSERT INTO priv_home_connections (home_id,connection_id,principal_id,provider_label,created_at) VALUES (?,?,?,?,?)");
  conn.run("home_alpha000001", "conn_a_chatgpt", "prin_a_chatgpt", "chatgpt", T);
  conn.run("home_alpha000001", "conn_a_claude", "prin_a_claude", "claude", T);
  conn.run("home_beta0000001", "conn_b_chatgpt", "prin_b_chatgpt", "chatgpt", T);
  const ibx = db.prepare("INSERT INTO priv_inboxes (home_id,inbox_id,scope,plane,owner_connection_id,created_at) VALUES (?,?,?,?,?,?)");
  ibx.run("home_alpha000001", "ibx_a_home01", "home", "chat", null, T);
  ibx.run("home_alpha000001", "ibx_a_cgpt01", "connection", "chat", "conn_a_chatgpt", T);
  ibx.run("home_beta0000001", "ibx_b_home01", "home", "chat", null, T);
}
function msg(db, home, id, inbox, conn) {
  db.prepare("INSERT INTO priv_messages (home_id,message_id,thread_id,sender_inbox_id,sender_connection_id,body_sha256,body_text,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(home, id, "thr_1", inbox, conn, "a".repeat(64), "hello", T);
}

test("schema loads and the Home is account-owned, provider is only a connection label", { skip }, () => {
  const db = fresh();
  seed(db);
  const cols = db.prepare("PRAGMA table_info(priv_homes)").all().map(c => c.name);
  assert.ok(!cols.includes("provider") && !cols.includes("provider_label"));
  const row = db.prepare("SELECT COUNT(*) n FROM priv_home_connections WHERE home_id='home_alpha000001'").get();
  assert.equal(row.n, 2, "one Home carries several provider connections");
});

test("only one default Home per account", { skip }, () => {
  const db = fresh();
  seed(db);
  assert.throws(() => db.prepare("INSERT INTO priv_homes (home_id,account_id,tenant_id,is_default,created_at) VALUES (?,?,?,1,?)").run("home_alpha000002", "acct_a", "ten_a", T));
  db.prepare("INSERT INTO priv_homes (home_id,account_id,tenant_id,is_default,created_at) VALUES (?,?,?,0,?)").run("home_alpha000002", "acct_a", "ten_a", T);
});

test("opaque ID shapes are enforced", { skip }, () => {
  const db = fresh();
  assert.throws(() => db.prepare("INSERT INTO priv_homes (home_id,account_id,tenant_id,created_at) VALUES (?,?,?,?)").run("alice", "acct_a", "ten_a", T));
  assert.throws(() => db.prepare("INSERT INTO priv_homes (home_id,account_id,tenant_id,created_at) VALUES (?,?,?,?)").run("home_alpha000001", "chatgpt:chat", "ten_a", T));
});

test("a connection cannot be attached to two Homes", { skip }, () => {
  const db = fresh();
  seed(db);
  assert.throws(() => db.prepare("INSERT INTO priv_home_connections (home_id,connection_id,principal_id,created_at) VALUES (?,?,?,?)").run("home_beta0000001", "conn_a_chatgpt", "prin_x", T));
});

test("connection-private inbox must name a connection of the same Home", { skip }, () => {
  const db = fresh();
  seed(db);
  const ins = db.prepare("INSERT INTO priv_inboxes (home_id,inbox_id,scope,plane,owner_connection_id,created_at) VALUES (?,?,?,?,?,?)");
  assert.throws(() => ins.run("home_alpha000001", "ibx_bad_x1", "connection", "chat", null, T), "connection scope needs owner");
  assert.throws(() => ins.run("home_alpha000001", "ibx_bad_x2", "home", "chat", "conn_a_chatgpt", T), "home scope must not name owner");
  assert.throws(() => ins.run("home_alpha000001", "ibx_bad_x3", "connection", "chat", "conn_b_chatgpt", T), "cross-Home owner rejected by composite FK");
});

test("cross-Home references are rejected by composite foreign keys", { skip }, () => {
  const db = fresh();
  seed(db);
  assert.throws(() => db.prepare("INSERT INTO priv_inbox_grants (home_id,inbox_id,connection_id,can_read,granted_at) VALUES (?,?,?,1,?)").run("home_alpha000001", "ibx_a_home01", "conn_b_chatgpt", T));
  assert.throws(() => db.prepare("INSERT INTO priv_inbox_grants (home_id,inbox_id,connection_id,can_read,granted_at) VALUES (?,?,?,1,?)").run("home_alpha000001", "ibx_b_home01", "conn_a_chatgpt", T));
  assert.throws(() => msg(db, "home_alpha000001", "msg_cross_01", "ibx_b_home01", "conn_a_chatgpt"));
  msg(db, "home_alpha000001", "msg_ok_000001", "ibx_a_home01", "conn_a_chatgpt");
  assert.throws(() => db.prepare("INSERT INTO priv_deliveries (home_id,message_id,inbox_id,delivered_at) VALUES (?,?,?,?)").run("home_alpha000001", "msg_ok_000001", "ibx_b_home01", T));
});

test("messages are immutable", { skip }, () => {
  const db = fresh();
  seed(db);
  msg(db, "home_alpha000001", "msg_imm_0001", "ibx_a_home01", "conn_a_claude");
  assert.throws(() => db.exec("UPDATE priv_messages SET body_text='x'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM priv_messages"), /immutable/);
});

test("message needs a body location and a full sha256", { skip }, () => {
  const db = fresh();
  seed(db);
  const ins = db.prepare("INSERT INTO priv_messages (home_id,message_id,thread_id,sender_inbox_id,sender_connection_id,body_sha256,body_text,body_r2_key,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  assert.throws(() => ins.run("home_alpha000001", "msg_nobody_01", "t", "ibx_a_home01", "conn_a_claude", "a".repeat(64), null, null, T));
  assert.throws(() => ins.run("home_alpha000001", "msg_shortsha1", "t", "ibx_a_home01", "conn_a_claude", "abc", "x", null, T));
});

test("deliveries: read/ack may be set once, identity frozen, no delete", { skip }, () => {
  const db = fresh();
  seed(db);
  msg(db, "home_alpha000001", "msg_del_00001", "ibx_a_home01", "conn_a_claude");
  db.prepare("INSERT INTO priv_deliveries (home_id,message_id,inbox_id,delivered_at) VALUES (?,?,?,?)").run("home_alpha000001", "msg_del_00001", "ibx_a_cgpt01", T);
  db.exec("UPDATE priv_deliveries SET read_at='2026-10-10T01:00:00Z'");
  assert.throws(() => db.exec("UPDATE priv_deliveries SET read_at=NULL"), /backwards/);
  assert.throws(() => db.exec("UPDATE priv_deliveries SET read_at='2026-10-10T02:00:00Z'"), /backwards/);
  assert.throws(() => db.exec("UPDATE priv_deliveries SET inbox_id='ibx_a_home01'"), /identity/);
  assert.throws(() => db.exec("DELETE FROM priv_deliveries"), /append-only/);
  db.exec("UPDATE priv_deliveries SET acked_at='2026-10-10T03:00:00Z'");
});

test("audit is append-only", { skip }, () => {
  const db = fresh();
  db.prepare("INSERT INTO priv_audit (action,outcome,reason,created_at) VALUES (?,?,?,?)").run("get_inbox", "deny", "no_grant", T);
  assert.throws(() => db.exec("UPDATE priv_audit SET outcome='allow'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM priv_audit"), /append-only/);
});

test("draft contains no credential columns and no shared-store coupling", () => {
  assert.doesNotMatch(ddl, /\b(token|secret|password|refresh)\w*\s+(TEXT|BLOB)/i);
  assert.doesNotMatch(ddl, /REFERENCES\s+(stones|refs|auth_)/i);
});
