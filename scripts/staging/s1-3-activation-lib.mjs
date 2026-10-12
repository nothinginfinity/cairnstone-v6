// S1-3 staging ACTIVATION verification (issue #97). STAGING ONLY.
// Pure verifiers + a fail-closed Cloudflare API client. Zero dependencies (runs before any `npm ci`).
// Read-only against Cloudflare, with exactly ONE write: createAuthD1() (POST /d1/database, pinned name only).
// Nothing here ever prints or returns the API token or any secret VALUE; only secret NAMES are inspected.
// Every verifier returns an array of error strings; an empty array means the check passed.
import { EXPECTED as PRIVATE, CloudflareApiError, createCloudflareClient, checkD1Schema, checkWorkerState, normalizeConfig } from "./s1-3-preflight-lib.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

export const ACTIVATION = Object.freeze({
  zeroId: ZERO_ID,
  auth: Object.freeze({
    dbName: "cairnstone-staging-auth",
    // PIN POINT. null until the owner-approved create workflow has run and a reviewed PR pins the printed id here AND in
    // wrangler.stagec-harness.toml. While null, every harness deploy/enable path fails closed ("auth_d1_id_not_pinned").
    dbId: null,
    binding: "STAGING_AUTH_DB",
    migrationsDir: "migrations/staging-auth",
    migrationFile: "0001_staging_auth.sql",
    migrationSha256: "775d2ae29d20ca3d9bf9d6179221d2770e9e92183780fd6bce1fafd44324fb51",
    schemaVersion: 1,
    tables: Object.freeze(["staging_auth_schema", "staging_connections", "staging_token_families"]),
    triggers: Object.freeze([
      "staging_connections_identity_frozen", "staging_connections_revoked_is_terminal", "staging_connections_no_delete",
      "staging_token_families_identity_frozen", "staging_token_families_revocation_is_permanent",
      "staging_token_families_no_delete", "staging_token_families_same_account"
    ])
  }),
  harness: Object.freeze({
    workerName: "cairnstone-stage-harness",
    privateWorker: PRIVATE.workerName,
    secrets: Object.freeze(["STAGE_C_HARNESS_TOKEN", "PRIVATE_GATEWAY_HMAC_KEY", "STAGING_OAUTH_SIGNING_KEY"]),
    services: Object.freeze([
      { binding: "CAIRNSTONE_PRIVATE_STAGE", caller: "cairnstone-stage-gateway" },
      { binding: "CAIRNSTONE_PRIVATE_STAGE_NOPROPS", caller: null },
      { binding: "CAIRNSTONE_PRIVATE_STAGE_WRONGPROPS", caller: "not-the-stage-gateway" }
    ]),
    oauthPath: "/mcp/core-auth"
  })
});

const FIXED = Object.freeze([
  'name = "cairnstone-stage-harness"',
  'main = "src/staging-gateway/stagec-harness-worker.js"',
  'compatibility_date = "2026-06-21"',
  "workers_dev = false",
  "preview_urls = false",
  "send_metrics = false",
  "[vars]",
  'STAGE_C_HARNESS_ENABLED = "false"', // the file NEVER enables the harness; `enable` is a deploy-time --var only
  "STAGING_OAUTH_RESOURCE = <resource>",
  "STAGING_OAUTH_ISSUER = <issuer>",
  "[[services]]",
  'binding = "CAIRNSTONE_PRIVATE_STAGE"',
  'service = "cairnstone-private-staging"',
  'props = { caller = "cairnstone-stage-gateway" }',
  "[[services]]",
  'binding = "CAIRNSTONE_PRIVATE_STAGE_NOPROPS"',
  'service = "cairnstone-private-staging"',
  "[[services]]",
  'binding = "CAIRNSTONE_PRIVATE_STAGE_WRONGPROPS"',
  'service = "cairnstone-private-staging"',
  'props = { caller = "not-the-stage-gateway" }',
  "[[d1_databases]]",
  'binding = "STAGING_AUTH_DB"',
  'database_name = "cairnstone-staging-auth"',
  "database_id = <auth-d1-id>",
  'migrations_dir = "migrations/staging-auth"'
]);

const redact = (l) => (l.length > 80 ? `${l.slice(0, 80)}…` : l);
const isExampleHost = (host) => /(^|\.)example(\.[a-z]+)?$/i.test(host) || host === "localhost";

