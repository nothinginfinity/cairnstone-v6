// V7.7.7a Durable Code Session + V7.7.7b Code Checkpoints / task ledger.
//
// Operational state only. Reuses Shared Agent Workspace (bound workspace_id)
// and V7.7.6 workspace_capability / membership — no second ticket format,
// actor registry, or model-self-service authority path.
//
// NEVER moves chain_heads / path_heads. accepted_state_authority always false.
// Never infer currentness from timestamps when session_revision / tip digest /
// checkpoint pointers exist. Checkpoints are append-only operational artifacts
// and are never auto-promoted into canonical project-memory HEAD.

import { sha256Text, stableJson } from "./agent-bootstrap.js";
import {
  authorizeWorkspaceRequest,
  buildTipVector,
  computeTipVectorDigest,
  getWorkspace,
  listWorkspaceTips,
  tipVectorsEqual
} from "./workspace.js";

export const CODE_SESSION_SCHEMA = "cairnstone-code-session-v1";
export const CODE_SESSION_CONTEXT_SCHEMA = "cairnstone-code-session-context-v1";
export const CODE_CHECKPOINT_SCHEMA = "cairnstone-code-checkpoint-v1";

export const CODE_SESSION_LIFECYCLES = Object.freeze([
  "active",
  "paused",
  "blocked",
  "proposed",
  "closed",
  "superseded"
]);

const LIFECYCLE_SET = new Set(CODE_SESSION_LIFECYCLES);

export const CODE_TASK_STATES = Object.freeze([
  "queued",
  "claimed",
  "active",
  "blocked",
  "review",
  "done",
  "abandoned"
]);

const CODE_TASK_STATE_SET = new Set(CODE_TASK_STATES);

/** Legal directed edges for the durable task ledger state machine. */
export const CODE_TASK_TRANSITIONS = Object.freeze({
  queued: Object.freeze(["claimed", "active", "abandoned"]),
  claimed: Object.freeze(["active", "queued", "blocked", "abandoned"]),
  active: Object.freeze(["blocked", "review", "done", "abandoned", "claimed"]),
  blocked: Object.freeze(["active", "queued", "review", "abandoned"]),
  review: Object.freeze(["done", "active", "blocked", "abandoned"]),
  done: Object.freeze(["queued"]),
  abandoned: Object.freeze(["queued"])
});

export const CODE_CHECKPOINT_BOUNDARIES = Object.freeze([
  "handoff",
  "pause",
  "task_completion",
  "conflict_rebase",
  "test_gate",
  "proposal",
  "user_requested"
]);

const CODE_CHECKPOINT_BOUNDARY_SET = new Set(CODE_CHECKPOINT_BOUNDARIES);

export const CODE_SESSION_BROKER_TOOL_IDS = Object.freeze({
  create: "cairnstone_code_session_create",
  get: "cairnstone_code_session_get",
  pause: "cairnstone_code_session_pause",
  resume: "cairnstone_code_session_resume",
  compile_context: "cairnstone_code_session_compile_context",
  checkpoint_create: "cairnstone_code_checkpoint_create",
  checkpoint_get: "cairnstone_code_checkpoint_get",
  checkpoint_list: "cairnstone_code_checkpoint_list",
  task_transition: "cairnstone_code_session_task_transition"
});

export const CODE_SESSION_MUTATION_TOOL_IDS = Object.freeze([
  CODE_SESSION_BROKER_TOOL_IDS.create,
  CODE_SESSION_BROKER_TOOL_IDS.pause,
  CODE_SESSION_BROKER_TOOL_IDS.resume,
  CODE_SESSION_BROKER_TOOL_IDS.checkpoint_create,
  CODE_SESSION_BROKER_TOOL_IDS.task_transition
]);

export const CODE_SESSION_READ_TOOL_IDS = Object.freeze([
  CODE_SESSION_BROKER_TOOL_IDS.get,
  CODE_SESSION_BROKER_TOOL_IDS.compile_context,
  CODE_SESSION_BROKER_TOOL_IDS.checkpoint_get,
  CODE_SESSION_BROKER_TOOL_IDS.checkpoint_list
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const WORKSPACE_ID_RE = /^ws:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CODE_SESSION_ID_RE = /^cs:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CHECKPOINT_ID_RE = /^cp:[a-z0-9][a-z0-9._-]{0,127}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_KEY_RE = /^(workspace_capability|mailbox_capability|capability|api[_-]?key|secret|bearer|token|password|credential|private[_-]?key|authorization)$/i;
const MAX_CHANGED_PATHS = 500;
const MAX_CHECKPOINT_LIST = 100;
const DEFAULT_CHECKPOINT_LIST = 20;
const MAX_ARTIFACT_REFS = 100;
const MAX_LEASE_STUBS = 50;
const REDACTED_SECRET = "[REDACTED]";

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

function codeSessionId(value, field = "code_session_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!CODE_SESSION_ID_RE.test(text)) throw new Error(`Invalid code session id for ${field}`);
  return text;
}

function parseJsonField(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    synthetic_global_head: false
  };
}

export function normalizeSourceRepos(input) {
  const list = Array.isArray(input) ? input : [];
  const repos = [...new Set(list.map(value => String(value || "").trim()).filter(Boolean))].sort();
  if (!repos.length) return { ok: false, error: "code_session_source_repos_required" };
  if (repos.some(repo => !REPO_RE.test(repo))) {
    return { ok: false, error: "invalid_code_session_source_repo", allowed_shape: "owner/repo" };
  }
  return { ok: true, source_repos: repos };
}

export function normalizeBaseCommits(input, sourceRepos = []) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) return { ok: false, error: "code_session_base_commits_required" };
  const commits = [];
  for (const entry of list) {
    if (!isObject(entry)) return { ok: false, error: "invalid_code_session_base_commit" };
    const repo = String(entry.repo || "").trim();
    const commitSha = String(entry.commit_sha || entry.sha || "").trim().toLowerCase();
    if (!REPO_RE.test(repo) || !FULL_SHA_RE.test(commitSha)) {
      return {
        ok: false,
        error: "invalid_code_session_base_commit",
        detail: "repo owner/repo + immutable 40-char commit_sha required"
      };
    }
    commits.push({
      repo,
      commit_sha: commitSha,
      authority_class: "immutable_git_base",
      accepted_state_authority: false
    });
  }
  commits.sort((a, b) => a.repo.localeCompare(b.repo) || a.commit_sha.localeCompare(b.commit_sha));
  const repoSet = new Set(sourceRepos);
  for (const commit of commits) {
    if (repoSet.size && !repoSet.has(commit.repo)) {
      return {
        ok: false,
        error: "code_session_base_commit_repo_mismatch",
        repo: commit.repo,
        source_repos: sourceRepos
      };
    }
  }
  return { ok: true, base_commits: commits };
}

/**
 * Optional working branch/PR transport refs. Never accepted-state authority.
 * Mutable refs are recorded as transport metadata only; base commits remain
 * the immutable identity for source provenance.
 */
export function normalizeWorkingTransport(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, working_transport: null };
  }
  if (!isObject(input)) return { ok: false, error: "invalid_code_session_working_transport" };
  const transport = {
    schema: "cairnstone-code-session-working-transport-v1",
    accepted_state_authority: false,
    transport_only: true
  };
  if (isNonEmptyString(input.branch)) transport.branch = String(input.branch).trim();
  if (isNonEmptyString(input.ref)) transport.ref = String(input.ref).trim();
  if (input.pr !== undefined && input.pr !== null) {
    if (!isObject(input.pr)) return { ok: false, error: "invalid_code_session_working_transport_pr" };
    const number = Number(input.pr.number || input.pr.pr_number);
    if (!Number.isInteger(number) || number <= 0) {
      return { ok: false, error: "invalid_code_session_working_transport_pr", detail: "number" };
    }
    transport.pr = {
      number,
      url: isNonEmptyString(input.pr.url) ? String(input.pr.url).trim() : null
    };
  }
  if (isNonEmptyString(input.observed_commit_sha)) {
    const sha = String(input.observed_commit_sha).trim().toLowerCase();
    if (!FULL_SHA_RE.test(sha)) {
      return { ok: false, error: "invalid_code_session_working_transport_observed_commit" };
    }
    transport.observed_commit_sha = sha;
  }
  if (!transport.branch && !transport.ref && !transport.pr) {
    return { ok: false, error: "invalid_code_session_working_transport", detail: "empty" };
  }
  return { ok: true, working_transport: transport };
}

export function isLegalTaskTransition(fromState, toState) {
  const from = String(fromState || "").trim();
  const to = String(toState || "").trim();
  if (!CODE_TASK_STATE_SET.has(to)) return false;
  if (from === "" || from === null || from === undefined) {
    // Seed / first observation: only allow entering queued (or direct create states).
    return CODE_TASK_STATE_SET.has(to);
  }
  if (!CODE_TASK_STATE_SET.has(from)) return false;
  return (CODE_TASK_TRANSITIONS[from] || []).includes(to);
}

