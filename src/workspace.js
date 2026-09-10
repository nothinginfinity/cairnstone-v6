// V7.7.5 Shared Agent Workspace (5a foundation + 5b MCP + 5c snapshot/propose).
//
// Contract + capability + path hardening + revision CAS storage + MCP tools:
// create/list/stat/ls/read/write_draft/diff/propose_accept + optional GitHub bind.
// ChatGPT baseline (B/A-hybrid): content-addressed R2 blobs + D1 tips.
// Draft revisions do NOT enter ordinary Stones / search / Scope / HEADs.
// propose_accept freezes an immutable snapshot and may emit a proposal Stone
// with accepted_state_authority:false; it NEVER moves chain_heads/path_heads.

import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const WORKSPACE_CAPABILITY_SCHEMA = "cairnstone-workspace-capability-v1";
export const WORKSPACE_REVISION_SCHEMA = "cairnstone-workspace-revision-v1";
export const WORKSPACE_SNAPSHOT_SCHEMA = "cairnstone-workspace-snapshot-v1";
export const WORKSPACE_TIP_VECTOR_SCHEMA = "cairnstone-workspace-tip-vector-v1";
export const WORKSPACE_PROPOSAL_SCHEMA = "cairnstone-workspace-proposal-v1";
export const WORKSPACE_CAPABILITY_PURPOSE = "workspace";
export const WORKSPACE_CAPABILITY_MAX_TTL_SECONDS = 3600;
export const WORKSPACE_CAPABILITY_DEFAULT_TTL_SECONDS = 900;
export const WORKSPACE_MAX_CONTENT_BYTES = 262144; // 256 KiB UTF-8 text v1 bound
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]+$/;

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

/**
 * Optional GitHub bind: transport/backing only. Branch refs are not authority.
 * root_path (if set) must be a canonical relative POSIX path (sandboxed).
 */
export function normalizeGithubBind(input) {
  if (input === undefined || input === null) return { ok: true, github_bind: null };
  if (!isObject(input)) return { ok: false, error: "invalid_workspace_github_bind", detail: "object_required" };
  const owner = String(input.owner || "").trim();
  const repo = String(input.repo || input.repository || "").trim();
  if (!owner || !repo || !GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
    return { ok: false, error: "invalid_workspace_github_bind", detail: "owner_repo" };
  }
  const ref = String(input.ref || input.branch || input.sha || "main").trim();
  if (!ref || ref.length > 256 || ref.includes("\0") || ref.includes("..")) {
    return { ok: false, error: "invalid_workspace_github_bind", detail: "ref" };
  }
  let rootPath = null;
  if (input.root_path !== undefined && input.root_path !== null && input.root_path !== "") {
    const pathResult = canonicalizeWorkspacePath(input.root_path);
    if (!pathResult.ok) {
      return { ok: false, error: "invalid_workspace_github_bind_root_path", detail: pathResult };
    }
    rootPath = pathResult.path;
  }
  return {
    ok: true,
    github_bind: {
      owner,
      repo,
      ref,
      root_path: rootPath
    }
  };
}

export function parseGithubBindJson(githubBindJson) {
  if (githubBindJson === undefined || githubBindJson === null || githubBindJson === "") {
    return { ok: true, github_bind: null };
  }
  try {
    const parsed = typeof githubBindJson === "string" ? JSON.parse(githubBindJson) : githubBindJson;
    return normalizeGithubBind(parsed);
  } catch {
    return { ok: false, error: "invalid_workspace_github_bind_json" };
  }
}

/**
 * Resolve a mutable branch/tag ref to an immutable 40-hex commit SHA.
 * Full SHAs short-circuit with no network call. Fail closed on unresolved refs.
 */
