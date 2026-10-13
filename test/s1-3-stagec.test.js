// Source CI for issue #89: the Stage C driver, evidence handling and fail-closed behaviour.
// The matrix runs against the REAL pinned private-staging core + REAL staging migrations on SQLite (S1_3_SOURCE_DIR).
// This proves the driver and the triggers; it is NOT live acceptance. Live acceptance needs the s1-3-stagec-e2e workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  STAGEC, runStageC, redact, createHttpHarness, createD1Http, makeCleanup, snapshot,
  assertReadOnlySql, assertAbortProbeSql, ALL_PROBES, connectionIdOf, inboxIdOf
} from "../scripts/staging/s1-3-stagec-lib.mjs";

const SHA = "ce565ef97eb7b5a6847679604e1abb42daaef700";
const sourceDir = process.env.S1_3_SOURCE_DIR ? resolve(process.env.S1_3_SOURCE_DIR) : null;
const haveSource = sourceDir && existsSync(resolve(sourceDir, "migrations/private-staging/0002_parity_role_and_authz_triggers.sql"));
// The dedicated gates set S1_3_REQUIRE_SOURCE=1 so a missing checkout can never turn into a silent skip there.
// The repo-wide `node --test` gate has no pinned checkout: source-dependent tests skip, pure tests still run.
if (!haveSource && process.env.S1_3_REQUIRE_SOURCE === "1") throw new Error("S1_3_SOURCE_DIR must point at the pinned source when S1_3_REQUIRE_SOURCE=1");
const skip = haveSource ? false : "S1_3_SOURCE_DIR (pinned source checkout) not set";
const { createInProcessHarness } = haveSource ? await import("./helpers/stagec-inprocess-harness.mjs") : {};

let seq = 0;
const nextRun = () => `t${String(++seq).padStart(5, "0")}`;
async function run(variant = {}, opts = {}) {
  const h = await createInProcessHarness({ sourceDir, variant });
  const evidence = await runStageC({ harness: h.harness, d1: h.d1, runId: nextRun(), sourceSha: SHA, allowStubs: true, ...opts });
  return { ...h, evidence };
}
const byId = (e, id) => e.cases.find((c) => c.id === id);

test("full matrix passes on the real staging core + schema; evidence is marked simulated", { skip }, async () => {
  const { evidence } = await run();
  for (const c of evidence.cases) assert.equal(c.ok, true, `${c.id} ${c.title}: ${JSON.stringify(c.observed)}`);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.mode, "simulated");
  assert.deepEqual(evidence.cases.map((c) => c.id), ["C00", "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08"]);
  assert.equal(evidence.source_sha, SHA);
  assert.match(evidence.evidence_sha256, /^[0-9a-f]{64}$/);
});

test("fixtures: two accounts x two providers, roles and per-provider separation", { skip }, async () => {
  const { evidence, db } = await run();
  assert.deepEqual(byId(evidence, "C00").observed, { "alpha.chatgpt": "admin", "alpha.grok": "member", "bravo.chatgpt": "admin", "bravo.grok": "member" });
  assert.equal(db.count("priv_homes"), 2);
  assert.equal(db.count("priv_home_connections"), 4);
});

test("evidence never carries signatures, nonces, tokens or message bodies", { skip }, async () => {
  const { evidence } = await run();
  const text = JSON.stringify(evidence);
  assert.doesNotMatch(text.replace(evidence.evidence_sha256, ""), /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/);
  assert.doesNotMatch(text, /synthetic stage C message|synthetic cross-home|synthetic after revoke|Bearer /);
});

test("a live run refuses simulated probes (allowStubs=false fails the stub-dependent cases)", { skip }, async () => {
  const h = await createInProcessHarness({ sourceDir });
  const e = await runStageC({ harness: h.harness, d1: h.d1, runId: nextRun(), sourceSha: SHA });
  assert.equal(e.mode, "live");
  assert.equal(e.ok, false);
  for (const id of ["C03", "C04", "C06", "C08"]) assert.equal(byId(e, id).ok, false, id);
  for (const id of ["C00", "C01", "C02", "C05"]) assert.equal(byId(e, id).ok, true, id);
});