export function normalizeTaskLedger(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, task_ledger: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_code_session_task_ledger" };
  if (input.length > 200) return { ok: false, error: "code_session_task_ledger_too_large", max: 200 };
  const ledger = [];
  for (const item of input) {
    if (!isObject(item)) return { ok: false, error: "invalid_code_session_task_ledger_entry" };
    const taskId = isNonEmptyString(item.task_id) ? String(item.task_id).trim() : null;
    const title = isNonEmptyString(item.title) ? String(item.title).trim() : null;
    if (!taskId || !title) {
      return { ok: false, error: "invalid_code_session_task_ledger_entry", detail: "task_id and title required" };
    }
    const state = isNonEmptyString(item.state) ? String(item.state).trim() : "queued";
    if (!CODE_TASK_STATE_SET.has(state)) {
      return {
        ok: false,
        error: "invalid_code_session_task_state",
        state,
        allowed: [...CODE_TASK_STATES]
      };
    }
    let author = null;
    if (isNonEmptyString(item.author_id)) {
      try { author = actorId(item.author_id, "author_id"); }
      catch (error) {
        return { ok: false, error: "invalid_code_session_task_author", detail: String(error.message || error) };
      }
    }
    let actor = null;
    if (isNonEmptyString(item.actor_id)) {
      try { actor = actorId(item.actor_id, "actor_id"); }
      catch (error) {
        return { ok: false, error: "invalid_code_session_task_actor", detail: String(error.message || error) };
      }
    }
    ledger.push({
      task_id: taskId.slice(0, 128),
      title: title.slice(0, 500),
      state,
      actor_id: actor,
      author_id: author || actor,
      notes: isNonEmptyString(item.notes) ? String(item.notes).trim().slice(0, 2000) : null,
      updated_at: isNonEmptyString(item.updated_at) ? String(item.updated_at).trim() : null
    });
  }
  return { ok: true, task_ledger: ledger };
}

/**
 * Recursively scrub secret-bearing keys from checkpoint / context payloads.
 * Never persists raw capability bearers, tokens, or credentials.
 */
export function scrubSecretsDeep(value, depth = 0) {
  if (depth > 12) return REDACTED_SECRET;
  if (Array.isArray(value)) return value.map(item => scrubSecretsDeep(item, depth + 1));
  if (!isObject(value)) {
    if (typeof value === "string" && /workspace_capability|bearer\s+[a-z0-9._-]{16,}/i.test(value)) {
      return REDACTED_SECRET;
    }
    return value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) || /workspace_capability|mailbox_capability/i.test(key)) {
      out[key] = REDACTED_SECRET;
      continue;
    }
    out[key] = scrubSecretsDeep(entry, depth + 1);
  }
  return out;
}

function checkpointId(value, field = "checkpoint_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!CHECKPOINT_ID_RE.test(text)) throw new Error(`Invalid checkpoint id for ${field}`);
  return text;
}

function tipEntryKey(entry) {
  return `${entry.path}\0${entry.revision_id || ""}\0${entry.content_hash || ""}`;
}

export function diffTipVectors(previousTips, currentTips) {
  const prev = Array.isArray(previousTips) ? previousTips : [];
  const curr = Array.isArray(currentTips) ? currentTips : [];
  const prevByPath = new Map(prev.map(tip => [tip.path, tip]));
  const currByPath = new Map(curr.map(tip => [tip.path, tip]));
  const changed = [];
  for (const [path, tip] of currByPath) {
    const prior = prevByPath.get(path);
    if (!prior || tipEntryKey(prior) !== tipEntryKey(tip)) {
      changed.push({
        path,
        revision_id: tip.revision_id || null,
        content_hash: tip.content_hash || null,
        change: prior ? "modified" : "added"
      });
    }
  }
  for (const [path, tip] of prevByPath) {
    if (!currByPath.has(path)) {
      changed.push({
        path,
        revision_id: tip.revision_id || null,
        content_hash: tip.content_hash || null,
        change: "removed"
      });
    }
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));
  return changed.slice(0, MAX_CHANGED_PATHS);
}

export function normalizeUnresolvedIssues(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, unresolved_issues: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_code_session_unresolved_issues" };
  if (input.length > 200) return { ok: false, error: "code_session_unresolved_issues_too_large", max: 200 };
  const issues = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      issues.push({ issue_id: null, summary: item.trim().slice(0, 500) });
      continue;
    }
    if (!isObject(item) || !isNonEmptyString(item.summary)) {
      return { ok: false, error: "invalid_code_session_unresolved_issue" };
    }
    issues.push({
      issue_id: isNonEmptyString(item.issue_id) ? String(item.issue_id).trim().slice(0, 128) : null,
      summary: String(item.summary).trim().slice(0, 500),
      actor_id: isNonEmptyString(item.actor_id) ? String(item.actor_id).trim() : null
    });
  }
  return { ok: true, unresolved_issues: issues };
}

export function normalizeActors(input, createdBy) {
  const list = Array.isArray(input) ? [...input] : [];
  if (createdBy && !list.some(entry => isObject(entry) && entry.actor_id === createdBy)) {
    list.unshift({
      actor_id: createdBy,
      role: "owner",
      last_checkpoint_id: null
    });
  }
  if (list.length > 100) return { ok: false, error: "code_session_actors_too_large", max: 100 };
  const actors = [];
  const seen = new Set();
  for (const entry of list) {
    if (!isObject(entry)) return { ok: false, error: "invalid_code_session_actor" };
    let id;
    try { id = actorId(entry.actor_id, "actor_id"); }
    catch (error) {
      return { ok: false, error: "invalid_code_session_actor", detail: String(error.message || error) };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    actors.push({
      actor_id: id,
      role: isNonEmptyString(entry.role) ? String(entry.role).trim().slice(0, 64) : "participant",
      last_checkpoint_id: isNonEmptyString(entry.last_checkpoint_id)
        ? String(entry.last_checkpoint_id).trim()
        : null,
      last_session_revision: Number.isInteger(entry.last_session_revision)
        ? entry.last_session_revision
        : null
    });
  }
  actors.sort((a, b) => a.actor_id.localeCompare(b.actor_id));
  return { ok: true, actors };
}

export function normalizeReceiptRefs(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, latest_execution_receipt_refs: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_code_session_execution_receipt_refs" };
  if (input.length > 100) return { ok: false, error: "code_session_execution_receipt_refs_too_large", max: 100 };
  const refs = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      refs.push({ ref: item.trim().slice(0, 256), kind: "receipt" });
      continue;
    }
    if (!isObject(item) || !isNonEmptyString(item.ref)) {
      return { ok: false, error: "invalid_code_session_execution_receipt_ref" };
    }
    refs.push({
      ref: String(item.ref).trim().slice(0, 256),
      kind: isNonEmptyString(item.kind) ? String(item.kind).trim().slice(0, 64) : "receipt",
      status: isNonEmptyString(item.status) ? String(item.status).trim().slice(0, 64) : null
    });
  }
  return { ok: true, latest_execution_receipt_refs: refs };
}

export function rowToCodeSessionRecord(row) {
  if (!row) return null;
  return {
    schema: CODE_SESSION_SCHEMA,
    code_session_id: row.code_session_id,
    workspace_id: row.workspace_id,
    project_chain: row.project_chain || null,
    scope: parseJsonField(row.scope_json, null),
    source_repos: parseJsonField(row.source_repos_json, []),
    base_commits: parseJsonField(row.base_commits_json, []),
    working_transport: parseJsonField(row.working_transport_json, null),
    tip_vector: parseJsonField(row.tip_vector_json, null),
    tip_vector_digest: row.tip_vector_digest || null,
    workspace_snapshot_id: row.workspace_snapshot_id || null,
    task_ledger: parseJsonField(row.task_ledger_json, []),
    unresolved_issues: parseJsonField(row.unresolved_issues_json, []),
    actors: parseJsonField(row.actors_json, []),
    environment_manifest_id: row.environment_manifest_id || null,
    latest_execution_receipt_refs: parseJsonField(row.latest_execution_receipt_refs_json, []),
    latest_checkpoint_id: row.latest_checkpoint_id || null,
    checkpoint_tip_vector_digest: row.checkpoint_tip_vector_digest || null,
    capability_policy_profile_id: row.capability_policy_profile_id || null,
    lifecycle: row.lifecycle,
    session_revision: Number(row.session_revision) || 1,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...authorityClosedFields()
  };
}

