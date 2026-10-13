// Source CI for issue #97: activation verifiers must fail closed. No network, no credentials. Real staging migrations on SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { EXPECTED as PRIVATE, CloudflareApiError, runPreflight, runReadback, verifyWorkerSettings } from "../scripts/staging/s1-3-preflight-lib.mjs";
import {
  ACTIVATION, verifyHarnessConfig, verifyAuthMigrationSha, verifyNewAuthD1Id, verifyAuthD1Schema, verifyHarnessSettings,
  verifyHarnessSecrets, missingHarnessSecrets, verifyAccessApp, verifyHarnessExposure, createActivationClient,
  checkAuthD1, checkAuthD1Identity, runHarnessChecks, runActivationPlan, planMarkdown
} from "../scripts/staging/s1-3-activation-lib.mjs";

const root = (p) => new URL(`../${p}`, import.meta.url);
const TOKEN = "t".repeat(40);
const ACCT = "a".repeat(32);
const AUTH_ID = "11111111-2222-4333-8444-555555555555";
const ISSUER_HOST = "stage-harness.staging.cairnstone.dev";
const EXP = Object.freeze({ ...ACTIVATION, auth: Object.freeze({ ...ACTIVATION.auth, dbId: AUTH_ID }) });
const realHarnessToml = readFileSync(root("wrangler.stagec-harness.toml"), "utf8");
// Fixtures are derived from a CANONICAL template of the committed toml (placeholder id + example issuer), so they stay valid both before
// and after the owner's reviewed pin PR replaces the real id and issuer (runbook steps 5-6). They never depend on the pinned values.
const PLACEHOLDER_ORIGIN = "https://stage.cairnstone.example";
const templateToml = realHarnessToml
  .replace(/^database_id = "[0-9a-f-]{36}"$/m, `database_id = "${ACTIVATION.zeroId}"`)
  .replace(/^STAGING_OAUTH_ISSUER = "https:\/\/[^"\s]+"$/m, `STAGING_OAUTH_ISSUER = "${PLACEHOLDER_ORIGIN}"`)
  .replace(/^STAGING_OAUTH_RESOURCE = "https:\/\/[^"\s]+"$/m, `STAGING_OAUTH_RESOURCE = "${PLACEHOLDER_ORIGIN}/mcp/core-auth"`);
const pinnedToml = templateToml.replaceAll(ACTIVATION.zeroId, AUTH_ID);
const enableToml = pinnedToml.replace("https://stage.cairnstone.example/mcp/core-auth", `https://${ISSUER_HOST}/mcp/core-auth`).replace('"https://stage.cairnstone.example"', `"https://${ISSUER_HOST}"`);
const authSql = readFileSync(root("migrations/staging-auth/0001_staging_auth.sql"), "utf8");

// ---------------------------------------------------------------- config identity
test("config: the repo's real harness toml is NOT deployable until the auth D1 id is pinned (current state)", () => {
  const errors = verifyHarnessConfig(realHarnessToml);
  if (ACTIVATION.auth.dbId === null) {
    assert.ok(errors.includes("auth_d1_id_not_pinned"));
    assert.ok(errors.includes("config_placeholder_all_zero_d1_id"));
  } else {
    assert.deepEqual(errors, [], "once pinned, the real toml must verify exactly");
  }
});
test("config: pinned id substituted into the real toml passes dormant; placeholder hostname blocks enable", () => {
  assert.deepEqual(verifyHarnessConfig(pinnedToml, { expected: EXP }), []);
  assert.ok(verifyHarnessConfig(pinnedToml, { expected: EXP, mode: "enable" }).includes("oauth_placeholder_hostname_not_allowed_for_enable"));
  assert.deepEqual(verifyHarnessConfig(enableToml, { expected: EXP, mode: "enable" }), []);
});
for (const [name, mutate, expectCode] of [
  ["file enables the harness", (t) => t.replace('STAGE_C_HARNESS_ENABLED = "false"', 'STAGE_C_HARNESS_ENABLED = "true"'), "config_unexpected_line"],
  ["route added", (t) => `${t}\nroutes = [{ pattern = "h.example.com/*", zone_name = "example.com" }]\n`, "config_unexpected_line"],
  ["workers_dev true", (t) => t.replace("workers_dev = false", "workers_dev = true"), "config_unexpected_line"],
  ["preview urls true", (t) => t.replace("preview_urls = false", "preview_urls = true"), "config_unexpected_line"],
  ["cron trigger", (t) => `${t}\n[triggers]\ncrons = ["* * * * *"]\n`, "config_unexpected_line"],
  ["kv namespace", (t) => `${t}\n[[kv_namespaces]]\nbinding = "K"\nid = "abc"\n`, "config_unexpected_line"],
  ["r2 bucket", (t) => `${t}\n[[r2_buckets]]\nbinding = "R"\nbucket_name = "x"\n`, "config_unexpected_line"],
  ["fourth service binding", (t) => `${t}\n[[services]]\nbinding = "CORE"\nservice = "cairnstone-v6"\n`, "config_unexpected_line"],
  ["valid binding props changed", (t) => t.replace('props = { caller = "cairnstone-stage-gateway" }', 'props = { caller = "someone-else" }'), "config_unexpected_line"],
  ["wrong-props binding becomes valid", (t) => t.replace('props = { caller = "not-the-stage-gateway" }', 'props = { caller = "cairnstone-stage-gateway" }'), "config_order_or_content_mismatch"],
  ["no-props binding gains props", (t) => t.replace('binding = "CAIRNSTONE_PRIVATE_STAGE_NOPROPS"\nservice = "cairnstone-private-staging"', 'binding = "CAIRNSTONE_PRIVATE_STAGE_NOPROPS"\nservice = "cairnstone-private-staging"\nprops = { caller = "cairnstone-stage-gateway" }'), "config_line_count"],
  ["binds the production D1", (t) => t.replace(AUTH_ID, "7c4ae99e-4ab0-44c3-afa3-3f1a2d64d319"), "config_auth_d1_id_differs_from_pin"],
  ["binds the old private D1", (t) => t.replace(AUTH_ID, PRIVATE.oldD1Id), "config_references_old_staging_d1"],
  ["binds the replacement private D1", (t) => t.replace(AUTH_ID, PRIVATE.d1Id), "config_binds_private_realm_d1"],
  ["all-zero placeholder id", (t) => t.replace(AUTH_ID, ACTIVATION.zeroId), "config_placeholder_all_zero_d1_id"],
  ["different worker name", (t) => t.replace('name = "cairnstone-stage-harness"', 'name = "cairnstone-v6"'), "config_unexpected_line"],
  ["different entrypoint", (t) => t.replace("stagec-harness-worker.js", "worker.js"), "config_unexpected_line"],
  ["trailing comment on a pinned line", (t) => t.replace('database_name = "cairnstone-staging-auth"', 'database_name = "cairnstone-staging-auth" # x'), "config_unexpected_line"],
  ["http issuer", (t) => t.replace('"https://stage.cairnstone.example"', '"http://stage.cairnstone.example"'), "config_unexpected_line"]
]) {
  test(`config: ${name} fails closed`, () => {
    const errors = verifyHarnessConfig(mutate(pinnedToml), { expected: EXP });
    assert.ok(errors.length > 0 && errors.some((e) => e.startsWith(expectCode)), `${expectCode} not in ${JSON.stringify(errors)}`);
  });
}
test("config: resource must be the issuer origin plus /mcp/core-auth; issuer must be a bare origin", () => {
  assert.ok(verifyHarnessConfig(enableToml.replace(`https://${ISSUER_HOST}/mcp/core-auth`, `https://other.${ISSUER_HOST}/mcp/core-auth`), { expected: EXP, mode: "enable" }).includes("oauth_resource_must_be_issuer_plus_core_auth_path"));
  assert.ok(verifyHarnessConfig(enableToml.replace(`"https://${ISSUER_HOST}"`, `"https://${ISSUER_HOST}/x"`), { expected: EXP, mode: "enable" }).includes("oauth_issuer_must_be_bare_origin"));
});
test("pin: ids that can never be pinned are rejected (zero, old/new private D1, malformed)", () => {
  for (const bad of [ACTIVATION.zeroId, PRIVATE.oldD1Id, PRIVATE.d1Id, "nope", "", null, undefined, 42]) assert.ok(verifyNewAuthD1Id(bad).length > 0, String(bad));
  assert.deepEqual(verifyNewAuthD1Id(AUTH_ID), []);
  for (const bad of [ACTIVATION.zeroId, PRIVATE.oldD1Id, PRIVATE.d1Id]) {
    assert.ok(verifyHarnessConfig(pinnedToml, { expected: { ...ACTIVATION, auth: { ...ACTIVATION.auth, dbId: bad } } }).includes("auth_d1_id_pin_is_placeholder_or_foreign"));
  }
});
test("migration: committed bytes match the reviewed sha; any change is detected", () => {
  const sha = createHash("sha256").update(readFileSync(root("migrations/staging-auth/0001_staging_auth.sql"))).digest("hex");
  assert.deepEqual(verifyAuthMigrationSha(sha), []);
  assert.deepEqual(verifyAuthMigrationSha(createHash("sha256").update(`${authSql}\n-- x`).digest("hex")), ["auth_migration_sha256_differs_from_reviewed"]);
  assert.equal(readdirSync(root("migrations/staging-auth")).length, 1);
});

