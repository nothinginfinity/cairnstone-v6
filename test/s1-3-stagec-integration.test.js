// Issue #94: non-stub Stage C integration. The real PR #93 driver runs through the real harness Worker, real signed envelopes,
// service-binding doubles with props.caller, the real private staging core and real staging schema on SQLite.
// This replaces the former `stub:true` harness. It is still NOT live acceptance: the platform (service bindings, isolates,
// Workers RPC error transport, Cloudflare APIs) is simulated here. Live acceptance is the owner-dispatched workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runStageC, STAGEC, ALL_PROBES } from "../scripts/staging/s1-3-stagec-lib.mjs";
import { createRig, SQLITE_AVAILABLE, HARNESS_TOKEN, HMAC } from "./helpers/stagec-e2e-rig.mjs";
import { HARNESS_PROBES } from "../src/staging-gateway/stagec-harness-core.js";
import { privateErrorCode } from "../src/staging-gateway/private-error-code.js";
import { createStagingPrivateStoreClient } from "../src/staging-gateway/private-staging-gateway-client.js";
import { PrivateRealmError } from "../src/private-realm/scope.js";

const skip = SQLITE_AVAILABLE ? false : "node:sqlite unavailable";
const SHA = "bec2e2e8f0287ac1ff84280344166f1f1d9b9fb0";
let n = 0;
const rid = () => `i${String(++n).padStart(5, "0")}`;
async function drive(opts = {}) {
  const runId = rid();
  const rig = createRig({ ...opts, runId });
  const evidence = await runStageC({ harness: rig.harness, d1: rig.d1, runId, sourceSha: SHA });   // allowStubs NOT set: stubs would fail
  return { ...rig, evidence };
}
const byId = (e, id) => e.cases.find((c) => c.id === id);
const post = (rig, path, body, headers = {}) => rig.worker.fetch(new Request(`https://stage-harness.example.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${HARNESS_TOKEN}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }), rig.env);

test("E2E: the unmodified driver passes C00-C08 with NO stubs; evidence is honest that the platform is simulated", { skip }, async () => {
  const { evidence } = await drive();
  for (const c of evidence.cases) assert.equal(c.ok, true, `${c.id} ${c.title}: ${JSON.stringify(c.observed)}`);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.harness_transport, "injected");
  assert.equal(evidence.mode, "simulated", "an injected-transport run must never be labelled live");
  assert.doesNotMatch(JSON.stringify(evidence), /"stub":\s*true/);
  assert.equal(byId(evidence, "C03").observed.preseeded_nonce_denied_by_durable_barrier, true);
  assert.equal(byId(evidence, "C06").observed.revoked_oauth_denied, true);
  assert.equal(byId(evidence, "C06").observed.wrong_account_association_denied, true);
});

test("E2E: sources contain no stub responses and probes line up with the driver contract", () => {
  for (const f of ["src/staging-gateway/stagec-harness-core.js", "src/staging-gateway/stagec-harness-worker.js", "src/staging-gateway/staging-gateway-worker.js"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""), /stub\s*:\s*true|stagec-source/, f);
  }
  assert.deepEqual([...ALL_PROBES].sort(), [...HARNESS_PROBES].sort(), "every probe the driver can send is implemented by the harness, and vice versa");
});

test("E2E: real D1 effects exist (messages, deliveries, nonce receipts) and trigger probes left nothing behind", { skip }, async () => {
  const { privateDb, evidence } = await drive();
  assert.equal(evidence.ok, true);
  assert.equal(privateDb.count("priv_messages"), 5, "4 account/provider sends + 1 send by the still-authorized peer after the revocation probe");
  assert.equal(privateDb.count("priv_messages", "message_id LIKE '%-after'"), 1);
  assert.ok(privateDb.count("priv_deliveries") >= 4);
  assert.ok(privateDb.count("priv_service_nonces", "caller = ?", STAGEC.caller) > 20);
  assert.equal(privateDb.count("priv_messages", "message_id LIKE '%trigger-probe'"), 0);
});

test("E2E: Workers RPC may drop the error class and .code -> the typed code is recovered from the message", { skip }, async () => {
  const { evidence, harness } = await drive({ rpcErrors: "plain" });
  assert.equal(evidence.ok, true, JSON.stringify(byId(evidence, "C07")?.observed));
  const r = await harness.call({ account: "alpha", provider: "grok" }, "listInbox", [{ inboxId: "ibx_stagec_alpha_aux" }]);
  assert.deepEqual([r.ok, r.code, r.code_source], [false, "capability_denied", "message"]);
});

test("E2E: if RPC delivers NOTHING typed, C07 fails (the gap is visible, never papered over)", { skip }, async () => {
  const { evidence } = await drive({ rpcErrors: "opaque" });
  assert.equal(byId(evidence, "C07").ok, false);
  assert.equal(evidence.ok, false);
});

// ---- mutations against the real path ----
test("MUTATION: a binding that ignores props.caller -> C04 fails", { skip }, async () => {
  const { evidence } = await drive({ variant: { ignorePlatform: true } });
  assert.equal(byId(evidence, "C04").ok, false);
});
test("MUTATION: sender trigger dropped on the private DB -> C02 fails", { skip }, async () => {
  const { evidence } = await drive({ variant: { dropSenderTrigger: true } });
  assert.equal(byId(evidence, "C02").ok, false);
  assert.equal(byId(evidence, "C02").observed.trigger_messages, "NOT_ABORTED");
});
test("MUTATION: an auth store that admits everything -> the revoked-OAuth probe fails (control passes, denial does not happen)", { skip }, async () => {
  const { evidence } = await drive({ variant: { authAlwaysAdmit: true } });
  const c6 = byId(evidence, "C06");
  assert.equal(c6.ok, false);
  assert.equal(c6.observed.revoked_oauth_denied, false);
});
test("MUTATION: OAuth layer unconfigured -> explicit fail-closed result and C06 fails", { skip }, async () => {
  const { evidence, harness } = await drive({ harnessEnv: { STAGING_OAUTH_SIGNING_KEY: "short" } });
  assert.equal(byId(evidence, "C06").ok, false);
  assert.deepEqual(await harness.probe("revoked_oauth", { identity: { account: "alpha", provider: "grok" } }), { ok: false, code: "harness_oauth_unconfigured" });
});
test("MUTATION: legacy URLs not configured -> C08 fails closed", { skip }, async () => {
  const { evidence, harness } = await drive({ harnessEnv: { LEGACY_MCP_HEALTH_URL: undefined } });
  assert.equal(byId(evidence, "C08").ok, false);
  assert.deepEqual(await harness.probe("legacy_regression", {}), { ok: false, code: "legacy_not_configured" });
});
test("MUTATION: legacy tools list exposing private tools -> C08 fails", { skip }, async () => {
  const prev = globalThis.fetch;
  const { createRig: mk } = await import("./helpers/stagec-e2e-rig.mjs");
  const rig = mk({ runId: rid() });
  const evil = async (u) => new Response(String(u).endsWith("/health") ? "ok" : JSON.stringify({ tools: ["private_inbox_send"] }), { status: 200 });
  // rig.fetchImpl swaps globalThis.fetch to a clean legacy mock; override by calling the Worker directly with the evil legacy fetch
  try {
    globalThis.fetch = evil;
    const res = await rig.worker.fetch(new Request("https://h.example.test/stagec/v1/probe", { method: "POST", headers: { Authorization: `Bearer ${HARNESS_TOKEN}` }, body: JSON.stringify({ name: "legacy_regression", params: {} }) }), rig.env);
    const body = await res.json();
    assert.equal(body.private_tools_visible, true);
  } finally { globalThis.fetch = prev; }
});

// ---- harness Worker surface ----
test("harness Worker: disabled by default, strong token required, POST + two paths only, bounded strict bodies", { skip }, async () => {
  const rig = createRig({ runId: rid() });
  const req = (path = "/stagec/v1/call", init = {}) => new Request(`https://h.example.test${path}`, { method: "POST", ...init });
  assert.equal((await rig.worker.fetch(req(), { ...rig.env, STAGE_C_HARNESS_ENABLED: "false" })).status, 404);
  assert.equal((await rig.worker.fetch(req(), { ...rig.env, STAGE_C_HARNESS_ENABLED: undefined })).status, 404);
  assert.equal((await rig.worker.fetch(req(), {})).status, 404);
  const weak = await rig.worker.fetch(req("/stagec/v1/call", { headers: { Authorization: "Bearer short" } }), { ...rig.env, STAGE_C_HARNESS_TOKEN: "short" });
  assert.deepEqual([weak.status, (await weak.json()).code], [403, "harness_unconfigured"]);
  for (const auth of [undefined, "", "Bearer", `Bearer ${HARNESS_TOKEN}x`, `bearer ${HARNESS_TOKEN}`, HARNESS_TOKEN, `Bearer ${HARNESS_TOKEN.slice(0, -1)}`]) {
    const res = await rig.worker.fetch(req("/stagec/v1/call", { headers: auth === undefined ? {} : { Authorization: auth }, body: "{}" }), rig.env);
    assert.equal(res.status, 401, String(auth));
  }
  for (const [method, path] of [["GET", "/stagec/v1/call"], ["PUT", "/stagec/v1/call"], ["POST", "/stagec/v1/other"], ["POST", "/"], ["POST", "/v1/private-inbox/get"], ["POST", "/stagec/v1/call/"]]) {
    assert.equal((await rig.worker.fetch(new Request(`https://h.example.test${path}`, { method, headers: { Authorization: `Bearer ${HARNESS_TOKEN}` }, body: method === "GET" ? undefined : "{}" }), rig.env)).status, 404, `${method} ${path}`);
  }
  assert.equal((await post(rig, "/stagec/v1/call", "{not json")).status, 400);
  assert.equal((await post(rig, "/stagec/v1/call", "x".repeat(40000))).status, 413);
});

