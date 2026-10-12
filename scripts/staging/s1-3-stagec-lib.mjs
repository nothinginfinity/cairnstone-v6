// S1-3 Stage C live E2E driver (issue #89). STAGING ONLY. Source-only until an owner dispatches it.
//
// The driver is transport-agnostic: it talks to a `harness` (the staging gateway test harness, owned by the gateway
// work in PR #86) and a `d1` reader (Cloudflare D1 REST, or an in-process SQLite in CI). Every case compares an
// EXPECTED outcome to the OBSERVED outcome and records a redacted receipt. Anything unknown fails closed.
//
// Harness contract (HTTP, bearer-authenticated, see docs/private-realm/S1_3_STAGE_C_E2E.md):
//   POST {url}/stagec/v1/call   {identity:{account,provider}, method, args:[...args AFTER the scope]}  -> {ok, code?, result?, isolate?}
//   POST {url}/stagec/v1/probe  {name, params}                                         -> {ok, code?, ...probe fields}
// The harness (not this driver) builds the HomeScope server-side from `identity` and holds the HMAC key. The driver
// never sees a key, a token for a user, or a message body other than its own synthetic bodies.
import { createHash } from "node:crypto";

export const STAGEC = Object.freeze({
  caller: "cairnstone-stage-gateway",
  worker: "cairnstone-private-staging",
  d1Id: "9420f645-4bdf-430f-a790-feb34d01f077",
  accounts: Object.freeze(["alpha", "bravo"]),
  providers: Object.freeze(["chatgpt", "grok"]),
  evidenceSchema: "cairnstone-s1-3-stagec-evidence-v1",
  cleanupPhrase: "OWNER_APPROVED_STAGEC_FIXTURE_CLEANUP"
});

export const ENVELOPE_PROBES = Object.freeze(["bad_sig", "stale_iat", "future_iat", "mutated_method", "mutated_args", "wrong_caller_name"]);
export const PLATFORM_PROBES = Object.freeze(["missing_platform_caller", "wrong_platform_caller"]);
export const GATEWAY_PROBES = Object.freeze(["wrong_audience_token", "revoked_oauth", "caller_selector_injection"]);
export const ALL_PROBES = Object.freeze([...ENVELOPE_PROBES, ...PLATFORM_PROBES, ...GATEWAY_PROBES, "replay_same_nonce", "legacy_regression"]);

export const connectionIdOf = ({ account, provider }) => `conn_stagec_${account}_${provider}`;
export const inboxIdOf = (account, kind) => `ibx_stagec_${account}_${kind}`;
const ident = (account, provider) => ({ account, provider });
const SAFE_KEYS = new Set(["ok", "code", "isolate", "result", "stub", "first", "second", "isolates", "nonce", "health", "private_tools_visible"]);
// Stubs exist only so the in-process CI harness can exercise this driver. A LIVE run never allows them.
let ALLOW_STUBS = false;
const real = (r) => ALLOW_STUBS || r?.stub !== true;
const WRITE_COUNTERS = ["m", "d", "g", "c", "h", "i"]; // everything a store write could touch (nonces tracked separately)

export class StageCError extends Error {
  constructor(code) { super(code); this.name = "StageCError"; this.code = code; }
}