// ---------------------------------------------------------------- live-state verifiers on REAL schemas (node:sqlite)
function authDb({ migrate = true } = {}) { const db = new DatabaseSync(":memory:"); if (migrate) db.exec(authSql); return db; }
function privateDb() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(root("migrations/private-staging")).sort()) db.exec(readFileSync(root(`migrations/private-staging/${f}`), "utf8"));
  return db;
}
const rows = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r }));
function authRows(db) {
  return {
    tables: rows(db, "SELECT name FROM sqlite_master WHERE type='table'"),
    triggers: rows(db, "SELECT name, sql FROM sqlite_master WHERE type='trigger'"),
    versions: rows(db, "SELECT version FROM staging_auth_schema"),
    counts: { connections: rows(db, "SELECT COUNT(*) AS n FROM staging_connections")[0].n, families: rows(db, "SELECT COUNT(*) AS n FROM staging_token_families")[0].n }
  };
}
test("auth schema: the real migration verifies, including requireEmpty", () => {
  assert.deepEqual(verifyAuthD1Schema(authRows(authDb()), { requireEmpty: true }), []);
});
test("auth schema: every trigger is individually required and cannot be weakened", () => {
  for (const name of ACTIVATION.auth.triggers) {
    const r = authRows(authDb());
    assert.ok(verifyAuthD1Schema({ ...r, triggers: r.triggers.filter((t) => t.name !== name) }).includes(`auth_d1_trigger_missing: ${name}`), name);
    assert.ok(verifyAuthD1Schema({ ...r, triggers: r.triggers.map((t) => (t.name === name ? { ...t, sql: "CREATE TRIGGER x BEFORE UPDATE ON y BEGIN SELECT 1; END" } : t)) }).includes(`auth_d1_trigger_weakened: ${name}`), name);
  }
});
test("auth schema: missing tables, wrong/duplicate version and a non-empty fresh database fail", () => {
  const r = authRows(authDb());
  assert.ok(verifyAuthD1Schema({ ...r, tables: [] }).some((e) => e.startsWith("auth_d1_table_missing")));
  assert.ok(verifyAuthD1Schema({ ...r, versions: [] }).includes("auth_d1_schema_version_not_exactly_1"));
  assert.ok(verifyAuthD1Schema({ ...r, versions: [{ version: 1 }, { version: 2 }] }).includes("auth_d1_schema_version_not_exactly_1"));
  assert.ok(verifyAuthD1Schema({ ...r, versions: [{ version: 2 }] }).includes("auth_d1_schema_version_not_exactly_1"));
  assert.ok(verifyAuthD1Schema({ ...r, counts: { connections: 1, families: 0 } }, { requireEmpty: true }).includes("auth_d1_not_empty_after_create"));
  assert.ok(verifyAuthD1Schema({ ...r, counts: undefined }, { requireEmpty: true }).includes("auth_d1_not_empty_after_create"));
  assert.deepEqual(verifyAuthD1Schema({ ...r, counts: { connections: 3, families: 2 } }), []); // readiness checks do not require empty
});

