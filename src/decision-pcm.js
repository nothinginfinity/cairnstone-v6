import { routeDecisionFromBody } from "./decision-scorer.js";
import { hydrateSelectedContract } from "./decision-hydrate.js";

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
    Array.isArray(blockers) ? blockers.map((b) => b.title || b.detail || b).join(" ") : ""
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

export async function resolveMappedTool(mapped, deps = {}) {
  if (!mapped) return { status: "none", tool_route: null };
  const validated = await hydrateSelectedContract({ id: mapped.id }, deps);
  if (validated.ok) {
    return {
      status: "hydrated",
      tool_route: {
        ok: true,
        selected: { id: mapped.id, capability: mapped.capability },
        hydrated: validated,
        execution_authority: false
      }
    };
  }
  if (validated.error === "schema_disagreement") {
    return { status: "schema_disagreement", tool_route: { ok: false, hydrated: validated, selected: mapped } };
  }
  if (validated.error === "contract_not_found") {
    return { status: "unavailable", tool_route: { ok: false, error: "mapped_tool_unavailable", selected: mapped } };
  }
  const entry = (deps.decisionRegistry || deps.registry || []).find((item) => item && item.tool_id === mapped.id) || null;
  if (validated.error === "hydrate_not_automatic_read" && entry && entry.risk_class === "read" && entry.authorization === "scoped_grant") {
    return {
      status: "needs_scoped_grant",
      tool_route: {
        ok: false,
        status: "needs_scoped_grant",
        selected: { id: mapped.id, capability: mapped.capability },
        hydrated: null,
        execution_authority: false
      }
    };
  }
  return { status: "fail_closed", tool_route: { ok: false, hydrated: validated, selected: mapped } };
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
    return { ok: false, error: "pcm_context_required", status: "fail_closed", ...closed };
  }
  const nextDecision = await routeDecisionFromBody({
    kind: "next_action",
    task: taskText(context),
    mode: "deterministic",
    candidates: derivePcmNextActionCandidates(context)
  }, deps);
  const mapped = ACTION_TOOL[context.next_safe_continuation?.action];
  const tool = await resolveMappedTool(mapped, deps);
  const fail = tool.status === "schema_disagreement" || tool.status === "unavailable" || tool.status === "fail_closed";
  const ok = Boolean(nextDecision?.ok) && !fail;
  return {
    ok,
    status: fail ? tool.status : (tool.status === "needs_scoped_grant" ? "needs_scoped_grant" : (nextDecision?.ok ? "resolved" : "unresolved")),
    schema: "cairnstone-pcm-decision-v1",
    consumer: "persistent_code_mode",
    slice: "V7.7.10h.4",
    context_digest: context.content_identity?.context_digest || null,
    session_revision: context.session_revision || context.content_identity?.session_revision || null,
    next_action: nextDecision,
    tool_route: tool.tool_route,
    ...closed
  };
}

export { ACTION_TOOL, hydrateSelectedContract };