export async function getCodeSession(db, code_session_id) {
  let id;
  try { id = codeSessionId(code_session_id); }
  catch { return null; }
  const row = await db.prepare(
    `SELECT code_session_id, workspace_id, project_chain, scope_json, source_repos_json,
            base_commits_json, working_transport_json, tip_vector_json, tip_vector_digest,
            workspace_snapshot_id, task_ledger_json, unresolved_issues_json, actors_json,
            environment_manifest_id, latest_execution_receipt_refs_json, latest_checkpoint_id,
            checkpoint_tip_vector_digest, capability_policy_profile_id, lifecycle,
            session_revision, created_by, created_at, updated_at
     FROM code_sessions WHERE code_session_id = ?`
  ).bind(id).first();
  return rowToCodeSessionRecord(row);
}

export async function getCodeCheckpoint(db, checkpoint_id) {
  let id;
  try { id = checkpointId(checkpoint_id); }
  catch { return null; }
  const row = await db.prepare(
    `SELECT checkpoint_id, code_session_id, workspace_id, actor_id, boundary,
            session_revision, tip_vector_json, tip_vector_digest, workspace_snapshot_id,
            payload_json, payload_digest, created_at
     FROM code_checkpoints WHERE checkpoint_id = ?`
  ).bind(id).first();
  return rowToCodeCheckpointRecord(row);
}

export function rowToCodeCheckpointRecord(row) {
  if (!row) return null;
  const payload = scrubSecretsDeep(parseJsonField(row.payload_json, {}));
  return {
    schema: CODE_CHECKPOINT_SCHEMA,
    checkpoint_id: row.checkpoint_id,
    code_session_id: row.code_session_id,
    workspace_id: row.workspace_id,
    actor_id: row.actor_id,
    boundary: row.boundary,
    session_revision: Number(row.session_revision) || null,
    tip_vector: parseJsonField(row.tip_vector_json, []),
    tip_vector_digest: row.tip_vector_digest || null,
    workspace_snapshot_id: row.workspace_snapshot_id || null,
    payload,
    payload_digest: row.payload_digest || null,
    created_at: row.created_at,
    ...authorityClosedFields()
  };
}