// ---------------------------------------------------------------- harness bindings, secrets, exposure
const goodBindings = () => [
  { type: "service", name: "CAIRNSTONE_PRIVATE_STAGE", service: "cairnstone-private-staging", props: { caller: "cairnstone-stage-gateway" } },
  { type: "service", name: "CAIRNSTONE_PRIVATE_STAGE_NOPROPS", service: "cairnstone-private-staging" },
  { type: "service", name: "CAIRNSTONE_PRIVATE_STAGE_WRONGPROPS", service: "cairnstone-private-staging", props: { caller: "not-the-stage-gateway" } },
  { type: "d1", name: "STAGING_AUTH_DB", id: AUTH_ID },
  { type: "plain_text", name: "STAGE_C_HARNESS_ENABLED", text: "false" },
  { type: "plain_text", name: "STAGING_OAUTH_ISSUER", text: `https://${ISSUER_HOST}` },
  { type: "plain_text", name: "STAGING_OAUTH_RESOURCE", text: `https://${ISSUER_HOST}/mcp/core-auth` },
  { type: "secret_text", name: "STAGE_C_HARNESS_TOKEN" }, { type: "secret_text", name: "PRIVATE_GATEWAY_HMAC_KEY" }, { type: "secret_text", name: "STAGING_OAUTH_SIGNING_KEY" }
];
test("harness bindings: exact set passes; props omitted by the API is tolerated, props returned must match", () => {
  assert.deepEqual(verifyHarnessSettings({ bindings: goodBindings() }, { expected: EXP }), []);
  const noProps = goodBindings().map((b) => { const { props, ...rest } = b; void props; return rest; });
  assert.deepEqual(verifyHarnessSettings({ bindings: noProps }, { expected: EXP }), []);
});
for (const [name, mutate, code] of [
  ["service points at production", (b) => { b[0].service = "cairnstone-v6"; }, "harness_service_binding_wrong_target"],
  ["valid binding has wrong caller", (b) => { b[0].props.caller = "x"; }, "harness_service_props_mismatch"],
  ["no-props binding returns props", (b) => { b[1].props = { caller: "cairnstone-stage-gateway" }; }, "harness_service_props_mismatch"],
  ["wrong-props binding is made valid", (b) => { b[2].props.caller = "cairnstone-stage-gateway"; }, "harness_service_props_mismatch"],
  ["service binding missing", (b) => { b.splice(1, 1); }, "harness_unexpected_service_binding_count"],
  ["extra service binding", (b) => { b.push({ type: "service", name: "CORE", service: "cairnstone-v6" }); }, "harness_unexpected_service_binding_count"],
  ["auth D1 id differs from pin", (b) => { b[3].id = PRIVATE.d1Id; }, "harness_unexpected_d1_binding"],
  ["second D1", (b) => { b.push({ type: "d1", name: "CAIRNSTONE_PRIVATE_DB", id: PRIVATE.d1Id }); }, "harness_unexpected_d1_binding"],
  ["r2 bucket", (b) => { b.push({ type: "r2_bucket", name: "R", bucket_name: "x" }); }, "harness_unexpected_binding"],
  ["kv", (b) => { b.push({ type: "kv_namespace", name: "K" }); }, "harness_unexpected_binding"],
  ["unexpected secret binding", (b) => { b.push({ type: "secret_text", name: "CLOUDFLARE_API_TOKEN" }); }, "harness_unexpected_binding"],
  ["extra var", (b) => { b.push({ type: "plain_text", name: "EXTRA", text: "1" }); }, "harness_unexpected_vars"],
  ["enabled flag true while dormant expected", (b) => { b[4].text = "true"; }, "harness_enabled_flag_unexpected"]
]) {
  test(`harness bindings: ${name} fails closed`, () => {
    const b = goodBindings(); mutate(b);
    assert.ok(verifyHarnessSettings({ bindings: b }, { expected: EXP }).some((e) => e.startsWith(code)), name);
  });
}
test("harness bindings: unreadable fails closed; enable mode requires enabled flag true", () => {
  assert.deepEqual(verifyHarnessSettings(undefined), ["harness_bindings_unreadable"]);
  assert.ok(verifyHarnessSettings({ bindings: goodBindings() }, { expected: EXP, enabledValues: ["true"] }).includes("harness_enabled_flag_unexpected"));
});
test("harness secrets: names only; all three required when asked; unknown names fail; missing names listed", () => {
  const all = ACTIVATION.harness.secrets.map((name) => ({ name }));
  assert.deepEqual(verifyHarnessSecrets(all, { requireAll: true }), []);
  assert.deepEqual(verifyHarnessSecrets([], { requireAll: false }), []);
  assert.deepEqual(verifyHarnessSecrets(all.slice(1), { requireAll: true }), [`harness_secret_absent: ${all[0].name}`]);
  assert.ok(verifyHarnessSecrets([...all, { name: "CLOUDFLARE_API_TOKEN" }]).includes("harness_secret_unexpected: CLOUDFLARE_API_TOKEN"));
  assert.deepEqual(verifyHarnessSecrets(undefined), ["harness_secrets_unreadable"]);
  assert.deepEqual(missingHarnessSecrets(all.slice(0, 1)), ACTIVATION.harness.secrets.slice(1));
  assert.deepEqual(missingHarnessSecrets(undefined), [...ACTIVATION.harness.secrets]);
});
const goodApp = () => ({ domain: ISSUER_HOST, type: "self_hosted", policies: [{ decision: "allow", include: [{ email: { email: "owner@example.com" } }] }] });
test("access app: exactly one self-hosted app with an identity policy; bypass/everyone/none/ambiguous all fail", () => {
  assert.deepEqual(verifyAccessApp([goodApp()], ISSUER_HOST), []);
  assert.deepEqual(verifyAccessApp([{ ...goodApp(), domain: undefined, destinations: [{ type: "public", uri: ISSUER_HOST }] }], ISSUER_HOST), []);
  assert.deepEqual(verifyAccessApp([], ISSUER_HOST), ["access_app_count_for_host_0"]);
  assert.deepEqual(verifyAccessApp([goodApp(), goodApp()], ISSUER_HOST), ["access_app_count_for_host_2"]);
  assert.deepEqual(verifyAccessApp(undefined, ISSUER_HOST), ["access_apps_unreadable"]);
  assert.ok(verifyAccessApp([{ ...goodApp(), policies: [] }], ISSUER_HOST).includes("access_policies_missing_or_unreadable"));
  assert.ok(verifyAccessApp([{ ...goodApp(), policies: undefined }], ISSUER_HOST).includes("access_policies_missing_or_unreadable"));
  assert.ok(verifyAccessApp([{ ...goodApp(), policies: [{ decision: "bypass", include: [] }] }], ISSUER_HOST).includes("access_policy_bypass"));
  assert.ok(verifyAccessApp([{ ...goodApp(), policies: [{ decision: "allow", include: [{ everyone: {} }] }] }], ISSUER_HOST).includes("access_policy_allows_everyone"));
  assert.ok(verifyAccessApp([{ ...goodApp(), type: "saas" }], ISSUER_HOST).includes("access_app_not_self_hosted"));
});
test("harness exposure: dormant = nothing public at all; enable = exactly the Access-protected issuer host and no route", () => {
  const quiet = { subdomain: { enabled: false, previews_enabled: false }, domains: [], routes: [{ pattern: "x/*", script: "other" }] };
  assert.deepEqual(verifyHarnessExposure(quiet, { expected: EXP, mode: "dormant" }), []);
  assert.ok(verifyHarnessExposure({ ...quiet, subdomain: { enabled: true } }, { mode: "dormant" }).includes("harness_workers_dev_enabled_or_unknown"));
  assert.ok(verifyHarnessExposure({ ...quiet, subdomain: undefined }, { mode: "dormant" }).length);
  assert.ok(verifyHarnessExposure({ ...quiet, subdomain: { enabled: false, previews_enabled: true } }, { mode: "dormant" }).includes("harness_previews_enabled"));
  assert.ok(verifyHarnessExposure({ ...quiet, domains: [{ hostname: "h.example.com", service: "cairnstone-stage-harness" }] }, { mode: "dormant" }).some((e) => e.startsWith("harness_custom_domain_present_while_dormant")));
  assert.ok(verifyHarnessExposure({ ...quiet, routes: [{ pattern: "h/*", script: "cairnstone-stage-harness" }] }, { mode: "dormant" }).some((e) => e.startsWith("harness_zone_route")));
  assert.ok(verifyHarnessExposure({ ...quiet, domains: undefined }, { mode: "dormant" }).includes("harness_domains_unreadable"));
  const live = { ...quiet, domains: [{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }], accessApps: [goodApp()] };
  assert.deepEqual(verifyHarnessExposure(live, { expected: EXP, mode: "enable", issuerHost: ISSUER_HOST }), []);
  assert.ok(verifyHarnessExposure({ ...live, domains: [] }, { mode: "enable", issuerHost: ISSUER_HOST }).includes("harness_domain_must_be_exactly_the_issuer_host"));
  assert.ok(verifyHarnessExposure({ ...live, domains: [{ hostname: "other.example.com", service: "cairnstone-stage-harness" }] }, { mode: "enable", issuerHost: ISSUER_HOST }).includes("harness_domain_must_be_exactly_the_issuer_host"));
  assert.ok(verifyHarnessExposure({ ...live, accessApps: [] }, { mode: "enable", issuerHost: ISSUER_HOST }).includes("access_app_count_for_host_0"));
  assert.ok(verifyHarnessExposure(live, { mode: "enable", issuerHost: null }).includes("harness_issuer_host_unknown"));
});

// ---------------------------------------------------------------- client: ONE pinned write, fail closed, no token leak
test("client: createAuthD1 posts exactly the pinned name and returns a usable id", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ success: true, result: { uuid: AUTH_ID, name: "cairnstone-staging-auth" } }) }; };
  const c = createActivationClient({ token: TOKEN, accountId: ACCT, fetchImpl });
  assert.deepEqual(await c.createAuthD1(), { id: AUTH_ID, name: "cairnstone-staging-auth" });
  assert.equal(calls.length, 1); assert.equal(calls[0].init.method, "POST");
  assert.ok(calls[0].url.endsWith(`/accounts/${ACCT}/d1/database`));
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: "cairnstone-staging-auth" });
});
test("client: createAuthD1 refuses any other name, unusable returned ids, API failures, and never leaks the token", async () => {
  const mk = (res) => createActivationClient({ token: TOKEN, accountId: ACCT, fetchImpl: async () => res });
  await assert.rejects(mk({}).createAuthD1("cairnstone-private-staging-2"), { code: "create_d1_name_not_pinned_auth_db" });
  await assert.rejects(mk({}).createAuthD1("anything"), { code: "create_d1_name_not_pinned_auth_db" });
  for (const bad of [ACTIVATION.zeroId, PRIVATE.d1Id, PRIVATE.oldD1Id, "x", undefined]) {
    await assert.rejects(mk({ ok: true, status: 200, json: async () => ({ success: true, result: { uuid: bad, name: "cairnstone-staging-auth" } }) }).createAuthD1(), (e) => e instanceof CloudflareApiError && e.code.startsWith("create_d1_returned_unusable_id"), String(bad));
  }
  const denied = mk({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000 }] }) });
  try { await denied.createAuthD1(); assert.fail("should throw"); } catch (e) { assert.ok(e instanceof CloudflareApiError); assert.ok(!e.message.includes(TOKEN)); assert.ok(!e.message.includes(ACCT)); }
  await assert.rejects(createActivationClient({ token: TOKEN, accountId: ACCT, fetchImpl: async () => { throw new Error("boom"); } }).createAuthD1(), { code: "cloudflare_create_d1_failed" });
  assert.throws(() => createActivationClient({ token: "short", accountId: ACCT }), CloudflareApiError);
});

