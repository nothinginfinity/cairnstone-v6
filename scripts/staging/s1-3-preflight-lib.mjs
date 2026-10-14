// S1-3 staging deploy preflight/readback verification (issue #87). STAGING ONLY, read-only against Cloudflare.
// Pure functions + a tiny fail-closed Cloudflare API client. Zero dependencies so it runs before any `npm ci`.
// Every verifier returns an array of error strings; an empty array means the check passed.
// Nothing here ever prints or returns the API token or any secret value.

export const EXPECTED = Object.freeze({
  workerName: "cairnstone-private-staging",
  d1Name: "cairnstone-private-staging-2",
  d1Id: "9420f645-4bdf-430f-a790-feb34d01f077",
  oldD1Id: "26d4e786-2da7-47a4-a159-1ba206712b13",
  d1Binding: "CAIRNSTONE_PRIVATE_DB",
  r2Binding: "CAIRNSTONE_PRIVATE_R2",
  r2Bucket: "cairnstone-private-staging",
  hmacSecret: "PRIVATE_GATEWAY_HMAC_KEY",
  allowedSecrets: Object.freeze(["PRIVATE_GATEWAY_HMAC_KEY", "PRIVATE_GATEWAY_HMAC_KEY_PREVIOUS"]),
  vars: Object.freeze({
    PRIVATE_STAGE_ENABLED: "true",
    PRIVATE_STAGE_CALLER: "cairnstone-stage-gateway",
    PRIVATE_ALLOWED_CALLERS: "cairnstone-stage-gateway"
  }),
  // The ONLY non-comment, non-blank lines wrangler.private-staging.toml may contain. Anything else
  // ([build], [[services]], [[kv_namespaces]], routes, triggers, extra vars, a different ID...) fails closed.
  // Reserved secret names (HMAC current/previous) are the only staging signing keys in scope for this private Worker preflight.
  configLines: Object.freeze([
    'name = "cairnstone-private-staging"',
    'main = "src/private-realm/private-staging-worker.js"',
    'compatibility_date = "2026-06-21"',
    "workers_dev = false",
    "preview_urls = false",
    "send_metrics = false",
    "[vars]",
    'PRIVATE_STAGE_ENABLED = "true"',
    'PRIVATE_STAGE_CALLER = "cairnstone-stage-gateway"',
    'PRIVATE_ALLOWED_CALLERS = "cairnstone-stage-gateway"',
    "[[d1_databases]]",
    'binding = "CAIRNSTONE_PRIVATE_DB"',
    'database_name = "cairnstone-private-staging-2"',
    'database_id = "9420f645-4bdf-430f-a790-feb34d01f077"',
    'migrations_dir = "migrations/private-staging"',
    "[[r2_buckets]]",
    'binding = "CAIRNSTONE_PRIVATE_R2"',
    'bucket_name = "cairnstone-private-staging"'
  ])
});