/**
 * Exact-line verification of wrangler.stagec-harness.toml.
 *  - the auth D1 id must be PINNED in this module, real, non-placeholder, and equal to the file;
 *  - the file may never enable the harness, add routes/domains/workers.dev/previews/triggers/other bindings;
 *  - mode "enable" additionally requires a non-placeholder https issuer and resource = issuer + /mcp/core-auth.
 */
export function verifyHarnessConfig(text, { expected = ACTIVATION, mode = "dormant" } = {}) {
  const errors = [];
  const pinned = expected.auth.dbId;
  if (pinned === null || pinned === undefined) errors.push("auth_d1_id_not_pinned");
  else if (!UUID.test(pinned)) errors.push("auth_d1_id_pin_malformed");
  else if (pinned === ZERO_ID || pinned === PRIVATE.d1Id || pinned === PRIVATE.oldD1Id) errors.push("auth_d1_id_pin_is_placeholder_or_foreign");
  const raw = String(text);
  if (raw.includes(ZERO_ID)) errors.push("config_placeholder_all_zero_d1_id");
  if (raw.includes(PRIVATE.oldD1Id)) errors.push("config_references_old_staging_d1");
  if (raw.includes(PRIVATE.d1Id)) errors.push("config_binds_private_realm_d1");

  let issuer = null, resource = null, authId = null;
  const got = normalizeConfig(raw).map((l) => {
    let m;
    if ((m = l.match(/^STAGING_OAUTH_ISSUER = "(https:\/\/[^"\s]+)"$/))) { issuer = m[1]; return "STAGING_OAUTH_ISSUER = <issuer>"; }
    if ((m = l.match(/^STAGING_OAUTH_RESOURCE = "(https:\/\/[^"\s]+)"$/))) { resource = m[1]; return "STAGING_OAUTH_RESOURCE = <resource>"; }
    if ((m = l.match(/^database_id = "([0-9a-f-]{36})"$/))) { authId = m[1]; return "database_id = <auth-d1-id>"; }
    return l;
  });
  for (const l of got) if (!FIXED.includes(l)) errors.push(`config_unexpected_line: ${redact(l)}`);
  for (const l of FIXED) if (!got.includes(l)) errors.push(`config_missing_line: ${l}`);
  if (got.length !== FIXED.length) errors.push(`config_line_count: expected ${FIXED.length}, got ${got.length}`);
  for (let i = 0; i < Math.min(got.length, FIXED.length); i++) if (got[i] !== FIXED[i]) { errors.push("config_order_or_content_mismatch"); break; }
  if (authId !== null && pinned && authId !== pinned) errors.push("config_auth_d1_id_differs_from_pin");

  if (issuer && resource) {
    let iu, ru;
    try { iu = new URL(issuer); ru = new URL(resource); } catch { errors.push("oauth_url_malformed"); }
    if (iu && ru) {
      if (iu.pathname !== "/" || iu.search || iu.hash) errors.push("oauth_issuer_must_be_bare_origin");
      if (ru.origin !== iu.origin || ru.pathname !== expected.harness.oauthPath || ru.search || ru.hash) errors.push("oauth_resource_must_be_issuer_plus_core_auth_path");
      if (mode === "enable" && (isExampleHost(iu.hostname) || isExampleHost(ru.hostname))) errors.push("oauth_placeholder_hostname_not_allowed_for_enable");
    }
  }
  return errors;
}

/** The migration file the create workflow applies must be exactly the reviewed bytes. */
export function verifyAuthMigrationSha(sha256Hex, expected = ACTIVATION) {
  return sha256Hex === expected.auth.migrationSha256 ? [] : ["auth_migration_sha256_differs_from_reviewed"];
}

/** Validate an id before it is ever written into a generated config or compared to live state. */
export function verifyNewAuthD1Id(id) {
  const errors = [];
  if (typeof id !== "string" || !UUID.test(id)) errors.push("auth_d1_id_malformed");
  else if (id === ZERO_ID) errors.push("auth_d1_id_is_all_zero_placeholder");
  else if (id === PRIVATE.d1Id || id === PRIVATE.oldD1Id) errors.push("auth_d1_id_collides_with_private_realm_d1");
  return errors;
}

/** Live schema of cairnstone-staging-auth (rows are what D1 /query returns). */
export function verifyAuthD1Schema({ tables, triggers, versions, counts }, { expected = ACTIVATION, requireEmpty = false } = {}) {
  const errors = [];
  const names = new Set((tables ?? []).map((r) => r.name));
  for (const t of expected.auth.tables) if (!names.has(t)) errors.push(`auth_d1_table_missing: ${t}`);
  for (const want of expected.auth.triggers) {
    const t = (triggers ?? []).find((r) => r.name === want);
    if (!t) { errors.push(`auth_d1_trigger_missing: ${want}`); continue; }
    if (!/RAISE\s*\(\s*ABORT/i.test(String(t.sql ?? ""))) errors.push(`auth_d1_trigger_weakened: ${want}`);
  }
  const v = Array.isArray(versions) ? versions.map((r) => Number(r.version)) : null;
  if (!v || v.length !== 1 || v[0] !== expected.auth.schemaVersion) errors.push("auth_d1_schema_version_not_exactly_1");
  if (requireEmpty && (Number(counts?.connections) !== 0 || Number(counts?.families) !== 0)) errors.push("auth_d1_not_empty_after_create");
  return errors;
}

/** Harness Worker bindings. `enabledValues` = the STAGE_C_HARNESS_ENABLED values acceptable at this point in the flow. */
export function verifyHarnessSettings(settingsResult, { expected = ACTIVATION, enabledValues = ["false"] } = {}) {
  const errors = [];
  const bindings = Array.isArray(settingsResult?.bindings) ? settingsResult.bindings : null;
  if (!bindings) return ["harness_bindings_unreadable"];
  const svc = bindings.filter((b) => b.type === "service");
  if (svc.length !== expected.harness.services.length) errors.push("harness_unexpected_service_binding_count");
  for (const want of expected.harness.services) {
    const b = svc.find((s) => s.name === want.binding);
    if (!b) { errors.push(`harness_service_binding_missing: ${want.binding}`); continue; }
    if (b.service !== expected.harness.privateWorker) errors.push(`harness_service_binding_wrong_target: ${want.binding}`);
    // `props` is not guaranteed to be returned by the API: when it IS returned it must match exactly; behavior is proven by Stage C C04.
    if (b.props !== undefined) {
      const caller = b.props && typeof b.props === "object" ? b.props.caller : undefined;
      if (want.caller === null ? caller !== undefined : caller !== want.caller) errors.push(`harness_service_props_mismatch: ${want.binding}`);
    }
  }
  const d1 = bindings.filter((b) => b.type === "d1");
  const pinned = expected.auth.dbId;
  if (d1.length !== 1 || d1[0].name !== expected.auth.binding || !pinned || d1[0].id !== pinned) errors.push("harness_unexpected_d1_binding");
  const plain = Object.fromEntries(bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]));
  const wantVars = ["STAGE_C_HARNESS_ENABLED", "STAGING_OAUTH_ISSUER", "STAGING_OAUTH_RESOURCE"];
  if (Object.keys(plain).sort().join(",") !== wantVars.join(",")) errors.push("harness_unexpected_vars");
  if (!enabledValues.includes(plain.STAGE_C_HARNESS_ENABLED)) errors.push("harness_enabled_flag_unexpected");
  for (const b of bindings) {
    if (["service", "d1", "plain_text"].includes(b.type)) continue;
    if (b.type === "secret_text" && expected.harness.secrets.includes(b.name)) continue;
    errors.push(`harness_unexpected_binding: ${b.type}:${b.name}`); // r2, kv, durable_object, ai, queue, ...
  }
  return errors;
}

/** Secret NAMES only. requireAll: every required name must exist; unknown names always fail. */
export function verifyHarnessSecrets(list, { expected = ACTIVATION, requireAll = false } = {}) {
  if (!Array.isArray(list)) return ["harness_secrets_unreadable"];
  const errors = [];
  if (requireAll) for (const n of expected.harness.secrets) if (!list.some((s) => s.name === n)) errors.push(`harness_secret_absent: ${n}`);
  for (const s of list) if (!expected.harness.secrets.includes(s.name)) errors.push(`harness_secret_unexpected: ${s.name}`);
  return errors;
}

/** Names of required harness secrets that are not yet present (for the operator checklist). */
export function missingHarnessSecrets(list, expected = ACTIVATION) {
  const have = new Set((Array.isArray(list) ? list : []).map((s) => s.name));
  return expected.harness.secrets.filter((n) => !have.has(n));
}

/** Cloudflare Access app protecting the hostname: exactly one self-hosted app, >=1 policy, no bypass, no "everyone". */
export function verifyAccessApp(apps, host) {
  if (!Array.isArray(apps)) return ["access_apps_unreadable"];
  const hits = apps.filter((a) => a?.domain === host || (Array.isArray(a?.destinations) && a.destinations.some((d) => d?.uri === host)));
  if (hits.length !== 1) return [`access_app_count_for_host_${hits.length}`];
  const app = hits[0];
  const errors = [];
  if (app.type !== "self_hosted") errors.push("access_app_not_self_hosted");
  if (!Array.isArray(app.policies) || app.policies.length === 0) return [...errors, "access_policies_missing_or_unreadable"];
  for (const p of app.policies) {
    if (p?.decision === "bypass" || p?.decision === "non_identity") errors.push("access_policy_bypass");
    if (Array.isArray(p?.include) && p.include.some((i) => i && typeof i === "object" && "everyone" in i)) errors.push("access_policy_allows_everyone");
  }
  return errors;
}

/** Exposure of the HARNESS Worker. dormant: none at all. enable: exactly one custom domain == issuer host, no zone routes, Access app verified. */
export function verifyHarnessExposure({ subdomain, domains, routes, accessApps }, { expected = ACTIVATION, mode = "dormant", issuerHost = null } = {}) {
  const errors = [];
  if (!subdomain || subdomain.enabled !== false) errors.push("harness_workers_dev_enabled_or_unknown");
  if (subdomain && subdomain.previews_enabled !== undefined && subdomain.previews_enabled !== false) errors.push("harness_previews_enabled");
  if (!Array.isArray(routes)) errors.push("harness_routes_unreadable");
  else for (const r of routes) if (r?.script === expected.harness.workerName) errors.push(`harness_zone_route: ${r.pattern ?? "unknown"}`);
  if (!Array.isArray(domains)) { errors.push("harness_domains_unreadable"); return errors; }
  const mine = domains.filter((d) => d?.service === expected.harness.workerName);
  if (mode === "dormant") {
    for (const d of mine) errors.push(`harness_custom_domain_present_while_dormant: ${d?.hostname ?? "unknown"}`);
    return errors;
  }
  if (!issuerHost) { errors.push("harness_issuer_host_unknown"); return errors; }
  if (mine.length !== 1 || mine[0].hostname !== issuerHost) errors.push("harness_domain_must_be_exactly_the_issuer_host");
  errors.push(...verifyAccessApp(accessApps, issuerHost));
  return errors;
}

// ---- Fail-closed client: read-only, plus ONE pinned write (create the auth D1) ----

export function createActivationClient({ token, accountId, fetchImpl = globalThis.fetch } = {}) {
  const base = createCloudflareClient({ token, accountId, fetchImpl }); // validates credentials
  const root = "https://api.cloudflare.com/client/v4";
  async function createAuthD1(name = ACTIVATION.auth.dbName) {
    if (name !== ACTIVATION.auth.dbName) throw new CloudflareApiError("create_d1_name_not_pinned_auth_db");
    const path = `/accounts/${accountId}/d1/database`;
    let res, json;
    try {
      res = await fetchImpl(`${root}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      json = await res.json();
    } catch { throw new CloudflareApiError("cloudflare_create_d1_failed"); }
    if (!res.ok || json?.success !== true) throw new CloudflareApiError(`cloudflare_api_failed:POST:/accounts/<acct>/d1/database:${res.status}:`);
    const id = json?.result?.uuid;
    const bad = verifyNewAuthD1Id(id);
    if (bad.length) throw new CloudflareApiError(`create_d1_returned_unusable_id:${bad[0]}`);
    return { id, name: json.result.name ?? name };
  }
  return { ...base, createAuthD1 };
}

const check = (name, errors) => ({ name, ok: errors.length === 0, errors });
const absent = (e) => e instanceof CloudflareApiError && /^cloudflare_api_failed:GET:[^:]*:404:/.test(e.code);

async function listD1ByName(client, name) {
  const r = await client.get(`/accounts/${client.accountId}/d1/database?name=${encodeURIComponent(name)}`);
  return (r.result ?? []).filter((d) => d?.name === name).map((d) => ({ id: d.uuid, name: d.name }));
}

async function collectZoneRoutes(client) {
  const routes = [];
  for (let page = 1; page <= 20; page++) {
    const zones = await client.get(`/zones?per_page=50&page=${page}`);
    for (const z of zones.result ?? []) routes.push(...((await client.get(`/zones/${z.id}/workers/routes`)).result ?? []));
    const info = zones.result_info;
    if (!info || page >= (info.total_pages ?? 1)) return routes;
  }
  throw new CloudflareApiError("cloudflare_zone_pagination_exceeded");
}

/** Name-only identity check (used before applying migrations to a database id the operator supplied for a resumed run). */
export async function checkAuthD1Identity(client, dbId, { expected = ACTIVATION } = {}) {
  const idErrors = verifyNewAuthD1Id(dbId);
  if (idErrors.length) return check("auth_d1_identity", idErrors);
  const meta = (await client.get(`/accounts/${client.accountId}/d1/database/${dbId}`)).result;
  return check("auth_d1_identity", meta?.name === expected.auth.dbName ? [] : ["auth_d1_name_mismatch"]);
}

/** Live read-only verification of cairnstone-staging-auth at a given id (post-create, pre-harness, readiness). */
export async function checkAuthD1(client, dbId, { expected = ACTIVATION, requireEmpty = false } = {}) {
  const idErrors = verifyNewAuthD1Id(dbId);
  if (idErrors.length) return check("auth_d1_schema", idErrors);
  const meta = (await client.get(`/accounts/${client.accountId}/d1/database/${dbId}`)).result;
  const errors = [];
  if (meta?.name !== expected.auth.dbName) errors.push("auth_d1_name_mismatch");
  const tables = await client.d1(dbId, "SELECT name FROM sqlite_master WHERE type='table'");
  const triggers = await client.d1(dbId, "SELECT name, sql FROM sqlite_master WHERE type='trigger'");
  const hasSchema = tables.some((t) => t.name === "staging_auth_schema");
  const versions = hasSchema ? await client.d1(dbId, "SELECT version FROM staging_auth_schema") : [];
  const hasData = tables.some((t) => t.name === "staging_connections") && tables.some((t) => t.name === "staging_token_families");
  const counts = hasData ? {
    connections: (await client.d1(dbId, "SELECT COUNT(*) AS n FROM staging_connections"))[0]?.n,
    families: (await client.d1(dbId, "SELECT COUNT(*) AS n FROM staging_token_families"))[0]?.n
  } : undefined;
  errors.push(...verifyAuthD1Schema({ tables, triggers, versions, counts }, { expected, requireEmpty }));
  return check("auth_d1_schema", errors);
}

async function readHarness(client, expected) {
  const acct = client.accountId;
  const w = `/accounts/${acct}/workers/scripts/${expected.harness.workerName}`;
  try {
    const settings = (await client.get(`${w}/settings`)).result;
    const secrets = (await client.get(`${w}/secrets`)).result;
    const subdomain = (await client.get(`${w}/subdomain`)).result;
    const domains = (await client.get(`/accounts/${acct}/workers/domains?service=${expected.harness.workerName}`)).result;
    const routes = await collectZoneRoutes(client);
    return { exists: true, settings, secrets, subdomain, domains, routes };
  } catch (e) {
    if (absent(e)) return { exists: false };
    throw e;
  }
}

function issuerHostOf(harnessToml) {
  const m = String(harnessToml ?? "").match(/^\s*STAGING_OAUTH_ISSUER\s*=\s*"https:\/\/([^"\/\s]+)"\s*$/m);
  return m ? m[1] : null;
}

/**
 * Harness checks. phase "preflight" (before a deploy) tolerates an absent harness Worker in dormant mode (first deploy) and any
 * enabled flag (it is about to be overwritten); phase "readback" (after) requires the exact end state for `mode`.
 */
export async function runHarnessChecks(client, { mode, phase, harnessToml, expected = ACTIVATION, deps = {} }) {
  const priv = { checkD1Schema, checkWorkerState, ...deps };
  if (mode !== "dormant" && mode !== "enable") throw new CloudflareApiError("harness_mode_must_be_dormant_or_enable");
  const checks = [];
  const pinned = expected.auth.dbId;
  checks.push(check("auth_d1_pinned", pinned ? [] : ["auth_d1_id_not_pinned"]));
  if (pinned) checks.push(await checkAuthD1(client, pinned, { expected }));
  // The private Worker must already be deployed, rebound to the replacement D1, keyed, and unexposed.
  checks.push(await priv.checkD1Schema(client));
  checks.push(...(await priv.checkWorkerState(client)));
  const h = await readHarness(client, expected);
  const preflightDormant = phase === "preflight" && mode === "dormant";
  if (!h.exists) {
    checks.push(check("harness_worker_state", preflightDormant ? [] : ["harness_worker_absent"]));
    return { phase, mode, ok: checks.every((c) => c.ok), checks };
  }
  const enabledValues = phase === "preflight" ? ["false", "true"] : [mode === "enable" ? "true" : "false"];
  checks.push(check("harness_bindings", verifyHarnessSettings(h.settings, { expected, enabledValues })));
  const needAll = mode === "enable" && (phase === "readback" || phase === "preflight");
  checks.push(check("harness_secrets_present", verifyHarnessSecrets(h.secrets, { expected, requireAll: needAll })));
  let accessApps = null;
  if (mode === "enable") {
    const host = issuerHostOf(harnessToml);
    try { accessApps = (await client.get(`/accounts/${client.accountId}/access/apps?per_page=100`)).result; } catch { accessApps = null; }
    checks.push(check("harness_exposure_restricted_hostname", verifyHarnessExposure({ subdomain: h.subdomain, domains: h.domains, routes: h.routes, accessApps }, { expected, mode, issuerHost: host })));
  } else {
    checks.push(check("harness_no_public_exposure", verifyHarnessExposure({ subdomain: h.subdomain, domains: h.domains, routes: h.routes }, { expected, mode })));
  }
  return { phase, mode, ok: checks.every((c) => c.ok), checks };
}

/**
 * Read-only go/no-go board. Never throws for a NO_GO; returns items with status GO | NO_GO | OWNER_ACTION and the exact next action.
 * `files` = { privateToml, harnessToml } texts from the checked-out main.
 */
export async function runActivationPlan(client, { files = {}, expected = ACTIVATION, deps = {} } = {}) {
  const priv = { checkD1Schema, checkWorkerState, ...deps };
  const items = [];
  const add = (id, title, status, detail) => items.push({ id, title, status, detail });
  const guard = async (id, title, fn) => { try { await fn(); } catch (e) { add(id, title, "NO_GO", `unreadable: ${e instanceof CloudflareApiError ? e.code : "internal_error"}`); } };

  await guard("private_d1_schema", "replacement private staging D1 schema + triggers", async () => {
    const c = await priv.checkD1Schema(client);
    add("private_d1_schema", "replacement private staging D1 schema + triggers", c.ok ? "GO" : "NO_GO", c.ok ? PRIVATE.d1Id : c.errors.join("; "));
  });
  await guard("private_worker", "private staging Worker binding / HMAC key / exposure", async () => {
    const acct = client.accountId, w = `/accounts/${acct}/workers/scripts/${PRIVATE.workerName}`;
    const settings = (await client.get(`${w}/settings`)).result;
    const d1 = (settings?.bindings ?? []).filter((b) => b.type === "d1");
    const bound = d1.length === 1 ? d1[0].id : null;
    if (bound === PRIVATE.d1Id) add("private_worker_bound_d1", "private Worker bound to replacement D1", "GO", "rebound");
    else if (bound === PRIVATE.oldD1Id) add("private_worker_bound_d1", "private Worker bound to replacement D1", "OWNER_ACTION", "still bound to OLD D1; dispatch s1-3-staging-deploy-v2 (rebind) under the protected environment");
    else add("private_worker_bound_d1", "private Worker bound to replacement D1", "NO_GO", "unexpected or missing D1 binding");
    const state = await priv.checkWorkerState(client);
    for (const c of state) {
      if (c.name === "worker_bindings") continue; // covered above (old-vs-new is an owner action, not a defect)
      add(`private_${c.name}`, c.name.replace(/_/g, " "), c.ok ? "GO" : "NO_GO", c.ok ? "ok" : c.errors.join("; "));
    }
  });
  let authD1CreationNeeded = false;
  await guard("auth_d1", "staging auth D1 exists, migrated, pinned", async () => {
    const found = await listD1ByName(client, expected.auth.dbName);
    const pinned = expected.auth.dbId;
    if (found.length === 0) { authD1CreationNeeded = true; add("auth_d1", "staging auth D1 exists, migrated, pinned", "OWNER_ACTION", "does not exist; dispatch s1-3-staging-auth-d1 (create + migrate + verify)"); return; }
    if (found.length > 1) { add("auth_d1", "staging auth D1 exists, migrated, pinned", "NO_GO", "more than one database with the pinned name"); return; }
    const id = found[0].id;
    const c = await checkAuthD1(client, id, { expected });
    if (!c.ok) { add("auth_d1", "staging auth D1 exists, migrated, pinned", "NO_GO", c.errors.join("; ")); return; }
    if (!pinned) add("auth_d1", "staging auth D1 exists, migrated, pinned", "OWNER_ACTION", `exists and verified (${id}); open a reviewed PR pinning this id in scripts/staging/s1-3-activation-lib.mjs and wrangler.stagec-harness.toml`);
    else if (pinned !== id) add("auth_d1", "staging auth D1 exists, migrated, pinned", "NO_GO", "live id differs from the pinned id");
    else add("auth_d1", "staging auth D1 exists, migrated, pinned", "GO", id);
  });
  {
    const errs = verifyHarnessConfig(files.harnessToml ?? "", { expected });
    add("harness_config", "wrangler.stagec-harness.toml exact + auth D1 pinned", errs.length ? "OWNER_ACTION" : "GO", errs.length ? errs.slice(0, 4).join("; ") : "exact");
  }
  await guard("harness_worker", "harness Worker deployed (dormant) and exact", async () => {
    const h = await readHarness(client, expected);
    if (!h.exists) { add("harness_worker", "harness Worker deployed (dormant) and exact", "OWNER_ACTION", "not deployed; dispatch s1-3-staging-harness-deploy phase=dormant after the auth D1 is pinned"); add("harness_secrets", "harness secret names present", "OWNER_ACTION", `all pending first deploy: ${expected.harness.secrets.join(", ")}`); return; }
    const e = verifyHarnessSettings(h.settings, { expected, enabledValues: ["false", "true"] });
    add("harness_worker", "harness Worker deployed (dormant) and exact", e.length ? "NO_GO" : "GO", e.length ? e.join("; ") : "bindings exact");
    const miss = missingHarnessSecrets(h.secrets, expected);
    add("harness_secrets", "harness secret names present", miss.length ? "OWNER_ACTION" : "GO", miss.length ? `missing: ${miss.join(", ")} (owner provisions values outside CI; never printed)` : "all present (values not inspected)");
    const host = issuerHostOf(files.harnessToml);
    let apps = null;
    try { apps = (await client.get(`/accounts/${client.accountId}/access/apps?per_page=100`)).result; } catch { apps = null; }
    const x = verifyHarnessExposure({ subdomain: h.subdomain, domains: h.domains, routes: h.routes, accessApps: apps }, { expected, mode: "enable", issuerHost: host });
    add("harness_restricted_hostname", "Access-restricted staging hostname for the harness", x.length ? "OWNER_ACTION" : "GO", x.length ? x.slice(0, 4).join("; ") : host);
  });
  const by = Object.fromEntries(items.map((i) => [i.id, i.status]));
  const go = (...ids) => ids.every((id) => by[id] === "GO");
  const ready = {
    auth_d1_create: authD1CreationNeeded && !items.some((i) => i.status === "NO_GO"),
    private_rebind_deploy: go("private_d1_schema") && by.private_worker_bound_d1 !== "NO_GO",
    harness_dormant_deploy: go("private_d1_schema", "private_worker_bound_d1", "auth_d1", "harness_config"),
    harness_enable: go("private_d1_schema", "private_worker_bound_d1", "auth_d1", "harness_config", "harness_worker", "harness_secrets", "harness_restricted_hostname"),
    stagec_live_run: go("private_d1_schema", "private_worker_bound_d1", "auth_d1", "harness_config", "harness_worker", "harness_secrets", "harness_restricted_hostname")
  };
  return { phase: "plan", ok: !items.some((i) => i.status === "NO_GO"), items, ready };
}

export function planMarkdown(plan) {
  const icon = { GO: "GO", NO_GO: "NO-GO", OWNER_ACTION: "OWNER ACTION" };
  const lines = ["## S1-3 staging activation plan (read-only)", "", "| Item | Status | Detail |", "|---|---|---|"];
  for (const i of plan.items) lines.push(`| ${i.title} | ${icon[i.status]} | ${String(i.detail).replace(/\|/g, "/")} |`);
  lines.push("", `Ready: ${Object.entries(plan.ready).map(([k, v]) => `${k}=${v ? "yes" : "no"}`).join(", ")}`);
  lines.push("", "No Cloudflare state was changed by this report. Secret VALUES are never read.");
  return lines.join("\n");
}
