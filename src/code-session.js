// V7.7.7a Durable Code Session + deterministic resume/context contract.
//
// Operational state only. Reuses Shared Agent Workspace (bound workspace_id)
// and V7.7.6 workspace_capability / membership — no second ticket format,
// actor registry, or model-self-service authority path.
//
// NEVER moves chain_heads / path_heads. accepted_state_authority always false.
// Never infer currentness from timestamps when session_revision / tip digest /
// checkpoint pointers exist.

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

export const CODE_SESSION_LIFECYCLES = Object.freeze([
  "active",
  "paused",
  "blocked",
  "proposed",
  "closed",
  "superseded"
]);

const LIFECYCLE_SET = new Set(CODE_SESSION_LIFECYCLES);

export const CODE_SESSION_BROKER_TOOL_IDS = Object.freeze({
  create: "cairnstone_code_session_create",
  get: "cairnstone_code_session_get",
  pause: "cairnstone_code_session_pause",
  resume: "cairnstone_code_session_resume",
  compile_context: "cairnstone_code_session_compile_context"
});

export const CODE_SESSION_MUTATION_TOOL_IDS = Object.freeze([
  CODE_SESSION_BROKER_TOOL_IDS.create,
  CODE_SESSION_BROKER_TOOL_IDS.pause,
  CODE_SESSION_BROKER_TOOL_IDS.resume
]);

export const CODE_SESSION_READ_TOOL_IDS = Object.freeze([
  CODE_SESSION_BROKER_TOOL_IDS.get,
  CODE_SESSION_BROKER_TOOL_IDS.compile_context
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const WORKSPACE_ID_RE = /^ws:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CODE_SESSION_ID_RE = /^cs:[a-z0-9][a-z0-9._-]{0,127}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
    ledger.push({
      task_id: taskId.slice(0, 128),
      title: title.slice(0, 500),
      state: state.slice(0, 64),
      actor_id: isNonEmptyString(item.actor_id) ? String(item.actor_id).trim() : null,
      notes: isNonEmptyString(item.notes) ? String(item.notes).trim().slice(0, 2000) : null
    });
  }
  return { ok: true, task_ledger: ledger };
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

function pathsChangedSinceCheckpoint(currentTips, checkpointDigest, storedCheckpointDigest) {
  if (!checkpointDigest && !storedCheckpointDigest) {
    return {
      latest_checkpoint_id: null,
      checkpoint_tip_vector_digest: null,
      digest_match: null,
      paths_changed: currentTips.map(tip => tip.path),
      currentness_basis: "session_tip_vector_digest"
    };
  }
  const expected = storedCheckpointDigest || null;
  const match = expected && checkpointDigest ? expected === checkpointDigest : false;
  return {
    checkpoint_tip_vector_digest: expected,
    digest_match: expected ? match : null,
    // Without a stored checkpoint tip vector body (7.7.7b), report all current
    // paths as changed-or-present when digests differ; never use timestamps.
    paths_changed: match ? [] : currentTips.map(tip => tip.path),
    currentness_basis: "tip_vector_digest+session_revision"
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

  const changeSet = pathsChangedSinceCheckpoint(
    tipState.tip_vector,
    tipState.tip_vector_digest,
    fresh.checkpoint_tip_vector_digest
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
    changes_since_last_checkpoint: {
      latest_checkpoint_id: fresh.latest_checkpoint_id,
      ...changeSet
    },
    task_ledger: fresh.task_ledger,
    unresolved_issues: fresh.unresolved_issues,
    actors: fresh.actors,
    latest_execution_receipt_refs: fresh.latest_execution_receipt_refs,
    environment_manifest_id: fresh.environment_manifest_id,
    capability_policy_profile_id: fresh.capability_policy_profile_id,
    permissions: permissionsView,
    next_safe_continuation: next,
    currentness: {
      basis: "session_revision+tip_vector_digest+checkpoint_pointer",
      session_revision: fresh.session_revision,
      tip_vector_digest: tipState.tip_vector_digest,
      latest_checkpoint_id: fresh.latest_checkpoint_id,
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
    lifecycle: fresh.lifecycle,
    permissions: permissionsView
  }));

  return {
    ok: true,
    ...contextBody,
    content_identity: {
      context_digest: contextDigest,
      tip_vector_digest: tipState.tip_vector_digest,
      session_revision: fresh.session_revision,
      latest_checkpoint_id: fresh.latest_checkpoint_id
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
  description: "V7.7.7a: compile bounded cairnstone-code-session-context-v1 for an authorized actor (project/base/tips/tasks/actors/tests/permissions/next action). Race-safe tip re-read; never infers currentness from timestamps when explicit pointers exist.",
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

export const CODE_SESSION_MCP_TOOL_DEFINITIONS = Object.freeze([
  CODE_SESSION_CREATE_TOOL_DEFINITION,
  CODE_SESSION_GET_TOOL_DEFINITION,
  CODE_SESSION_PAUSE_TOOL_DEFINITION,
  CODE_SESSION_RESUME_TOOL_DEFINITION,
  CODE_SESSION_COMPILE_CONTEXT_TOOL_DEFINITION
]);