test("harness Worker: the request can never supply scope, home, role, caller, key or an unlisted method", { skip }, async () => {
  const rig = createRig({ runId: rid() });
  const id = { account: "alpha", provider: "chatgpt" };
  const bad = [
    { identity: id, method: "listInboxes", args: [], scope: { account_id: "acct_x" } },
    { identity: id, method: "listInboxes", args: [], caller: "evil" },
    { identity: { ...id, home_id: "home_x_00000001" }, method: "listInboxes", args: [] },
    { identity: { account: "mallory", provider: "chatgpt" }, method: "listInboxes", args: [] },
    { identity: { account: "alpha", provider: "admin" }, method: "listInboxes", args: [] },
    { identity: id, method: "constructor", args: [] }, { identity: id, method: "__proto__", args: [] }, { identity: id, method: "handlePrivateCall", args: [] },
    { identity: id, method: "listInboxes", args: [1, 2, 3] }, { identity: id, method: "listInboxes", args: "x" },
    { identity: id, method: "listInboxes" }, [], null, "str", { identity: id, method: 7, args: [] }
  ];
  for (const body of bad) {
    const res = await post(rig, "/stagec/v1/call", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const j = await res.json();
    assert.equal(j.ok, false); assert.ok(["invalid_arguments", "unknown_store_method"].includes(j.code), j.code);
  }
  assert.equal(rig.privateDb.count("priv_service_nonces"), 0, "rejected requests never reached the private Worker");
  const unknownProbe = await (await post(rig, "/stagec/v1/probe", { name: "drop_tables", params: {} })).json();
  assert.deepEqual(unknownProbe, { ok: false, code: "unknown_probe" });
  assert.equal((await post(rig, "/stagec/v1/probe", { name: "bad_sig", params: { identity: id }, extra: 1 })).status, 400);
});

test("harness Worker: missing bindings or key -> 503 private_worker_unconfigured, nothing sent", { skip }, async () => {
  for (const drop of ["CAIRNSTONE_PRIVATE_STAGE", "CAIRNSTONE_PRIVATE_STAGE_NOPROPS", "CAIRNSTONE_PRIVATE_STAGE_WRONGPROPS", "PRIVATE_GATEWAY_HMAC_KEY"]) {
    const rig = createRig({ runId: rid(), harnessEnv: { [drop]: undefined } });
    const res = await post(rig, "/stagec/v1/call", { identity: { account: "alpha", provider: "chatgpt" }, method: "listInboxes", args: [] });
    assert.equal(res.status, 503, drop);
    assert.equal((await res.json()).code, "private_worker_unconfigured");
  }
  const rig = createRig({ runId: rid(), harnessEnv: { PRIVATE_GATEWAY_HMAC_KEY: "x".repeat(31) } });
  assert.equal((await post(rig, "/stagec/v1/call", { identity: { account: "alpha", provider: "chatgpt" }, method: "listInboxes", args: [] })).status, 503);
});

// ---- typed error recovery ----
test("privateErrorCode: by code, by message, never raw text", () => {
  assert.deepEqual(privateErrorCode(new PrivateRealmError("capability_denied")), { code: "capability_denied", source: "code" });
  assert.deepEqual(privateErrorCode(new Error("capability_denied")), { code: "capability_denied", source: "message" });
  assert.deepEqual(privateErrorCode(new Error("invalid_body")), { code: "invalid_body", source: "message" });
  for (const raw of [new Error("D1_ERROR: no such table: priv_homes: SQLITE_ERROR"), new Error("secret key leaked"), new Error("not_a_known_code"), new Error(""), "capability_denied", null, undefined, {}, { code: "DROP TABLE" }, { code: 7, message: 7 }]) {
    assert.deepEqual(privateErrorCode(raw), { code: "private_store_error", source: "fallback" }, String(raw?.message ?? raw));
  }
});

test("product gateway client: typed code recovered across a binding that drops class identity; unsafe codes still collapse", { skip }, async () => {
  const env = (throwing) => ({ PRIVATE_STAGE_GATEWAY_ENABLED: "true", PRIVATE_GATEWAY_HMAC_KEY: HMAC, CAIRNSTONE_PRIVATE_STAGE: { call: async () => { throw throwing; } } });
  const call = (e) => createStagingPrivateStoreClient({ env: env(e) }).resolveHome({ a: 1 });
  await assert.rejects(call(new Error("caller_not_authorized")), { code: "caller_not_authorized" });
  await assert.rejects(call(new Error("scope_not_authorized")), { code: "scope_not_authorized" });
  await assert.rejects(call(new Error("capability_denied")), { code: "private_store_error" });   // product policy unchanged: collapsed
  await assert.rejects(call(new Error("D1_ERROR: SELECT secret FROM x")), (e) => e.code === "private_store_error" && !String(e.message).includes("secret"));
});
