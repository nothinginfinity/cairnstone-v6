// V7.7.5a Shared Agent Workspace foundation.
//
// Contract + capability + path hardening + revision CAS storage.
// ChatGPT baseline (B/A-hybrid): content-addressed R2 blobs + D1 tips.
// Draft revisions do NOT enter ordinary Stones / search / Scope / HEADs.
//
// Full MCP tool surface (create/list/stat/ls/read/diff/propose_accept) is
// deferred to V7.7.5b/5c. This module proves capability fail-closed and CAS.

import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const WORKSPACE_CAPABILITY_SCHEMA = "cairnstone-workspace-capability-v1";
export const WORKSPACE_REVISION_SCHEMA = "cairnstone-workspace-revision-v1";
export const WORKSPACE_CAPABILITY_PURPOSE = "workspace";
export const WORKSPACE_CAPABILITY_MAX_TTL_SECONDS = 3600;
export const WORKSPACE_CAPABILITY_DEFAULT_TTL_SECONDS = 900;
export const WORKSPACE_MAX_CONTENT_BYTES = 262144; // 256 KiB UTF-8 text v1 bound

export const WORKSPACE_CAPABILITY_SCOPES = Object.freeze([
  "diff",
  "ls",
  "propose",
  "read",
  "write_draft"
]);

const WORKSPACE_SCOPE_SET = new Set(WORKSPACE_CAPABILITY_SCOPES);

export const WORKSPACE_MEMBER_ROLES = Object.freeze([
  "reader",
  "drafter",
  "proposer",
  "owner"
]);

/** Membership role → max scopes that may be minted (capability may only narrow). */
export const WORKSPACE_ROLE_SCOPES = Object.freeze({
  reader: Object.freeze(["diff", "ls", "read"]),
  drafter: Object.freeze(["diff", "ls", "read", "write_draft"]),
  proposer: Object.freeze(["diff", "ls", "propose", "read", "write_draft"]),
  owner: Object.freeze(["diff", "ls", "propose", "read", "write_draft"])
});

/** Broker tool ids registered in 5a (handlers may remain stubs until 5b/5c). */
export const WORKSPACE_BROKER_TOOL_IDS = Object.freeze({
  create: "cairnstone_workspace_create",
  list: "cairnstone_workspace_list",
  stat: "cairnstone_workspace_stat",
  ls: "cairnstone_workspace_ls",
  read: "cairnstone_workspace_read",
  write_draft: "cairnstone_workspace_write_draft",
  diff: "cairnstone_workspace_diff",
  propose_accept: "cairnstone_workspace_propose_accept"
});

export const WORKSPACE_MUTATION_TOOL_IDS = Object.freeze([
  WORKSPACE_BROKER_TOOL_IDS.create,
  WORKSPACE_BROKER_TOOL_IDS.write_draft,
  WORKSPACE_BROKER_TOOL_IDS.propose_accept
]);

