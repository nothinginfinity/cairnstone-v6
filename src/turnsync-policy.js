// V7.7.10j — authenticated standing TurnSync policy.
//
// This is account-owned operational authorization/preference state in the Core-auth D1.
// It is NOT CairnStone accepted project state and never moves chain/path HEADs.
// Effective precedence: workspace -> chain -> account -> safe default ASK.

import { authDb, CORE_AUTH_REALM } from "./core-auth.js";

export const TURNSYNC_POLICY_SCHEMA = "cairnstone-turnsync-policy-v1";
export const TURNSYNC_POLICY_GET_TOOL_ID = "cairnstone_turnsync_policy_get";
export const TURNSYNC_POLICY_SET_TOOL_ID = "cairnstone_turnsync_policy_set";

export const TURNSYNC_POLICY_MODES = Object.freeze(["on", "off", "ask"]);
export const TURNSYNC_PAYLOAD_MODES = Object.freeze(["full_turns", "decisions_tasks", "summaries"]);
export const TURNSYNC_POLICY_SCOPE_KINDS = Object.freeze(["account", "workspace", "chain"]);

const MODE_SET = new Set(TURNSYNC_POLICY_MODES);
const PAYLOAD_SET = new Set(TURNSYNC_PAYLOAD_MODES);
const SCOPE_KIND_SET = new Set(TURNSYNC_POLICY_SCOPE_KINDS);
const DEFAULT_POLICY = Object.freeze({ mode: "ask", payload_mode: "full_turns" });

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_capability: false,
    project_memory_promoted: false
  };
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = 300) {
  const out = String(value ?? "").trim();
  return out && out.length <= max ? out : "";
}

function policyId() {
  return `tsp:${crypto.randomUUID()}`;
}

function rowToPolicy(row, { source = "stored" } = {}) {
  if (!row) return null;
  return {
    schema: TURNSYNC_POLICY_SCHEMA,
    policy_id: row.policy_id || null,
    account_id: row.account_id || null,
    tenant_id: row.tenant_id || null,
    scope_kind: row.scope_kind,
    scope_key: row.scope_key,
    mode: row.mode,
    payload_mode: row.payload_mode,
    revision: Number(row.revision || 0),
    updated_by_principal_id: row.updated_by_principal_id || null,
    updated_by_connection_id: row.updated_by_connection_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    source,
    ...authorityClosedFields()
  };
}

export function policyScopeCandidates({ workspace_id = null, chain = null } = {}) {
  const candidates = [];
  const workspace = clean(workspace_id);
  const selectedChain = clean(chain);
  if (workspace) candidates.push({ scope_kind: "workspace", scope_key: workspace });
  if (selectedChain) candidates.push({ scope_kind: "chain", scope_key: selectedChain });
  candidates.push({ scope_kind: "account", scope_key: "*" });
  return candidates;
}

export function effectivePolicyFromRows(rows = [], scope = {}) {
  const byKey = new Map();
  for (const row of rows || []) {
    if (!row || !MODE_SET.has(row.mode) || !PAYLOAD_SET.has(row.payload_mode)) continue;
    byKey.set(`${row.scope_kind}:${row.scope_key}`, row);
  }
  for (const candidate of policyScopeCandidates(scope)) {
    const row = byKey.get(`${candidate.scope_kind}:${candidate.scope_key}`);
    if (row) {
      return {
        ok: true,
        effective: rowToPolicy(row, { source: "stored" }),
        matched_scope: candidate,
        defaulted: false,
        precedence: ["workspace", "chain", "account", "default_ask"],
        ...authorityClosedFields()
      };
    }
  }
  return {
    ok: true,
    effective: {
      schema: TURNSYNC_POLICY_SCHEMA,
      policy_id: null,
      account_id: null,
      tenant_id: null,
      scope_kind: "default",
      scope_key: "*",
      mode: DEFAULT_POLICY.mode,
      payload_mode: DEFAULT_POLICY.payload_mode,
      revision: 0,
      source: "safe_default",
      ...authorityClosedFields()
    },
    matched_scope: { scope_kind: "default", scope_key: "*" },
    defaulted: true,
    precedence: ["workspace", "chain", "account", "default_ask"],
    ...authorityClosedFields()
  };
}

export function evaluateTurnSyncStandingPolicy(policy) {
  const mode = policy?.mode;
  const payloadMode = policy?.payload_mode;
  if (!MODE_SET.has(mode) || !PAYLOAD_SET.has(payloadMode)) {
    return {
      ok: false,
      allow_append: false,
      error: "turnsync_policy_invalid",
      ...authorityClosedFields()
    };
  }
  if (mode === "off") {
    return {
      ok: true,
      allow_append: false,
      error: "turnsync_sync_disabled",
      mode,
      payload_mode: payloadMode,
      requires_human_confirmation: false,
      ...authorityClosedFields()
    };
  }
  if (mode === "ask") {
    return {
      ok: true,
      allow_append: false,
      error: "turnsync_confirmation_required",
      mode,
      payload_mode: payloadMode,
      requires_human_confirmation: true,
      ...authorityClosedFields()
    };
  }
  if (payloadMode !== "full_turns") {
    return {
      ok: true,
      allow_append: false,
      error: "turnsync_payload_transform_required",
      mode,
      payload_mode: payloadMode,
      requires_human_confirmation: false,
      detail: "Selective/summarized payload modes fail closed until a trusted transformation pipeline supplies the bounded derived payload.",
      ...authorityClosedFields()
    };
  }
  return {
    ok: true,
    allow_append: true,
    mode,
    payload_mode: payloadMode,
    requires_human_confirmation: false,
    ...authorityClosedFields()
  };
}