// ---------------------------------------------------------------- full flows against a fake Cloudflare world backed by real SQLite
function world(over = {}) {
  const w = {
    privateDb: privateDb(), authDb: authDb(), authId: AUTH_ID, authName: "cairnstone-staging-auth", authListed: true,
    privateBindings: [
      { type: "d1", name: PRIVATE.d1Binding, id: PRIVATE.d1Id }, { type: "r2_bucket", name: PRIVATE.r2Binding, bucket_name: PRIVATE.r2Bucket },
      ...Object.entries(PRIVATE.vars).map(([name, text]) => ({ type: "plain_text", name, text })), { type: "secret_text", name: PRIVATE.hmacSecret }
    ],
    privateSecrets: [{ name: PRIVATE.hmacSecret }],
    harness: { exists: true, bindings: goodBindings(), secrets: ACTIVATION.harness.secrets.map((name) => ({ name })), subdomain: { enabled: false, previews_enabled: false }, domains: [] },
    routes: [], accessApps: [], ...over
  };
  return w;
}
function fakeClient(w) {
  const notFound = (path) => new CloudflareApiError(`cloudflare_api_failed:GET:${path.split("?")[0].replace(ACCT, "<acct>")}:404:`);
  const calls = [];
  return {
    accountId: ACCT, calls,
    async get(path) {
      calls.push(path);
      const a = `/accounts/${ACCT}`;
      if (path === `${a}/d1/database?name=${encodeURIComponent("cairnstone-staging-auth")}`) return { result: w.authListed ? [{ uuid: w.authId, name: w.authName }] : [] };
      if (path === `${a}/d1/database/${w.authId}`) return { result: { uuid: w.authId, name: w.authName } };
      const pw = `${a}/workers/scripts/${PRIVATE.workerName}`, hw = `${a}/workers/scripts/cairnstone-stage-harness`;
      if (path === `${pw}/settings`) return { result: { bindings: w.privateBindings } };
      if (path === `${pw}/secrets`) return { result: w.privateSecrets };
      if (path === `${pw}/subdomain`) return { result: { enabled: false, previews_enabled: false } };
      if (path === `${a}/workers/domains?service=${PRIVATE.workerName}`) return { result: [] };
      if (path.startsWith(hw)) {
        if (!w.harness.exists) throw notFound(path);
        if (path === `${hw}/settings`) return { result: { bindings: w.harness.bindings } };
        if (path === `${hw}/secrets`) return { result: w.harness.secrets };
        if (path === `${hw}/subdomain`) return { result: w.harness.subdomain };
      }
      if (path === `${a}/workers/domains?service=cairnstone-stage-harness`) return { result: w.harness.domains };
      if (path.startsWith("/zones?")) return { result: [{ id: "z1" }], result_info: { total_pages: 1 } };
      if (path === "/zones/z1/workers/routes") return { result: w.routes };
      if (path.startsWith(`${a}/access/apps`)) return { result: w.accessApps };
      throw notFound(path);
    },
    async d1(dbId, sql) {
      if (!/^\s*(SELECT|PRAGMA)\s/i.test(sql)) throw new CloudflareApiError("d1_statement_not_read_only");
      const db = dbId === PRIVATE.d1Id ? w.privateDb : dbId === w.authId ? w.authDb : null;
      if (!db) throw new CloudflareApiError("cloudflare_api_failed:POST:/d1/query:404:");
      return rows(db, sql);
    }
  };
}
const enableWorld = () => {
  const b = goodBindings(); b[4].text = "true";
  return world({ harness: { exists: true, bindings: b, secrets: ACTIVATION.harness.secrets.map((name) => ({ name })), subdomain: { enabled: false, previews_enabled: false }, domains: [{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }] }, accessApps: [goodApp()] });
};