export const WORKSPACE_READ_TOOL_IDS = Object.freeze([
  WORKSPACE_BROKER_TOOL_IDS.list,
  WORKSPACE_BROKER_TOOL_IDS.stat,
  WORKSPACE_BROKER_TOOL_IDS.ls,
  WORKSPACE_BROKER_TOOL_IDS.read,
  WORKSPACE_BROKER_TOOL_IDS.diff
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const WORKSPACE_ID_RE = /^ws:[a-z0-9][a-z0-9._-]{0,127}$/i;

/** Default-deny secret / credential filename patterns (basename match). */
const SECRET_BASENAME_RES = Object.freeze([
  /^\.env$/i,
  /^\.env\..+$/i,
  /^\.aws$/i,
  /^\.ssh$/i,
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ecdsa$/i,
  /^id_ed25519$/i,
  /^credentials$/i,
  /^credentials\.json$/i,
  /^secrets?\.(json|ya?ml|toml|env)$/i,
  /^.+\.pem$/i,
  /^.+\.key$/i,
  /^.+\.p12$/i,
  /^.+\.pfx$/i,
  /^authorized_keys$/i,
  /^known_hosts$/i
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function actorId(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ACTOR_ID_RE.test(text)) throw new Error(`Invalid actor id for ${field}`);
  return text;
}

function workspaceId(value, field = "workspace_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!WORKSPACE_ID_RE.test(text)) throw new Error(`Invalid workspace id for ${field}`);
  return text;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const text = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = text + "=".repeat((4 - (text.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSha256Base64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Dedicated workspace secret only. NO fallback to mailbox secret or
 * CAIRNSTONE_OPERATOR_TOKEN. Missing secret → fail closed.
 */
export function workspaceCapabilitySecret(env = {}) {
  const dedicated = typeof env?.CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET === "string"
    ? env.CAIRNSTONE_WORKSPACE_CAPABILITY_SECRET.trim()
    : "";
  return dedicated || null;
}

export function scopesAllowedForRole(role) {
  const key = String(role || "").trim();
  return WORKSPACE_ROLE_SCOPES[key] ? [...WORKSPACE_ROLE_SCOPES[key]] : [];
}

export function normalizeWorkspaceScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  return [...new Set(list.map(value => String(value || "").trim()).filter(Boolean))].sort();
}

/**
 * Capability may narrow membership, never widen.
 * Returns { ok:true, scopes } or { ok:false, error, ... }.
 */
export function narrowScopesToMembership(requestedScopes, membershipRole) {
  const allowed = new Set(scopesAllowedForRole(membershipRole));
  if (!allowed.size) {
    return { ok: false, error: "invalid_workspace_membership_role", allowed_roles: [...WORKSPACE_MEMBER_ROLES] };
  }
  const scopes = normalizeWorkspaceScopes(requestedScopes);
  if (!scopes.length || scopes.some(scope => !WORKSPACE_SCOPE_SET.has(scope))) {
    return { ok: false, error: "invalid_workspace_capability_scopes", allowed: [...WORKSPACE_CAPABILITY_SCOPES] };
  }
  const widened = scopes.filter(scope => !allowed.has(scope));
  if (widened.length) {
    return {
      ok: false,
      error: "workspace_capability_widens_membership",
      widened,
      membership_role: membershipRole,
      role_scopes: [...allowed].sort()
    };
  }
  return { ok: true, scopes, membership_role: membershipRole, role_scopes: [...allowed].sort() };
}

/**
 * Canonical relative POSIX path only.
 * Rejects absolute paths, `..`, `.` components, NUL, backslashes, empty,
 * symlink-ish markers, and default-deny secret basenames.
 */
export function canonicalizeWorkspacePath(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "workspace_path_invalid", detail: "path_must_be_string" };
  }
  if (input.length === 0) {
    return { ok: false, error: "workspace_path_invalid", detail: "path_empty" };
  }
  if (input.length > 1024) {
    return { ok: false, error: "workspace_path_invalid", detail: "path_too_long" };
  }
  if (input.includes("\0")) {
    return { ok: false, error: "workspace_path_invalid", detail: "nul_byte" };
  }
  if (input.includes("\\")) {
    return { ok: false, error: "workspace_path_invalid", detail: "backslash_not_allowed" };
  }
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input)) {
    return { ok: false, error: "workspace_path_invalid", detail: "absolute_path" };
  }
  // Symlink / special markers — workspace never follows host links.
  if (/(^|\/)->($|\/)/.test(input) || input.includes("\u0000")) {
    return { ok: false, error: "workspace_path_invalid", detail: "symlink_or_special" };
  }
  if (input.endsWith("/") || input.includes("//")) {
    return { ok: false, error: "workspace_path_invalid", detail: "non_canonical_slashes" };
  }

  const parts = input.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      return { ok: false, error: "workspace_path_invalid", detail: "dot_or_dotdot_component" };
    }
    if (part === ".symlink" || part.endsWith(".symlink")) {
      return { ok: false, error: "workspace_path_invalid", detail: "symlink_pattern" };
    }
    if (SECRET_BASENAME_RES.some(re => re.test(part))) {
      return { ok: false, error: "workspace_path_denied_secret", detail: part };
    }
  }

  return { ok: true, path: parts.join("/") };
}