export async function resolveGitHubCommitSha(owner, repo, ref, env = {}) {
  const requestedRef = String(ref || "").trim();
  if (FULL_SHA_RE.test(requestedRef)) {
    return {
      ok: true,
      requested_ref: requestedRef,
      observed_commit_sha: requestedRef.toLowerCase(),
      already_resolved: true
    };
  }
  if (!owner || !repo || !requestedRef) {
    return { ok: false, error: "github_commit_resolution_failed", detail: "owner_repo_ref_required" };
  }
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(requestedRef)}`;
  const headers = {
    "User-Agent": "cairnstone-v6-worker",
    Accept: "application/vnd.github+json"
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      return {
        ok: false,
        error: "github_commit_resolution_failed",
        detail: `github_commit_lookup_failed:${response.status}`,
        requested_ref: requestedRef
      };
    }
    const data = await response.json();
    if (data && typeof data.sha === "string" && FULL_SHA_RE.test(data.sha)) {
      return {
        ok: true,
        requested_ref: requestedRef,
        observed_commit_sha: data.sha.toLowerCase(),
        already_resolved: false
      };
    }
    return {
      ok: false,
      error: "github_commit_resolution_failed",
      detail: "github_commit_lookup_malformed_response",
      requested_ref: requestedRef
    };
  } catch (error) {
    return {
      ok: false,
      error: "github_commit_resolution_failed",
      detail: `github_commit_lookup_exception:${String(error && error.message ? error.message : error)}`,
      requested_ref: requestedRef
    };
  }
}

export function buildTipVector(tips = []) {
  const list = Array.isArray(tips) ? tips : [];
  return list
    .map(tip => ({
      path: String(tip.path),
      revision_id: String(tip.revision_id),
      content_hash: String(tip.content_hash)
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function tipVectorDigestPayload(workspaceId, tipVector) {
  return {
    schema: WORKSPACE_TIP_VECTOR_SCHEMA,
    workspace_id: workspaceId,
    tips: tipVector
  };
}

export async function computeTipVectorDigest(workspaceId, tipVector) {
  return sha256Text(stableJson(tipVectorDigestPayload(workspaceId, tipVector)));
}

export function tipVectorsEqual(left, right) {
  const a = buildTipVector(left);
  const b = buildTipVector(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].path !== b[i].path) return false;
    if (a[i].revision_id !== b[i].revision_id) return false;
    if (a[i].content_hash !== b[i].content_hash) return false;
  }
  return true;
}

async function selectTipsForSnapshot(db, workspaceId, { paths = null, prefix = null } = {}) {
  if (Array.isArray(paths) && paths.length) {
    const selected = [];
    for (const rawPath of paths) {
      const pathResult = canonicalizeWorkspacePath(rawPath);
      if (!pathResult.ok) return pathResult;
      const tip = await getWorkspaceTip(db, workspaceId, pathResult.path);
      if (!tip) {
        return { ok: false, error: "workspace_path_not_found", path: pathResult.path };
      }
      selected.push(tip);
    }
    return { ok: true, tips: selected };
  }
  const listed = await listWorkspaceTips(db, workspaceId, prefix);
  if (!listed.ok) return listed;
  return { ok: true, tips: listed.tips };
}

/**
 * Freeze an immutable workspace_snapshot over the selected path-tip vector.
 * Re-reads tips before commit; fail closed with workspace_snapshot_race on change.
 * Does not mutate chain_heads / path_heads / workspace_tips.
 */
export async function freezeWorkspaceSnapshot(db, {
  workspace_id,
  created_by,
  paths = null,
  prefix = null
} = {}) {
  let wsId;
  let creator;
  try {
    wsId = workspaceId(workspace_id);
    creator = actorId(created_by, "created_by");
  } catch (error) {
    return { ok: false, error: "invalid_workspace_snapshot", detail: String(error.message || error) };
  }

  const first = await selectTipsForSnapshot(db, wsId, { paths, prefix });
  if (!first.ok) return first;
  if (!first.tips.length) {
    return { ok: false, error: "workspace_snapshot_empty", workspace_id: wsId };
  }

  const tipVector = buildTipVector(first.tips);
  const tipVectorDigest = await computeTipVectorDigest(wsId, tipVector);
  const snapshotId = await sha256Text(stableJson({
    schema: WORKSPACE_SNAPSHOT_SCHEMA,
    workspace_id: wsId,
    tip_vector_digest: tipVectorDigest
  }));

  // Authority-first recheck: tips must still match the compiled vector.
  const second = await selectTipsForSnapshot(db, wsId, { paths, prefix });
  if (!second.ok) return second;
  if (!tipVectorsEqual(tipVector, second.tips)) {
    return {
      ok: false,
      error: "workspace_snapshot_race",
      workspace_id: wsId,
      expected_tip_vector_digest: tipVectorDigest,
      accepted_state_authority: false
    };
  }

  const now = new Date().toISOString();
  const tipVectorJson = stableJson(tipVectorDigestPayload(wsId, tipVector));
  await db.prepare(
    `INSERT OR IGNORE INTO workspace_snapshots
      (snapshot_id, workspace_id, tip_vector_json, tip_vector_digest, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(snapshotId, wsId, tipVectorJson, tipVectorDigest, creator, now).run();

  // Final closed re-read before returning the frozen id.
  const third = await selectTipsForSnapshot(db, wsId, { paths, prefix });
  if (!third.ok) return third;
  if (!tipVectorsEqual(tipVector, third.tips)) {
    return {
      ok: false,
      error: "workspace_snapshot_race",
      workspace_id: wsId,
      workspace_snapshot_id: snapshotId,
      tip_vector_digest: tipVectorDigest,
      accepted_state_authority: false
    };
  }

  return {
    ok: true,
    workspace_id: wsId,
    workspace_snapshot_id: snapshotId,
    tip_vector: tipVector,
    tip_vector_digest: tipVectorDigest,
    created_by: creator,
    created_at: now,
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };
}