// ---- mutation checks: break the system, the driver must notice ----
test("MUTATION: sender trigger missing -> C02 fails and names the stray row", { skip }, async () => {
  const { evidence } = await run({ dropSenderTrigger: true });
  const c = byId(evidence, "C02");
  assert.equal(c.ok, false);
  assert.equal(c.observed.trigger_messages, "NOT_ABORTED");
  assert.ok(c.observed.stray?.stray_message_id);
  assert.equal(evidence.ok, false);
});
test("MUTATION: delivery trigger missing -> C02 fails", { skip }, async () => {
  const { evidence } = await run({ dropDeliveryTrigger: true });
  assert.equal(byId(evidence, "C02").ok, false);
  assert.equal(byId(evidence, "C02").observed.trigger_deliveries, "NOT_ABORTED");
});
test("MUTATION: durable nonce barrier removed -> replay is accepted twice and C03 fails", { skip }, async () => {
  const { evidence } = await run({ noNonceKey: true });
  const c = byId(evidence, "C03");
  assert.equal(c.ok, false);
  assert.equal(c.observed.second_denied_caller_not_authorized, false);
  assert.equal(c.observed.exactly_one_nonce_receipt_in_d1, false);
  assert.equal(evidence.ok, false);
});
test("MUTATION: platform caller ignored -> C04 fails", { skip }, async () => {
  const { evidence } = await run({ ignorePlatform: true });
  assert.equal(byId(evidence, "C04").ok, false);
});
test("MUTATION: typed denials collapse to private_store_error across the boundary -> C07 fails (PR #86 safeCodes finding)", { skip }, async () => {
  const { evidence } = await run({ collapseCodes: true });
  assert.equal(byId(evidence, "C07").ok, false);
  assert.equal(byId(evidence, "C07").observed.none_degraded_to_private_store_error, false);
  assert.equal(evidence.ok, false);
});

test("D1 state after the matrix: revoked grok cannot send, other account unaffected, nothing deleted", { skip }, async () => {
  const { db } = await run();
  const revoked = db.rows("SELECT revoked_at FROM priv_inbox_grants WHERE connection_id = ? AND inbox_id = ?", connectionIdOf({ account: "alpha", provider: "grok" }), inboxIdOf("alpha", "main"))[0];
  assert.ok(revoked.revoked_at);
  const live = db.rows("SELECT revoked_at FROM priv_inbox_grants WHERE connection_id = ? AND inbox_id = ?", connectionIdOf({ account: "bravo", provider: "grok" }), inboxIdOf("bravo", "main"))[0];
  assert.equal(live.revoked_at, null);
  assert.equal(db.count("priv_service_nonces", "caller = ?", STAGEC.caller) > 0, true);
});

test("cleanup is gated on the exact owner phrase AND an approval id; it never deletes messages", { skip }, async () => {
  assert.deepEqual(await makeCleanup({ approval: "yes", approvalId: "OP-12345" })({}), { performed: false, reason: "not_approved" });
  assert.deepEqual(await makeCleanup({ approval: STAGEC.cleanupPhrase, approvalId: "" })({}), { performed: false, reason: "not_approved" });
  const h = await createInProcessHarness({ sourceDir });
  const e = await runStageC({ harness: h.harness, d1: h.d1, runId: nextRun(), sourceSha: SHA, allowStubs: true, cleanup: makeCleanup({ approval: STAGEC.cleanupPhrase, approvalId: "OP-2026-10-11" }) });
  assert.equal(e.cleanup.performed, true);
  assert.match(e.cleanup.scope, /messages are immutable/);
  assert.ok(h.db.count("priv_messages") > 0);
});

// ---- pure unit tests (no source checkout needed) ----
test("redact: hex, tokens, secret-named keys and long strings", () => {
  const r = redact({ sig: "abc", nonce: "n".repeat(20), body: "private text", ok: true, h: "a".repeat(64), jwt: "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbb.cccccccccc", long: "x".repeat(500), nested: { token: "t" } });
  assert.equal(r.sig, "[redacted:3]"); assert.equal(r.body, "[redacted:12]"); assert.equal(r.h, "[redacted:hex]");
  assert.equal(r.jwt, "[redacted:token]"); assert.equal(r.nested.token, "[redacted:1]"); assert.equal(r.ok, true);
  assert.ok(r.long.length < 100);
});