export function pathWithinPrefix(canonicalPath, pathPrefix) {
  if (pathPrefix === undefined || pathPrefix === null || pathPrefix === "") return { ok: true };
  const prefixResult = canonicalizeWorkspacePath(pathPrefix);
  if (!prefixResult.ok) return prefixResult;
  const prefix = prefixResult.path;
  if (canonicalPath === prefix || canonicalPath.startsWith(`${prefix}/`)) return { ok: true };
  return { ok: false, error: "workspace_path_outside_capability_prefix", path: canonicalPath, path_prefix: prefix };
}

export function workspaceBlobKey(contentHash) {
  return `workspace-blobs/${contentHash}.txt`;
}

export async function hashWorkspaceContent(content) {
  return sha256Text(String(content));
}

export async function computeRevisionId({
  workspace_id,
  path,
  parent_revision_id,
  content_hash,
  actor_id
}) {
  return sha256Text(stableJson({
    schema: WORKSPACE_REVISION_SCHEMA,
    workspace_id,
    path,
    parent_revision_id: parent_revision_id || null,
    content_hash,
    actor_id
  }));
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

function assertBoundedUtf8Text(content) {
  if (typeof content !== "string") {
    return { ok: false, error: "workspace_content_invalid", detail: "utf8_text_required" };
  }
  // Reject lone surrogates / non-well-formed by round-tripping through TextEncoder.
  try {
    const encoded = new TextEncoder().encode(content);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    if (decoded !== content) {
      return { ok: false, error: "workspace_content_invalid", detail: "utf8_roundtrip_mismatch" };
    }
  } catch {
    return { ok: false, error: "workspace_content_invalid", detail: "invalid_utf8" };
  }
  const bytes = utf8ByteLength(content);
  if (bytes > WORKSPACE_MAX_CONTENT_BYTES) {
    return { ok: false, error: "workspace_content_too_large", max_bytes: WORKSPACE_MAX_CONTENT_BYTES, bytes };
  }
  return { ok: true, bytes };
}

export async function issueWorkspaceCapabilityFromBody(body = {}, env = {}) {
  const secret = workspaceCapabilitySecret(env);
  if (!secret) return { ok: false, error: "workspace_capability_not_configured" };

  let principalActorId;
  let wsId;
  try {
    principalActorId = actorId(body.principal_actor_id ?? body.actor_id, "principal_actor_id");
    wsId = workspaceId(body.workspace_id);
  } catch (error) {
    return { ok: false, error: "invalid_workspace_capability_principal", detail: String(error.message || error) };
  }

  const membershipRole = String(body.membership_role || "").trim();
  const narrowed = narrowScopesToMembership(body.scopes, membershipRole);
  if (!narrowed.ok) return narrowed;

  let pathPrefix = null;
  if (body.path_prefix !== undefined && body.path_prefix !== null && body.path_prefix !== "") {
    const prefixResult = canonicalizeWorkspacePath(body.path_prefix);
    if (!prefixResult.ok) return { ok: false, error: "invalid_workspace_path_prefix", detail: prefixResult };
    pathPrefix = prefixResult.path;
  }

  const ttlSeconds = clampInt(
    body.ttl_seconds,
    30,
    WORKSPACE_CAPABILITY_MAX_TTL_SECONDS,
    WORKSPACE_CAPABILITY_DEFAULT_TTL_SECONDS
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    schema: WORKSPACE_CAPABILITY_SCHEMA,
    purpose: WORKSPACE_CAPABILITY_PURPOSE,
    audience: WORKSPACE_CAPABILITY_PURPOSE,
    principal_actor_id: principalActorId,
    workspace_id: wsId,
    scopes: narrowed.scopes,
    membership_role: membershipRole,
    path_prefix: pathPrefix,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    nonce: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${issuedAt}:${Math.random()}`,
    policy: {
      accepted_state_authority: false,
      execution_authority: false,
      mutation_authority: false,
      write_draft_implies_propose: false,
      propose_implies_accepted_state: false
    }
  };
  const encodedPayload = encodeBase64Url(stableJson(payload));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return {
    ok: true,
    schema: WORKSPACE_CAPABILITY_SCHEMA,
    workspace_capability: `${encodedPayload}.${signature}`,
    principal_actor_id: principalActorId,
    workspace_id: wsId,
    scopes: narrowed.scopes,
    membership_role: membershipRole,
    path_prefix: pathPrefix,
    issued_at: new Date(payload.iat * 1000).toISOString(),
    expires_at: new Date(payload.exp * 1000).toISOString(),
    policy: payload.policy
  };
}

/**
 * Verify a signed workspace capability.
 * requiredScopes are exact — write_draft does not imply propose.
 */
export async function verifyWorkspaceCapability(
  token,
  {
    expectedActorId,
    expectedWorkspaceId,
    requiredScopes = [],
    path = null
  } = {},
  env = {}
) {
  const secret = workspaceCapabilitySecret(env);
  if (!secret) return { ok: false, error: "workspace_capability_not_configured" };
  if (!isNonEmptyString(token)) return { ok: false, error: "workspace_capability_required" };

  const parts = token.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "workspace_capability_invalid" };
  const expectedSignature = await hmacSha256Base64Url(secret, parts[0]);
  if (!constantTimeTextEqual(parts[1], expectedSignature)) {
    return { ok: false, error: "workspace_capability_invalid_signature" };
  }

  let payload;
  try { payload = JSON.parse(decodeBase64Url(parts[0])); }
  catch { return { ok: false, error: "workspace_capability_invalid_payload" }; }

  if (!isObject(payload) || payload.schema !== WORKSPACE_CAPABILITY_SCHEMA) {
    return { ok: false, error: "workspace_capability_wrong_schema" };
  }
  if (payload.purpose !== WORKSPACE_CAPABILITY_PURPOSE || payload.audience !== WORKSPACE_CAPABILITY_PURPOSE) {
    return { ok: false, error: "workspace_capability_wrong_purpose" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= now || payload.iat > now + 60) {
    return { ok: false, error: "workspace_capability_expired_or_invalid_time" };
  }
  if (payload.exp - payload.iat > WORKSPACE_CAPABILITY_MAX_TTL_SECONDS) {
    return { ok: false, error: "workspace_capability_ttl_exceeded" };
  }

  let principalActorId;
  let wsId;
  try {
    principalActorId = actorId(payload.principal_actor_id, "principal_actor_id");
    wsId = workspaceId(payload.workspace_id);
  } catch {
    return { ok: false, error: "workspace_capability_invalid_principal" };
  }

  if (expectedActorId && principalActorId !== expectedActorId) {
    return {
      ok: false,
      error: "workspace_capability_principal_mismatch",
      principal_actor_id: principalActorId,
      requested_actor_id: expectedActorId
    };
  }
  if (expectedWorkspaceId && wsId !== expectedWorkspaceId) {
    return {
      ok: false,
      error: "workspace_capability_workspace_mismatch",
      workspace_id: wsId,
      requested_workspace_id: expectedWorkspaceId
    };
  }

  const scopes = Array.isArray(payload.scopes) ? [...new Set(payload.scopes.map(String))] : [];
  const required = Array.isArray(requiredScopes) ? requiredScopes.map(String) : [];
  const missing = required.filter(scope => !scopes.includes(scope));
  if (missing.length) {
    return { ok: false, error: "workspace_capability_scope_missing", missing, scopes };
  }

  // Explicit scope separation invariant for callers.
  if (required.includes("propose") && !scopes.includes("propose")) {
    return { ok: false, error: "workspace_capability_scope_missing", missing: ["propose"], scopes };
  }

  if (path !== undefined && path !== null && path !== "") {
    const canonical = canonicalizeWorkspacePath(path);
    if (!canonical.ok) return canonical;
    const prefixCheck = pathWithinPrefix(canonical.path, payload.path_prefix);
    if (!prefixCheck.ok) return prefixCheck;
  }

  return {
    ok: true,
    schema: WORKSPACE_CAPABILITY_SCHEMA,
    principal_actor_id: principalActorId,
    workspace_id: wsId,
    scopes,
    membership_role: payload.membership_role || null,
    path_prefix: payload.path_prefix || null,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    policy: payload.policy || null
  };
}

/** True iff scopes include every required scope (no implication between write_draft and propose). */
export function capabilityHasExactScopes(scopes, requiredScopes = []) {
  const have = new Set(Array.isArray(scopes) ? scopes.map(String) : []);
  return (Array.isArray(requiredScopes) ? requiredScopes : []).every(scope => have.has(String(scope)));
}

export async function createWorkspace(db, {
  workspace_id,
  name,
  created_by,
  github_bind = null
} = {}) {
  let wsId;
  let creator;
  try {
    wsId = workspaceId(workspace_id);
    creator = actorId(created_by, "created_by");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_create", detail: String(error.message || error) };
  }
  if (!isNonEmptyString(name) || name.trim().length > 200) {
    return { ok: false, error: "invalid_workspace_name" };
  }
  const now = new Date().toISOString();
  const bindJson = github_bind == null ? null : stableJson(github_bind);
  await db.prepare(
    `INSERT INTO workspaces (workspace_id, name, created_by, created_at, updated_at, status, github_bind_json)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  ).bind(wsId, name.trim(), creator, now, now, bindJson).run();

  await db.prepare(
    `INSERT INTO workspace_members (workspace_id, actor_id, role, created_at)
     VALUES (?, ?, 'owner', ?)`
  ).bind(wsId, creator, now).run();

  return {
    ok: true,
    workspace_id: wsId,
    name: name.trim(),
    created_by: creator,
    created_at: now,
    status: "active",
    accepted_state_authority: false
  };
}

export async function upsertWorkspaceMember(db, {
  workspace_id,
  actor_id,
  role
} = {}) {
  let wsId;
  let member;
  try {
    wsId = workspaceId(workspace_id);
    member = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_member", detail: String(error.message || error) };
  }
  if (!WORKSPACE_ROLE_SCOPES[role]) {
    return { ok: false, error: "invalid_workspace_membership_role", allowed_roles: [...WORKSPACE_MEMBER_ROLES] };
  }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO workspace_members (workspace_id, actor_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, actor_id) DO UPDATE SET role=excluded.role`
  ).bind(wsId, member, role, now).run();
  return { ok: true, workspace_id: wsId, actor_id: member, role };
}

export async function getWorkspaceMember(db, workspace_id, actor_id) {
  const row = await db.prepare(
    `SELECT workspace_id, actor_id, role, created_at
     FROM workspace_members WHERE workspace_id = ? AND actor_id = ?`
  ).bind(workspace_id, actor_id).first();
  return row || null;
}

export async function getWorkspaceTip(db, workspace_id, path) {
  return await db.prepare(
    `SELECT workspace_id, path, revision_id, content_hash, updated_at
     FROM workspace_tips WHERE workspace_id = ? AND path = ?`
  ).bind(workspace_id, path).first() || null;
}

async function putWorkspaceBlob(r2, contentHash, content) {
  if (!r2 || typeof r2.put !== "function") throw new Error("Missing R2 binding for workspace blobs");
  const key = workspaceBlobKey(contentHash);
  await r2.put(key, content, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { content_hash: contentHash, plane: "workspace_draft" }
  });
  return key;
}

function conflictResult(tip) {
  return {
    ok: false,
    error: "workspace_conflict",
    current_tip: tip
      ? {
        revision_id: tip.revision_id,
        content_hash: tip.content_hash,
        path: tip.path,
        updated_at: tip.updated_at || null
      }
      : null,
    accepted_state_authority: false
  };
}

/**
 * write_draft CAS library API.
 * - base_revision null only for create (no existing tip)
 * - on mismatch → workspace_conflict with current tip + content hash
 * - never last-write-wins; never writes Stones / chain_heads / path_heads
 */
export async function writeDraft(db, r2, {
  workspace_id,
  path,
  content,
  base_revision = null,
  actor_id
} = {}) {
  let wsId;
  let actor;
  try {
    wsId = workspaceId(workspace_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_write", detail: String(error.message || error) };
  }

  const pathResult = canonicalizeWorkspacePath(path);
  if (!pathResult.ok) return pathResult;
  const canonicalPath = pathResult.path;

  const contentCheck = assertBoundedUtf8Text(content);
  if (!contentCheck.ok) return contentCheck;

  if (base_revision !== null && base_revision !== undefined && !isNonEmptyString(base_revision)) {
    return { ok: false, error: "invalid_base_revision" };
  }
  const baseRevision = base_revision === undefined || base_revision === null || base_revision === ""
    ? null
    : String(base_revision).trim();

  const tip = await getWorkspaceTip(db, wsId, canonicalPath);
  if (!tip && baseRevision !== null) {
    return conflictResult(null);
  }
  if (tip && baseRevision === null) {
    return conflictResult(tip);
  }
  if (tip && tip.revision_id !== baseRevision) {
    return conflictResult(tip);
  }

  const contentHash = await hashWorkspaceContent(content);
  const rawKey = await putWorkspaceBlob(r2, contentHash, content);
  const now = new Date().toISOString();
  const revisionId = await computeRevisionId({
    workspace_id: wsId,
    path: canonicalPath,
    parent_revision_id: tip ? tip.revision_id : null,
    content_hash: contentHash,
    actor_id: actor
  });

  // Append-only revision row (idempotent on identical envelope).
  await db.prepare(
    `INSERT OR IGNORE INTO workspace_revisions
      (revision_id, workspace_id, path, parent_revision_id, content_hash, content_bytes, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    revisionId,
    wsId,
    canonicalPath,
    tip ? tip.revision_id : null,
    contentHash,
    contentCheck.bytes,
    actor,
    now
  ).run();

  if (!tip) {
    try {
      await db.prepare(
        `INSERT INTO workspace_tips (workspace_id, path, revision_id, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(wsId, canonicalPath, revisionId, contentHash, now).run();
    } catch (error) {
      const raced = await getWorkspaceTip(db, wsId, canonicalPath);
      return conflictResult(raced);
    }
  } else {
    const updated = await db.prepare(
      `UPDATE workspace_tips
       SET revision_id = ?, content_hash = ?, updated_at = ?
       WHERE workspace_id = ? AND path = ? AND revision_id = ?`
    ).bind(revisionId, contentHash, now, wsId, canonicalPath, baseRevision).run();
    const changes = updated?.meta?.changes ?? updated?.changes ?? 0;
    if (!changes) {
      const raced = await getWorkspaceTip(db, wsId, canonicalPath);
      return conflictResult(raced);
    }
  }

  await db.prepare(
    `UPDATE workspaces SET updated_at = ? WHERE workspace_id = ?`
  ).bind(now, wsId).run();

  return {
    ok: true,
    workspace_id: wsId,
    path: canonicalPath,
    revision_id: revisionId,
    parent_revision_id: tip ? tip.revision_id : null,
    content_hash: contentHash,
    content_bytes: contentCheck.bytes,
    raw_key: rawKey,
    actor_id: actor,
    created_at: now,
    accepted_state_authority: false,
    stones_written: 0,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };
}

export async function readDraft(db, r2, { workspace_id, path } = {}) {
  let wsId;
  try { wsId = workspaceId(workspace_id); }
  catch (error) { return { ok: false, error: "invalid_workspace_read", detail: String(error.message || error) }; }
  const pathResult = canonicalizeWorkspacePath(path);
  if (!pathResult.ok) return pathResult;
  const tip = await getWorkspaceTip(db, wsId, pathResult.path);
  if (!tip) return { ok: false, error: "workspace_path_not_found", path: pathResult.path };
  const key = workspaceBlobKey(tip.content_hash);
  const obj = await r2.get(key);
  if (!obj) return { ok: false, error: "workspace_blob_missing", content_hash: tip.content_hash, raw_key: key };
  const content = await obj.text();
  return {
    ok: true,
    workspace_id: wsId,
    path: pathResult.path,
    revision_id: tip.revision_id,
    content_hash: tip.content_hash,
    content,
    accepted_state_authority: false
  };
}