test("rebind: preflight tolerates the live Worker still bound to the OLD D1; readback and the default never do", async () => {
  const old = world(); old.privateBindings[0].id = PRIVATE.oldD1Id;
  assert.equal((await runPreflight(fakeClient(old))).ok, true);
  assert.equal((await runReadback(fakeClient(old))).ok, false);
  assert.ok(verifyWorkerSettings({ bindings: old.privateBindings }).includes("worker_unexpected_d1_binding"));
  const other = world(); other.privateBindings[0].id = ACTIVATION.zeroId;
  assert.equal((await runPreflight(fakeClient(other))).ok, false); // only the exact old id is tolerated
  const unrelated = world(); unrelated.privateBindings.push({ type: "service", name: "CORE", service: "cairnstone-v6" });
  assert.equal((await runPreflight(fakeClient(unrelated))).ok, false);
  assert.equal((await runReadback(fakeClient(world()))).ok, true);
});
test("checkAuthD1: healthy passes; wrong name, unmigrated, stray rows fail; read-only statements only", async () => {
  assert.equal((await checkAuthD1(fakeClient(world()), AUTH_ID, { expected: EXP, requireEmpty: true })).ok, true);
  assert.equal((await checkAuthD1(fakeClient(world({ authName: "cairnstone-private-staging" })), AUTH_ID, { expected: EXP })).ok, false);
  assert.equal((await checkAuthD1(fakeClient(world({ authDb: authDb({ migrate: false }) })), AUTH_ID, { expected: EXP })).ok, false);
  const dirty = world(); dirty.authDb.exec("INSERT INTO staging_connections (connection_id, account_id, status, created_at, updated_at) VALUES ('conn_x1','acct_x1','active',1,1)");
  assert.equal((await checkAuthD1(fakeClient(dirty), AUTH_ID, { expected: EXP, requireEmpty: true })).ok, false);
  assert.equal((await checkAuthD1(fakeClient(dirty), AUTH_ID, { expected: EXP })).ok, true);
  assert.equal((await checkAuthD1(fakeClient(world()), ACTIVATION.zeroId, { expected: EXP })).ok, false); // never queries the placeholder
  assert.equal((await checkAuthD1Identity(fakeClient(world()), AUTH_ID, { expected: EXP })).ok, true);
  assert.equal((await checkAuthD1Identity(fakeClient(world({ authName: "x" })), AUTH_ID, { expected: EXP })).ok, false);
});
test("harness flow: while the auth D1 id is not pinned nothing can pass (current default)", async () => {
  if (ACTIVATION.auth.dbId === null) { // once pinned, the pinned-flow tests below (explicit `expected`) cover the live behavior
    for (const [mode, phase] of [["dormant", "preflight"], ["dormant", "readback"], ["enable", "preflight"], ["enable", "readback"]]) {
      const r = await runHarnessChecks(fakeClient(world()), { mode, phase, harnessToml: pinnedToml });
      assert.equal(r.ok, false, `${mode}/${phase}`); assert.equal(r.checks.find((c) => c.name === "auth_d1_pinned").ok, false);
    }
  }
  await assert.rejects(runHarnessChecks(fakeClient(world()), { mode: "bogus", phase: "preflight", harnessToml: "" }), { code: "harness_mode_must_be_dormant_or_enable" });
});
test("harness flow (pinned): dormant first deploy passes preflight with no harness Worker; readback then requires it", async () => {
  const none = world({ harness: { exists: false } });
  assert.equal((await runHarnessChecks(fakeClient(none), { mode: "dormant", phase: "preflight", harnessToml: pinnedToml, expected: EXP })).ok, true);
  assert.equal((await runHarnessChecks(fakeClient(none), { mode: "dormant", phase: "readback", harnessToml: pinnedToml, expected: EXP })).ok, false);
  assert.equal((await runHarnessChecks(fakeClient(none), { mode: "enable", phase: "preflight", harnessToml: enableToml, expected: EXP })).ok, false); // enable needs an existing, keyed harness
  assert.equal((await runHarnessChecks(fakeClient(world()), { mode: "dormant", phase: "readback", harnessToml: pinnedToml, expected: EXP })).ok, true);
});
test("harness flow (pinned): the private Worker must already be rebound; the old D1 is not acceptable for the harness", async () => {
  const old = world(); old.privateBindings[0].id = PRIVATE.oldD1Id;
  const r = await runHarnessChecks(fakeClient(old), { mode: "dormant", phase: "preflight", harnessToml: pinnedToml, expected: EXP });
  assert.equal(r.ok, false);
  assert.ok(r.checks.find((c) => c.name === "worker_bindings").errors.includes("worker_unexpected_d1_binding"));
});
test("harness flow (pinned): enable requires all secrets, the Access-protected issuer host, no routes; the dormant state refuses a public hostname", async () => {
  assert.equal((await runHarnessChecks(fakeClient(enableWorld()), { mode: "enable", phase: "readback", harnessToml: enableToml, expected: EXP })).ok, true);
  assert.equal((await runHarnessChecks(fakeClient(enableWorld()), { mode: "enable", phase: "preflight", harnessToml: enableToml, expected: EXP })).ok, true);
  const mutations = [
    ["missing secret", (w) => { w.harness.secrets = w.harness.secrets.slice(1); }],
    ["unexpected secret", (w) => { w.harness.secrets.push({ name: "CLOUDFLARE_API_TOKEN" }); }],
    ["no custom domain", (w) => { w.harness.domains = []; }],
    ["wrong hostname", (w) => { w.harness.domains = [{ hostname: "other.example.com", service: "cairnstone-stage-harness" }]; }],
    ["workers.dev enabled", (w) => { w.harness.subdomain = { enabled: true }; }],
    ["zone route", (w) => { w.routes = [{ pattern: "h/*", script: "cairnstone-stage-harness" }]; }],
    ["no Access app", (w) => { w.accessApps = []; }],
    ["Access allows everyone", (w) => { w.accessApps = [{ ...goodApp(), policies: [{ decision: "allow", include: [{ everyone: {} }] }] }]; }],
    ["flag not enabled after enable deploy", (w) => { w.harness.bindings[4].text = "false"; }]
  ];
  for (const [name, m] of mutations) { const w = enableWorld(); m(w); assert.equal((await runHarnessChecks(fakeClient(w), { mode: "enable", phase: "readback", harnessToml: enableToml, expected: EXP })).ok, false, name); }
  const dormantPublic = world(); dormantPublic.harness.domains = [{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }];
  assert.equal((await runHarnessChecks(fakeClient(dormantPublic), { mode: "dormant", phase: "readback", harnessToml: pinnedToml, expected: EXP })).ok, false);
  const placeholderEnable = await runHarnessChecks(fakeClient(enableWorld()), { mode: "enable", phase: "preflight", harnessToml: pinnedToml, expected: EXP });
  assert.equal(placeholderEnable.ok, false); // example.* issuer host is not the live domain
});
test("harness flow: an API that cannot answer throws instead of passing", async () => {
  const w = world(); const c = fakeClient(w); const get = c.get.bind(c);
  c.get = async (p) => { if (p.endsWith("/workers/routes")) throw new CloudflareApiError("cloudflare_api_failed:GET:/zones/z1/workers/routes:403:10000"); return get(p); };
  await assert.rejects(runHarnessChecks(c, { mode: "dormant", phase: "readback", harnessToml: pinnedToml, expected: EXP }), CloudflareApiError);
});

// ---------------------------------------------------------------- plan (read-only board)
test("plan: today's state (old D1 binding, no auth D1, no harness) is not defective but not ready; the next owner actions are named", async () => {
  const w = world({ authListed: false, harness: { exists: false } }); w.privateBindings[0].id = PRIVATE.oldD1Id;
  const plan = await runActivationPlan(fakeClient(w), { files: { harnessToml: realHarnessToml } });
  const by = Object.fromEntries(plan.items.map((i) => [i.id, i]));
  assert.equal(by.private_d1_schema.status, "GO");
  assert.equal(by.private_worker_bound_d1.status, "OWNER_ACTION");
  assert.match(by.private_worker_bound_d1.detail, /s1-3-staging-deploy-v2/);
  assert.equal(by.auth_d1.status, "OWNER_ACTION");
  assert.match(by.auth_d1.detail, /s1-3-staging-auth-d1/);
  assert.equal(by.harness_worker.status, "OWNER_ACTION");
  assert.match(by.harness_secrets.detail, /STAGE_C_HARNESS_TOKEN.*PRIVATE_GATEWAY_HMAC_KEY.*STAGING_OAUTH_SIGNING_KEY/);
  assert.equal(plan.ok, true);
  assert.equal(plan.ready.harness_enable, false); assert.equal(plan.ready.stagec_live_run, false); assert.equal(plan.ready.harness_dormant_deploy, false);
  assert.equal(plan.ready.private_rebind_deploy, true);
  assert.equal(plan.ready.auth_d1_create, true); // The database is absent; creating it is a valid next action.
  assert.match(planMarkdown(plan), /OWNER ACTION/);
});
test("plan: the auth D1 exists but is unpinned -> owner action naming the id; a differing pin or wrong schema is NO-GO", async () => {
  const plan = await runActivationPlan(fakeClient(world({ harness: { exists: false } })), { files: { harnessToml: realHarnessToml } });
  if (ACTIVATION.auth.dbId === null) { const a = plan.items.find((i) => i.id === "auth_d1"); assert.equal(a.status, "OWNER_ACTION"); assert.ok(a.detail.includes(AUTH_ID)); }
  assert.equal(plan.ready.auth_d1_create, false); // Already exists: pin it, never recommend duplicate creation.
  const wrongPin = await runActivationPlan(fakeClient(world({ harness: { exists: false }, authId: "99999999-2222-4333-8444-555555555555" })), { files: { harnessToml: pinnedToml }, expected: EXP });
  assert.equal(wrongPin.items.find((i) => i.id === "auth_d1").status, "NO_GO");
  assert.equal(wrongPin.ok, false);
  const bad = await runActivationPlan(fakeClient(world({ authDb: authDb({ migrate: false }), harness: { exists: false } })), { files: { harnessToml: pinnedToml }, expected: EXP });
  assert.equal(bad.items.find((i) => i.id === "auth_d1").status, "NO_GO");
});
test("plan: fully activated staging reports ready for the live Stage C run; one missing secret withdraws readiness", async () => {
  const ok = await runActivationPlan(fakeClient(enableWorld()), { files: { harnessToml: enableToml }, expected: EXP });
  assert.deepEqual(ok.items.filter((i) => i.status !== "GO"), []);
  assert.equal(ok.ready.stagec_live_run, true); assert.equal(ok.ready.harness_enable, true); assert.equal(ok.ok, true);
  const w = enableWorld(); w.harness.secrets = w.harness.secrets.slice(1);
  const miss = await runActivationPlan(fakeClient(w), { files: { harnessToml: enableToml }, expected: EXP });
  assert.equal(miss.ready.stagec_live_run, false);
  assert.match(miss.items.find((i) => i.id === "harness_secrets").detail, /missing: STAGE_C_HARNESS_TOKEN/);
});
test("plan: unreadable API state becomes NO-GO items, never a pass, and secret values never appear", async () => {
  const c = fakeClient(world()); const get = c.get.bind(c);
  c.get = async (p) => { if (p.includes("/secrets")) throw new CloudflareApiError("cloudflare_api_failed:GET:/secrets:403:10000"); return get(p); };
  const plan = await runActivationPlan(c, { files: { harnessToml: pinnedToml }, expected: EXP });
  assert.ok(plan.items.some((i) => i.status === "NO_GO" && /unreadable/.test(i.detail)));
  assert.equal(plan.ok, false);
  assert.equal(plan.ready.auth_d1_create, false); // Unverifiable state must not authorize create.
  assert.ok(!JSON.stringify(plan).includes(TOKEN));
});