// ---------------------------------------------------------------------------------------------
// Redaction: receipts never carry signatures, nonces, tokens, keys or bodies.
// ---------------------------------------------------------------------------------------------
const SECRET_KEYS = /^(sig|signature|nonce|token|authorization|key|secret|hmac|body|body_text|bearer|password)$/i;
export function redact(value, depth = 0) {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") {
    if (/^[0-9a-f]{40,}$/i.test(value)) return "[redacted:hex]";
    if (/^Bearer\s/i.test(value) || /^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)) return "[redacted:token]";
    return value.length > 200 ? `${value.slice(0, 40)}…[${value.length} chars]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? `[redacted:${typeof v === "string" ? v.length : typeof v}]` : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------
export function createHttpHarness({ url, token, runId, fetchImpl = globalThis.fetch } = {}) {
  let base;
  try { base = new URL(url); } catch { throw new StageCError("harness_url_missing_or_invalid"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new StageCError("harness_url_must_be_plain_https");
  if (base.hostname.includes(STAGEC.worker)) throw new StageCError("harness_url_must_not_be_the_private_worker");
  if (typeof token !== "string" || token.length < 20) throw new StageCError("harness_token_missing");
  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(new URL(path, base).toString(), {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Stagec-Run": String(runId ?? "") },
        body: JSON.stringify(body)
      });
    } catch { throw new StageCError("harness_network_error"); }
    let json;
    try { json = await res.json(); } catch { throw new StageCError(`harness_non_json_response:${res.status}`); }
    if (!res.ok && !(json && typeof json === "object" && json.ok === false)) throw new StageCError(`harness_http_${res.status}`);
    return json;
  }
  return {
    kind: "http",
    call: (identity, method, args = []) => post("/stagec/v1/call", { identity, method, args }),
    probe: (name, params = {}) => post("/stagec/v1/probe", { name, params })
  };
}

const READ_ONLY = /^\s*(SELECT|PRAGMA)\s/i;
const ABORT_ALLOWED = /^\s*INSERT INTO (priv_messages|priv_deliveries)\s*\(/i;
export function assertReadOnlySql(sql) { if (!READ_ONLY.test(sql) || /;\s*\S/.test(sql)) throw new StageCError("d1_statement_not_read_only"); }
export function assertAbortProbeSql(sql) { if (!ABORT_ALLOWED.test(sql) || /;\s*\S/.test(sql)) throw new StageCError("d1_abort_probe_statement_not_allowed"); }
export function createD1Http({ token, accountId, dbId = STAGEC.d1Id, fetchImpl = globalThis.fetch } = {}) {
  if (dbId !== STAGEC.d1Id) throw new StageCError("d1_id_is_not_the_reviewed_staging_database");
  if (typeof token !== "string" || token.length < 20 || !/^[0-9a-f]{32}$/.test(accountId ?? "")) throw new StageCError("cloudflare_credentials_missing_or_malformed");
  async function exec(sql, params) {
    let res;
    try {
      res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql, params })
      });
    } catch { throw new StageCError("cloudflare_network_error"); }
    let json;
    try { json = await res.json(); } catch { throw new StageCError("cloudflare_non_json_response"); }
    return { status: res.status, json };
  }
  return {
    kind: "d1-rest",
    async query(sql, params = []) {
      assertReadOnlySql(sql);
      const { json } = await exec(sql, params);
      if (json?.success !== true) throw new StageCError("d1_query_failed");
      return json.result?.[0]?.results ?? [];
    },
    // Executes ONE allow-listed INSERT that the database triggers MUST reject. Returns whether it aborted and the reason.
    async expectAbort(sql, params) {
      assertAbortProbeSql(sql);
      const { json } = await exec(sql, params);
      if (json?.success === true) return { aborted: false, message: "" };
      const message = (Array.isArray(json?.errors) ? json.errors.map((e) => String(e?.message ?? "")).join(" | ") : "").slice(0, 300);
      return { aborted: true, message };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const COUNT_SQL = "SELECT (SELECT COUNT(*) FROM priv_messages) AS m, (SELECT COUNT(*) FROM priv_deliveries) AS d, " +
  "(SELECT COUNT(*) FROM priv_service_nonces) AS n, (SELECT COUNT(*) FROM priv_inbox_grants WHERE revoked_at IS NULL) AS g, " +
  "(SELECT COUNT(*) FROM priv_home_connections) AS c, (SELECT COUNT(*) FROM priv_homes) AS h, (SELECT COUNT(*) FROM priv_inboxes) AS i";
export async function snapshot(d1) {
  const row = (await d1.query(COUNT_SQL))[0];
  if (!row) throw new StageCError("d1_snapshot_empty");
  const out = {};
  for (const k of ["m", "d", "n", "g", "c", "h", "i"]) { out[k] = Number(row[k]); if (!Number.isInteger(out[k])) throw new StageCError("d1_snapshot_malformed"); }
  return out;
}
const sameWrites = (a, b) => WRITE_COUNTERS.every((k) => a[k] === b[k]);
const sameAll = (a, b) => sameWrites(a, b) && a.n === b.n;
const isFailClosed = (r) => r && r.ok === false && typeof r.code === "string" && r.code.length > 0 && r.code.length < 64 &&
  Object.keys(r).every((k) => SAFE_KEYS.has(k)) && r.result === undefined;
const rowsOf = (r) => (Array.isArray(r?.result) ? r.result : Array.isArray(r?.result?.messages) ? r.result.messages : Array.isArray(r?.result?.rows) ? r.result.rows : null);
const DENIED_CAPABILITY = new Set(["capability_denied", "scope_not_authorized"]);

function newRecorder() {
  const requests = [];
  return {
    requests,
    async call(harness, identity, method, ...args) {
      while (args.length && args[args.length - 1] === undefined) args.pop();
      const r = await harness.call(identity, method, args);
      requests.push(redact({ kind: "call", identity, method, ok: r?.ok === true, code: r?.code ?? null, isolate: r?.isolate ?? null, stub: r?.stub === true ? true : undefined }));
      return r;
    },
    async probe(harness, name, params) {
      if (!ALL_PROBES.includes(name)) throw new StageCError(`unknown_probe:${name}`);
      const r = await harness.probe(name, params);
      requests.push(redact({ kind: "probe", name, params: params && params.identity ? { identity: params.identity, method: params.method } : undefined, ok: r?.ok === true, code: r?.code ?? null, stub: r?.stub === true ? true : undefined }));
      return r;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Cases. Each returns { expected, observed, ok, d1? }. A thrown error becomes a failed case (fail closed).
// ---------------------------------------------------------------------------------------------
async function expectOk(rec, harness, identity, method, ...args) {
  const r = await rec.call(harness, identity, method, ...args);
  if (r?.ok !== true) throw new StageCError(`unexpected_denial:${method}:${r?.code ?? "unknown"}`);
  return r;
}

async function setup({ harness, rec }) {
  const roles = {};
  for (const account of STAGEC.accounts) {
    const admin = ident(account, "chatgpt"), member = ident(account, "grok");
    roles[`${account}.chatgpt`] = (await expectOk(rec, harness, admin, "ensureDefaultHome")).result?.role;
    roles[`${account}.grok`] = (await expectOk(rec, harness, member, "ensureDefaultHome")).result?.role;
    for (const kind of ["main", "aux"]) {
      await expectOk(rec, harness, admin, "createInbox", { scope: "home", inboxId: inboxIdOf(account, kind), grantToCreator: true });
    }
    await expectOk(rec, harness, admin, "grantInbox", { inboxId: inboxIdOf(account, "main"), targetConnectionId: connectionIdOf(member), caps: { read: true, send: true, ack: true } });
  }
  const ok = STAGEC.accounts.every((a) => roles[`${a}.chatgpt`] === "admin" && roles[`${a}.grok`] === "member");
  return { expected: "both accounts: chatgpt admin, grok member; main+aux inboxes; grok granted main only", observed: roles, ok };
}

async function isolationMatrix({ harness, d1, rec, runId, codes }) {
  const checks = {};
  const before = await snapshot(d1);
  for (const account of STAGEC.accounts) {
    const main = inboxIdOf(account, "main"), aux = inboxIdOf(account, "aux");
    for (const provider of STAGEC.providers) {
      const id = ident(account, provider);
      const tag = `${account}.${provider}`;
      const g = await rec.call(harness, id, "resolveHome");
      const l = await rec.call(harness, id, "listInboxes");
      const s = await rec.call(harness, id, "send", { fromInboxId: main, toInboxIds: [main], messageId: `stagec-${runId}-${account}-${provider}`, body: `synthetic stage C message ${account}/${provider}` });
      checks[`${tag}.get_list_send`] = g?.ok === true && l?.ok === true && s?.ok === true;
    }
    for (const provider of STAGEC.providers) {
      const id = ident(account, provider), main = inboxIdOf(account, "main");
      const tag = `${account}.${provider}`;
      const r = await rec.call(harness, id, "readInbox", { inboxId: main });
      const rows = rowsOf(r);
      const ids = rows ? rows.map((x) => String(x.message_id)) : [];
      const own = ids.filter((m) => m.startsWith(`stagec-${runId}-${account}-`));
      const foreign = ids.filter((m) => m.includes(`-${STAGEC.accounts.find((x) => x !== account)}-`));
      checks[`${tag}.read_sees_both_providers_no_foreign`] = r?.ok === true && own.length === 2 && foreign.length === 0;
      const peer = STAGEC.providers.find((p) => p !== provider);
      const a = await rec.call(harness, id, "ack", { inboxId: main, messageId: `stagec-${runId}-${account}-${peer}` });
      checks[`${tag}.ack_peer_message`] = a?.ok === true;
    }
    // Per-provider separation: only the admin identity has the aux inbox.
    const auxAdmin = await rec.call(harness, ident(account, "chatgpt"), "listInbox", { inboxId: aux });
    const auxMember = [
      await rec.call(harness, ident(account, "grok"), "listInbox", { inboxId: aux }),
      await rec.call(harness, ident(account, "grok"), "readInbox", { inboxId: aux }),
      await rec.call(harness, ident(account, "grok"), "send", { fromInboxId: aux, toInboxIds: [aux], messageId: `stagec-${runId}-${account}-grok-aux`, body: "synthetic denied" })
    ];
    checks[`${account}.aux_admin_only`] = auxAdmin?.ok === true && auxMember.every((r) => isFailClosed(r) && DENIED_CAPABILITY.has(r.code));
    for (const r of auxMember) codes.push(r.code);
  }
  // Cross-home negatives: each account's providers against the OTHER account's inbox ids.
  const afterOwn = await snapshot(d1);
  for (const account of STAGEC.accounts) {
    const other = STAGEC.accounts.find((a) => a !== account);
    const foreignMain = inboxIdOf(other, "main");
    for (const provider of STAGEC.providers) {
      const id = ident(account, provider);
      const rs = [
        await rec.call(harness, id, "readInbox", { inboxId: foreignMain }),
        await rec.call(harness, id, "listInbox", { inboxId: foreignMain }),
        await rec.call(harness, id, "ack", { inboxId: foreignMain, messageId: `stagec-${runId}-${other}-chatgpt` }),
        await rec.call(harness, id, "send", { fromInboxId: inboxIdOf(account, "main"), toInboxIds: [foreignMain], messageId: `stagec-${runId}-${account}-${provider}-x`, body: "synthetic cross-home" })
      ];
      checks[`${account}.${provider}.cross_home_denied`] = rs.every((r) => isFailClosed(r) && DENIED_CAPABILITY.has(r.code));
      for (const r of rs) codes.push(r.code);
    }
  }
  const after = await snapshot(d1);
  const leak = await d1.query("SELECT COUNT(*) AS n FROM priv_deliveries WHERE inbox_id = ? AND message_id LIKE ?", [inboxIdOf("bravo", "main"), `stagec-${runId}-alpha-%`]);
  const leak2 = await d1.query("SELECT COUNT(*) AS n FROM priv_deliveries WHERE inbox_id = ? AND message_id LIKE ?", [inboxIdOf("alpha", "main"), `stagec-${runId}-bravo-%`]);
  checks["no_cross_account_delivery_in_d1"] = Number(leak[0]?.n) === 0 && Number(leak2[0]?.n) === 0;
  checks["denied_attempts_wrote_nothing"] = sameWrites(afterOwn, after) && after.n >= afterOwn.n;
  checks["own_sends_created_exactly_4_messages_and_4_deliveries"] = afterOwn.m - before.m === 4 && afterOwn.d - before.d === 4;
  return { expected: "every provider can get/list/send/read/ack own account main inbox; grok denied aux; no cross-account read/send/ack/list; no cross-home writes", observed: checks, ok: Object.values(checks).every(Boolean), d1: { before, afterOwn, after } };
}

async function revokedGrantTrigger({ harness, d1, rec, runId, codes }) {
  const checks = {};
  const account = "alpha", main = inboxIdOf(account, "main"), aux = inboxIdOf(account, "aux");
  const admin = ident(account, "chatgpt"), member = ident(account, "grok"), controlMember = ident("bravo", "grok");
  const memberConn = connectionIdOf(member);
  await expectOk(rec, harness, admin, "revokeGrant", { inboxId: main, targetConnectionId: memberConn });
  const s0 = await snapshot(d1);
  // 1. Application path: the store denies.
  const denied = await rec.call(harness, member, "send", { fromInboxId: main, toInboxIds: [main], messageId: `stagec-${runId}-alpha-grok-revoked`, body: "synthetic after revoke" });
  checks["app_layer_denies_revoked_sender"] = isFailClosed(denied) && DENIED_CAPABILITY.has(denied.code);
  codes.push(denied.code);
  const s1 = await snapshot(d1);
  checks["revoked_send_wrote_no_message_or_delivery"] = sameWrites(s0, s1);
  // 2. Database path: the trigger rejects the write even if the application check were bypassed (race, bug, direct write).
  const home = (await d1.query("SELECT home_id FROM priv_home_connections WHERE connection_id = ?", [memberConn]))[0]?.home_id;
  checks["home_id_resolved_from_d1"] = typeof home === "string" && home.startsWith("home_");
  let msgProbe = { aborted: false, message: "not_run" }, delProbe = { aborted: false, message: "not_run" };
  const strayMessageId = `stagec-${runId}-trigger-probe`;
  if (checks.home_id_resolved_from_d1) {
    msgProbe = await d1.expectAbort(
      "INSERT INTO priv_messages (home_id, message_id, thread_id, sender_inbox_id, sender_connection_id, body_sha256, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [home, strayMessageId, strayMessageId, main, memberConn, "0".repeat(64), "synthetic trigger probe", new Date().toISOString()]);
    // The delivery trigger keys off an EXISTING message whose sender has been revoked: the earlier grok message from the matrix case.
    delProbe = await d1.expectAbort(
      "INSERT INTO priv_deliveries (home_id, message_id, inbox_id, delivered_at) VALUES (?, ?, ?, ?)",
      [home, `stagec-${runId}-alpha-grok`, aux, new Date().toISOString()]);
  }
  checks["trigger_priv_messages_sender_authorized_aborts"] = msgProbe.aborted === true && msgProbe.message.includes("sender_not_authorized");
  checks["trigger_priv_deliveries_target_authorized_aborts"] = delProbe.aborted === true && delProbe.message.includes("delivery_not_authorized");
  const s2 = await snapshot(d1);
  checks["trigger_probes_wrote_nothing"] = sameWrites(s0, s2);
  // 3. Blast radius: another account's identical provider is unaffected.
  const control = await rec.call(harness, controlMember, "send", { fromInboxId: inboxIdOf("bravo", "main"), toInboxIds: [inboxIdOf("bravo", "main")], messageId: `stagec-${runId}-bravo-grok-after`, body: "synthetic control after alpha revoke" });
  checks["other_account_provider_still_works"] = control?.ok === true;
  const stray = !checks.trigger_probes_wrote_nothing ? { stray_message_id: strayMessageId, note: "a trigger probe committed a row: staging schema is NOT protected; owner-approved cleanup required" } : undefined;
  return { expected: "store denies revoked sender; BOTH D1 triggers abort direct inserts with their named reasons; no message/delivery created; other account unaffected", observed: { ...checks, ...(stray ? { stray } : {}), trigger_messages: msgProbe.aborted ? "aborted" : "NOT_ABORTED", trigger_deliveries: delProbe.aborted ? "aborted" : "NOT_ABORTED" }, ok: Object.values(checks).every(Boolean), d1: { s0, s1, s2 } };
}

async function nonceReplay({ harness, d1, rec }) {
  const before = await snapshot(d1);
  const r = await rec.probe(harness, "replay_same_nonce", { identity: ident("alpha", "chatgpt"), method: "listInboxes", isolates: 2, restart: true });
  const checks = {
    first_accepted: r?.first?.ok === true,
    second_denied_caller_not_authorized: r?.second?.ok === false && r?.second?.code === "caller_not_authorized",
    isolates_distinct: Array.isArray(r?.isolates) && r.isolates.length >= 2 && new Set(r.isolates).size === r.isolates.length && r.isolates.every((x) => typeof x === "string" && x),
    not_a_stub: real(r)
  };
  const nonce = typeof r?.nonce === "string" ? r.nonce : "";
  const rows = nonce ? await d1.query("SELECT COUNT(*) AS n FROM priv_service_nonces WHERE caller = ? AND nonce = ?", [STAGEC.caller, nonce]) : [];
  checks.exactly_one_nonce_receipt_in_d1 = Number(rows[0]?.n) === 1;
  const after = await snapshot(d1);
  checks.nonce_table_grew_by_one = after.n - before.n === 1;
  checks.replay_wrote_nothing_else = sameWrites(before, after);
  return { expected: "same signed envelope across distinct isolates: exactly one accepted, second caller_not_authorized, one D1 nonce row", observed: checks, ok: Object.values(checks).every(Boolean), d1: { before, after } };
}

async function platformCaller({ harness, d1, rec }) {
  const checks = {};
  const before = await snapshot(d1);
  for (const name of PLATFORM_PROBES) {
    const r = await rec.probe(harness, name, { identity: ident("alpha", "chatgpt"), method: "listInboxes" });
    checks[`${name}_denied_caller_not_authorized`] = r?.ok === false && r?.code === "caller_not_authorized" && real(r) && isFailClosed(r);
  }
  const after = await snapshot(d1);
  checks.no_store_write_and_no_nonce_consumed = sameAll(before, after);
  return { expected: "missing/wrong ctx.props.caller via real service bindings: caller_not_authorized, nothing written, no nonce consumed", observed: checks, ok: Object.values(checks).every(Boolean), d1: { before, after } };
}

async function envelopeFailures({ harness, d1, rec }) {
  const checks = {};
  const before = await snapshot(d1);
  for (const name of ENVELOPE_PROBES) {
    const r = await rec.probe(harness, name, { identity: ident("alpha", "chatgpt"), method: "listInboxes" });
    checks[`${name}_denied_caller_not_authorized`] = r?.ok === false && r?.code === "caller_not_authorized" && real(r) && isFailClosed(r);
  }
  const after = await snapshot(d1);
  checks.no_store_write_and_no_nonce_consumed = sameAll(before, after);
  return { expected: "bad sig / stale / future / mutated method / mutated args / wrong caller name: identical caller_not_authorized, no write, no nonce", observed: checks, ok: Object.values(checks).every(Boolean), d1: { before, after } };
}

async function gatewayAuth({ harness, d1, rec, codes }) {
  const checks = {};
  const before = await snapshot(d1);
  const roleSql = "SELECT role FROM priv_home_connections WHERE connection_id = ?";
  const roleBefore = (await d1.query(roleSql, [connectionIdOf(ident("alpha", "grok"))]))[0]?.role;
  for (const name of GATEWAY_PROBES) {
    const r = await rec.probe(harness, name, { identity: ident("alpha", "grok"), method: "listInboxes" });
    checks[`${name}_denied`] = isFailClosed(r) && real(r);
  }
  // Recovery-admin self-grant: a member asks to become admin / to be granted admin over the Home.
  const self = ident("alpha", "grok");
  const escalate = await rec.call(harness, self, "setConnectionRole", connectionIdOf(self), "admin");
  const grantSelf = await rec.call(harness, self, "grantInbox", { inboxId: inboxIdOf("alpha", "aux"), targetConnectionId: connectionIdOf(self), caps: { read: true, send: true, ack: true } });
  checks.recovery_admin_self_escalation_denied = isFailClosed(escalate) && isFailClosed(grantSelf);
  codes.push(escalate.code, grantSelf.code);
  const roleAfter = (await d1.query(roleSql, [connectionIdOf(self)]))[0]?.role;
  checks.role_unchanged_member = roleBefore === "member" && roleAfter === "member";
  const after = await snapshot(d1);
  checks.no_store_write = sameWrites(before, after);
  return { expected: "wrong audience, revoked OAuth, selector/authContext/role injection, recovery-admin self-grant: all fail closed; role stays member; no write", observed: checks, ok: Object.values(checks).every(Boolean), d1: { before, after } };
}

function rpcErrorIdentity({ codes }) {
  // A PrivateRealmError that crosses a REAL service binding must keep its typed code (instanceof across RPC).
  // If it degraded to private_store_error, the gateway cannot distinguish a denial from an outage.
  const cleaned = codes.filter((c) => typeof c === "string");
  const checks = {
    observed_denials: cleaned.length >= 10,
    none_degraded_to_private_store_error: cleaned.every((c) => c !== "private_store_error"),
    typed_codes_only: cleaned.every((c) => DENIED_CAPABILITY.has(c))
  };
  return { expected: "typed denial codes survive the RPC boundary (capability_denied / scope_not_authorized), never private_store_error", observed: { ...checks, distinct_codes: [...new Set(cleaned)].sort() }, ok: Object.values(checks).every(Boolean) };
}

async function legacyRegression({ harness, rec }) {
  const r = await rec.probe(harness, "legacy_regression", {});
  const checks = { harness_ok: r?.ok === true, not_a_stub: real(r), health_2xx: Number.isInteger(r?.health) && r.health >= 200 && r.health < 300, no_private_tools_visible: r?.private_tools_visible === false };
  return { expected: "legacy MCP/Core OAuth healthy, no private tool names visible", observed: checks, ok: Object.values(checks).every(Boolean) };
}

// ---------------------------------------------------------------------------------------------
// Live Cloudflare readback + public-URL probe (reuses the #87 verifiers; read-only)
// ---------------------------------------------------------------------------------------------
export async function readDeploymentTag(client, { worker = STAGEC.worker, sourceSha } = {}) {
  const want = `s1-3-${String(sourceSha).slice(0, 12)}`;
  const json = await client.get(`/accounts/${client.accountId}/workers/scripts/${worker}/deployments`);
  const text = JSON.stringify(json?.result ?? {});
  return { ok: /^[0-9a-f]{40}$/.test(String(sourceSha)) && text.includes(want), want };
}

export async function liveReadbackCase({ cf, lib, fetchImpl, sourceSha, gatewayWorker }) {
  const checks = {}, warnings = [];
  const readback = await lib.runReadback(cf);
  checks.cloudflare_readback_d1_r2_bindings_secrets_no_exposure = readback.ok === true;
  const tag = await readDeploymentTag(cf, { sourceSha }).catch(() => ({ ok: false, want: "unreadable" }));
  checks.deployment_tag_matches_source_sha = tag.ok;
  const sub = await cf.get(`/accounts/${cf.accountId}/workers/subdomain`).catch(() => null);
  const subdomain = sub?.result?.subdomain;
  if (typeof subdomain !== "string") checks.subdomain_readable = false;
  else {
    const url = `https://${STAGEC.worker}.${subdomain}.workers.dev/`;
    let blocked = false;
    try { const res = await fetchImpl(url, { redirect: "manual" }); blocked = !(res.status >= 200 && res.status < 400); } catch { blocked = true; }
    checks.no_public_url_responds = blocked;
  }
  if (gatewayWorker) {
    const settings = await cf.get(`/accounts/${cf.accountId}/workers/scripts/${gatewayWorker}/settings`).catch(() => null);
    const bindings = settings?.result?.bindings ?? [];
    const svc = bindings.filter((b) => b?.type === "service" && b.service === STAGEC.worker);
    checks.gateway_has_exactly_one_binding_to_private_worker = svc.length === 1;
    if (svc.length === 1) {
      const props = svc[0].props;
      if (props === undefined) warnings.push("gateway_binding_props_not_returned_by_api: attestation is proven only behaviorally (platformCaller case); owner must confirm props.caller in the dashboard");
      else checks.gateway_binding_props_caller_exact = props?.caller === STAGEC.caller;
    }
  } else warnings.push("STAGE_C_GATEWAY_WORKER not set: gateway binding readback skipped");
  return { expected: "live bindings/IDs/secrets exact, deployment tagged with the reviewed SHA, no workers.dev/preview/routes/domains, gateway binds only the private Worker", observed: checks, warnings, ok: Object.values(checks).every(Boolean), receipt: redact(readback) };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------