async function activeContext(env) {
  const authContext = env?.CORE_AUTH_CONTEXT;
  if (!authContext?.account_id || !authContext?.tenant_id || !authContext?.principal_id || !authContext?.connection_id) {
    return { ok: false, error: "authenticated_account_context_required", ...authorityClosedFields() };
  }
  const binding = authDb(env);
  if (!binding.ok) return { ok: false, error: binding.error || "missing_auth_d1_binding", ...authorityClosedFields() };
  const row = await binding.db.prepare(
    `SELECT connection_id, principal_id, account_id, tenant_id, status
       FROM auth_connection_principals
      WHERE realm = ? AND connection_id = ? AND account_id = ? AND tenant_id = ? AND principal_id = ?
      LIMIT 1`
  ).bind(
    CORE_AUTH_REALM,
    authContext.connection_id,
    authContext.account_id,
    authContext.tenant_id,
    authContext.principal_id
  ).first();
  if (!row || row.status !== "active") {
    return { ok: false, error: "authenticated_connection_not_active", ...authorityClosedFields() };
  }
  return { ok: true, db: binding.db, auth: authContext, ...authorityClosedFields() };
}

async function readStoredPolicies(db, auth, scope) {
  const candidates = policyScopeCandidates(scope);
  const rows = [];
  for (const candidate of candidates) {
    const row = await db.prepare(
      `SELECT * FROM auth_turnsync_policies
        WHERE realm = ? AND account_id = ? AND tenant_id = ? AND scope_kind = ? AND scope_key = ?
        LIMIT 1`
    ).bind(
      CORE_AUTH_REALM,
      auth.account_id,
      auth.tenant_id,
      candidate.scope_kind,
      candidate.scope_key
    ).first();
    if (row) rows.push(row);
  }
  return rows;
}

export async function getEffectiveTurnSyncPolicy(env = {}, { workspace_id = null, chain = null } = {}) {
  const context = await activeContext(env);
  if (!context.ok) return context;
  const rows = await readStoredPolicies(context.db, context.auth, { workspace_id, chain });
  const resolved = effectivePolicyFromRows(rows, { workspace_id, chain });
  if (resolved.effective) {
    resolved.effective.account_id = context.auth.account_id;
    resolved.effective.tenant_id = context.auth.tenant_id;
  }
  return {
    ...resolved,
    account_id: context.auth.account_id,
    tenant_id: context.auth.tenant_id,
    requested_scope: {
      workspace_id: clean(workspace_id) || null,
      chain: clean(chain) || null
    },
    stored_matches: rows.map(row => rowToPolicy(row)),
    ...authorityClosedFields()
  };
}

export async function turnSyncPolicyGetFromBody(body = {}, env = {}) {
  return getEffectiveTurnSyncPolicy(env, {
    workspace_id: body.workspace_id || null,
    chain: body.chain || null
  });
}

function normalizePolicyWrite(body = {}) {
  const scopeKind = clean(body.scope_kind, 32).toLowerCase();
  const mode = clean(body.mode, 32).toLowerCase();
  const payloadMode = clean(body.payload_mode, 64).toLowerCase();
  if (!SCOPE_KIND_SET.has(scopeKind)) return { ok: false, error: "turnsync_policy_scope_invalid" };
  if (!MODE_SET.has(mode)) return { ok: false, error: "turnsync_policy_mode_invalid" };
  if (!PAYLOAD_SET.has(payloadMode)) return { ok: false, error: "turnsync_policy_payload_invalid" };
  const scopeKey = scopeKind === "account" ? "*" : clean(body.scope_key);
  if (!scopeKey) return { ok: false, error: "turnsync_policy_scope_key_required" };
  const baseRevision = body.base_revision === undefined || body.base_revision === null
    ? null
    : Number(body.base_revision);
  if (baseRevision !== null && (!Number.isInteger(baseRevision) || baseRevision < 1)) {
    return { ok: false, error: "turnsync_policy_base_revision_invalid" };
  }
  return { ok: true, scope_kind: scopeKind, scope_key: scopeKey, mode, payload_mode: payloadMode, base_revision: baseRevision };
}

