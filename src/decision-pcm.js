import { routeDecisionFromBody } from "./decision-scorer.js";

const ACTION_TOOL = Object.freeze({
  inspect_blockers: { id: "cairnstone_find_v2", capability: "stone.search" },
  read_changes_since_checkpoint: { id: "cairnstone_workspace_diff", capability: "workspace.diff" },
  continue_from_tip_after_checkpoint_diff: { id: "cairnstone_workspace_diff", capability: "workspace.diff" },
  read_only_continue: { id: "cairnstone_code_session_compile_context", capability: "code_session.context" },
  continue_active_task: { id: "cairnstone_code_session_compile_context", capability: "code_session.context" },
  resume_then_compile_context: { id: "cairnstone_code_session_compile_context", capability: "code_session.context" }
});

function taskText(context = {}) {
  const next = context.next_safe_continuation || {};
  const task = next.active_task || context.task_ledger_summary?.active?.[0] || {};
  const blockers = context.unresolved_issues || next.unresolved_issues || [];
  return [
    next.action || "",
    next.rationale || "",
    task.title || task.task_id || "",
    Array.isArray(blockers) ? blockers.map((b) => b.title || b.detail || b).join(" ") : "",
    context.changes_since_last_checkpoint?.changed_paths?.join?.(" ") || ""
  ].join(" ").trim();
}

export function derivePcmNextActionCandidates(context = {}) {
  const action = context.next_safe_continuation?.action;
  if (!action || typeof action !== "string") return [];
  return [{
    id: action,
    kind: "next_action",
    capability: action,
    title: action,
    eligible: true
  }];
}

export async function routePcmDecision(context = {}, deps = {}) {
  const closed = {
    accepted_state_authority: false,
    execution_authority: false,
    mutation_authority: false,
    lease_authority: false,
    task_transition_authority: false
  };
  if (!context || context.ok === false) {
    return { ok: false, error: "pcm_context_required", ...closed };
  }
  const nextCandidates = derivePcmNextActionCandidates(context);
  const nextDecision = await routeDecisionFromBody({
    kind: "next_action",
    task: taskText(context),
    mode: "deterministic",
    candidates: nextCandidates
  }, deps);

  const mapped = ACTION_TOOL[context.next_safe_continuation?.action];
  let toolDecision = null;
  if (mapped) {
    toolDecision = await routeDecisionFromBody({
      kind: "tool_route",
      mode: "hydrate",
      task: `${mapped.id} ${mapped.capability} ${taskText(context)}`,
      candidates: [{
        id: mapped.id,
        capability: mapped.capability,
        tool: mapped.id,
        eligible: true
      }]
    }, deps);
  }

  return {
    ok: Boolean(nextDecision && nextDecision.ok),
    schema: "cairnstone-pcm-decision-v1",
    consumer: "persistent_code_mode",
    slice: "V7.7.10h.4",
    context_digest: context.content_identity?.context_digest || null,
    session_revision: context.session_revision || context.content_identity?.session_revision || null,
    next_action: nextDecision,
    tool_route: toolDecision,
    ...closed
  };
}