// ---------------------------------------------------------------- CLI
const CLI = new URL("../scripts/staging/s1-3-activation.mjs", import.meta.url).pathname;
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
test("cli: verify-harness-config exits 1 for the real (unpinned) toml; unknown mode and missing args exit 1", () => {
  if (ACTIVATION.auth.dbId === null) assert.equal(run(["verify-harness-config", new URL("../wrangler.stagec-harness.toml", import.meta.url).pathname]).status, 1);
  assert.equal(run(["bogus"]).status, 1);
  assert.equal(run(["verify-harness-config"]).status, 1);
  assert.equal(run(["verify-harness-config", "x", "--mode", "weird"]).status, 1);
  assert.equal(run(["harness-preflight", "--mode", "dormant"]).status, 1);
});
test("cli: verify-auth-migration passes the reviewed bytes and rejects altered bytes", () => {
  assert.equal(run(["verify-auth-migration", new URL("../migrations/staging-auth/0001_staging_auth.sql", import.meta.url).pathname]).status, 0);
  const dir = mkdtempSync(join(tmpdir(), "s13a-")); const f = join(dir, "m.sql"); writeFileSync(f, `${authSql}\n-- tampered`);
  assert.equal(run(["verify-auth-migration", f]).status, 1);
});
test("cli: write-auth-d1-config writes only the pinned auth D1 binding and refuses placeholder/foreign ids and odd paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "s13b-")); const out = join(dir, "w.toml");
  assert.equal(run(["write-auth-d1-config", "--db-id", AUTH_ID, "--migrations-dir", "/work/migrations/staging-auth", "--out", out]).status, 0);
  const t = readFileSync(out, "utf8");
  assert.match(t, /binding = "STAGING_AUTH_DB"/); assert.match(t, new RegExp(`database_id = "${AUTH_ID}"`)); assert.ok(!/main|routes|vars|services/.test(t));
  for (const bad of [ACTIVATION.zeroId, PRIVATE.d1Id, PRIVATE.oldD1Id, "nope"]) assert.equal(run(["write-auth-d1-config", "--db-id", bad, "--migrations-dir", "/w/m", "--out", out]).status, 1, bad);
  assert.equal(run(["write-auth-d1-config", "--db-id", AUTH_ID, "--migrations-dir", "/w/m\"; x", "--out", out]).status, 1);
  assert.equal(run(["write-auth-d1-config", "--db-id", AUTH_ID, "--migrations-dir", "relative/dir", "--out", out]).status, 1);
});
test("cli: credentialed modes without valid credentials fail closed and never print the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "s13c-")); const tomlPath = join(dir, "h.toml"); writeFileSync(tomlPath, pinnedToml);
  const env = { SOURCE_SHA: "a".repeat(40), CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "bad" };
  for (const args of [["create-auth-d1", "--out", join(dir, "o.json")], ["verify-auth-d1", "--db-id", AUTH_ID], ["harness-preflight", "--mode", "dormant", "--harness-toml", tomlPath], ["harness-readback", "--mode", "enable", "--harness-toml", tomlPath], ["plan", "--root", new URL("..", import.meta.url).pathname]]) {
    const r = run(args, env);
    assert.equal(r.status, 1, args[0]);
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN), args[0]);
  }
});

// ---------------------------------------------------------------- issue #101: Access service token policy + dormant rollback
import { harnessRollbackPlan, runHarnessRollbackPlan } from "../scripts/staging/s1-3-activation-lib.mjs";

const TOKEN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_TOKEN_ID = "11111111-2222-4333-8444-666666666666";
const serviceAuthApp = (include, over = {}) => ({ domain: ISSUER_HOST, type: "self_hosted", policies: [{ decision: "non_identity", include, ...over }] });
const pinnedToken = { allowedServiceTokenId: TOKEN_ID };
const EXP_TOKEN = Object.freeze({ ...EXP, access: Object.freeze({ serviceTokenId: TOKEN_ID }) });

test("access pin point: the service token id is unpinned by default and frozen, so Service Auth cannot be enabled by accident", () => {
  assert.equal(ACTIVATION.access.serviceTokenId, null);
  assert.ok(Object.isFrozen(ACTIVATION.access) && Object.isFrozen(ACTIVATION));
  assert.throws(() => { "use strict"; ACTIVATION.access.serviceTokenId = TOKEN_ID; }, TypeError);
});

test("service auth policy: exactly the one pinned service token is accepted (alone, or next to an identity policy)", () => {
  assert.deepEqual(verifyAccessApp([serviceAuthApp([{ service_token: { token_id: TOKEN_ID } }])], ISSUER_HOST, pinnedToken), []);
  const both = { ...goodApp(), policies: [...goodApp().policies, { decision: "non_identity", include: [{ service_token: { token_id: TOKEN_ID } }] }] };
  assert.deepEqual(verifyAccessApp([both], ISSUER_HOST, pinnedToken), []);
  assert.deepEqual(verifyAccessApp([serviceAuthApp([{ service_token: { token_id: TOKEN_ID } }, { service_token: { token_id: TOKEN_ID } }])], ISSUER_HOST, pinnedToken), []);
  // an extra `require`/`exclude` only narrows access and is tolerated
  assert.deepEqual(verifyAccessApp([serviceAuthApp([{ service_token: { token_id: TOKEN_ID } }], { require: [{ ip: { ip: "192.0.2.0/24" } }], exclude: [{ email: { email: "x@example.com" } }] })], ISSUER_HOST, pinnedToken), []);
});