export async function listCodeCheckpoints(db, {
  code_session_id,
  limit = DEFAULT_CHECKPOINT_LIST
} = {}) {
  let sessionId;
  try { sessionId = codeSessionId(code_session_id); }
  catch (error) {
    return { ok: false, error: "invalid_code_session_id", detail: String(error.message || error) };
  }
  const bounded = Math.min(Math.max(Number(limit) || DEFAULT_CHECKPOINT_LIST, 1), MAX_CHECKPOINT_LIST);
  const rows = await db.prepare(
    `SELECT checkpoint_id, code_session_id, workspace_id, actor_id, boundary,
            session_revision, tip_vector_json, tip_vector_digest, workspace_snapshot_id,
            payload_json, payload_digest, created_at
     FROM code_checkpoints
     WHERE code_session_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(sessionId, bounded).all();
  const checkpoints = (rows?.results || []).map(rowToCodeCheckpointRecord);
  return {
    ok: true,
    code_session_id: sessionId,
    count: checkpoints.length,
    limit: bounded,
    checkpoints,
    ...authorityClosedFields()
  };
}

function normalizeChangedPathsInput(input, tipVector) {
  if (input === undefined || input === null || input === "") {
    return {
      ok: true,
      changed_paths: (Array.isArray(tipVector) ? tipVector : []).map(tip => ({
        path: tip.path,
        revision_id: tip.revision_id || null,
        content_hash: tip.content_hash || null,
        change: "present"
      })).slice(0, MAX_CHANGED_PATHS)
    };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_code_checkpoint_changed_paths" };
  if (input.length > MAX_CHANGED_PATHS) {
    return { ok: false, error: "code_checkpoint_changed_paths_too_large", max: MAX_CHANGED_PATHS };
  }
  const paths = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      paths.push({
        path: item.trim().slice(0, 512),
        revision_id: null,
        content_hash: null,
        change: "present"
      });
      continue;
    }
    if (!isObject(item) || !isNonEmptyString(item.path)) {
      return { ok: false, error: "invalid_code_checkpoint_changed_path" };
    }
    paths.push({
      path: String(item.path).trim().slice(0, 512),
      revision_id: isNonEmptyString(item.revision_id) ? String(item.revision_id).trim() : null,
      content_hash: isNonEmptyString(item.content_hash) ? String(item.content_hash).trim() : null,
      change: isNonEmptyString(item.change) ? String(item.change).trim().slice(0, 32) : "present"
    });
  }
  return { ok: true, changed_paths: paths };
}

function normalizeArtifactRefs(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, artifact_refs: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_code_checkpoint_artifact_refs" };
  if (input.length > MAX_ARTIFACT_REFS) {
    return { ok: false, error: "code_checkpoint_artifact_refs_too_large", max: MAX_ARTIFACT_REFS };
  }
  const refs = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      refs.push({ ref: item.trim().slice(0, 256), kind: "artifact" });
      continue;
    }
    if (!isObject(item) || !isNonEmptyString(item.ref)) {
      return { ok: false, error: "invalid_code_checkpoint_artifact_ref" };
    }
    refs.push({
      ref: String(item.ref).trim().slice(0, 256),
      kind: isNonEmptyString(item.kind) ? String(item.kind).trim().slice(0, 64) : "artifact"
    });
  }
  return { ok: true, artifact_refs: refs };
}

function normalizeLeaseStubs(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, active_task_leases: [], known_concurrent_actors: [] };
  }
  if (!isObject(input)) return { ok: false, error: "invalid_code_checkpoint_lease_stubs" };
  const leases = Array.isArray(input.active_task_leases) ? input.active_task_leases : [];
  const actors = Array.isArray(input.known_concurrent_actors) ? input.known_concurrent_actors : [];
  if (leases.length > MAX_LEASE_STUBS || actors.length > MAX_LEASE_STUBS) {
    return { ok: false, error: "code_checkpoint_lease_stubs_too_large", max: MAX_LEASE_STUBS };
  }
  // 7.7.7c will fill these; 7.7.7b stores empty-capable stubs only.
  return {
    ok: true,
    active_task_leases: leases.slice(0, MAX_LEASE_STUBS).map(entry => scrubSecretsDeep(
      isObject(entry) ? entry : { stub: String(entry).slice(0, 128) }
    )),
    known_concurrent_actors: actors.slice(0, MAX_LEASE_STUBS).map(entry => {
      if (isNonEmptyString(entry)) return { actor_id: String(entry).trim() };
      if (isObject(entry) && isNonEmptyString(entry.actor_id)) {
        return scrubSecretsDeep({
          actor_id: String(entry.actor_id).trim(),
          role: isNonEmptyString(entry.role) ? String(entry.role).trim().slice(0, 64) : null
        });
      }
      return scrubSecretsDeep(entry);
    })
  };
}

/**
 * Build immutable cairnstone-code-checkpoint-v1 payload body (no checkpoint_id).
 * Content-addressable id is derived from this body.
 */
export async function buildCodeCheckpointPayload({
  code_session_id,
  actor_id,
  boundary,
  session,
  tip_vector,
  tip_vector_digest,
  changed_paths,
  current_task = null,
  completed_work = [],
  next_action = null,
  blockers = [],
  test_build_execution_receipts = [],
  artifact_refs = [],
  active_task_leases = [],
  known_concurrent_actors = [],
  safe_to_continue = true,
  known_caveats = [],
  workspace_snapshot_id = null,
  note = null,
  observed_commits = null
} = {}) {
  const baseCommits = Array.isArray(session?.base_commits) ? session.base_commits : [];
  const observed = Array.isArray(observed_commits) && observed_commits.length
    ? observed_commits
    : baseCommits.map(entry => ({
      repo: entry.repo,
      commit_sha: entry.commit_sha,
      authority_class: "immutable_git_base"
    }));

  const body = scrubSecretsDeep({
    schema: CODE_CHECKPOINT_SCHEMA,
    code_session_id,
    actor_id,
    boundary,
    session_revision: session.session_revision,
    lifecycle: session.lifecycle,
    repo: {
      source_repos: session.source_repos,
      base_commits: baseCommits,
      observed_commits: observed,
      working_transport: session.working_transport
    },
    workspace: {
      workspace_id: session.workspace_id,
      tip_vector,
      tip_vector_digest,
      workspace_snapshot_id: workspace_snapshot_id || session.workspace_snapshot_id || null
    },
    changed_paths,
    task: {
      current_task: current_task || (session.task_ledger || []).find(task =>
        ["queued", "claimed", "active", "blocked", "review"].includes(task.state)
      ) || null,
      task_ledger: session.task_ledger || [],
      completed_work: Array.isArray(completed_work) ? completed_work.slice(0, 100) : [],
      next_action: isNonEmptyString(next_action) ? String(next_action).trim().slice(0, 1000) : null,
      blockers: Array.isArray(blockers) ? blockers.slice(0, 100) : (session.unresolved_issues || [])
    },
    test_build_execution_receipts: Array.isArray(test_build_execution_receipts)
      ? test_build_execution_receipts.slice(0, MAX_ARTIFACT_REFS)
      : (session.latest_execution_receipt_refs || []),
    artifact_refs,
    active_task_leases,
    known_concurrent_actors,
    safe_to_continue: Boolean(safe_to_continue),
    known_caveats: Array.isArray(known_caveats)
      ? known_caveats.map(item => String(item).slice(0, 500)).slice(0, 50)
      : [],
    capability_policy_profile_id: session.capability_policy_profile_id || null,
    environment_manifest_id: session.environment_manifest_id || null,
    note: isNonEmptyString(note) ? String(note).trim().slice(0, 1000) : null,
    resumability: {
      sufficient_without_predecessor_transcript: true,
      currentness_basis: "checkpoint_id+session_revision+tip_vector_digest"
    },
    accepted_state_authority: false
  });

  const payloadDigest = await sha256Text(stableJson(body));
  const derivedId = `cp:${payloadDigest}`;
  return {
    ok: true,
    checkpoint_id: derivedId,
    payload_digest: payloadDigest,
    payload: {
      ...body,
      checkpoint_id: derivedId,
      payload_digest: payloadDigest
    }
  };
}

export async function createCodeCheckpoint(db, {
  code_session_id,
  actor_id,
  boundary,
  base_revision,
  expected_tip_vector_digest = null,
  changed_paths = null,
  current_task = null,
  completed_work = [],
  next_action = null,
  blockers = [],
  test_build_execution_receipts = [],
  artifact_refs = [],
  active_task_leases = [],
  known_concurrent_actors = [],
  safe_to_continue = true,
  known_caveats = [],
  workspace_snapshot_id = null,
  note = null,
  observed_commits = null
} = {}) {
  let sessionId;
  let actor;
  try {
    sessionId = codeSessionId(code_session_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_code_checkpoint_create", detail: String(error.message || error) };
  }
  if (!CODE_CHECKPOINT_BOUNDARY_SET.has(boundary)) {
    return {
      ok: false,
      error: "invalid_code_checkpoint_boundary",
      allowed: [...CODE_CHECKPOINT_BOUNDARIES]
    };
  }
  if (!Number.isInteger(base_revision) || base_revision < 1) {
    return { ok: false, error: "code_session_base_revision_required" };
  }

  const current = await getCodeSession(db, sessionId);
  if (!current) return { ok: false, error: "code_session_not_found", code_session_id: sessionId };

  if (current.session_revision !== base_revision) {
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      expected_session_revision: current.session_revision,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  const tipState = await refreshWorkspaceTipState(db, current.workspace_id);
  if (!tipState.ok) return tipState;

  if (isNonEmptyString(expected_tip_vector_digest)
    && tipState.tip_vector_digest !== String(expected_tip_vector_digest).trim()) {
    return {
      ok: false,
      error: "code_session_tip_race",
      code_session_id: sessionId,
      expected_tip_vector_digest: String(expected_tip_vector_digest).trim(),
      observed_tip_vector_digest: tipState.tip_vector_digest,
      ...authorityClosedFields()
    };
  }

  const pathsNorm = normalizeChangedPathsInput(changed_paths, tipState.tip_vector);
  if (!pathsNorm.ok) return pathsNorm;
  const artifactsNorm = normalizeArtifactRefs(artifact_refs);
  if (!artifactsNorm.ok) return artifactsNorm;
  const leasesNorm = normalizeLeaseStubs({ active_task_leases, known_concurrent_actors });
  if (!leasesNorm.ok) return leasesNorm;
  const receiptsNorm = normalizeReceiptRefs(test_build_execution_receipts);
  if (!receiptsNorm.ok) return receiptsNorm;

  const built = await buildCodeCheckpointPayload({
    code_session_id: sessionId,
    actor_id: actor,
    boundary,
    session: current,
    tip_vector: tipState.tip_vector,
    tip_vector_digest: tipState.tip_vector_digest,
    changed_paths: pathsNorm.changed_paths,
    current_task,
    completed_work,
    next_action,
    blockers,
    test_build_execution_receipts: receiptsNorm.latest_execution_receipt_refs,
    artifact_refs: artifactsNorm.artifact_refs,
    active_task_leases: leasesNorm.active_task_leases,
    known_concurrent_actors: leasesNorm.known_concurrent_actors,
    safe_to_continue,
    known_caveats,
    workspace_snapshot_id,
    note,
    observed_commits
  });
  if (!built.ok) return built;

  const now = new Date().toISOString();
  const nextRevision = current.session_revision + 1;
  const actors = (current.actors || []).map(entry => (
    entry.actor_id === actor
      ? {
        ...entry,
        last_checkpoint_id: built.checkpoint_id,
        last_session_revision: nextRevision
      }
      : entry
  ));
  if (!actors.some(entry => entry.actor_id === actor)) {
    actors.push({
      actor_id: actor,
      role: "participant",
      last_checkpoint_id: built.checkpoint_id,
      last_session_revision: nextRevision
    });
  }
  actors.sort((a, b) => a.actor_id.localeCompare(b.actor_id));

  try {
    await db.prepare(
      `INSERT INTO code_checkpoints (
        checkpoint_id, code_session_id, workspace_id, actor_id, boundary,
        session_revision, tip_vector_json, tip_vector_digest, workspace_snapshot_id,
        payload_json, payload_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      built.checkpoint_id,
      sessionId,
      current.workspace_id,
      actor,
      boundary,
      current.session_revision,
      stableJson(tipState.tip_vector),
      tipState.tip_vector_digest,
      isNonEmptyString(workspace_snapshot_id)
        ? String(workspace_snapshot_id).trim()
        : (current.workspace_snapshot_id || null),
      stableJson(built.payload),
      built.payload_digest,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return {
        ok: false,
        error: "code_checkpoint_already_exists",
        checkpoint_id: built.checkpoint_id,
        ...authorityClosedFields()
      };
    }
    throw error;
  }

  const updated = await db.prepare(
    `UPDATE code_sessions
     SET latest_checkpoint_id = ?, checkpoint_tip_vector_digest = ?,
         tip_vector_json = ?, tip_vector_digest = ?,
         actors_json = ?, session_revision = ?, updated_at = ?
     WHERE code_session_id = ? AND session_revision = ?`
  ).bind(
    built.checkpoint_id,
    tipState.tip_vector_digest,
    stableJson(tipState.tip_vector),
    tipState.tip_vector_digest,
    stableJson(actors),
    nextRevision,
    now,
    sessionId,
    base_revision
  ).run();

  if (!updated?.meta?.changes) {
    // Append-only checkpoint row may already exist; fail closed on pointer CAS.
    const raced = await getCodeSession(db, sessionId);
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      checkpoint_id: built.checkpoint_id,
      expected_session_revision: raced?.session_revision || null,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  const record = await getCodeCheckpoint(db, built.checkpoint_id);
  const session = await getCodeSession(db, sessionId);
  return {
    ok: true,
    checkpoint: record,
    session: {
      code_session_id: session.code_session_id,
      session_revision: session.session_revision,
      latest_checkpoint_id: session.latest_checkpoint_id,
      checkpoint_tip_vector_digest: session.checkpoint_tip_vector_digest,
      tip_vector_digest: session.tip_vector_digest,
      lifecycle: session.lifecycle
    },
    ...authorityClosedFields()
  };
}

export async function transitionCodeSessionTask(db, {
  code_session_id,
  actor_id,
  task_id,
  to_state,
  base_revision,
  note = null,
  title = null,
  author_id = null
} = {}) {
  let sessionId;
  let actor;
  try {
    sessionId = codeSessionId(code_session_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_code_session_task_transition", detail: String(error.message || error) };
  }
  if (!isNonEmptyString(task_id)) {
    return { ok: false, error: "task_id_required" };
  }
  const taskId = String(task_id).trim().slice(0, 128);
  if (!CODE_TASK_STATE_SET.has(to_state)) {
    return {
      ok: false,
      error: "invalid_code_session_task_state",
      state: to_state,
      allowed: [...CODE_TASK_STATES]
    };
  }
  if (!Number.isInteger(base_revision) || base_revision < 1) {
    return { ok: false, error: "code_session_base_revision_required" };
  }

  let author = actor;
  if (isNonEmptyString(author_id)) {
    try { author = actorId(author_id, "author_id"); }
    catch (error) {
      return { ok: false, error: "invalid_code_session_task_author", detail: String(error.message || error) };
    }
  }

  const current = await getCodeSession(db, sessionId);
  if (!current) return { ok: false, error: "code_session_not_found", code_session_id: sessionId };
  if (current.session_revision !== base_revision) {
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      expected_session_revision: current.session_revision,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  const ledger = Array.isArray(current.task_ledger) ? [...current.task_ledger] : [];
  const index = ledger.findIndex(task => task.task_id === taskId);
  const existing = index >= 0 ? ledger[index] : null;
  const fromState = existing?.state || null;

  if (existing) {
    if (!isLegalTaskTransition(fromState, to_state)) {
      return {
        ok: false,
        error: "code_session_task_transition_illegal",
        task_id: taskId,
        from_state: fromState,
        to_state,
        allowed: CODE_TASK_TRANSITIONS[fromState] || [],
        ...authorityClosedFields()
      };
    }
  } else if (!CODE_TASK_STATE_SET.has(to_state)) {
    return { ok: false, error: "invalid_code_session_task_state", state: to_state };
  } else if (!isNonEmptyString(title) && !existing) {
    return { ok: false, error: "task_title_required_for_create" };
  }

  const now = new Date().toISOString();
  const nextRevision = current.session_revision + 1;
  const nextEntry = {
    task_id: taskId,
    title: isNonEmptyString(title)
      ? String(title).trim().slice(0, 500)
      : (existing?.title || taskId),
    state: to_state,
    actor_id: actor,
    author_id: existing?.author_id || author,
    notes: isNonEmptyString(note) ? String(note).trim().slice(0, 2000) : (existing?.notes || null),
    updated_at: now
  };
  if (index >= 0) ledger[index] = nextEntry;
  else ledger.push(nextEntry);

  const eventBody = scrubSecretsDeep({
    schema: "cairnstone-code-session-task-ledger-event-v1",
    code_session_id: sessionId,
    task_id: taskId,
    from_state: fromState,
    to_state,
    actor_id: actor,
    author_id: nextEntry.author_id,
    note: nextEntry.notes,
    session_revision: nextRevision,
    created_at: now
  });
  const eventDigest = await sha256Text(stableJson(eventBody));
  const eventId = `tle:${eventDigest}`;

  try {
    await db.prepare(
      `INSERT INTO code_session_task_ledger_events (
        event_id, code_session_id, task_id, from_state, to_state,
        actor_id, author_id, note, session_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      eventId,
      sessionId,
      taskId,
      fromState,
      to_state,
      actor,
      nextEntry.author_id,
      nextEntry.notes,
      nextRevision,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return {
        ok: false,
        error: "code_session_task_event_already_exists",
        event_id: eventId,
        ...authorityClosedFields()
      };
    }
    throw error;
  }

  const actors = (current.actors || []).map(entry => (
    entry.actor_id === actor
      ? { ...entry, last_session_revision: nextRevision }
      : entry
  ));
  if (!actors.some(entry => entry.actor_id === actor)) {
    actors.push({
      actor_id: actor,
      role: "participant",
      last_checkpoint_id: null,
      last_session_revision: nextRevision
    });
  }
  actors.sort((a, b) => a.actor_id.localeCompare(b.actor_id));

  const updated = await db.prepare(
    `UPDATE code_sessions
     SET task_ledger_json = ?, actors_json = ?, session_revision = ?, updated_at = ?
     WHERE code_session_id = ? AND session_revision = ?`
  ).bind(
    stableJson(ledger),
    stableJson(actors),
    nextRevision,
    now,
    sessionId,
    base_revision
  ).run();

  if (!updated?.meta?.changes) {
    const raced = await getCodeSession(db, sessionId);
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      expected_session_revision: raced?.session_revision || null,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  const record = await getCodeSession(db, sessionId);
  return {
    ok: true,
    transition: {
      event_id: eventId,
      task_id: taskId,
      from_state: fromState,
      to_state,
      actor_id: actor,
      author_id: nextEntry.author_id,
      note: nextEntry.notes,
      base_revision,
      session_revision: nextRevision,
      created_at: now
    },
    task: nextEntry,
    task_ledger: record.task_ledger,
    session_revision: record.session_revision,
    code_session_id: sessionId,
    ...authorityClosedFields()
  };
}

async function refreshWorkspaceTipState(db, workspace_id) {
  const listed = await listWorkspaceTips(db, workspace_id);
  if (!listed.ok) return listed;
  const tipVector = buildTipVector(listed.tips);
  const tipVectorDigest = await computeTipVectorDigest(workspace_id, tipVector);
  // Race-safe: re-read tips and require identical tip vector before accepting.
  const second = await listWorkspaceTips(db, workspace_id);
  if (!second.ok) return second;
  const secondVector = buildTipVector(second.tips);
  if (!tipVectorsEqual(tipVector, secondVector)) {
    return {
      ok: false,
      error: "code_session_tip_race",
      workspace_id,
      tip_vector_digest: tipVectorDigest,
      ...authorityClosedFields()
    };
  }
  return {
    ok: true,
    workspace_id,
    tip_vector: tipVector,
    tip_vector_digest: tipVectorDigest,
    tip_count: tipVector.length
  };
}

function pathsChangedSinceCheckpoint(currentTips, checkpointDigest, storedCheckpointDigest, previousTips = null) {
  if (!checkpointDigest && !storedCheckpointDigest) {
    return {
      latest_checkpoint_id: null,
      checkpoint_tip_vector_digest: null,
      digest_match: null,
      paths_changed: currentTips.map(tip => tip.path),
      changed_path_details: currentTips.map(tip => ({
        path: tip.path,
        revision_id: tip.revision_id || null,
        content_hash: tip.content_hash || null,
        change: "present"
      })).slice(0, MAX_CHANGED_PATHS),
      currentness_basis: "session_tip_vector_digest"
    };
  }
  const expected = storedCheckpointDigest || null;
  const match = expected && checkpointDigest ? expected === checkpointDigest : false;
  const details = match
    ? []
    : (previousTips
      ? diffTipVectors(previousTips, currentTips)
      : currentTips.map(tip => ({
        path: tip.path,
        revision_id: tip.revision_id || null,
        content_hash: tip.content_hash || null,
        change: "present_or_changed"
      })).slice(0, MAX_CHANGED_PATHS));
  return {
    checkpoint_tip_vector_digest: expected,
    digest_match: expected ? match : null,
    paths_changed: details.map(entry => entry.path),
    changed_path_details: details,
    currentness_basis: "tip_vector_digest+session_revision+checkpoint_id"
  };
}

export function deriveNextSafeContinuation(session, tipState, permissions) {
  const lifecycle = session.lifecycle;
  if (lifecycle === "closed" || lifecycle === "superseded") {
    return {
      action: "refuse_continue",
      rationale: `lifecycle_${lifecycle}_is_terminal_for_resume`,
      safe_to_continue: false
    };
  }
  if (lifecycle === "blocked") {
    return {
      action: "inspect_blockers",
      rationale: "lifecycle_blocked_requires_human_or_ledger_resolution",
      safe_to_continue: false,
      unresolved_issues: session.unresolved_issues
    };
  }
  if (lifecycle === "paused") {
    return {
      action: "resume_then_compile_context",
      rationale: "session_paused_resume_required_before_mutation",
      safe_to_continue: false
    };
  }
  if (lifecycle === "proposed") {
    return {
      action: "review_proposal",
      rationale: "session_in_proposed_state_awaiting_separate_accept_path",
      safe_to_continue: true,
      caveats: ["accepted_state_authority_remains_false"]
    };
  }
  const canWrite = Array.isArray(permissions?.scopes) && permissions.scopes.includes("write_draft");
  const activeTasks = (session.task_ledger || []).filter(task =>
    ["queued", "claimed", "active", "blocked", "review"].includes(String(task.state || ""))
  );
  if (!tipState?.tip_count) {
    return {
      action: canWrite ? "hydrate_workspace_from_base" : "read_base_and_await_grant",
      rationale: "workspace_tips_empty_start_from_immutable_base",
      safe_to_continue: true,
      active_task: activeTasks[0] || null
    };
  }
  if (session.latest_checkpoint_id && session.checkpoint_tip_vector_digest
    && tipState.tip_vector_digest !== session.checkpoint_tip_vector_digest) {
    return {
      action: canWrite ? "continue_from_tip_after_checkpoint_diff" : "read_changes_since_checkpoint",
      rationale: "tip_vector_digest_differs_from_latest_checkpoint",
      safe_to_continue: true,
      latest_checkpoint_id: session.latest_checkpoint_id,
      active_task: activeTasks[0] || null
    };
  }
  return {
    action: canWrite ? "continue_active_task" : "read_only_continue",
    rationale: "session_active_tip_vector_stable",
    safe_to_continue: true,
    active_task: activeTasks[0] || null,
    tip_vector_digest: tipState.tip_vector_digest
  };
}

function codeSessionEnvBindings(env) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  // R2 optional for 7.7.7a session metadata ops; tips still read via workspace list.
  return { ok: true, db: env.CAIRNSTONE_DB, r2: env.CAIRNSTONE_RAW || null };
}

function requireActorField(body, field) {
  try { return { ok: true, value: actorId(body?.[field], field) }; }
  catch (error) {
    return { ok: false, error: "invalid_code_session_actor", detail: String(error.message || error), field };
  }
}

async function authorizeCodeSessionRequest(db, env, {
  workspace_capability,
  actor_id,
  workspace_id,
  requiredScopes = []
} = {}) {
  const auth = await authorizeWorkspaceRequest(db, env, {
    workspace_capability,
    actor_id,
    workspace_id,
    requiredScopes,
    requireMembership: true
  });
  if (!auth.ok) return auth;
  return {
    ...auth,
    ...authorityClosedFields()
  };
}

export async function createCodeSession(db, {
  code_session_id,
  workspace_id,
  created_by,
  project_chain = null,
  scope = null,
  source_repos,
  base_commits,
  working_transport = null,
  task_ledger = [],
  unresolved_issues = [],
  actors = [],
  environment_manifest_id = null,
  latest_execution_receipt_refs = [],
  latest_checkpoint_id = null,
  checkpoint_tip_vector_digest = null,
  capability_policy_profile_id = null,
  workspace_snapshot_id = null,
  tip_vector = null,
  tip_vector_digest = null
} = {}) {
  let sessionId;
  let wsId;
  let creator;
  try {
    sessionId = codeSessionId(code_session_id);
    wsId = workspaceId(workspace_id);
    creator = actorId(created_by, "created_by");
  } catch (error) {
    return { ok: false, error: "invalid_code_session_create", detail: String(error.message || error) };
  }

  const workspace = await getWorkspace(db, wsId);
  if (!workspace) return { ok: false, error: "workspace_not_found", workspace_id: wsId };

  const reposNorm = normalizeSourceRepos(source_repos);
  if (!reposNorm.ok) return reposNorm;
  const commitsNorm = normalizeBaseCommits(base_commits, reposNorm.source_repos);
  if (!commitsNorm.ok) return commitsNorm;
  const transportNorm = normalizeWorkingTransport(working_transport);
  if (!transportNorm.ok) return transportNorm;
  const ledgerNorm = normalizeTaskLedger(task_ledger);
  if (!ledgerNorm.ok) return ledgerNorm;
  const issuesNorm = normalizeUnresolvedIssues(unresolved_issues);
  if (!issuesNorm.ok) return issuesNorm;
  const actorsNorm = normalizeActors(actors, creator);
  if (!actorsNorm.ok) return actorsNorm;
  const receiptsNorm = normalizeReceiptRefs(latest_execution_receipt_refs);
  if (!receiptsNorm.ok) return receiptsNorm;

  if (scope !== undefined && scope !== null && !isObject(scope) && typeof scope !== "string") {
    return { ok: false, error: "invalid_code_session_scope" };
  }
  const scopeValue = typeof scope === "string"
    ? { schema: "cairnstone-scope-v1", mode: "single_chain", chains: [scope.trim()].filter(Boolean) }
    : (scope || (project_chain ? { schema: "cairnstone-scope-v1", mode: "single_chain", chains: [project_chain] } : null));

  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO code_sessions (
        code_session_id, workspace_id, project_chain, scope_json, source_repos_json,
        base_commits_json, working_transport_json, tip_vector_json, tip_vector_digest,
        workspace_snapshot_id, task_ledger_json, unresolved_issues_json, actors_json,
        environment_manifest_id, latest_execution_receipt_refs_json, latest_checkpoint_id,
        checkpoint_tip_vector_digest, capability_policy_profile_id, lifecycle,
        session_revision, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
    ).bind(
      sessionId,
      wsId,
      isNonEmptyString(project_chain) ? String(project_chain).trim() : null,
      scopeValue == null ? null : stableJson(scopeValue),
      stableJson(reposNorm.source_repos),
      stableJson(commitsNorm.base_commits),
      transportNorm.working_transport == null ? null : stableJson(transportNorm.working_transport),
      tip_vector == null ? null : stableJson(tip_vector),
      tip_vector_digest || null,
      isNonEmptyString(workspace_snapshot_id) ? String(workspace_snapshot_id).trim() : null,
      stableJson(ledgerNorm.task_ledger),
      stableJson(issuesNorm.unresolved_issues),
      stableJson(actorsNorm.actors),
      isNonEmptyString(environment_manifest_id) ? String(environment_manifest_id).trim() : null,
      stableJson(receiptsNorm.latest_execution_receipt_refs),
      isNonEmptyString(latest_checkpoint_id) ? String(latest_checkpoint_id).trim() : null,
      isNonEmptyString(checkpoint_tip_vector_digest) ? String(checkpoint_tip_vector_digest).trim() : null,
      isNonEmptyString(capability_policy_profile_id) ? String(capability_policy_profile_id).trim() : null,
      creator,
      now,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return { ok: false, error: "code_session_already_exists", code_session_id: sessionId };
    }
    throw error;
  }

  const record = await getCodeSession(db, sessionId);
  return {
    ok: true,
    ...record,
    ...authorityClosedFields()
  };
}

export async function transitionCodeSessionLifecycle(db, {
  code_session_id,
  actor_id,
  target_lifecycle,
  base_revision,
  note = null
} = {}) {
  let sessionId;
  let actor;
  try {
    sessionId = codeSessionId(code_session_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return { ok: false, error: "invalid_code_session_transition", detail: String(error.message || error) };
  }
  if (!LIFECYCLE_SET.has(target_lifecycle)) {
    return { ok: false, error: "invalid_code_session_lifecycle", allowed: [...CODE_SESSION_LIFECYCLES] };
  }
  if (!Number.isInteger(base_revision) || base_revision < 1) {
    return { ok: false, error: "code_session_base_revision_required" };
  }

  const current = await getCodeSession(db, sessionId);
  if (!current) return { ok: false, error: "code_session_not_found", code_session_id: sessionId };

  if (current.session_revision !== base_revision) {
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      expected_session_revision: current.session_revision,
      provided_base_revision: base_revision,
      lifecycle: current.lifecycle,
      ...authorityClosedFields()
    };
  }

  if (target_lifecycle === "paused") {
    if (current.lifecycle !== "active" && current.lifecycle !== "blocked") {
      return {
        ok: false,
        error: "code_session_pause_invalid_lifecycle",
        lifecycle: current.lifecycle,
        ...authorityClosedFields()
      };
    }
  } else if (target_lifecycle === "active") {
    if (current.lifecycle !== "paused" && current.lifecycle !== "blocked") {
      return {
        ok: false,
        error: "code_session_resume_invalid_lifecycle",
        lifecycle: current.lifecycle,
        ...authorityClosedFields()
      };
    }
  }

  const now = new Date().toISOString();
  const nextRevision = current.session_revision + 1;
  const actors = (current.actors || []).map(entry => (
    entry.actor_id === actor
      ? { ...entry, last_session_revision: nextRevision }
      : entry
  ));
  if (!actors.some(entry => entry.actor_id === actor)) {
    actors.push({
      actor_id: actor,
      role: "participant",
      last_checkpoint_id: null,
      last_session_revision: nextRevision
    });
  }
  actors.sort((a, b) => a.actor_id.localeCompare(b.actor_id));

  const updated = await db.prepare(
    `UPDATE code_sessions
     SET lifecycle = ?, session_revision = ?, actors_json = ?, updated_at = ?
     WHERE code_session_id = ? AND session_revision = ?`
  ).bind(
    target_lifecycle,
    nextRevision,
    stableJson(actors),
    now,
    sessionId,
    base_revision
  ).run();

  if (!updated?.meta?.changes) {
    const raced = await getCodeSession(db, sessionId);
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      expected_session_revision: raced?.session_revision || null,
      provided_base_revision: base_revision,
      lifecycle: raced?.lifecycle || null,
      ...authorityClosedFields()
    };
  }

  const record = await getCodeSession(db, sessionId);
  return {
    ok: true,
    ...record,
    transition: {
      from: current.lifecycle,
      to: target_lifecycle,
      actor_id: actor,
      note: isNonEmptyString(note) ? String(note).trim().slice(0, 500) : null,
      base_revision,
      session_revision: nextRevision
    },
    ...authorityClosedFields()
  };
}

/**
 * Deterministically compile bounded cairnstone-code-session-context-v1.
 * Content/provenance identified; tip re-read fail-closed on race.
 * Never uses timestamps as currentness when explicit pointers exist.
 */
export async function compileCodeSessionContext(db, {
  code_session_id,
  actor_id,
  permissions = null
} = {}) {
  const session = await getCodeSession(db, code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id };
  }

  const tipState = await refreshWorkspaceTipState(db, session.workspace_id);
  if (!tipState.ok) return tipState;

  // Persist latest observed tip digest onto the session only when unchanged
  // revision CAS succeeds; never invent HEAD authority from this refresh.
  if (session.tip_vector_digest !== tipState.tip_vector_digest) {
    await db.prepare(
      `UPDATE code_sessions
       SET tip_vector_json = ?, tip_vector_digest = ?, updated_at = ?
       WHERE code_session_id = ? AND session_revision = ?`
    ).bind(
      stableJson(tipState.tip_vector),
      tipState.tip_vector_digest,
      new Date().toISOString(),
      session.code_session_id,
      session.session_revision
    ).run();
  }

  // Final re-read of session row for race-safe pointer identity.
  const fresh = await getCodeSession(db, session.code_session_id);
  if (!fresh) return { ok: false, error: "code_session_not_found", code_session_id };
  if (fresh.session_revision !== session.session_revision) {
    return {
      ok: false,
      error: "code_session_context_race",
      code_session_id: session.code_session_id,
      expected_session_revision: session.session_revision,
      observed_session_revision: fresh.session_revision,
      ...authorityClosedFields()
    };
  }

  const latestCheckpoint = fresh.latest_checkpoint_id
    ? await getCodeCheckpoint(db, fresh.latest_checkpoint_id)
    : null;

  const changeSet = pathsChangedSinceCheckpoint(
    tipState.tip_vector,
    tipState.tip_vector_digest,
    fresh.checkpoint_tip_vector_digest,
    latestCheckpoint?.tip_vector || null
  );

  const permissionsView = {
    actor_id,
    membership_role: permissions?.membership_role || null,
    scopes: Array.isArray(permissions?.scopes) ? [...permissions.scopes].sort() : [],
    path_prefix: permissions?.path_prefix || null,
    workspace_id: fresh.workspace_id,
    code_session_id: fresh.code_session_id,
    accepted_state_authority: false,
    execution_authority: false,
    capability_policy_profile_id: fresh.capability_policy_profile_id
  };

  const next = deriveNextSafeContinuation(fresh, tipState, permissionsView);
  const activeTasks = (fresh.task_ledger || []).filter(task =>
    ["queued", "claimed", "active", "blocked", "review"].includes(String(task.state || ""))
  );
  const doneTasks = (fresh.task_ledger || []).filter(task =>
    ["done", "abandoned"].includes(String(task.state || ""))
  );

  const checkpointResume = latestCheckpoint
    ? scrubSecretsDeep({
      checkpoint_id: latestCheckpoint.checkpoint_id,
      boundary: latestCheckpoint.boundary,
      actor_id: latestCheckpoint.actor_id,
      session_revision: latestCheckpoint.session_revision,
      tip_vector_digest: latestCheckpoint.tip_vector_digest,
      payload_digest: latestCheckpoint.payload_digest,
      safe_to_continue: latestCheckpoint.payload?.safe_to_continue ?? null,
      next_action: latestCheckpoint.payload?.task?.next_action || null,
      current_task: latestCheckpoint.payload?.task?.current_task || null,
      blockers: latestCheckpoint.payload?.task?.blockers || [],
      known_caveats: latestCheckpoint.payload?.known_caveats || [],
      test_build_execution_receipts: latestCheckpoint.payload?.test_build_execution_receipts || [],
      artifact_refs: latestCheckpoint.payload?.artifact_refs || [],
      active_task_leases: latestCheckpoint.payload?.active_task_leases || [],
      known_concurrent_actors: latestCheckpoint.payload?.known_concurrent_actors || [],
      capability_policy_profile_id: latestCheckpoint.payload?.capability_policy_profile_id || null,
      resumability: latestCheckpoint.payload?.resumability || null
    })
    : null;

  const contextBody = {
    schema: CODE_SESSION_CONTEXT_SCHEMA,
    code_session_id: fresh.code_session_id,
    session_revision: fresh.session_revision,
    lifecycle: fresh.lifecycle,
    project: {
      chain: fresh.project_chain,
      scope: fresh.scope,
      repos: fresh.source_repos
    },
    immutable_base: fresh.base_commits,
    working_transport: fresh.working_transport,
    workspace: {
      workspace_id: fresh.workspace_id,
      tip_vector: tipState.tip_vector,
      tip_vector_digest: tipState.tip_vector_digest,
      tip_count: tipState.tip_count,
      workspace_snapshot_id: fresh.workspace_snapshot_id
    },
    latest_checkpoint: checkpointResume,
    changes_since_last_checkpoint: {
      latest_checkpoint_id: fresh.latest_checkpoint_id,
      ...changeSet
    },
    task_ledger: fresh.task_ledger,
    task_ledger_summary: {
      active: activeTasks,
      completed_or_abandoned: doneTasks,
      states_allowed: [...CODE_TASK_STATES]
    },
    unresolved_issues: fresh.unresolved_issues,
    actors: fresh.actors,
    latest_execution_receipt_refs: fresh.latest_execution_receipt_refs,
    environment_manifest_id: fresh.environment_manifest_id,
    capability_policy_profile_id: fresh.capability_policy_profile_id,
    permissions: permissionsView,
    next_safe_continuation: {
      ...next,
      next_action_from_checkpoint: checkpointResume?.next_action || null
    },
    currentness: {
      basis: "session_revision+tip_vector_digest+checkpoint_pointer",
      session_revision: fresh.session_revision,
      tip_vector_digest: tipState.tip_vector_digest,
      latest_checkpoint_id: fresh.latest_checkpoint_id,
      checkpoint_payload_digest: latestCheckpoint?.payload_digest || null,
      timestamps_are_informational_only: true
    },
    ...authorityClosedFields()
  };

  const contextDigest = await sha256Text(stableJson({
    schema: CODE_SESSION_CONTEXT_SCHEMA,
    code_session_id: contextBody.code_session_id,
    session_revision: contextBody.session_revision,
    tip_vector_digest: tipState.tip_vector_digest,
    latest_checkpoint_id: fresh.latest_checkpoint_id,
    checkpoint_payload_digest: latestCheckpoint?.payload_digest || null,
    lifecycle: fresh.lifecycle,
    task_ledger: fresh.task_ledger,
    permissions: permissionsView
  }));

  return {
    ok: true,
    ...contextBody,
    content_identity: {
      context_digest: contextDigest,
      tip_vector_digest: tipState.tip_vector_digest,
      session_revision: fresh.session_revision,
      latest_checkpoint_id: fresh.latest_checkpoint_id,
      checkpoint_payload_digest: latestCheckpoint?.payload_digest || null
    },
    ...authorityClosedFields()
  };
}

export async function createCodeSessionFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const creator = requireActorField(body, "created_by");
  if (!creator.ok) return creator;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required_for_create" };
  }
  if (!isNonEmptyString(body.workspace_id)) {
    return { ok: false, error: "workspace_id_required_for_create" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: creator.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  // Capture tip state at open time when available (race-safe).
  let tipVector = null;
  let tipVectorDigest = null;
  const tipState = await refreshWorkspaceTipState(bindings.db, auth.workspace_id);
  if (tipState.ok) {
    tipVector = tipState.tip_vector;
    tipVectorDigest = tipState.tip_vector_digest;
  } else if (tipState.error === "code_session_tip_race") {
    return tipState;
  }

  return createCodeSession(bindings.db, {
    code_session_id: body.code_session_id,
    workspace_id: auth.workspace_id,
    created_by: creator.value,
    project_chain: body.project_chain,
    scope: body.scope,
    source_repos: body.source_repos,
    base_commits: body.base_commits,
    working_transport: body.working_transport,
    task_ledger: body.task_ledger,
    unresolved_issues: body.unresolved_issues,
    actors: body.actors,
    environment_manifest_id: body.environment_manifest_id,
    latest_execution_receipt_refs: body.latest_execution_receipt_refs,
    latest_checkpoint_id: body.latest_checkpoint_id,
    checkpoint_tip_vector_digest: body.checkpoint_tip_vector_digest,
    capability_policy_profile_id: body.capability_policy_profile_id || `profile:${auth.membership_role || "member"}`,
    workspace_snapshot_id: body.workspace_snapshot_id,
    tip_vector: tipVector,
    tip_vector_digest: tipVectorDigest
  });
}

export async function getCodeSessionFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: body.code_session_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["ls"]
  });
  if (!auth.ok) return auth;

  return {
    ok: true,
    ...session,
    membership_role: auth.membership_role,
    ...authorityClosedFields()
  };
}

export async function pauseCodeSessionFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: body.code_session_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return transitionCodeSessionLifecycle(bindings.db, {
    code_session_id: session.code_session_id,
    actor_id: actor.value,
    target_lifecycle: "paused",
    base_revision: body.base_revision,
    note: body.note
  });
}

export async function resumeCodeSessionFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: body.code_session_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return transitionCodeSessionLifecycle(bindings.db, {
    code_session_id: session.code_session_id,
    actor_id: actor.value,
    target_lifecycle: "active",
    base_revision: body.base_revision,
    note: body.note
  });
}

export async function compileCodeSessionContextFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: body.code_session_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["read"]
  });
  if (!auth.ok) return auth;

  return compileCodeSessionContext(bindings.db, {
    code_session_id: session.code_session_id,
    actor_id: actor.value,
    permissions: {
      membership_role: auth.membership_role,
      scopes: auth.scopes,
      path_prefix: auth.path_prefix || null
    }
  });
}

export async function createCodeCheckpointFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: body.code_session_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return createCodeCheckpoint(bindings.db, {
    code_session_id: session.code_session_id,
    actor_id: actor.value,
    boundary: body.boundary,
    base_revision: body.base_revision,
    expected_tip_vector_digest: body.expected_tip_vector_digest,
    changed_paths: body.changed_paths,
    current_task: body.current_task,
    completed_work: body.completed_work,
    next_action: body.next_action,
    blockers: body.blockers,
    test_build_execution_receipts: body.test_build_execution_receipts,
    artifact_refs: body.artifact_refs,
    active_task_leases: body.active_task_leases,
    known_concurrent_actors: body.known_concurrent_actors,
    safe_to_continue: body.safe_to_continue !== false,
    known_caveats: body.known_caveats,
    workspace_snapshot_id: body.workspace_snapshot_id,
    note: body.note,
    observed_commits: body.observed_commits
  });
}

export async function getCodeCheckpointFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.checkpoint_id)) {
    return { ok: false, error: "checkpoint_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const checkpoint = await getCodeCheckpoint(bindings.db, body.checkpoint_id);
  if (!checkpoint) {
    return { ok: false, error: "code_checkpoint_not_found", checkpoint_id: body.checkpoint_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: checkpoint.workspace_id,
    requiredScopes: ["ls"]
  });
  if (!auth.ok) return auth;

  return {
    ok: true,
    ...checkpoint,
    membership_role: auth.membership_role,
    ...authorityClosedFields()
  };
}

export async function listCodeCheckpointsFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: body.code_session_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["ls"]
  });
  if (!auth.ok) return auth;

  return listCodeCheckpoints(bindings.db, {
    code_session_id: session.code_session_id,
    limit: body.limit
  });
}

export async function transitionCodeSessionTaskFromBody(body = {}, env = {}) {
  const bindings = codeSessionEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required" };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required" };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: body.code_session_id };
  }

  const auth = await authorizeCodeSessionRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return transitionCodeSessionTask(bindings.db, {
    code_session_id: session.code_session_id,
    actor_id: actor.value,
    task_id: body.task_id,
    to_state: body.to_state,
    base_revision: body.base_revision,
    note: body.note,
    title: body.title,
    author_id: body.author_id
  });
}

export const CODE_SESSION_CREATE_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.create,
  description: "V7.7.7a: create durable Code Session bound to an existing Shared Agent Workspace. Requires workspace_capability (write_draft) + membership. Operational state only; never accepted-state authority; never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "workspace_id", "created_by", "workspace_capability", "source_repos", "base_commits"],
    properties: {
      code_session_id: { type: "string" },
      workspace_id: { type: "string" },
      created_by: { type: "string" },
      workspace_capability: { type: "string" },
      project_chain: { type: "string" },
      scope: { type: "object" },
      source_repos: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
      base_commits: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          required: ["repo", "commit_sha"],
          properties: {
            repo: { type: "string" },
            commit_sha: { type: "string" }
          },
          additionalProperties: false
        }
      },
      working_transport: {
        type: "object",
        properties: {
          branch: { type: "string" },
          ref: { type: "string" },
          observed_commit_sha: { type: "string" },
          pr: {
            type: "object",
            properties: {
              number: { type: "number" },
              url: { type: "string" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      task_ledger: { type: "array", items: { type: "object" }, maxItems: 200 },
      unresolved_issues: { type: "array", maxItems: 200 },
      actors: { type: "array", items: { type: "object" }, maxItems: 100 },
      environment_manifest_id: { type: "string" },
      latest_execution_receipt_refs: { type: "array", maxItems: 100 },
      latest_checkpoint_id: { type: "string" },
      checkpoint_tip_vector_digest: { type: "string" },
      capability_policy_profile_id: { type: "string" },
      workspace_snapshot_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_GET_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.get,
  description: "V7.7.7a: read cairnstone-code-session-v1 operational record. Requires workspace membership + workspace_capability (ls). Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_PAUSE_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.pause,
  description: "V7.7.7a: pause a Code Session (CAS on session_revision). Requires workspace_capability write_draft. Fail-closed on revision conflict. Never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability", "base_revision"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      base_revision: { type: "number", minimum: 1 },
      note: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_RESUME_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.resume,
  description: "V7.7.7a: resume a paused/blocked Code Session (CAS on session_revision). Requires workspace_capability write_draft. Never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability", "base_revision"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      base_revision: { type: "number", minimum: 1 },
      note: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.compile_context,
  description: "V7.7.7a/b: compile bounded cairnstone-code-session-context-v1 including latest checkpoint pointer + task ledger for an authorized actor. Race-safe tip re-read; never infers currentness from timestamps when explicit pointers exist.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CODE_CHECKPOINT_CREATE_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.checkpoint_create,
  description: "V7.7.7b: create immutable cairnstone-code-checkpoint-v1 at a meaningful boundary. CAS on session_revision and optional tip_vector_digest. Updates session latest_checkpoint_id via CAS. Operational only; never moves HEADs; never stores raw capability bearers.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability", "boundary", "base_revision"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      boundary: {
        type: "string",
        enum: [
          "handoff",
          "pause",
          "task_completion",
          "conflict_rebase",
          "test_gate",
          "proposal",
          "user_requested"
        ]
      },
      base_revision: { type: "number", minimum: 1 },
      expected_tip_vector_digest: { type: "string" },
      changed_paths: { type: "array", maxItems: 500 },
      current_task: { type: "object" },
      completed_work: { type: "array", maxItems: 100 },
      next_action: { type: "string" },
      blockers: { type: "array", maxItems: 100 },
      test_build_execution_receipts: { type: "array", maxItems: 100 },
      artifact_refs: { type: "array", maxItems: 100 },
      active_task_leases: { type: "array", maxItems: 50 },
      known_concurrent_actors: { type: "array", maxItems: 50 },
      safe_to_continue: { type: "boolean" },
      known_caveats: { type: "array", maxItems: 50 },
      workspace_snapshot_id: { type: "string" },
      note: { type: "string" },
      observed_commits: { type: "array", maxItems: 32 }
    },
    additionalProperties: false
  }
});

export const CODE_CHECKPOINT_GET_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.checkpoint_get,
  description: "V7.7.7b: read immutable cairnstone-code-checkpoint-v1. Requires workspace membership + workspace_capability (ls). Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["checkpoint_id", "actor_id", "workspace_capability"],
    properties: {
      checkpoint_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CODE_CHECKPOINT_LIST_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.checkpoint_list,
  description: "V7.7.7b: list recent immutable code checkpoints for a session (newest-first, bounded). Requires workspace_capability (ls).",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 }
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_TASK_TRANSITION_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_BROKER_TOOL_IDS.task_transition,
  description: "V7.7.7b: transition one task in the durable task ledger (queued|claimed|active|blocked|review|done|abandoned) with actor attribution. Append-only event + CAS session snapshot. Never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability", "task_id", "to_state", "base_revision"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      task_id: { type: "string" },
      to_state: {
        type: "string",
        enum: ["queued", "claimed", "active", "blocked", "review", "done", "abandoned"]
      },
      base_revision: { type: "number", minimum: 1 },
      note: { type: "string" },
      title: { type: "string" },
      author_id: { type: "string" }
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_MCP_TOOL_DEFINITIONS = Object.freeze([
  CODE_SESSION_CREATE_TOOL_DEFINITION,
  CODE_SESSION_GET_TOOL_DEFINITION,
  CODE_SESSION_PAUSE_TOOL_DEFINITION,
  CODE_SESSION_RESUME_TOOL_DEFINITION,
  CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION,
  CODE_CHECKPOINT_CREATE_TOOL_DEFINITION,
  CODE_CHECKPOINT_GET_TOOL_DEFINITION,
  CODE_CHECKPOINT_LIST_TOOL_DEFINITION,
  CODE_SESSION_TASK_TRANSITION_TOOL_DEFINITION
]);