test("sql guards: read-only and abort-probe allow-lists", () => {
  assertReadOnlySql("SELECT 1"); assertReadOnlySql("PRAGMA table_info(priv_homes)");
  for (const bad of ["DELETE FROM priv_homes", "SELECT 1; DROP TABLE priv_homes", "UPDATE priv_homes SET status='x'", "INSERT INTO priv_homes(a) VALUES(1)"]) assert.throws(() => assertReadOnlySql(bad), /read_only/);
  assertAbortProbeSql("INSERT INTO priv_messages (home_id) VALUES (?)"); assertAbortProbeSql("INSERT INTO priv_deliveries (home_id) VALUES (?)");
  for (const bad of ["INSERT INTO priv_homes (a) VALUES (1)", "INSERT INTO priv_messages (a) VALUES (1); DELETE FROM priv_audit", "UPDATE priv_messages SET body_text='x'", "DELETE FROM priv_messages"]) assert.throws(() => assertAbortProbeSql(bad), /not_allowed/);
});

test("http harness: https only, no creds/query, never the private worker, token required, no redirects", async () => {
  const tok = "t".repeat(24);
  for (const url of [undefined, "", "http://h.example.com", "https://u:p@h.example.com", "https://h.example.com/?a=1", `https://${STAGEC.worker}.x.workers.dev`])
    assert.throws(() => createHttpHarness({ url, token: tok }), /harness_/, String(url));
  assert.throws(() => createHttpHarness({ url: "https://h.example.com", token: "short" }), /harness_token_missing/);
  const seen = [];
  const h = createHttpHarness({ url: "https://h.example.com", token: tok, runId: "abc123", fetchImpl: async (u, init) => { seen.push({ u, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  await h.call({ account: "alpha", provider: "grok" }, "listInboxes", []);
  await h.probe("bad_sig", { identity: {} });
  assert.equal(seen[0].u, "https://h.example.com/stagec/v1/call"); assert.equal(seen[1].u, "https://h.example.com/stagec/v1/probe");
  assert.equal(seen[0].init.redirect, "error"); assert.equal(seen[0].init.headers["X-Stagec-Run"], "abc123");
  assert.equal(JSON.parse(seen[0].init.body).identity.account, "alpha");
  const down = createHttpHarness({ url: "https://h.example.com", token: tok, fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } }) });
  await assert.rejects(() => down.call({}, "x"), /harness_non_json_response:502/);
  const boom = createHttpHarness({ url: "https://h.example.com", token: tok, fetchImpl: async () => { throw new Error("net"); } });
  await assert.rejects(() => boom.call({}, "x"), /harness_network_error/);
  const err500 = createHttpHarness({ url: "https://h.example.com", token: tok, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ oops: 1 }) }) });
  await assert.rejects(() => err500.call({}, "x"), /harness_http_500/);
});

test("d1 rest: pinned database only, read-only queries, abort probe interprets the API error", async () => {
  const acct = "a".repeat(32), tok = "t".repeat(24);
  assert.throws(() => createD1Http({ token: tok, accountId: acct, dbId: "26d4e786-2da7-47a4-a159-1ba206712b13" }), /reviewed_staging_database/);
  assert.throws(() => createD1Http({ token: "x", accountId: acct }), /credentials/);
  const calls = [];
  const mk = (reply) => createD1Http({ token: tok, accountId: acct, fetchImpl: async (u, init) => { calls.push({ u, body: JSON.parse(init.body) }); return { status: 200, json: async () => reply }; } });
  assert.deepEqual(await mk({ success: true, result: [{ results: [{ n: 1 }] }] }).query("SELECT 1 AS n", [7]), [{ n: 1 }]);
  assert.match(calls[0].u, new RegExp(`/d1/database/${STAGEC.d1Id}/query$`)); assert.deepEqual(calls[0].body.params, [7]);
  await assert.rejects(() => mk({ success: false }).query("SELECT 1"), /d1_query_failed/);
  await assert.rejects(() => mk({ success: true }).query("DELETE FROM priv_homes"), /read_only/);
  const ins = "INSERT INTO priv_messages (home_id) VALUES (?)";
  assert.deepEqual(await mk({ success: false, errors: [{ message: "D1_ERROR: sender_not_authorized" }] }).expectAbort(ins, ["h"]), { aborted: true, message: "D1_ERROR: sender_not_authorized" });
  assert.deepEqual(await mk({ success: true, result: [{ results: [] }] }).expectAbort(ins, ["h"]), { aborted: false, message: "" });
});

