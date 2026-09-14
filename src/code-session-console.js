// V7.7.7f — Persistent Code Mode Console UX aggregation.
// Thin operator-facing read over existing Code Session / workspace / invite
// surfaces. Grants no new authority; never stores or returns raw capability
// bearers; never moves chain/path HEADs.

import {
  compileCodeSessionContextFromBody,
  listCodeCheckpoints,
  scrubSecretsDeep
} from "./code-session.js";
import { listExecutionReceipts } from "./environment-sandbox.js";
import { getWorkspace } from "./workspace.js";

export const CODE_SESSION_CONSOLE_VIEW_SCHEMA = "cairnstone-code-session-console-view-v1";

export const CODE_SESSION_CONSOLE_BROKER_TOOL_IDS = Object.freeze({
  view: "cairnstone_code_session_console_view"
});

export const CODE_SESSION_CONSOLE_READ_TOOL_IDS = Object.freeze([
  CODE_SESSION_CONSOLE_BROKER_TOOL_IDS.view
]);

export const CODE_SESSION_CONSOLE_MUTATION_TOOL_IDS = Object.freeze([]);

const CONTINUATION_PROMPT =
  "Check your CairnStone inbox and continue the Code Session.";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    synthetic_global_head: false,
    console_grants_no_new_authority: true,
    secrets_absent: true
  };
}