/** Strip comments/blank lines. A trailing `# comment` is NOT stripped: it will not match and fails closed. */
export function normalizeConfig(text) {
  return String(text).replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

export function verifyConfig(text, expected = EXPECTED) {
  const errors = [];
  const got = normalizeConfig(text);
  const want = expected.configLines;
  for (const line of got) {
    if (!want.includes(line)) errors.push(`config_unexpected_line: ${redactLine(line)}`);
  }
  for (const line of want) {
    if (!got.includes(line)) errors.push(`config_missing_line: ${line}`);
  }
  if (got.length !== want.length) errors.push(`config_line_count: expected ${want.length}, got ${got.length}`);
  for (let i = 0; i < Math.min(got.length, want.length); i++) {
    if (got[i] !== want[i]) { errors.push("config_order_or_content_mismatch"); break; }
  }
  if (String(text).includes(expected.oldD1Id)) errors.push("config_references_old_staging_d1");
  return errors;
}

// Keep a short, secret-free hint of an offending line; never echo long values.
const redactLine = (l) => (l.length > 80 ? `${l.slice(0, 80)}…` : l);

export function verifyD1Schema({ roleColumn, connectionsSql, nonceColumns, triggers }, expected = EXPECTED) {
  void expected;
  const errors = [];
  const role = (roleColumn ?? []).find((c) => c.name === "role");
  if (!role) errors.push("d1_role_column_missing");
  else {
    if (String(role.type).toUpperCase() !== "TEXT") errors.push("d1_role_column_type");
    if (Number(role.notnull) !== 1) errors.push("d1_role_column_not_null");
    if (String(role.dflt_value).replace(/\s/g, "") !== "'member'") errors.push("d1_role_column_default");
  }
  if (!/role\s+TEXT\s+NOT\s+NULL[^,]*CHECK\s*\(\s*role\s+IN\s*\(\s*'admin'\s*,\s*'member'\s*\)\s*\)/i.test(String(connectionsSql ?? ""))) {
    errors.push("d1_role_check_constraint_missing");
  }
  const cols = new Map((nonceColumns ?? []).map((c) => [c.name, c]));
  if (!cols.has("caller") || !cols.has("nonce") || !cols.has("issued_at")) errors.push("d1_nonce_columns_missing");
  else {
    if (Number(cols.get("caller").pk) !== 1 || Number(cols.get("nonce").pk) !== 2) errors.push("d1_nonce_composite_pk_missing");
    if (Number(cols.get("issued_at").pk) !== 0) errors.push("d1_nonce_issued_at_in_pk");
    for (const n of ["caller", "nonce", "issued_at"]) if (Number(cols.get(n).notnull) !== 1) errors.push(`d1_nonce_${n}_nullable`);
  }
  const wanted = [
    ["priv_messages_sender_authorized", "priv_messages", "sender_not_authorized"],
    ["priv_deliveries_target_authorized", "priv_deliveries", "delivery_not_authorized"]
  ];
  for (const [name, table, abort] of wanted) {
    const t = (triggers ?? []).find((r) => r.name === name);
    if (!t) { errors.push(`d1_trigger_missing: ${name}`); continue; }
    const sql = String(t.sql ?? "").replace(/\s+/g, " ");
    if (!new RegExp(`BEFORE INSERT ON ${table}\\b`, "i").test(sql)) errors.push(`d1_trigger_wrong_event: ${name}`);
    if (!new RegExp(`RAISE\\(ABORT, '${abort}'\\)`, "i").test(sql)) errors.push(`d1_trigger_wrong_abort: ${name}`);
    if (!/WHEN NOT EXISTS/i.test(sql) || !/revoked_at IS NULL/i.test(sql) || !/can_send = 1/i.test(sql)) {
      errors.push(`d1_trigger_weakened: ${name}`);
    }
  }
  return errors;
}

export function verifyWorkerSettings(settingsResult, expected = EXPECTED, { allowedD1Ids = [expected.d1Id] } = {}) {
  const errors = [];
  const bindings = Array.isArray(settingsResult?.bindings) ? settingsResult.bindings : null;
  if (!bindings) return ["worker_bindings_unreadable"];
  const d1 = bindings.filter((b) => b.type === "d1");
  if (d1.length !== 1 || d1[0].name !== expected.d1Binding || !allowedD1Ids.includes(d1[0].id)) errors.push("worker_unexpected_d1_binding");
  const r2 = bindings.filter((b) => b.type === "r2_bucket");
  if (r2.length !== 1 || r2[0].name !== expected.r2Binding || r2[0].bucket_name !== expected.r2Bucket) errors.push("worker_unexpected_r2_binding");
  const plain = Object.fromEntries(bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]));
  // Fail-closed: reserved secret names must never appear as plain_text (name/type only; never echo values).
  // allowedSecrets currently covers the HMAC signing keys (current + previous) used by the private staging Worker.
  // Other staging bearer/signing keys (STAGE_C_HARNESS_TOKEN, STAGING_OAUTH_SIGNING_KEY) belong to gateway/harness Workers, not this preflight scope.
  for (const name of expected.allowedSecrets) {
    if (Object.prototype.hasOwnProperty.call(plain, name)) {
      errors.push(`reserved_secret_as_plaintext: ${name}`);
    }
  }
  const wantVars = Object.keys(expected.vars).sort().join(",");
  if (Object.keys(plain).sort().join(",") !== wantVars) errors.push("worker_unexpected_vars");
  for (const [k, v] of Object.entries(expected.vars)) if (plain[k] !== v) errors.push(`worker_var_mismatch: ${k}`);
  for (const b of bindings) {
    if (["d1", "r2_bucket", "plain_text"].includes(b.type)) continue;
    if (b.type === "secret_text" && expected.allowedSecrets.includes(b.name)) continue;
    errors.push(`worker_unexpected_binding: ${b.type}:${b.name}`); // service, kv, durable_object, ai, queue, ...
  }
  return errors;
}

export function verifySecrets(secretsResult, expected = EXPECTED) {
  const list = Array.isArray(secretsResult) ? secretsResult : null;
  if (!list) return ["secrets_unreadable"];
  const errors = [];
  if (!list.some((s) => s.name === expected.hmacSecret)) errors.push("hmac_key_secret_absent");
  for (const s of list) if (!expected.allowedSecrets.includes(s.name)) errors.push(`secret_unexpected: ${s.name}`);
  return errors;
}