export async function turnSyncPolicySetFromBody(body = {}, env = {}) {
  if (body.human_commit !== true) {
    return {
      ok: false,
      error: "human_confirmation_required",
      human_confirmation_required: true,
      ...authorityClosedFields()
    };
  }
  const write = normalizePolicyWrite(body);
  if (!write.ok) return { ...write, ...authorityClosedFields() };
  const context = await activeContext(env);
  if (!context.ok) return context;
  const { db, auth } = context;
  const existing = await db.prepare(
    `SELECT * FROM auth_turnsync_policies
      WHERE realm = ? AND account_id = ? AND tenant_id = ? AND scope_kind = ? AND scope_key = ?
      LIMIT 1`
  ).bind(CORE_AUTH_REALM, auth.account_id, auth.tenant_id, write.scope_kind, write.scope_key).first();
  const timestamp = nowIso();

  if (!existing) {
    if (write.base_revision !== null) {
      return {
        ok: false,
        error: "turnsync_policy_conflict",
        expected_base_revision: null,
        actual_revision: null,
        ...authorityClosedFields()
      };
    }
    const id = policyId();
    await db.prepare(
      `INSERT INTO auth_turnsync_policies
        (policy_id, realm, account_id, tenant_id, scope_kind, scope_key, mode, payload_mode,
         revision, updated_by_principal_id, updated_by_connection_id, created_at, updated_at, accepted_state_authority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0)`
    ).bind(
      id,
      CORE_AUTH_REALM,
      auth.account_id,
      auth.tenant_id,
      write.scope_kind,
      write.scope_key,
      write.mode,
      write.payload_mode,
      auth.principal_id,
      auth.connection_id,
      timestamp,
      timestamp
    ).run();
    const created = await db.prepare("SELECT * FROM auth_turnsync_policies WHERE policy_id = ?").bind(id).first();
    return {
      ok: true,
      schema: TURNSYNC_POLICY_SCHEMA,
      created: true,
      policy: rowToPolicy(created),
      human_commit_recorded: true,
      ...authorityClosedFields()
    };
  }

  const currentRevision = Number(existing.revision || 0);
  if (write.base_revision === null) {
    return {
      ok: false,
      error: "turnsync_policy_revision_required",
      current_revision: currentRevision,
      current_policy: rowToPolicy(existing),
      ...authorityClosedFields()
    };
  }
  if (write.base_revision !== currentRevision) {
    return {
      ok: false,
      error: "turnsync_policy_conflict",
      expected_base_revision: write.base_revision,
      actual_revision: currentRevision,
      current_policy: rowToPolicy(existing),
      ...authorityClosedFields()
    };
  }

  const result = await db.prepare(
    `UPDATE auth_turnsync_policies
        SET mode = ?, payload_mode = ?, revision = revision + 1,
            updated_by_principal_id = ?, updated_by_connection_id = ?, updated_at = ?
      WHERE policy_id = ? AND revision = ?`
  ).bind(
    write.mode,
    write.payload_mode,
    auth.principal_id,
    auth.connection_id,
    timestamp,
    existing.policy_id,
    currentRevision
  ).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    const latest = await db.prepare("SELECT * FROM auth_turnsync_policies WHERE policy_id = ?").bind(existing.policy_id).first();
    return {
      ok: false,
      error: "turnsync_policy_conflict",
      expected_base_revision: currentRevision,
      actual_revision: Number(latest?.revision || 0) || null,
      current_policy: rowToPolicy(latest),
      ...authorityClosedFields()
    };
  }
  const updated = await db.prepare("SELECT * FROM auth_turnsync_policies WHERE policy_id = ?").bind(existing.policy_id).first();
  return {
    ok: true,
    schema: TURNSYNC_POLICY_SCHEMA,
    created: false,
    policy: rowToPolicy(updated),
    human_commit_recorded: true,
    ...authorityClosedFields()
  };
}

export const TURNSYNC_POLICY_GET_TOOL_DEFINITION = Object.freeze({
  name: TURNSYNC_POLICY_GET_TOOL_ID,
  description: "V7.7.10j: read the authenticated account's effective TurnSync standing policy. Precedence is workspace, chain, account, then safe default ASK. Read-only operational state; never accepted project authority.",
  inputSchema: {
    type: "object",
    properties: {
      workspace_id: { type: "string" },
      chain: { type: "string" }
    },
    additionalProperties: false
  }
});

export const TURNSYNC_POLICY_SET_TOOL_DEFINITION = Object.freeze({
  name: TURNSYNC_POLICY_SET_TOOL_ID,
  description: "V7.7.10j: human-confirmed CAS write of account-owned TurnSync ON/OFF/ASK + payload mode at account/workspace/chain scope. Existing policies require base_revision. Never moves accepted-state HEADs.",
  inputSchema: {
    type: "object",
    required: ["scope_kind", "mode", "payload_mode", "human_commit"],
    properties: {
      scope_kind: { type: "string", enum: [...TURNSYNC_POLICY_SCOPE_KINDS] },
      scope_key: { type: ["string", "null"], description: "Required for workspace/chain; ignored for account." },
      mode: { type: "string", enum: [...TURNSYNC_POLICY_MODES] },
      payload_mode: { type: "string", enum: [...TURNSYNC_PAYLOAD_MODES] },
      base_revision: { type: ["integer", "null"], minimum: 1 },
      human_commit: { type: "boolean" }
    },
    additionalProperties: false
  }
});
