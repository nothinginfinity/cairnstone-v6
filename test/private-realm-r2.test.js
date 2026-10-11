// S0b-2 private R2 body path: Home/message-scoped, content-addressed, integrity-checked, no shared fallback.
// Real SQLite + real migration; R2 is a minimal in-memory double that records every call.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { PrivateRealmError } from "../src/private-realm/index.js";
import { getPrivateBody, privateBodyKey, putPrivateBody } from "../src/private-realm/r2-body.js";
import { sha256Hex } from "../src/private-realm/hash.js";
import { SQLITE_AVAILABLE, createClock, createFakeR2, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";

const skip = SQLITE_AVAILABLE ? false : "node:sqlite unavailable";
const chatgpt = sc("alice", "chatgpt");
const grok = sc("alice", "grok");
const bob = sc("bobby", "chatgpt");
const full = { read: true, send: true, ack: true };
const LIMIT = 32; // force the R2 path with small bodies
const big = tag => `${tag}:`.padEnd(LIMIT * 2, "x");

const rejectsWith = (fn, code) => assert.rejects(fn, e => e instanceof PrivateRealmError && e.code === code, `expected ${code}`);

async function fixture({ withR2 = true } = {}) {
  const db = createSqliteD1();
  const r2 = createFakeR2();
  const store = createD1HomeStore({ db, now: createClock(), mintId: createMint(), r2: withR2 ? r2 : null, inlineBodyMax: LIMIT });
  await store.ensureDefaultHome(chatgpt);
  await store.ensureDefaultHome(grok);
  for (const id of ["ibx_shared01", "ibx_shared02"]) {
    await store.createInbox(chatgpt, { scope: "home", inboxId: id });
    for (const c of [chatgpt, grok]) await store.grantInbox(chatgpt, { inboxId: id, targetConnectionId: c.connection_id, caps: full });
  }
  const homeId = db.rows("SELECT home_id FROM priv_homes WHERE account_id = 'acct_alice'")[0].home_id;
  return { db, r2, store, homeId };
}
const send = (store, messageId, body, extra = {}) => store.send(chatgpt, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId, body, ...extra });

test("key derivation is Home/message/hash scoped and validates every component", async () => {
  const sha = await sha256Hex("x");
  assert.equal(privateBodyKey("home_abcdefgh01", "msg_00000001", sha), `private/home_abcdefgh01/msg_00000001/${sha}`);
  for (const [h, m, s] of [["x", "msg_00000001", sha], ["home_abcdefgh01", "../escape", sha], ["home_abcdefgh01", "msg_00000001/..", sha], ["home_abcdefgh01", "msg_00000001", "short"], ["home_abcdefgh01", "msg_00000001", sha.toUpperCase()]]) {
    assert.throws(() => privateBodyKey(h, m, s), e => e instanceof PrivateRealmError);
  }
});

test("a body above the inline threshold is stored ONLY in private R2 under its derived key", { skip }, async () => {
  const { db, r2, store, homeId } = await fixture();
  const body = big("large");
  const sent = await send(store, "msg_large_0001", body);
  assert.equal(sent.created, true);
  const sha = await sha256Hex(body);
  const row = db.rows("SELECT body_text, body_r2_key, body_sha256 FROM priv_messages")[0];
  assert.deepEqual({ ...row }, { body_text: null, body_r2_key: `private/${homeId}/msg_large_0001/${sha}`, body_sha256: sha });
  assert.deepEqual([...r2.objects.keys()], [row.body_r2_key]);
  assert.ok(![...r2.calls].some(([, key]) => !key.startsWith(`private/${homeId}/`)), "only Home-scoped private keys are ever touched");
  const inline = await send(store, "msg_small_0001", "tiny");
  assert.equal(inline.created, true);
  assert.equal(db.rows("SELECT body_text, body_r2_key FROM priv_messages WHERE message_id = 'msg_small_0001'")[0].body_r2_key, null);
  assert.equal(r2.objects.size, 1, "inline bodies never touch R2");
});

test("readInbox returns R2 bodies, verified, and stamps them; listInbox never fetches bodies", { skip }, async () => {
  const { db, r2, store } = await fixture();
  const body = big("readme");
  await send(store, "msg_large_0001", body);
  r2.calls.length = 0;
  const listed = await store.listInbox(grok, { inboxId: "ibx_shared02" });
  assert.equal(listed.length, 1);
  assert.deepEqual(r2.calls, [], "list is metadata only");
  const read = await store.readInbox(grok, { inboxId: "ibx_shared02" });
  assert.equal(read[0].body, body);
  assert.equal(read[0].body_status, "ok");
  assert.ok(read[0].read_at);
  assert.equal(db.count("priv_deliveries", "read_at IS NOT NULL"), 1);
  assert.ok(!("body_r2_key" in read[0]), "internal keys never leave the store");
});