test("service auth policy: fails closed when unpinned, for the wrong token, any_valid_service_token, mixed rules, bypass and unknown shapes", () => {
  const good = [{ service_token: { token_id: TOKEN_ID } }];
  const bad = (apps, opts, code) => assert.ok(verifyAccessApp(apps, ISSUER_HOST, opts).includes(code), `${code}: ${JSON.stringify(verifyAccessApp(apps, ISSUER_HOST, opts))}`);
  // unpinned (the default): ANY non_identity policy is rejected, even a perfectly specific one
  bad([serviceAuthApp(good)], undefined, "access_service_token_not_pinned");
  bad([serviceAuthApp(good)], { allowedServiceTokenId: null }, "access_service_token_not_pinned");
  for (const unusable of [ACTIVATION.zeroId, "not-a-uuid", 42, "", undefined]) bad([serviceAuthApp(good)], { allowedServiceTokenId: unusable }, "access_service_token_not_pinned");
  // wrong / unreadable token ids
  bad([serviceAuthApp([{ service_token: { token_id: OTHER_TOKEN_ID } }])], pinnedToken, "access_service_token_not_the_pinned_token");
  bad([serviceAuthApp([{ service_token: { token_id: TOKEN_ID } }, { service_token: { token_id: OTHER_TOKEN_ID } }])], pinnedToken, "access_service_token_not_the_pinned_token");
  bad([serviceAuthApp([{ service_token: {} }])], pinnedToken, "access_service_token_id_unreadable");
  bad([serviceAuthApp([{ service_token: { token_id: "x" } }])], pinnedToken, "access_service_token_id_unreadable");
  bad([serviceAuthApp([{ service_token: null }])], pinnedToken, "access_service_token_id_unreadable");
  // any valid service token (every token in the account) is never acceptable, in any decision
  bad([serviceAuthApp([{ any_valid_service_token: {} }])], pinnedToken, "access_policy_any_valid_service_token");
  bad([serviceAuthApp([{ any_valid_service_token: {} }])], pinnedToken, "access_service_auth_include_not_specific_service_token");
  bad([serviceAuthApp([...good, { any_valid_service_token: {} }])], pinnedToken, "access_policy_any_valid_service_token");
  bad([{ ...goodApp(), policies: [{ decision: "allow", include: [{ any_valid_service_token: {} }] }] }], pinnedToken, "access_policy_any_valid_service_token");
  // Service Auth may not be widened with other selectors
  bad([serviceAuthApp([...good, { email: { email: "owner@example.com" } }])], pinnedToken, "access_service_auth_include_not_specific_service_token");
  bad([serviceAuthApp([...good, { everyone: {} }])], pinnedToken, "access_policy_allows_everyone");
  bad([serviceAuthApp([{ ip: { ip: "0.0.0.0/0" } }])], pinnedToken, "access_policy_allows_every_ip");
  bad([serviceAuthApp([{ ip: { ip: "::/0" } }])], pinnedToken, "access_policy_allows_every_ip");
  bad([serviceAuthApp([{ ...good[0], extra: 1 }])], pinnedToken, "access_policy_include_unrecognized");
  // service-token selectors belong to the Service Auth decision only
  bad([{ ...goodApp(), policies: [{ decision: "allow", include: good }] }], pinnedToken, "access_service_token_requires_service_auth_decision");
  // bypass, unknown decisions, unreadable includes (e.g. a reusable-policy reference without rules) all fail closed
  bad([{ ...goodApp(), policies: [{ decision: "bypass", include: good }] }], pinnedToken, "access_policy_bypass");
  bad([{ ...goodApp(), policies: [{ decision: "mystery", include: good }] }], pinnedToken, "access_policy_decision_unknown");
  bad([{ ...goodApp(), policies: [{ include: good }] }], pinnedToken, "access_policy_decision_unknown");
  bad([{ ...goodApp(), policies: [{ id: "reusable-policy-ref" }] }], pinnedToken, "access_policy_decision_unknown");
  bad([serviceAuthApp(undefined)], pinnedToken, "access_policy_include_unreadable");
  bad([serviceAuthApp([])], pinnedToken, "access_policy_include_unreadable");
  bad([serviceAuthApp("service_token")], pinnedToken, "access_policy_include_unreadable");
  bad([serviceAuthApp([null])], pinnedToken, "access_policy_include_unrecognized");
  // one safe policy never excuses an unsafe sibling
  bad([{ ...goodApp(), policies: [...goodApp().policies, { decision: "bypass", include: [] }] }], pinnedToken, "access_policy_bypass");
  bad([{ ...goodApp(), policies: [...serviceAuthApp(good).policies, { decision: "non_identity", include: [{ any_valid_service_token: {} }] }] }], pinnedToken, "access_policy_any_valid_service_token");
  // a deny policy narrows access and is not itself an error
  assert.deepEqual(verifyAccessApp([{ ...goodApp(), policies: [...goodApp().policies, { decision: "deny", include: [{ email_domain: { domain: "x.example" } }] }] }], ISSUER_HOST), []);
});

test("harness exposure (enable): the pinned service-token policy passes only when pinned in `expected`", () => {
  const live = { subdomain: { enabled: false, previews_enabled: false }, domains: [{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }], routes: [], accessApps: [serviceAuthApp([{ service_token: { token_id: TOKEN_ID } }])] };
  assert.deepEqual(verifyHarnessExposure(live, { expected: EXP_TOKEN, mode: "enable", issuerHost: ISSUER_HOST }), []);
  assert.ok(verifyHarnessExposure(live, { expected: EXP, mode: "enable", issuerHost: ISSUER_HOST }).includes("access_service_token_not_pinned"));
  assert.ok(verifyHarnessExposure({ ...live, accessApps: [serviceAuthApp([{ any_valid_service_token: {} }])] }, { expected: EXP_TOKEN, mode: "enable", issuerHost: ISSUER_HOST }).includes("access_policy_any_valid_service_token"));
});

test("activation plan + enable preflight use the strict verifier (any_valid_service_token blocks harness enable)", async () => {
  const unsafe = enableWorld(); unsafe.accessApps = [serviceAuthApp([{ any_valid_service_token: {} }])];
  const r = await runHarnessChecks(fakeClient(unsafe), { mode: "enable", phase: "preflight", harnessToml: enableToml, expected: EXP_TOKEN });
  assert.equal(r.ok, false);
  assert.ok(r.checks.find((c) => c.name === "harness_exposure_restricted_hostname").errors.includes("access_policy_any_valid_service_token"));
  const safe = enableWorld(); safe.accessApps = [serviceAuthApp([{ service_token: { token_id: TOKEN_ID } }])];
  assert.equal((await runHarnessChecks(fakeClient(safe), { mode: "enable", phase: "preflight", harnessToml: enableToml, expected: EXP_TOKEN })).ok, true);
  assert.equal((await runHarnessChecks(fakeClient(safe), { mode: "enable", phase: "readback", harnessToml: enableToml, expected: EXP_TOKEN })).ok, true);
  assert.equal((await runHarnessChecks(fakeClient(safe), { mode: "enable", phase: "preflight", harnessToml: enableToml, expected: EXP })).ok, false, "unpinned token id blocks enable");
});

test("rollback with the domain attached: the dormant preflight is NOT blocked (it is the disabling deploy), only for the exact issuer-host domain", async () => {
  const w = enableWorld(); // harness ENABLED, one Access-protected custom domain == issuer host
  const pre = await runHarnessChecks(fakeClient(w), { mode: "dormant", phase: "preflight", harnessToml: enableToml, expected: EXP });
  assert.equal(pre.ok, true, JSON.stringify(pre.checks.filter((c) => !c.ok)));
  assert.ok(pre.notes.some((n) => n.startsWith("rollback_domain_still_attached")), "the owner is told the domain still has to be detached");
  // even when the Access app has gone wrong: the disabling deploy must not be held hostage to it
  const broken = enableWorld(); broken.accessApps = [];
  assert.equal((await runHarnessChecks(fakeClient(broken), { mode: "dormant", phase: "preflight", harnessToml: enableToml, expected: EXP })).ok, true);
});