test("input validation: run id, source sha, harness and d1 are mandatory", async () => {
  const stub = { call: async () => ({}), probe: async () => ({}), kind: "x" };
  await assert.rejects(() => runStageC({}), /harness_and_d1_required/);
  await assert.rejects(() => runStageC({ harness: stub, d1: stub, runId: "BAD!", sourceSha: SHA }), /run_id/);
  await assert.rejects(() => runStageC({ harness: stub, d1: stub, runId: "abcdef", sourceSha: "abc" }), /source_sha/);
  assert.ok(ALL_PROBES.includes("replay_same_nonce"));
});

test("a harness that cannot answer fails the run closed (setup fails, nothing else runs)", async () => {
  const dead = { kind: "dead", call: async () => { throw new Error("down"); }, probe: async () => { throw new Error("down"); } };
  const d1 = { kind: "none", query: async () => [{ m: 0, d: 0, n: 0, g: 0, c: 0, h: 0, i: 0 }] };
  const e = await runStageC({ harness: dead, d1, runId: "abcdef", sourceSha: SHA });
  assert.equal(e.ok, false);
  assert.deepEqual(e.cases.map((c) => c.id), ["C00"]);
  assert.equal(await snapshot(d1).then((s) => s.m), 0);
});

// ---- Cloudflare Access service token (issue #101) ----
const ACCESS_ID = "0123456789abcdef0123456789abcdef.access";
const ACCESS_SECRET = "f".repeat(64);
const okFetch = (seen) => async (u, init) => { seen.push({ u, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };

test("access service token: both headers are sent IN ADDITION to the bearer token, redirects still error, evidence labelled", async () => {
  const tok = "t".repeat(24), seen = [];
  const h = createHttpHarness({ url: "https://h.example.com", token: tok, runId: "r1", accessClientId: ACCESS_ID, accessClientSecret: ACCESS_SECRET, fetchImpl: okFetch(seen) });
  await h.call({ account: "alpha", provider: "grok" }, "listInboxes", []);
  await h.probe("bad_sig", {});
  assert.equal(seen.length, 2);
  for (const { u, init } of seen) {
    assert.equal(init.headers["CF-Access-Client-Id"], ACCESS_ID);
    assert.equal(init.headers["CF-Access-Client-Secret"], ACCESS_SECRET);
    assert.equal(init.headers.Authorization, `Bearer ${tok}`, "bearer authentication is never weakened or replaced");
    assert.equal(init.redirect, "error");
    assert.equal(new URL(u).origin, "https://h.example.com", "credentials only go to the pinned harness origin");
    assert.ok(!String(init.body).includes(ACCESS_SECRET) && !u.includes(ACCESS_SECRET), "never in the body or URL");
  }
  assert.equal(h.access_auth, "service-token");
});

test("access service token: absent (or empty-string, as unset GitHub secrets arrive) sends NO Access headers", async () => {
  const tok = "t".repeat(24);
  for (const creds of [{}, { accessClientId: "", accessClientSecret: "" }, { accessClientId: undefined, accessClientSecret: null }]) {
    const seen = [];
    const h = createHttpHarness({ url: "https://h.example.com", token: tok, fetchImpl: okFetch(seen), ...creds });
    await h.call({}, "x");
    assert.equal("CF-Access-Client-Id" in seen[0].init.headers, false);
    assert.equal("CF-Access-Client-Secret" in seen[0].init.headers, false);
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${tok}`);
    assert.equal(h.access_auth, "none");
  }
});

test("access service token: half-configured or malformed credentials fail closed, before any request, without echoing values", () => {
  const tok = "t".repeat(24), url = "https://h.example.com";
  const never = async () => { throw new Error("no network expected"); };
  const mk = (accessClientId, accessClientSecret) => () => createHttpHarness({ url, token: tok, accessClientId, accessClientSecret, fetchImpl: never });
  assert.throws(mk(ACCESS_ID, undefined), /harness_access_credentials_incomplete/);
  assert.throws(mk(undefined, ACCESS_SECRET), /harness_access_credentials_incomplete/);
  assert.throws(mk(ACCESS_ID, ""), /harness_access_credentials_incomplete/);
  for (const [id, secret] of [
    ["short", ACCESS_SECRET], [ACCESS_ID, "short"], [`${ACCESS_ID}\r\nX-Evil: 1`, ACCESS_SECRET], [ACCESS_ID, `${ACCESS_SECRET}\nX-Evil: 1`],
    [`${ACCESS_ID} `, ACCESS_SECRET], [ACCESS_ID, `${ACCESS_SECRET} extra`], [12345678901234567890, ACCESS_SECRET], [ACCESS_ID, { toString: () => ACCESS_SECRET }]
  ]) {
    assert.throws(mk(id, secret), (e) => e.code === "harness_access_credentials_malformed" && !String(e.message).includes(ACCESS_SECRET) && !String(e.message).includes(ACCESS_ID));
  }
});

test("access service token: a wrong identity (Access refuses or redirects) fails closed and the values never leak into the error", async () => {
  const tok = "t".repeat(24);
  const redirected = createHttpHarness({ url: "https://h.example.com", token: tok, accessClientId: ACCESS_ID, accessClientSecret: ACCESS_SECRET, fetchImpl: async () => { throw new TypeError(`redirect mode is set to error ${ACCESS_SECRET}`); } });
  await assert.rejects(() => redirected.call({}, "x"), (e) => e.code === "harness_network_error" && !e.message.includes(ACCESS_SECRET));
  const refused = createHttpHarness({ url: "https://h.example.com", token: tok, accessClientId: ACCESS_ID, accessClientSecret: ACCESS_SECRET, fetchImpl: async () => ({ ok: false, status: 403, json: async () => { throw new Error("<html>forbidden</html>"); } }) });
  await assert.rejects(() => refused.call({}, "x"), /harness_non_json_response:403/);
});

test("access service token: redaction treats Access secret field names as secret", () => {
  const out = redact({ client_secret: ACCESS_SECRET, "CF-Access-Client-Secret": ACCESS_SECRET, access_client_secret: ACCESS_SECRET, ok: true });
  assert.ok(!JSON.stringify(out).includes(ACCESS_SECRET));
  assert.equal(out.ok, true);
});

// ---- CLI + live readback (fake network) ----
import { main } from "../scripts/staging/s1-3-stagec.mjs";
import { liveReadbackCase, readDeploymentTag } from "../scripts/staging/s1-3-stagec-lib.mjs";

const goodEnv = { CLOUDFLARE_API_TOKEN: "t".repeat(24), CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), STAGE_C_HARNESS_URL: "https://h.example.com", STAGE_C_HARNESS_TOKEN: "h".repeat(24), SOURCE_SHA: SHA, STAGE_C_RUN_ID: "abcdef" };
const capture = () => { const out = {}; return { out, write: (f, t) => { out[f] = JSON.parse(t); } }; };

test("cli: usage error is exit 2; missing config fails closed with no network traffic", async () => {
  const net = []; const fetchImpl = async (...a) => { net.push(a); throw new Error("no network expected"); };
  assert.equal(await main([], {}, { fetchImpl, write: () => {} }), 2);
  const c = capture();
  assert.equal(await main(["run", "--receipt", "r.json"], {}, { fetchImpl, write: c.write }), 1);
  assert.equal(c.out["r.json"].ok, false);
  assert.equal(c.out["r.json"].aborted, "cloudflare_credentials_missing_or_malformed");
  const c2 = capture();
  assert.equal(await main(["run", "--receipt", "r.json"], { ...goodEnv, STAGE_C_HARNESS_URL: "" }, { fetchImpl, write: c2.write }), 1);
  assert.equal(c2.out["r.json"].aborted, "harness_url_missing_or_invalid");
  assert.equal(net.length, 0);
});

test("cli: Access service token env is validated before any network call, and never lands in the receipt", async () => {
  const net = []; const fetchImpl = async (...a) => { net.push(a); throw new Error("no network expected"); };
  const half = capture();
  assert.equal(await main(["run", "--receipt", "r.json"], { ...goodEnv, STAGE_C_ACCESS_CLIENT_ID: ACCESS_ID, STAGE_C_ACCESS_CLIENT_SECRET: "" }, { fetchImpl, write: half.write }), 1);
  assert.equal(half.out["r.json"].aborted, "harness_access_credentials_incomplete");
  const bad = capture();
  assert.equal(await main(["run", "--receipt", "r.json"], { ...goodEnv, STAGE_C_ACCESS_CLIENT_ID: "x", STAGE_C_ACCESS_CLIENT_SECRET: ACCESS_SECRET }, { fetchImpl, write: bad.write }), 1);
  assert.equal(bad.out["r.json"].aborted, "harness_access_credentials_malformed");
  assert.ok(!JSON.stringify([half.out, bad.out]).includes(ACCESS_SECRET));
  assert.equal(net.length, 0);
});

test("cli: with a service token configured the harness request carries it (after the D1 schema gate), and the receipt holds no secret", async () => {
  const harnessCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://h.example.com")) { harnessCalls.push(init.headers); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [] }] }) }; // schema fails: nothing is sent to the harness
  };
  const c = capture();
  const env = { ...goodEnv, STAGE_C_ACCESS_CLIENT_ID: ACCESS_ID, STAGE_C_ACCESS_CLIENT_SECRET: ACCESS_SECRET };
  assert.equal(await main(["run", "--receipt", "r.json"], env, { fetchImpl, write: c.write }), 1);
  assert.match(c.out["r.json"].aborted, /d1_schema_not_verified/);
  assert.equal(harnessCalls.length, 0, "the Access token is never presented before the live D1 schema verifies");
  assert.ok(!JSON.stringify(c.out).includes(ACCESS_SECRET));
});

test("cli: if the live D1 schema does not verify, NO harness call is made (trigger probes must never run on an unprotected DB)", async () => {
  const harnessCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://h.example.com")) { harnessCalls.push(url); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [] }] }) }; // empty schema: no role column, no triggers
  };
  const c = capture();
  assert.equal(await main(["run", "--receipt", "r.json"], goodEnv, { fetchImpl, write: c.write }), 1);
  assert.match(c.out["r.json"].aborted, /d1_schema_not_verified/);
  assert.equal(harnessCalls.length, 0);
  assert.equal(c.out["r.json"].mode, "live");
});

const fakeLib = (ok) => ({ runReadback: async () => ({ ok, checks: [] }) });
const fakeCf = (over = {}) => ({
  accountId: "a".repeat(32),
  get: async (path) => {
    if (path.endsWith("/deployments")) return over.deployments ?? { result: { items: [{ annotations: { "workers/tag": `s1-3-${SHA.slice(0, 12)}` } }] } };
    if (path.endsWith("/workers/subdomain")) return { result: { subdomain: "acct" } };
    if (path.endsWith("/gw/settings")) return over.gw ?? { result: { bindings: [{ type: "service", name: "CAIRNSTONE_PRIVATE_STAGE", service: STAGEC.worker, props: { caller: STAGEC.caller } }] } };
    throw new Error(`unexpected ${path}`);
  }
});
const blocked = async () => ({ status: 404 });

test("readback case: passes when tag, subdomain probe and gateway props line up", async () => {
  const r = await liveReadbackCase({ cf: fakeCf(), lib: fakeLib(true), fetchImpl: blocked, sourceSha: SHA, gatewayWorker: "gw" });
  assert.equal(r.ok, true, JSON.stringify(r.observed));
  assert.deepEqual(r.warnings, []);
});
test("readback case: fails on wrong deployment tag, public 200, wrong props, extra bindings, or failed #87 readback", async () => {
  const run = (cf, lib = fakeLib(true), fetchImpl = blocked) => liveReadbackCase({ cf, lib, fetchImpl, sourceSha: SHA, gatewayWorker: "gw" });
  assert.equal((await run(fakeCf({ deployments: { result: { items: [] } } }))).ok, false);
  assert.equal((await run(fakeCf(), fakeLib(true), async () => ({ status: 200 }))).ok, false);
  assert.equal((await run(fakeCf({ gw: { result: { bindings: [{ type: "service", service: STAGEC.worker, props: { caller: "evil" } }] } } }))).ok, false);
  assert.equal((await run(fakeCf({ gw: { result: { bindings: [{ type: "service", service: STAGEC.worker }, { type: "service", service: STAGEC.worker }] } } }))).ok, false);
  assert.equal((await run(fakeCf(), fakeLib(false))).ok, false);
});
test("readback case: props not returned by the API is a loud warning, not a silent pass", async () => {
  const r = await liveReadbackCase({ cf: fakeCf({ gw: { result: { bindings: [{ type: "service", service: STAGEC.worker }] } } }), lib: fakeLib(true), fetchImpl: blocked, sourceSha: SHA, gatewayWorker: "gw" });
  assert.equal(r.ok, true);
  assert.match(r.warnings[0], /props_not_returned_by_api/);
  const none = await liveReadbackCase({ cf: fakeCf(), lib: fakeLib(true), fetchImpl: blocked, sourceSha: SHA });
  assert.match(none.warnings[0], /STAGE_C_GATEWAY_WORKER not set/);
  assert.equal((await readDeploymentTag(fakeCf(), { sourceSha: "nothex" })).ok, false);
});