test("a tampered R2 object is withheld as integrity_failed and is NOT stamped read", { skip }, async () => {
  const { db, r2, store } = await fixture();
  await send(store, "msg_large_0001", big("good"));
  await send(store, "msg_large_0002", big("victim"));
  const victimKey = db.rows("SELECT body_r2_key FROM priv_messages WHERE message_id = 'msg_large_0002'")[0].body_r2_key;
  r2.objects.set(victimKey, "TAMPERED-BODY");
  const read = await store.readInbox(grok, { inboxId: "ibx_shared02" });
  const by = Object.fromEntries(read.map(r => [r.message_id, r]));
  assert.equal(by.msg_large_0001.body_status, "ok");
  assert.equal(by.msg_large_0002.body_status, "integrity_failed");
  assert.equal(by.msg_large_0002.body, null);
  assert.ok(!JSON.stringify(read).includes("TAMPERED-BODY"));
  assert.equal(by.msg_large_0002.read_at, null);
  assert.equal(db.count("priv_deliveries", "read_at IS NOT NULL"), 1, "only the verified row is stamped");
});

test("a missing R2 object is reported as unavailable and is NOT stamped read", { skip }, async () => {
  const { db, r2, store } = await fixture();
  await send(store, "msg_large_0001", big("gone"));
  r2.objects.clear();
  const read = await store.readInbox(grok, { inboxId: "ibx_shared02" });
  assert.equal(read[0].body_status, "unavailable");
  assert.equal(read[0].body, null);
  assert.equal(db.count("priv_deliveries", "read_at IS NOT NULL"), 0);
  // Without a bound R2 at all the same row is unavailable, never an error that hides the inbox.
  const noR2 = createD1HomeStore({ db, now: createClock(), mintId: createMint(), r2: null, inlineBodyMax: LIMIT });
  assert.equal((await noR2.readInbox(grok, { inboxId: "ibx_shared02" }))[0].body_status, "unavailable");
});

test("a stored key that does not match the row's Home/message/hash is never dereferenced", { skip }, async () => {
  const { db, r2, store, homeId } = await fixture();
  await store.ensureDefaultHome(bob);
  await send(store, "msg_large_0001", big("alice-secret"));
  const foreign = `private/home_foreignhome01/msg_large_0001/${"f".repeat(64)}`;
  r2.objects.set(foreign, "FOREIGN-HOME-SECRET");
  db.exec("DROP TRIGGER priv_messages_no_update"); // simulate corrupted/forged row: the guard must still hold
  db.exec(`UPDATE priv_messages SET body_r2_key = '${foreign}'`);
  r2.calls.length = 0;
  const read = await store.readInbox(grok, { inboxId: "ibx_shared02" });
  assert.equal(read[0].body_status, "integrity_failed");
  assert.ok(!JSON.stringify(read).includes("FOREIGN-HOME-SECRET"));
  assert.ok(!r2.calls.some(([, key]) => key === foreign), "the foreign key was never fetched");
  assert.ok(homeId);
});