// ---- Exposure: workers.dev, previews, custom domains, zone routes ----
export function verifyExposure({ subdomain, domains, routes }, expected = EXPECTED) {
  const errors = [];
  if (!subdomain || subdomain.enabled !== false) errors.push("exposure_workers_dev_enabled_or_unknown");
  // previews_enabled may be omitted by the API when never configured; anything other than false/omitted fails.
  if (subdomain && subdomain.previews_enabled !== undefined && subdomain.previews_enabled !== false) errors.push("exposure_previews_enabled");
  if (!Array.isArray(domains)) errors.push("exposure_domains_unreadable");
  else for (const d of domains) if (!d?.service || d.service === expected.workerName) errors.push(`exposure_custom_domain: ${d?.hostname ?? "unknown"}`);
  if (!Array.isArray(routes)) errors.push("exposure_routes_unreadable");
  else for (const r of routes) if (r?.script === expected.workerName) errors.push(`exposure_zone_route: ${r.pattern ?? "unknown"}`);
  return errors;
}

export class CloudflareApiError extends Error {
  constructor(code) { super(code); this.name = "CloudflareApiError"; this.code = code; }
}

export function createCloudflareClient({ token, accountId, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== "string" || token.length < 20 || typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new CloudflareApiError("cloudflare_credentials_missing_or_malformed");
  }
  const base = "https://api.cloudflare.com/client/v4";
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch { throw new CloudflareApiError("cloudflare_network_error"); }
    let json;
    try { json = await res.json(); } catch { throw new CloudflareApiError("cloudflare_non_json_response"); }
    if (!res.ok || json?.success !== true) {
      const codes = Array.isArray(json?.errors) ? json.errors.map((e) => e?.code).filter((c) => Number.isInteger(c)).join(",") : "";
      throw new CloudflareApiError(`cloudflare_api_failed:${method}:${path.split("?")[0].replace(accountId, "<acct>")}:${res.status}:${codes}`);
    }
    return json;
  }
  return {
    get: (path) => call("GET", path),
    async d1(dbId, sql) {
      if (!/^\s*(SELECT|PRAGMA)\s/i.test(sql) || /;\s*\S/.test(sql)) throw new CloudflareApiError("d1_statement_not_read_only");
      const json = await call("POST", `/accounts/${accountId}/d1/database/${dbId}/query`, { sql });
      return json.result?.[0]?.results ?? [];
    },
    accountId
  };
}

async function collectZoneRoutes(client) {
  const routes = [];
  for (let page = 1; page <= 20; page++) {
    const zones = await client.get(`/zones?per_page=50&page=${page}`);
    for (const z of zones.result ?? []) {
      const r = await client.get(`/zones/${z.id}/workers/routes`);
      routes.push(...(r.result ?? []));
    }
    const info = zones.result_info;
    if (!info || page >= (info.total_pages ?? 1)) return routes;
  }
  throw new CloudflareApiError("cloudflare_zone_pagination_exceeded");
}

const check = (name, errors) => ({ name, ok: errors.length === 0, errors });

export async function checkD1Schema(client, expected = EXPECTED) {
  const roleColumn = await client.d1(expected.d1Id, "PRAGMA table_info(priv_home_connections)");
  const connections = await client.d1(expected.d1Id, "SELECT sql FROM sqlite_master WHERE type='table' AND name='priv_home_connections'");
  const nonceColumns = await client.d1(expected.d1Id, "PRAGMA table_info(priv_service_nonces)");
  const triggers = await client.d1(expected.d1Id, "SELECT name, sql FROM sqlite_master WHERE type='trigger'");
  return check("d1_schema", verifyD1Schema({ roleColumn, connectionsSql: connections[0]?.sql, nonceColumns, triggers }, expected));
}

export async function checkWorkerState(client, expected = EXPECTED, opts = {}) {
  const acct = client.accountId;
  const w = `/accounts/${acct}/workers/scripts/${expected.workerName}`;
  const settings = (await client.get(`${w}/settings`)).result;
  const secrets = (await client.get(`${w}/secrets`)).result;
  const subdomain = (await client.get(`${w}/subdomain`)).result;
  const domains = (await client.get(`/accounts/${acct}/workers/domains?service=${expected.workerName}`)).result;
  const routes = await collectZoneRoutes(client);
  return [
    check("worker_bindings", verifyWorkerSettings(settings, expected, opts)),
    check("hmac_key_presence", verifySecrets(secrets, expected)),
    check("no_public_exposure", verifyExposure({ subdomain, domains, routes }, expected))
  ];
}

export async function runPreflight(client, expected = EXPECTED) {
  const checks = [await checkD1Schema(client, expected), ...(await checkWorkerState(client, expected, { allowedD1Ids: [expected.d1Id, expected.oldD1Id] }))];
  return { phase: "preflight", ok: checks.every((c) => c.ok), checks };
}

export async function runReadback(client, expected = EXPECTED) {
  const checks = [await checkD1Schema(client, expected), ...(await checkWorkerState(client, expected))];
  return { phase: "readback", ok: checks.every((c) => c.ok), checks };
}