function displayActorLabel(actorId) {
  const raw = String(actorId || "").trim();
  if (!raw) return "Unknown";
  const local = raw.includes(":") ? raw.split(":")[0] : raw;
  return local
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function relativeAge(iso, nowMs = Date.now()) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return null;
  const delta = Math.max(0, nowMs - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function countWorkingTree(changeSet = {}) {
  const details = Array.isArray(changeSet.changed_path_details)
    ? changeSet.changed_path_details
    : [];
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let other = 0;
  for (const entry of details) {
    const change = String(entry?.change || "").toLowerCase();
    if (change === "modified" || change === "present_or_changed" || change === "present") {
      modified += 1;
    } else if (change === "added") {
      added += 1;
    } else if (change === "deleted") {
      deleted += 1;
    } else {
      other += 1;
    }
  }
  // When details are empty but paths_changed lists paths, treat as modified.
  if (!details.length && Array.isArray(changeSet.paths_changed) && changeSet.paths_changed.length) {
    modified = changeSet.paths_changed.length;
  }
  return {
    modified,
    added,
    deleted,
    other,
    path_count: Array.isArray(changeSet.paths_changed)
      ? changeSet.paths_changed.length
      : details.length,
    digest_match: changeSet.digest_match ?? null
  };
}

/**
 * Derive operator-readable actor rows from session actors + live leases +
 * checkpoints. Coordination hints only — not locks or accepted-state authority.
 */
export function deriveConsoleActors({
  actors = [],
  known_concurrent_actors = [],
  active_task_leases = [],
  checkpoints = [],
  task_ledger = [],
  nowMs = Date.now()
} = {}) {
  const byId = new Map();

  for (const entry of Array.isArray(actors) ? actors : []) {
    if (!isObject(entry) || !entry.actor_id) continue;
    byId.set(entry.actor_id, {
      actor_id: entry.actor_id,
      display: displayActorLabel(entry.actor_id),
      role: entry.role || entry.membership_role || null,
      status: "idle",
      detail: entry.note || entry.detail || null,
      lease_id: null,
      last_checkpoint_id: null,
      last_checkpoint_at: null,
      coordination_hint_only: true
    });
  }

  for (const concurrent of Array.isArray(known_concurrent_actors) ? known_concurrent_actors : []) {
    const actorId = typeof concurrent === "string" ? concurrent : concurrent?.actor_id;
    if (!actorId) continue;
    if (!byId.has(actorId)) {
      byId.set(actorId, {
        actor_id: actorId,
        display: displayActorLabel(actorId),
        role: null,
        status: "idle",
        detail: null,
        lease_id: null,
        last_checkpoint_id: null,
        last_checkpoint_at: null,
        coordination_hint_only: true
      });
    }
  }

  for (const lease of Array.isArray(active_task_leases) ? active_task_leases : []) {
    if (!lease?.actor_id) continue;
    if (!byId.has(lease.actor_id)) {
      byId.set(lease.actor_id, {
        actor_id: lease.actor_id,
        display: displayActorLabel(lease.actor_id),
        role: null,
        status: "active",
        detail: null,
        lease_id: lease.lease_id || null,
        last_checkpoint_id: null,
        last_checkpoint_at: null,
        coordination_hint_only: true
      });
    }
    const row = byId.get(lease.actor_id);
    row.status = "active";
    row.lease_id = lease.lease_id || row.lease_id;
    const pathHint = Array.isArray(lease.path_prefixes) && lease.path_prefixes.length
      ? lease.path_prefixes[0]
      : null;
    row.detail = lease.task_id || pathHint || row.detail || "leased";
  }

  for (const task of Array.isArray(task_ledger) ? task_ledger : []) {
    const actorId = task?.actor_id || task?.author || null;
    if (!actorId || !byId.has(actorId)) continue;
    const row = byId.get(actorId);
    if (row.status === "active") continue;
    const state = String(task.state || "").toLowerCase();
    if (state === "review") {
      row.status = "reviewing";
      row.detail = task.title || task.task_id || row.detail;
    } else if (state === "blocked") {
      row.status = "blocked";
      row.detail = task.title || row.detail;
    } else if (state === "paused" || state === "claimed") {
      row.status = "paused";
      row.detail = task.title || row.detail;
    } else if (state === "active" && row.status === "idle") {
      row.status = "active";
      row.detail = task.title || row.detail;
    }
  }

  for (const checkpoint of Array.isArray(checkpoints) ? checkpoints : []) {
    if (!checkpoint?.actor_id || !byId.has(checkpoint.actor_id)) continue;
    const row = byId.get(checkpoint.actor_id);
    if (!row.last_checkpoint_at
      || Date.parse(checkpoint.created_at || "") > Date.parse(row.last_checkpoint_at || "")) {
      row.last_checkpoint_id = checkpoint.checkpoint_id;
      row.last_checkpoint_at = checkpoint.created_at || null;
    }
    if (row.status === "idle" || row.status === "paused") {
      const age = relativeAge(checkpoint.created_at, nowMs);
      row.status = "paused";
      row.detail = age ? `checkpoint ${age}` : (row.detail || "checkpoint");
    }
  }

  for (const row of byId.values()) {
    if (row.status === "idle" && /release|owner|proposer/i.test(String(row.role || ""))) {
      row.status = "release owner";
      row.detail = row.role;
    }
  }

  return [...byId.values()].sort((a, b) => a.actor_id.localeCompare(b.actor_id));
}

/**
 * Summarize test/build receipts for the Console Tests line.
 * Prefer explicit counts in receipt payload; otherwise status of latest test run.
 */
export function summarizeConsoleTests(receipts = []) {
  const list = Array.isArray(receipts) ? receipts : [];
  const testReceipts = list.filter(r => String(r?.command_class || "").toLowerCase() === "test");
  const preferred = testReceipts[0] || list.find(r => {
    const payload = r?.payload || {};
    return payload.tests_passed !== undefined || payload.passed !== undefined
      || payload.tests_total !== undefined || payload.total !== undefined;
  }) || null;

  if (!preferred) {
    return {
      available: false,
      summary: "No test receipts yet",
      passed: null,
      failed: null,
      total: null,
      status: null,
      receipt_id: null,
      command_class: null
    };
  }

  const payload = isObject(preferred.payload) ? preferred.payload : {};
  const passed = numberOrNull(
    payload.tests_passed ?? payload.passed ?? payload.pass ?? payload.ok_count
  );
  const failed = numberOrNull(
    payload.tests_failed ?? payload.failed ?? payload.fail ?? payload.fail_count
  );
  const total = numberOrNull(
    payload.tests_total ?? payload.total
      ?? (passed !== null && failed !== null ? passed + failed : null)
  );

  let summary;
  if (passed !== null && total !== null) {
    summary = `${passed} / ${total} passing`;
  } else if (preferred.status === "succeeded" || preferred.status === "passed"
    || preferred.exit_code === 0) {
    summary = "latest test receipt succeeded";
  } else if (preferred.status === "failed" || (Number.isInteger(preferred.exit_code) && preferred.exit_code !== 0)) {
    summary = "latest test receipt failed";
  } else {
    summary = `latest ${preferred.command_class || "execution"} · ${preferred.status || "unknown"}`;
  }

  return {
    available: true,
    summary,
    passed,
    failed,
    total,
    status: preferred.status || null,
    exit_code: preferred.exit_code ?? null,
    receipt_id: preferred.receipt_id || null,
    command_class: preferred.command_class || null,
    command_summary: preferred.command_summary || null,
    created_at: preferred.created_at || null
  };
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Action descriptors for the Console buttons. Each maps to an existing plane;
 * none invent a second ticket format or grant new authority.
 */
export function buildConsoleActionCatalog({
  code_session_id,
  workspace_id,
  project_chain = null
} = {}) {
  return scrubSecretsDeep({
    invite_agent: {
      label: "Invite Agent",
      plane: "v7.7.6_workspace_invite",
      authority: "operator_mint_only",
      rest: {
        mint: "POST /v1/workspace-invites",
        get: "GET /v1/workspace-invites/:invite_id",
        revoke: "POST /v1/workspace-invites/:invite_id/revoke"
      },
      mcp_claim: "cairnstone_workspace_invite_claim",
      console_panel: "Invite",
      continuation_prompt: CONTINUATION_PROMPT,
      notes: [
        "Reuses principal-bound V7.7.6 invite + mailbox claim — no second ticket format.",
        "AC1 notices carry invite_id/fingerprint/instructions only; never raw workspace bearers.",
        "Invited model claims with mailbox capability, resolves this Code Session, compiles context, continues."
      ],
      binds: { workspace_id, code_session_id }
    },
    send_message: {
      label: "Send Message",
      plane: "ac1_correspondence",
      mcp: "cairnstone_send_message",
      rest: "POST /v1/messages (via MCP/send handlers)",
      notes: [
        "Ordinary AC1 compose — transports intent only.",
        "Does not mint grants, widen scopes, or move accepted-state HEADs."
      ],
      suggested_body: CONTINUATION_PROMPT,
      suggested_subject: "Continue Code Session",
      binds: { code_session_id, chain: project_chain }
    },
    checkpoints: {
      label: "Checkpoints",
      plane: "v7.7.7b_code_checkpoint",
      mcp_list: "cairnstone_code_checkpoint_list",
      mcp_get: "cairnstone_code_checkpoint_get",
      mcp_create: "cairnstone_code_checkpoint_create",
      rest_list: "POST /v1/code-checkpoints/list",
      rest_create: "POST /v1/code-checkpoints",
      notes: [
        "List/create use existing checkpoint APIs with workspace_capability + membership.",
        "Create requires write_draft; never accepted-state authority."
      ],
      binds: { code_session_id }
    },
    view_work: {
      label: "View Work",
      plane: "v7.7.5_workspace + v7.7.7d_tree",
      mcp: [
        "cairnstone_workspace_ls",
        "cairnstone_workspace_diff",
        "cairnstone_workspace_tree_ls",
        "cairnstone_workspace_tree_diff",
        "cairnstone_code_session_compile_context"
      ],
      rest: [
        "POST /v1/workspaces/ls",
        "POST /v1/workspaces/tree/ls",
        "POST /v1/workspaces/tree/diff",
        "POST /v1/code-sessions/context"
      ],
      notes: [
        "Draft/working-tree inspection only.",
        "Git/GitZip success is transport evidence, not accepted state."
      ],
      binds: { workspace_id, code_session_id }
    },
    propose_merge: {
      label: "Propose / Merge",
      plane: "v7.7.5c_propose_accept",
      mcp: "cairnstone_workspace_propose_accept",
      rest: "POST /v1/workspaces/propose-accept",
      requires_scope: "propose",
      accepted_state_authority: false,
      notes: [
        "Only through existing propose/accept paths — Console does not add merge/deploy authority.",
        "Sandbox test success never implies production mutation.",
        "Canonical HEAD moves remain separate explicit accepted-state actions."
      ],
      binds: { workspace_id, code_session_id }
    }
  });
}

export function projectNameFromWorkspaceAndSession(workspace, session) {
  if (workspace?.name) return String(workspace.name);
  if (session?.project_chain) return String(session.project_chain);
  if (Array.isArray(session?.source_repos) && session.source_repos[0]) {
    return String(session.source_repos[0]);
  }
  return session?.workspace_id || "Untitled project";
}

export function lifecycleDisplay(lifecycle) {
  const value = String(lifecycle || "unknown").toLowerCase();
  if (value === "active") return "Active";
  if (value === "paused") return "Paused";
  if (value === "blocked") return "Blocked";
  if (value === "proposed") return "Proposed";
  if (value === "closed") return "Closed";
  if (value === "superseded") return "Superseded";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Build the operator Console snapshot from a compiled context + optional
 * checkpoints/receipts/workspace metadata. Pure aggregation — no new writes.
 */
export function buildConsoleViewFromContext({
  context,
  workspace = null,
  checkpoints = [],
  receipts = [],
  nowMs = Date.now()
} = {}) {
  if (!context?.ok) {
    return context && context.ok === false
      ? context
      : { ok: false, error: "code_session_console_context_required", ...authorityClosedFields() };
  }

  const changeSet = context.changes_since_last_checkpoint || {};
  const tree = countWorkingTree(changeSet);
  const conflicts = Array.isArray(context.unresolved_issues)
    ? context.unresolved_issues.filter(issue =>
      /conflict|cas|rebase/i.test(String(issue?.kind || issue?.type || issue?.code || issue?.title || ""))
    ).length
    : 0;

  const activeTasks = context.task_ledger_summary?.active
    || (context.task_ledger || []).filter(task =>
      ["queued", "claimed", "active", "blocked", "review"].includes(String(task.state || ""))
    );
  const currentTask = activeTasks[0]
    || (context.latest_checkpoint?.current_task
      ? { title: context.latest_checkpoint.current_task, state: "from_checkpoint" }
      : null);

  const actors = deriveConsoleActors({
    actors: context.actors,
    known_concurrent_actors: context.known_concurrent_actors,
    active_task_leases: context.active_task_leases,
    checkpoints,
    task_ledger: context.task_ledger,
    nowMs
  });

  const tests = summarizeConsoleTests(receipts);
  const projectName = projectNameFromWorkspaceAndSession(workspace, {
    project_chain: context.project?.chain,
    source_repos: context.project?.repos,
    workspace_id: context.workspace?.workspace_id
  });

  const actions = buildConsoleActionCatalog({
    code_session_id: context.code_session_id,
    workspace_id: context.workspace?.workspace_id,
    project_chain: context.project?.chain || null
  });

  const surface = {
    project: {
      name: projectName,
      chain: context.project?.chain || null,
      repos: context.project?.repos || [],
      workspace_id: context.workspace?.workspace_id || null,
      scope: context.project?.scope || null
    },
    persistent_code_session: {
      code_session_id: context.code_session_id,
      lifecycle: context.lifecycle,
      display: lifecycleDisplay(context.lifecycle),
      session_revision: context.session_revision,
      tip_vector_digest: context.workspace?.tip_vector_digest || null,
      latest_checkpoint_id: context.latest_checkpoint?.checkpoint_id || null
    },
    current_task: currentTask
      ? {
        task_id: currentTask.task_id || null,
        title: currentTask.title || currentTask.task_id || "Untitled task",
        state: currentTask.state || null,
        actor_id: currentTask.actor_id || currentTask.author || null
      }
      : null,
    actors,
    tests,
    working_tree: {
      modified: tree.modified,
      added: tree.added,
      deleted: tree.deleted,
      conflicts,
      tip_count: context.workspace?.tip_count ?? context.workspace?.tree_stats?.tip_count ?? null,
      tip_vector_digest: context.workspace?.tip_vector_digest || null,
      summary: `${tree.modified} modified · ${tree.added} added · ${conflicts} conflicts`
    },
    checkpoints: {
      latest: context.latest_checkpoint
        ? {
          checkpoint_id: context.latest_checkpoint.checkpoint_id,
          boundary: context.latest_checkpoint.boundary || null,
          actor_id: context.latest_checkpoint.actor_id || null,
          created_at: checkpoints.find(c => c.checkpoint_id === context.latest_checkpoint.checkpoint_id)?.created_at || null,
          age: relativeAge(
            checkpoints.find(c => c.checkpoint_id === context.latest_checkpoint.checkpoint_id)?.created_at,
            nowMs
          )
        }
        : null,
      recent: checkpoints.slice(0, 8).map(cp => ({
        checkpoint_id: cp.checkpoint_id,
        actor_id: cp.actor_id,
        boundary: cp.boundary,
        created_at: cp.created_at,
        age: relativeAge(cp.created_at, nowMs),
        session_revision: cp.session_revision
      })),
      count_returned: checkpoints.length
    },
    environment_sandbox: context.environment_sandbox
      ? scrubSecretsDeep({
        environment_manifest_id: context.environment_manifest_id || null,
        latest_sandbox_attachment_id: context.latest_sandbox_attachment_id || null,
        sandbox_attachment: context.environment_sandbox.sandbox_attachment || null,
        secrets_absent: true,
        sandbox_local_execution_only: true,
        production_mutation_authority: false,
        accepted_state_authority: false
      })
      : null,
    next_safe_continuation: context.next_safe_continuation || null,
    permissions: context.permissions
      ? scrubSecretsDeep({
        actor_id: context.permissions.actor_id,
        membership_role: context.permissions.membership_role,
        scopes: context.permissions.scopes,
        path_prefix: context.permissions.path_prefix,
        capability_policy_profile_id: context.permissions.capability_policy_profile_id,
        accepted_state_authority: false,
        execution_authority: false
      })
      : null,
    actions,
    operator_surface: {
      project_label: "PROJECT",
      project_value: projectName,
      session_label: "PERSISTENT CODE SESSION",
      session_value: lifecycleDisplay(context.lifecycle),
      current_task_label: "Current task",
      current_task_value: currentTask?.title || currentTask?.task_id || "None",
      actors_label: "Actors",
      actors_lines: actors.map(a => {
        const detail = a.detail ? ` · ${a.detail}` : "";
        return `${a.display}     ${a.status}${detail}`;
      }),
      tests_label: "Tests",
      tests_value: tests.summary,
      working_tree_label: "Working tree",
      working_tree_value: `${tree.modified} modified · ${tree.added} added · ${conflicts} conflicts`,
      buttons: ["Invite Agent", "Send Message", "Checkpoints", "View Work", "Propose / Merge"]
    },
    continuation_prompt: CONTINUATION_PROMPT,
    content_identity: context.content_identity || null
  };

  return scrubSecretsDeep({
    ok: true,
    schema: CODE_SESSION_CONSOLE_VIEW_SCHEMA,
    ...surface,
    ...authorityClosedFields()
  });
}

export async function codeSessionConsoleViewFromBody(body = {}, env = {}) {
  if (!isObject(body)) {
    return { ok: false, error: "invalid_code_session_console_view_body", ...authorityClosedFields() };
  }

  // Reuse compile-context auth + aggregation; console is a projection, not a
  // separate trust root. Required scopes match compile_context (read).
  const context = await compileCodeSessionContextFromBody(body, env);
  if (!context?.ok) return context;

  const db = env?.CAIRNSTONE_DB;
  if (!db) {
    return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB", ...authorityClosedFields() };
  }

  const workspace = context.workspace?.workspace_id
    ? await getWorkspace(db, context.workspace.workspace_id)
    : null;

  const checkpointList = await listCodeCheckpoints(db, {
    code_session_id: context.code_session_id,
    limit: Math.min(Math.max(Number(body.checkpoint_limit) || 12, 1), 50)
  });
  const checkpoints = checkpointList?.ok ? checkpointList.checkpoints : [];

  const receiptList = await listExecutionReceipts(db, {
    code_session_id: context.code_session_id,
    limit: Math.min(Math.max(Number(body.receipt_limit) || 12, 1), 50)
  });
  const receipts = receiptList?.ok ? receiptList.receipts : [];

  return buildConsoleViewFromContext({
    context,
    workspace,
    checkpoints,
    receipts
  });
}

export const CODE_SESSION_CONSOLE_VIEW_TOOL_DEFINITION = Object.freeze({
  name: CODE_SESSION_CONSOLE_BROKER_TOOL_IDS.view,
  description: "V7.7.7f: operator Console snapshot for one Code Session (project, lifecycle, current task, actors, tests, working tree, action catalog). Thin aggregation over compile-context + checkpoints + receipts. Scoped_grant read only; never automatic-read; never accepted-state authority; never returns raw capability bearers. Invite Agent maps to existing V7.7.6 mint/claim — Console grants no new authority.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability"],
    properties: {
      code_session_id: { type: "string" },
      actor_id: { type: "string" },
      workspace_capability: { type: "string" },
      checkpoint_limit: { type: "number", minimum: 1, maximum: 50 },
      receipt_limit: { type: "number", minimum: 1, maximum: 50 }
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_CONSOLE_MCP_TOOL_DEFINITIONS = Object.freeze([
  CODE_SESSION_CONSOLE_VIEW_TOOL_DEFINITION
]);