test("two Homes using the same message id get distinct objects and read only their own", { skip }, async () => {
  const { db, r2, store } = await fixture();
  await store.ensureDefaultHome(bob);
  await store.createInbox(bob, { scope: "home", inboxId: "ibx_shared01" });
  await store.grantInbox(bob, { inboxId: "ibx_shared01", targetConnectionId: bob.connection_id, caps: full });
  await send(store, "msg_same_00001", big("alice"));
  await store.send(bob, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared01"], messageId: "msg_same_00001", body: big("bobby") });
  assert.equal(r2.objects.size, 2);
  assert.deepEqual((await store.readInbox(bob, { inboxId: "ibx_shared01" })).map(r => r.body.split(":")[0]), ["bobby"]);
  assert.deepEqual((await store.readInbox(grok, { inboxId: "ibx_shared02" })).map(r => r.body.split(":")[0]), ["alice"]);
  assert.equal(db.count("priv_messages", "message_id = 'msg_same_00001'"), 2);
});

test("no R2 binding: an oversize body is refused BEFORE any write, and there is no fallback anywhere", { skip }, async () => {
  const { db, r2, store } = await fixture({ withR2: false });
  await rejectsWith(() => send(store, "msg_large_0001", big("nowhere")), "private_r2_required");
  assert.equal(db.count("priv_messages"), 0);
  assert.equal(db.count("priv_deliveries"), 0);
  assert.equal(r2.calls.length, 0);
  assert.equal((await send(store, "msg_small_0001", "fits inline")).created, true);
});

test("authorization comes BEFORE the R2 write: a denied or revoked sender never creates an object", { skip }, async () => {
  const { r2, store } = await fixture();
  await store.revokeConnection(chatgpt, grok.connection_id);
  await rejectsWith(() => store.send(grok, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_large_0001", body: big("x") }), "scope_not_authorized");
  await store.revokeGrant(chatgpt, { inboxId: "ibx_shared02", targetConnectionId: chatgpt.connection_id });
  await rejectsWith(() => send(store, "msg_large_0002", big("y")), "capability_denied");
  await store.ensureDefaultHome(bob);
  await rejectsWith(() => store.send(bob, { fromInboxId: "ibx_shared01", toInboxIds: ["ibx_shared02"], messageId: "msg_large_0003", body: big("z") }), "capability_denied");
  assert.equal(r2.calls.length, 0);
});

test("replays of a large message do not rewrite the object; conflicting bodies can never overwrite it", { skip }, async () => {
  const { db, r2, store } = await fixture();
  const body = big("original");
  await send(store, "msg_large_0001", body);
  const puts = () => r2.calls.filter(([op]) => op === "put").length;
  assert.equal(puts(), 1);
  assert.equal((await send(store, "msg_large_0001", body)).created, false);
  assert.equal(puts(), 1, "idempotent replay does not touch R2");
  await rejectsWith(() => send(store, "msg_large_0001", big("different")), "capability_denied");
  assert.equal(puts(), 1, "a conflict is detected before any R2 write");
  const key = db.rows("SELECT body_r2_key FROM priv_messages")[0].body_r2_key;
  assert.equal(r2.objects.get(key), body);
});

test("concurrent conflicting large sends: the stored row references the winner's object; the winner is never overwritten", { skip }, async () => {
  const { db, r2, store } = await fixture();
  const bodies = ["a", "b", "c", "d"].map(t => big(`variant-${t}`));
  const results = await Promise.allSettled(bodies.map(body => send(store, "msg_race_00001", body)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason instanceof PrivateRealmError && r.reason.code === "capability_denied"));
  const winner = bodies[results.findIndex(r => r.status === "fulfilled")];
  const row = db.rows("SELECT body_r2_key, body_sha256 FROM priv_messages")[0];
  assert.equal(r2.objects.get(row.body_r2_key), winner);
  // Losers may leave content-addressed orphans (disclosed residual) but cannot have overwritten anything.
  assert.ok(r2.objects.size >= 1);
  for (const [key, text] of r2.objects) assert.ok(key.endsWith(`/${await sha256Hex(text)}`), "every object sits under its own content hash");
});

test("sibling-private and cross-Home reads fetch nothing from R2", { skip }, async () => {
  const { r2, store } = await fixture();
  await store.createInbox(grok, { scope: "connection", inboxId: "ibx_grokpriv" });
  await store.send(grok, { fromInboxId: "ibx_grokpriv", toInboxIds: ["ibx_grokpriv"], messageId: "msg_priv_00001", body: big("grok-private") });
  await store.ensureDefaultHome(bob);
  r2.calls.length = 0;
  await rejectsWith(() => store.readInbox(chatgpt, { inboxId: "ibx_grokpriv" }), "capability_denied");
  await rejectsWith(() => store.readInbox(bob, { inboxId: "ibx_grokpriv" }), "capability_denied");
  await rejectsWith(() => store.readInbox(bob, { inboxId: "ibx_shared02" }), "capability_denied");
  assert.deepEqual(r2.calls, []);
});

test("adapter-level guards: bad R2 handle, hash mismatch on put, wrong key on get", async () => {
  const r2 = createFakeR2();
  const sha = await sha256Hex("hello");
  await assert.rejects(() => putPrivateBody(null, { home_id: "home_abcdefgh01", message_id: "msg_00000001", body_sha256: sha, body: "hello" }), e => e.code === "private_r2_required");
  await assert.rejects(() => putPrivateBody(r2, { home_id: "home_abcdefgh01", message_id: "msg_00000001", body_sha256: sha, body: "hellO" }), e => e.code === "invalid_body_hash");
  const key = await putPrivateBody(r2, { home_id: "home_abcdefgh01", message_id: "msg_00000001", body_sha256: sha, body: "hello" });
  assert.deepEqual(await getPrivateBody(r2, { home_id: "home_abcdefgh01", message_id: "msg_00000001", body_sha256: sha, storedKey: key }), { status: "ok", body: "hello" });
  assert.deepEqual(await getPrivateBody(r2, { home_id: "home_abcdefgh01", message_id: "msg_00000002", body_sha256: sha, storedKey: key }), { status: "integrity_failed" });
  assert.deepEqual(await getPrivateBody(null, { home_id: "home_abcdefgh01", message_id: "msg_00000001", body_sha256: sha, storedKey: key }), { status: "unavailable" });
});

test("source: the private R2 adapter names no shared bucket and no public fallback", () => {
  for (const file of ["r2-body.js", "d1-store.js", "private-worker-core.js", "private-worker.js"]) {
    const code = readFileSync(new URL(`../src/private-realm/${file}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /CAIRNSTONE_R2\b|CAIRNSTONE_DB\b|\.public\b|r2\.dev|getPublicUrl/i, file);
  }
});