test("rollback with the domain attached: anything but exactly the issuer host still stops the preflight", async () => {
  const mk = (domains, over = {}) => { const w = enableWorld(); w.harness.domains = domains; return Object.assign(w, over); };
  const run = (w, toml = enableToml) => runHarnessChecks(fakeClient(w), { mode: "dormant", phase: "preflight", harnessToml: toml, expected: EXP });
  const fail = async (w, why, toml) => { const r = await run(w, toml); assert.equal(r.ok, false, why); assert.ok(r.checks.find((c) => c.name === "harness_no_public_exposure").errors.some((e) => e.startsWith("harness_custom_domain_present_while_dormant")), why); };
  await fail(mk([{ hostname: "other.example.com", service: "cairnstone-stage-harness" }]), "foreign host");
  await fail(mk([{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }, { hostname: "second.example.com", service: "cairnstone-stage-harness" }]), "two domains");
  await fail(mk([{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }, { hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }]), "duplicate attachment");
  await fail(mk([{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }]), "unpinned/placeholder issuer in the toml", pinnedToml);
  // zone routes and workers.dev are never tolerated, domain or not
  const routed = mk([{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }], { routes: [{ pattern: "h.example.com/*", script: "cairnstone-stage-harness" }] });
  const r = await run(routed); assert.equal(r.ok, false);
  assert.ok(r.checks.find((c) => c.name === "harness_no_public_exposure").errors.some((e) => e.startsWith("harness_zone_route")));
  const devOn = mk([{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }]); devOn.harness.subdomain = { enabled: true, previews_enabled: false };
  assert.equal((await run(devOn)).ok, false);
  // the exposure helper itself never tolerates the domain unless explicitly asked
  const state = { subdomain: { enabled: false, previews_enabled: false }, domains: [{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }], routes: [] };
  assert.ok(verifyHarnessExposure(state, { expected: EXP, mode: "dormant", issuerHost: ISSUER_HOST }).length > 0);
  assert.deepEqual(verifyHarnessExposure(state, { expected: EXP, mode: "dormant", issuerHost: ISSUER_HOST, allowAttachedIssuerDomain: true }), []);
  assert.ok(verifyHarnessExposure(state, { expected: EXP, mode: "dormant", issuerHost: null, allowAttachedIssuerDomain: true }).length > 0);
  assert.ok(verifyHarnessExposure(state, { expected: EXP, mode: "dormant", issuerHost: "", allowAttachedIssuerDomain: "yes" }).length > 0);
});

test("rollback with the domain attached: readback is NEVER green until the domain is detached, even though the harness is already disabled", async () => {
  const disabledButAttached = world({ harness: { exists: true, bindings: goodBindings(), secrets: ACTIVATION.harness.secrets.map((name) => ({ name })), subdomain: { enabled: false, previews_enabled: false }, domains: [{ hostname: ISSUER_HOST, service: "cairnstone-stage-harness" }] }, accessApps: [goodApp()] });
  const r = await runHarnessChecks(fakeClient(disabledButAttached), { mode: "dormant", phase: "readback", harnessToml: enableToml, expected: EXP });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "harness_bindings").ok, true, "the flag is false: the deploy did disable the harness");
  assert.equal(r.checks.find((c) => c.name === "harness_no_public_exposure").ok, false);
  assert.equal(r.notes, undefined, "readback has no tolerance note");
  disabledButAttached.harness.domains = [];
  assert.equal((await runHarnessChecks(fakeClient(disabledButAttached), { mode: "dormant", phase: "readback", harnessToml: enableToml, expected: EXP })).ok, true);
  // an ENABLED harness can never pass a dormant readback
  assert.equal((await runHarnessChecks(fakeClient(enableWorld()), { mode: "dormant", phase: "readback", harnessToml: enableToml, expected: EXP })).ok, false);
});

test("rollback plan: ordered, read-only verdicts; detach only after disable; unknown state falls back to removing the Worker", () => {
  const bindings = (enabled) => { const b = goodBindings(); b[4].text = enabled ? "true" : "false"; return b; };
  const dom = (hostname) => ({ hostname, service: "cairnstone-stage-harness" });
  const base = { routes: [], subdomain: { enabled: false, previews_enabled: false } };
  const plan = (o, issuerHost = ISSUER_HOST) => harnessRollbackPlan({ ...base, ...o }, { expected: EXP, issuerHost });

  const enabledAttached = plan({ bindings: bindings(true), domains: [dom(ISSUER_HOST)] });
  assert.equal(enabledAttached.verdict, "ENABLED_DOMAIN_ATTACHED"); assert.equal(enabledAttached.ok, false);
  assert.match(enabledAttached.steps[0], /^1\. .*phase=dormant/);
  assert.match(enabledAttached.steps[1], /^2\. Detach the custom domain .*pinned issuer host.*Do NOT detach before the harness is disabled/);
  assert.match(enabledAttached.steps[2], /^3\. .*phase=dormant again/);

  const disabledAttached = plan({ bindings: bindings(false), domains: [dom(ISSUER_HOST)] });
  assert.equal(disabledAttached.verdict, "DISABLED_DOMAIN_ATTACHED"); assert.equal(disabledAttached.ok, false);
  assert.match(disabledAttached.steps[0], /^1\. Detach/); assert.match(disabledAttached.steps[1], /^2\. .*dormant again/);

  const enabledBare = plan({ bindings: bindings(true), domains: [] });
  assert.equal(enabledBare.verdict, "ENABLED_NO_DOMAIN"); assert.equal(enabledBare.ok, false);
  const done = plan({ bindings: bindings(false), domains: [] });
  assert.deepEqual(done, { verdict: "DORMANT_AND_DETACHED", ok: true, steps: [] });

  const foreign = plan({ bindings: bindings(false), domains: [dom("elsewhere.example.com")] });
  assert.equal(foreign.ok, false); assert.match(foreign.steps[0], /delete the Worker/); assert.ok(foreign.steps.some((s) => s.includes("UNEXPECTED: elsewhere.example.com")));
  // domains of other Workers are not ours
  assert.equal(plan({ bindings: bindings(false), domains: [{ hostname: "x.example.com", service: "someone-else" }] }).verdict, "DORMANT_AND_DETACHED");
  // unreadable / ambiguous / extra exposure: fail closed to the unconditional disable
  for (const o of [{ bindings: undefined, domains: [] }, { bindings: [], domains: [] }, { bindings: bindings(false), domains: undefined }, { bindings: bindings(false), domains: [], subdomain: { enabled: true } }, { bindings: bindings(false), domains: [], subdomain: undefined }, { bindings: bindings(false), domains: [], routes: [{ pattern: "h/*", script: "cairnstone-stage-harness" }] }]) {
    const r = plan(o); assert.equal(r.verdict, "UNKNOWN_STATE_FAIL_CLOSED", JSON.stringify(o)); assert.equal(r.ok, false); assert.match(r.steps[0], /delete the Worker/);
  }
});

test("rollback plan runner: reads live state read-only; absent Worker is nothing-enabled; never writes", async () => {
  const w = enableWorld(); const c = fakeClient(w);
  const live = await runHarnessRollbackPlan(c, { harnessToml: enableToml, expected: EXP });
  assert.equal(live.verdict, "ENABLED_DOMAIN_ATTACHED");
  assert.ok(c.calls.every((p) => typeof p === "string") && c.calls.length > 0);
  w.harness.bindings = goodBindings(); w.harness.domains = [];
  assert.equal((await runHarnessRollbackPlan(fakeClient(w), { harnessToml: enableToml, expected: EXP })).verdict, "DORMANT_AND_DETACHED");
  const absent = await runHarnessRollbackPlan(fakeClient(world({ harness: { exists: false } })), { harnessToml: enableToml, expected: EXP });
  assert.equal(absent.verdict, "WORKER_ABSENT"); assert.equal(absent.ok, true);
  // an API failure is not swallowed into a green verdict
  const broken = { accountId: ACCT, async get() { throw new CloudflareApiError("cloudflare_api_failed:GET:/x:500:"); } };
  await assert.rejects(runHarnessRollbackPlan(broken, { harnessToml: enableToml, expected: EXP }), { code: "cloudflare_api_failed:GET:/x:500:" });
});

test("cli: harness-rollback-plan fails closed without credentials and never prints the token", () => {
  const dir = mkdtempSync(join(tmpdir(), "s13d-")); const tomlPath = join(dir, "h.toml"); writeFileSync(tomlPath, enableToml);
  const env = { SOURCE_SHA: "a".repeat(40), CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "bad" };
  const r = run(["harness-rollback-plan", "--harness-toml", tomlPath], env);
  assert.equal(r.status, 1); assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  assert.equal(run(["harness-rollback-plan"], env).status, 1);
});