export async function getWorkspaceSnapshot(db, snapshot_id) {
  if (!isNonEmptyString(snapshot_id)) return null;
  return await db.prepare(
    `SELECT snapshot_id, workspace_id, tip_vector_json, tip_vector_digest, created_by, created_at
     FROM workspace_snapshots WHERE snapshot_id = ?`
  ).bind(String(snapshot_id).trim()).first() || null;
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
     VALUES (?, ?, ?, ?)`
  ).bind(wsId, creator, "owner", now).run();

  return {
    ok: true,
    workspace_id: wsId,
    name: name.trim(),
    created_by: creator,
    created_at: now,
    status: "active",
    github_bind: github_bind || null,
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

export async function getWorkspace(db, workspace_id) {
  let wsId;
  try { wsId = workspaceId(workspace_id); }
  catch (error) { return null; }
  return await db.prepare(
    `SELECT workspace_id, name, created_by, created_at, updated_at, status, github_bind_json
     FROM workspaces WHERE workspace_id = ?`
  ).bind(wsId).first() || null;
}

export async function listWorkspaceMembers(db, workspace_id) {
  const result = await db.prepare(
    `SELECT workspace_id, actor_id, role, created_at
     FROM workspace_members WHERE workspace_id = ?
     ORDER BY actor_id ASC`
  ).bind(workspace_id).all();
  return result?.results || [];
}

export async function listWorkspaceTips(db, workspace_id, prefix = null) {
  let sql = `SELECT workspace_id, path, revision_id, content_hash, updated_at
             FROM workspace_tips WHERE workspace_id = ?`;
  const binds = [workspace_id];
  if (prefix !== undefined && prefix !== null && prefix !== "") {
    const prefixResult = canonicalizeWorkspacePath(prefix);
    if (!prefixResult.ok) return prefixResult;
    sql += ` AND (path = ? OR path LIKE ?)`;
    binds.push(prefixResult.path, `${prefixResult.path}/%`);
  }
  sql += ` ORDER BY path ASC`;
  const result = await db.prepare(sql).bind(...binds).all();
  return { ok: true, tips: result?.results || [] };
}

export async function listWorkspacesForActor(db, actor_id, limit = 50) {
  const capped = clampInt(limit, 1, 100, 50);
  const result = await db.prepare(
    `SELECT w.workspace_id, w.name, w.created_by, w.created_at, w.updated_at, w.status,
            m.role AS membership_role
     FROM workspace_members m
     INNER JOIN workspaces w ON w.workspace_id = m.workspace_id
     WHERE m.actor_id = ?
     ORDER BY w.updated_at DESC, w.workspace_id ASC
     LIMIT ?`
  ).bind(actor_id, capped).all();
  return result?.results || [];
}

export async function getWorkspaceRevision(db, revision_id) {
  if (!isNonEmptyString(revision_id)) return null;
  return await db.prepare(
    `SELECT revision_id, workspace_id, path, parent_revision_id, content_hash, content_bytes, actor_id, created_at
     FROM workspace_revisions WHERE revision_id = ?`
  ).bind(String(revision_id).trim()).first() || null;
}

async function readBlobText(r2, contentHash) {
  const key = workspaceBlobKey(contentHash);
  const obj = await r2.get(key);
  if (!obj) return { ok: false, error: "workspace_blob_missing", content_hash: contentHash, raw_key: key };
  return { ok: true, content: await obj.text(), raw_key: key };
}

function lineDiff(beforeText, afterText) {
  const beforeLines = String(beforeText ?? "").split("\n");
  const afterLines = String(afterText ?? "").split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const hunks = [];
  for (let i = 0; i < max; i += 1) {
    const left = i < beforeLines.length ? beforeLines[i] : null;
    const right = i < afterLines.length ? afterLines[i] : null;
    if (left === right) {
      if (left !== null) hunks.push({ op: "equal", line: left, n: i + 1 });
      continue;
    }
    if (left !== null) hunks.push({ op: "remove", line: left, n: i + 1 });
    if (right !== null) hunks.push({ op: "add", line: right, n: i + 1 });
  }
  const unified = hunks
    .filter(h => h.op !== "equal")
    .map(h => `${h.op === "remove" ? "-" : "+"}${h.line}`)
    .join("\n");
  return {
    changed: Boolean(unified),
    unified,
    hunks: hunks.filter(h => h.op !== "equal").slice(0, 500)
  };
}

/**
 * Diff tip (or path content) against a prior revision. V1: UTF-8 text only.
 * When the workspace has an optional GitHub bind, resolve branch → immutable
 * commit SHA and return observed_commit_sha (transport only, not authority).
 */
export async function diffDraft(db, r2, {
  workspace_id,
  path,
  against_revision = null,
  github_bind = null,
  env = {},
  resolveGitHubCommit = null
} = {}) {
  let wsId;
  try { wsId = workspaceId(workspace_id); }
  catch (error) { return { ok: false, error: "invalid_workspace_diff", detail: String(error.message || error) }; }

  const pathResult = canonicalizeWorkspacePath(path);
  if (!pathResult.ok) return pathResult;
  const tip = await getWorkspaceTip(db, wsId, pathResult.path);
  if (!tip) return { ok: false, error: "workspace_path_not_found", path: pathResult.path };

  const tipBlob = await readBlobText(r2, tip.content_hash);
  if (!tipBlob.ok) return tipBlob;

  let baseRevisionId = against_revision === undefined || against_revision === null || against_revision === ""
    ? null
    : String(against_revision).trim();

  let baseRow = null;
  if (baseRevisionId) {
    baseRow = await getWorkspaceRevision(db, baseRevisionId);
    if (!baseRow || baseRow.workspace_id !== wsId || baseRow.path !== pathResult.path) {
      return { ok: false, error: "workspace_against_revision_not_found", against_revision: baseRevisionId };
    }
  } else {
    const tipRow = await getWorkspaceRevision(db, tip.revision_id);
    baseRevisionId = tipRow?.parent_revision_id || null;
    if (baseRevisionId) baseRow = await getWorkspaceRevision(db, baseRevisionId);
  }

  let beforeContent = "";
  let beforeHash = null;
  if (baseRow) {
    const baseBlob = await readBlobText(r2, baseRow.content_hash);
    if (!baseBlob.ok) return baseBlob;
    beforeContent = baseBlob.content;
    beforeHash = baseRow.content_hash;
  }

  const diff = lineDiff(beforeContent, tipBlob.content);

  let githubBindResult = null;
  let observedCommitSha = null;
  let requestedRef = null;
  if (github_bind) {
    const resolver = typeof resolveGitHubCommit === "function"
      ? resolveGitHubCommit
      : (owner, repo, ref) => resolveGitHubCommitSha(owner, repo, ref, env);
    const resolved = await resolver(github_bind.owner, github_bind.repo, github_bind.ref);
    if (!resolved?.ok && !resolved?.observed_commit_sha && !resolved?.sha) {
      return {
        ok: false,
        error: resolved?.error || "github_commit_resolution_failed",
        detail: resolved?.detail || null,
        requested_ref: github_bind.ref,
        github_bind: {
          owner: github_bind.owner,
          repo: github_bind.repo,
          ref: github_bind.ref,
          root_path: github_bind.root_path || null
        },
        accepted_state_authority: false
      };
    }
    observedCommitSha = (resolved.observed_commit_sha || resolved.sha || "").toLowerCase();
    requestedRef = resolved.requested_ref || github_bind.ref;
    if (!FULL_SHA_RE.test(observedCommitSha)) {
      return {
        ok: false,
        error: "github_commit_resolution_failed",
        detail: "immutable_commit_sha_required",
        requested_ref: requestedRef,
        accepted_state_authority: false
      };
    }
    githubBindResult = {
      owner: github_bind.owner,
      repo: github_bind.repo,
      requested_ref: requestedRef,
      observed_commit_sha: observedCommitSha,
      root_path: github_bind.root_path || null,
      transport_only: true
    };
  }

  return {
    ok: true,
    workspace_id: wsId,
    path: pathResult.path,
    tip: {
      revision_id: tip.revision_id,
      content_hash: tip.content_hash
    },
    against: baseRow
      ? { revision_id: baseRow.revision_id, content_hash: beforeHash, parent_revision_id: baseRow.parent_revision_id || null }
      : null,
    changed: tip.content_hash !== beforeHash,
    diff,
    github_bind: githubBindResult,
    observed_commit_sha: observedCommitSha,
    accepted_state_authority: false
  };
}

/**
 * Capability + membership gate for every workspace MCP mutation/read.
 * Fail closed. No mailbox/operator-token fallback.
 * Capability may narrow membership, never widen (re-checked against live role).
 */
export async function authorizeWorkspaceRequest(db, env, {
  workspace_capability,
  actor_id,
  workspace_id = null,
  requiredScopes = [],
  path = null,
  requireMembership = true
} = {}) {
  const verified = await verifyWorkspaceCapability(
    workspace_capability,
    {
      expectedActorId: actor_id,
      expectedWorkspaceId: workspace_id || undefined,
      requiredScopes,
      path
    },
    env
  );
  if (!verified.ok) return verified;

  if (!requireMembership) {
    return {
      ...verified,
      membership: null,
      accepted_state_authority: false
    };
  }

  const member = await getWorkspaceMember(db, verified.workspace_id, verified.principal_actor_id);
  if (!member) {
    return {
      ok: false,
      error: "workspace_membership_required",
      workspace_id: verified.workspace_id,
      actor_id: verified.principal_actor_id
    };
  }

  const roleScopes = new Set(scopesAllowedForRole(member.role));
  const capabilityExceeds = verified.scopes.filter(scope => !roleScopes.has(scope));
  if (capabilityExceeds.length) {
    return {
      ok: false,
      error: "workspace_capability_exceeds_membership",
      exceeded: capabilityExceeds,
      membership_role: member.role,
      role_scopes: [...roleScopes].sort()
    };
  }
  const missingVsRole = (Array.isArray(requiredScopes) ? requiredScopes : [])
    .filter(scope => !roleScopes.has(String(scope)));
  if (missingVsRole.length) {
    return {
      ok: false,
      error: "workspace_membership_scope_denied",
      missing: missingVsRole,
      membership_role: member.role,
      role_scopes: [...roleScopes].sort()
    };
  }

  return {
    ...verified,
    membership_role: member.role,
    membership: member,
    accepted_state_authority: false
  };
}

function workspaceEnvBindings(env) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  if (!env?.CAIRNSTONE_RAW) return { ok: false, error: "missing_r2_binding", binding: "CAIRNSTONE_RAW" };
  return { ok: true, db: env.CAIRNSTONE_DB, r2: env.CAIRNSTONE_RAW };
}

function requireActorField(body, field) {
  try { return { ok: true, value: actorId(body?.[field], field) }; }
  catch (error) { return { ok: false, error: "invalid_workspace_actor", detail: String(error.message || error), field }; }
}

export async function createWorkspaceFromBody(body = {}, env = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const bindNorm = normalizeGithubBind(body.github_bind);
  if (!bindNorm.ok) return bindNorm;

  const creator = requireActorField(body, "created_by");
  if (!creator.ok) return creator;
  if (!isNonEmptyString(body.workspace_id)) {
    return { ok: false, error: "workspace_id_required_for_create" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: creator.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["write_draft"],
    requireMembership: false
  });
  if (!auth.ok) return auth;
  if (auth.membership_role !== "owner") {
    return {
      ok: false,
      error: "workspace_create_requires_owner_capability",
      membership_role: auth.membership_role
    };
  }

  const existing = await getWorkspace(bindings.db, auth.workspace_id);
  if (existing) {
    return { ok: false, error: "workspace_already_exists", workspace_id: auth.workspace_id };
  }

  return createWorkspace(bindings.db, {
    workspace_id: auth.workspace_id,
    name: body.name,
    created_by: creator.value,
    github_bind: bindNorm.github_bind
  });
}

export async function listWorkspacesFromBody(body = {}, env = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    requiredScopes: ["ls"],
    requireMembership: true
  });
  if (!auth.ok) return auth;

  const workspaces = await listWorkspacesForActor(bindings.db, auth.principal_actor_id, body.limit);
  return {
    ok: true,
    actor_id: auth.principal_actor_id,
    workspaces,
    total: workspaces.length,
    capability_workspace_id: auth.workspace_id,
    accepted_state_authority: false
  };
}

export async function statWorkspaceFromBody(body = {}, env = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["ls"],
    requireMembership: true
  });
  if (!auth.ok) return auth;

  const workspace = await getWorkspace(bindings.db, auth.workspace_id);
  if (!workspace) return { ok: false, error: "workspace_not_found", workspace_id: auth.workspace_id };
  const members = await listWorkspaceMembers(bindings.db, auth.workspace_id);
  const tips = await listWorkspaceTips(bindings.db, auth.workspace_id);
  if (!tips.ok) return tips;
  const bindParsed = parseGithubBindJson(workspace.github_bind_json);
  if (!bindParsed.ok) return bindParsed;

  return {
    ok: true,
    workspace: {
      workspace_id: workspace.workspace_id,
      name: workspace.name,
      created_by: workspace.created_by,
      created_at: workspace.created_at,
      updated_at: workspace.updated_at,
      status: workspace.status,
      github_bind: bindParsed.github_bind
    },
    members,
    tips: tips.tips,
    tip_count: tips.tips.length,
    membership_role: auth.membership_role,
    accepted_state_authority: false
  };
}

export async function lsWorkspaceFromBody(body = {}, env = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["ls"],
    path: body.prefix || null,
    requireMembership: true
  });
  if (!auth.ok) return auth;

  const tips = await listWorkspaceTips(bindings.db, auth.workspace_id, body.prefix);
  if (!tips.ok) return tips;

  return {
    ok: true,
    workspace_id: auth.workspace_id,
    prefix: body.prefix || null,
    entries: tips.tips.map(tip => ({
      path: tip.path,
      revision_id: tip.revision_id,
      content_hash: tip.content_hash,
      updated_at: tip.updated_at
    })),
    total: tips.tips.length,
    accepted_state_authority: false
  };
}

export async function readWorkspaceFromBody(body = {}, env = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["read"],
    path: body.path,
    requireMembership: true
  });
  if (!auth.ok) return auth;

  return readDraft(bindings.db, bindings.r2, {
    workspace_id: auth.workspace_id,
    path: body.path
  });
}

export async function writeDraftFromBody(body = {}, env = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["write_draft"],
    path: body.path,
    requireMembership: true
  });
  if (!auth.ok) return auth;

  return writeDraft(bindings.db, bindings.r2, {
    workspace_id: auth.workspace_id,
    path: body.path,
    content: body.content,
    base_revision: body.base_revision === undefined ? null : body.base_revision,
    actor_id: auth.principal_actor_id
  });
}

export async function diffWorkspaceFromBody(body = {}, env = {}, deps = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }
  if (!isNonEmptyString(body.path)) {
    return { ok: false, error: "workspace_path_required_for_diff" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["diff"],
    path: body.path,
    requireMembership: true
  });
  if (!auth.ok) return auth;

  const workspace = await getWorkspace(bindings.db, auth.workspace_id);
  if (!workspace) return { ok: false, error: "workspace_not_found", workspace_id: auth.workspace_id };
  const bindParsed = parseGithubBindJson(workspace.github_bind_json);
  if (!bindParsed.ok) return bindParsed;

  return diffDraft(bindings.db, bindings.r2, {
    workspace_id: auth.workspace_id,
    path: body.path,
    against_revision: body.against_revision,
    github_bind: bindParsed.github_bind,
    env,
    resolveGitHubCommit: deps.resolveGitHubCommit || null
  });
}

/**
 * V7.7.5c: freeze immutable snapshot + emit proposal packet/Stone for review.
 * Requires propose-scoped capability. MUST NOT move chain_heads/path_heads.
 * Proposal references snapshot digest, never a moving tip.
 * Optional GitHub PR/commit pointers only after immutable commit identity exists.
 */
export async function proposeAcceptWorkspaceFromBody(body = {}, env = {}, deps = {}) {
  const bindings = workspaceEnvBindings(env);
  if (!bindings.ok) return bindings;
  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeWorkspaceRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["propose"],
    path: Array.isArray(body.paths) && body.paths[0] ? body.paths[0] : (body.prefix || null),
    requireMembership: true
  });
  if (!auth.ok) return auth;

  const workspace = await getWorkspace(bindings.db, auth.workspace_id);
  if (!workspace) return { ok: false, error: "workspace_not_found", workspace_id: auth.workspace_id };

  const freeze = await freezeWorkspaceSnapshot(bindings.db, {
    workspace_id: auth.workspace_id,
    created_by: auth.principal_actor_id,
    paths: Array.isArray(body.paths) ? body.paths : null,
    prefix: body.prefix || null
  });
  if (!freeze.ok) return freeze;

  const bindParsed = parseGithubBindJson(workspace.github_bind_json);
  if (!bindParsed.ok) return bindParsed;

  let githubBindObserved = null;
  let observedCommitSha = null;
  if (bindParsed.github_bind) {
    const resolver = typeof deps.resolveGitHubCommit === "function"
      ? deps.resolveGitHubCommit
      : (owner, repo, ref) => resolveGitHubCommitSha(owner, repo, ref, env);
    const resolved = await resolver(
      bindParsed.github_bind.owner,
      bindParsed.github_bind.repo,
      bindParsed.github_bind.ref
    );
    observedCommitSha = (resolved?.observed_commit_sha || resolved?.sha || "").toLowerCase();
    if (!resolved || (!resolved.ok && !FULL_SHA_RE.test(observedCommitSha)) || !FULL_SHA_RE.test(observedCommitSha)) {
      return {
        ok: false,
        error: resolved?.error || "github_commit_resolution_failed",
        detail: resolved?.detail || "immutable_commit_sha_required_before_propose_github_pointer",
        workspace_id: auth.workspace_id,
        workspace_snapshot_id: freeze.workspace_snapshot_id,
        tip_vector_digest: freeze.tip_vector_digest,
        accepted_state_authority: false
      };
    }
    githubBindObserved = {
      owner: bindParsed.github_bind.owner,
      repo: bindParsed.github_bind.repo,
      requested_ref: resolved.requested_ref || bindParsed.github_bind.ref,
      observed_commit_sha: observedCommitSha,
      root_path: bindParsed.github_bind.root_path || null,
      transport_only: true
    };
  }

  // PR/commit pointers are allowed only after immutable commit identity exists.
  let githubPr = null;
  if (body.github_pr !== undefined && body.github_pr !== null) {
    if (!observedCommitSha) {
      return {
        ok: false,
        error: "workspace_github_pr_requires_immutable_commit",
        message: "propose_accept may point at a PR/commit only after GitHub bind resolves to an immutable commit SHA.",
        accepted_state_authority: false
      };
    }
    if (!isObject(body.github_pr)) {
      return { ok: false, error: "invalid_workspace_github_pr" };
    }
    const prNumber = Number(body.github_pr.number || body.github_pr.pr_number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { ok: false, error: "invalid_workspace_github_pr", detail: "number" };
    }
    githubPr = {
      number: prNumber,
      url: typeof body.github_pr.url === "string" ? body.github_pr.url : null,
      observed_commit_sha: observedCommitSha
    };
  }

  const createdAt = new Date().toISOString();
  const proposalPacket = {
    schema: WORKSPACE_PROPOSAL_SCHEMA,
    workspace_id: auth.workspace_id,
    workspace_snapshot_id: freeze.workspace_snapshot_id,
    tip_vector_digest: freeze.tip_vector_digest,
    tip_vector: freeze.tip_vector,
    proposed_by: auth.principal_actor_id,
    created_at: createdAt,
    title: isNonEmptyString(body.title) ? String(body.title).trim() : `Workspace proposal ${freeze.workspace_snapshot_id.slice(0, 16)}`,
    note: isNonEmptyString(body.note) ? String(body.note).trim() : null,
    github_bind: githubBindObserved,
    github_pr: githubPr,
    observed_commit_sha: observedCommitSha,
    accepted_state_authority: false,
    propose_implies_accepted_state: false,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };

  let stoneHash = null;
  let stonePath = isNonEmptyString(body.path)
    ? String(body.path).trim()
    : `proposals/workspace/${auth.workspace_id.replace(/^ws:/, "")}/${freeze.workspace_snapshot_id.slice(0, 16)}.json`;
  const pathCheck = canonicalizeWorkspacePath(stonePath);
  if (!pathCheck.ok) {
    // Proposal stone path is vault-side metadata; allow proposals/ prefix as relative.
    if (!stonePath.startsWith("proposals/")) return pathCheck;
  }

  if (typeof deps.createStone === "function") {
    const stoneResult = await deps.createStone({
      title: proposalPacket.title,
      author: auth.principal_actor_id,
      content: stableJson(proposalPacket),
      path: stonePath,
      chain: isNonEmptyString(body.chain) ? String(body.chain).trim() : null,
      repo: githubBindObserved ? `${githubBindObserved.owner}/${githubBindObserved.repo}` : null,
      commit: observedCommitSha,
      set_as_head: false,
      related: Array.isArray(body.related) ? body.related : [],
      metadata: {
        kind: "workspace_proposal",
        schema: WORKSPACE_PROPOSAL_SCHEMA,
        workspace_id: auth.workspace_id,
        workspace_snapshot_id: freeze.workspace_snapshot_id,
        tip_vector_digest: freeze.tip_vector_digest,
        observed_commit_sha: observedCommitSha,
        accepted_state_authority: false,
        slice: "V7.7.5c"
      }
    });
    if (!stoneResult?.ok) {
      return {
        ok: false,
        error: stoneResult?.error || "workspace_proposal_stone_failed",
        detail: stoneResult || null,
        workspace_snapshot_id: freeze.workspace_snapshot_id,
        tip_vector_digest: freeze.tip_vector_digest,
        proposal_packet: proposalPacket,
        accepted_state_authority: false
      };
    }
    stoneHash = stoneResult.stone_hash || stoneResult.hash || null;
  }

  return {
    ok: true,
    workspace_id: auth.workspace_id,
    workspace_snapshot_id: freeze.workspace_snapshot_id,
    tip_vector_digest: freeze.tip_vector_digest,
    tip_vector: freeze.tip_vector,
    proposal_packet: proposalPacket,
    proposal_stone_hash: stoneHash,
    observed_commit_sha: observedCommitSha,
    github_bind: githubBindObserved,
    accepted_state_authority: false,
    stones_written: stoneHash ? 1 : 0,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };
}

export const WORKSPACE_CREATE_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.create,
  description: "V7.7.5c: create a shared agent workspace (draft plane). Requires signed workspace_capability with owner + write_draft for the new workspace_id. Optional github_bind is transport/backing only. Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["name", "created_by", "workspace_id", "workspace_capability"],
    properties: {
      name: { type: "string" },
      created_by: { type: "string" },
      workspace_id: { type: "string" },
      workspace_capability: { type: "string" },
      github_bind: {
        type: "object",
        required: ["owner", "repo"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          ref: { type: "string" },
          root_path: { type: "string" }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_LIST_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.list,
  description: "V7.7.5: list workspaces visible to the capability principal (membership + signed workspace_capability). Never automatic for models.",
  inputSchema: {
    type: "object",
    required: ["actor_id", "workspace_capability"],
    properties: {
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_STAT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.stat,
  description: "V7.7.5: workspace metadata, members, draft tips, and optional github_bind. Requires membership + scoped workspace_capability (ls).",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "actor_id", "workspace_capability"],
    properties: {
      workspace_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_LS_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.ls,
  description: "V7.7.5: list draft paths under an optional prefix. Requires membership + scoped workspace_capability (ls).",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "actor_id", "workspace_capability"],
    properties: {
      workspace_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      prefix: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_READ_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.read,
  description: "V7.7.5: read one UTF-8 draft path + content hash/revision. Requires membership + scoped workspace_capability (read). Bounded text only.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "path", "actor_id", "workspace_capability"],
    properties: {
      workspace_id: { type: "string" },
      path: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_WRITE_DRAFT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.write_draft,
  description: "V7.7.5: CAS write_draft mutation. base_revision null only on create; stale tip → workspace_conflict. write_draft scope does not imply propose. Never automatic-read; never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "path", "content", "actor_id", "workspace_capability"],
    properties: {
      workspace_id: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
      base_revision: { type: ["string", "null"] },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_DIFF_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.diff,
  description: "V7.7.5c: diff one draft path vs prior/against_revision (UTF-8 text). Optional GitHub bind resolves branch → immutable observed_commit_sha. Requires membership + scoped workspace_capability (diff).",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "path", "actor_id", "workspace_capability"],
    properties: {
      workspace_id: { type: "string" },
      path: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      against_revision: { type: "string" }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_PROPOSE_ACCEPT_TOOL_DEFINITION = Object.freeze({
  name: WORKSPACE_BROKER_TOOL_IDS.propose_accept,
  description: "V7.7.5c: freeze immutable workspace_snapshot over selected tips, emit proposal packet/Stone for review. Requires propose scope. Never moves chain_heads/path_heads; accepted_state_authority always false. write_draft does not imply propose.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "actor_id", "workspace_capability"],
    properties: {
      workspace_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      paths: { type: "array", items: { type: "string" }, maxItems: 200 },
      prefix: { type: "string" },
      title: { type: "string" },
      note: { type: "string" },
      path: { type: "string" },
      chain: { type: "string" },
      github_pr: {
        type: "object",
        properties: {
          number: { type: "number" },
          url: { type: "string" }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
});

export const WORKSPACE_MCP_TOOL_DEFINITIONS = Object.freeze([
  WORKSPACE_CREATE_TOOL_DEFINITION,
  WORKSPACE_LIST_TOOL_DEFINITION,
  WORKSPACE_STAT_TOOL_DEFINITION,
  WORKSPACE_LS_TOOL_DEFINITION,
  WORKSPACE_READ_TOOL_DEFINITION,
  WORKSPACE_WRITE_DRAFT_TOOL_DEFINITION,
  WORKSPACE_DIFF_TOOL_DEFINITION,
  WORKSPACE_PROPOSE_ACCEPT_TOOL_DEFINITION
]);