export async function runStageC({ harness, d1, runId, sourceSha, extraCases = [], requiredExtra = [], cleanup = null, allowStubs = false } = {}) {
  if (!harness || !d1) throw new StageCError("harness_and_d1_required");
  if (!/^[a-z0-9]{6,16}$/.test(String(runId))) throw new StageCError("run_id_must_be_6_to_16_lowercase_alnum");
  if (!/^[0-9a-f]{40}$/.test(String(sourceSha))) throw new StageCError("source_sha_must_be_full_sha");
  ALLOW_STUBS = allowStubs === true;
  const rec = newRecorder();
  const codes = [];
  const ctx = { harness, d1, rec, runId, codes };
  const cases = [];
  const run = async (id, title, fn) => {
    const started = rec.requests.length;
    let outcome;
    try { outcome = await fn(); } catch (e) { outcome = { expected: "case completes", observed: { error: e instanceof StageCError ? e.code : "unexpected_error" }, ok: false }; }
    cases.push({ id, title, ok: outcome.ok === true, expected: outcome.expected, observed: redact(outcome.observed), d1: outcome.d1, warnings: outcome.warnings ?? [], receipt: outcome.receipt, request_count: rec.requests.length - started });
    return outcome.ok === true;
  };
  // Setup must pass or nothing after it means anything.
  const setupOk = await run("C00", "fixture setup (2 accounts x 2 providers)", () => setup(ctx));
  if (setupOk) {
    await run("C01", "isolation matrix + cross-home negatives", () => isolationMatrix(ctx));
    await run("C02", "revoked grant: store denial and real D1 triggers", () => revokedGrantTrigger(ctx));
    await run("C03", "nonce replay across isolates", () => nonceReplay(ctx));
    await run("C04", "missing / wrong ctx.props.caller", () => platformCaller(ctx));
    await run("C05", "envelope failures", () => envelopeFailures(ctx));
    await run("C06", "gateway auth failures + recovery-admin self-grant", () => gatewayAuth(ctx));
    await run("C07", "typed errors survive RPC boundary", async () => rpcErrorIdentity(ctx));
    await run("C08", "legacy MCP regression", () => legacyRegression(ctx));
    for (const [id, title, fn] of extraCases) await run(id, title, () => fn(ctx));
  }
  let cleanupResult = { performed: false };
  if (cleanup) cleanupResult = await cleanup(ctx).catch(() => ({ performed: false, error: "cleanup_failed" }));
  const warnings = cases.flatMap((c) => c.warnings);
  const expectedIds = ["C00", "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", ...requiredExtra];
  const ok = expectedIds.every((id) => cases.find((c) => c.id === id)?.ok === true) && cases.every((c) => c.ok);
  const body = { schema: STAGEC.evidenceSchema, mode: ALLOW_STUBS ? "simulated" : "live", source_sha: sourceSha, run_id: runId, harness_kind: harness.kind ?? "unknown", d1_kind: d1.kind ?? "unknown", d1_id: STAGEC.d1Id, ok, cases, warnings, cleanup: cleanupResult, requests: rec.requests };
  return { ...body, evidence_sha256: sha256(canonical(body)) };
}

/** Fixture cleanup is an owner-approved operation only: revokes the four synthetic connections via the store. */
export function makeCleanup({ approval, approvalId }) {
  return async ({ harness, rec }) => {
    if (approval !== STAGEC.cleanupPhrase || !/^[A-Za-z0-9_.:-]{6,64}$/.test(approvalId ?? "")) return { performed: false, reason: "not_approved" };
    for (const account of STAGEC.accounts) {
      const admin = ident(account, "chatgpt");
      await rec.call(harness, admin, "revokeConnection", connectionIdOf(ident(account, "grok")));
    }
    return { performed: true, approval_id: approvalId, scope: "revoked synthetic grok connections only; messages are immutable and are not deleted" };
  };
}
