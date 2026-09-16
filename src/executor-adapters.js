// V7.7.10d — Executor adapter contracts + stubs / dry-run
//
// Adapters are invoked ONLY after human_commit dispatch. Coding / AFO /
// Copilot / Cursor paths record async stub jobs (adapter_live=false,
// dry_run=true) unless a safe live hook already exists. Deterministic MCP
// may run one bounded allowlisted read and attach a receipt.
// Never stores raw API keys. Never moves HEADs.

import { getExecutorProfile } from "./executor-profile.js";

export const ADAPTER_JOB_SCHEMA = "cairnstone-executor-adapter-job-v1";
export const ADAPTER_RECEIPT_SCHEMA = "cairnstone-executor-adapter-receipt-v1";

/** Bounded allowlist for deterministic-mcp on dispatch. Read-only only. */
export const DETERMINISTIC_MCP_ALLOWLIST = Object.freeze([
  "cairnstone_executor_list",
  "cairnstone_executor_get",
  "cairnstone_executor_health",
  "cairnstone_health"
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true
  };
}

function baseAdapterContract(executorId) {
  const profile = getExecutorProfile(executorId);
  if (!profile.ok) return profile;
  return {
    ok: true,
    executor_id: executorId,
    adapter_id: profile.executor.adapter_id,
    executor_class: profile.executor.executor_class,
    contract: {
      verify_availability: true,
      pin_immutable_base_sha: Boolean(profile.executor.bounds?.requires_immutable_base_sha),
      carry_attachment_refs: true,
      return_async_status: profile.executor.execution_mode === "async",
      attach_evidence_to_task_run: true,
      never_self_accept: true,
      never_store_raw_secrets: true,
      discovery_over_stale_schemas: true
    },
    adapter_live: profile.executor.health?.adapter_live === true,
    dry_run_default: profile.executor.bounds?.dry_run_default !== false
      || profile.executor.health?.dry_run === true
      || profile.executor.availability === "stub",
    ...authorityClosedFields()
  };
}

export function getAdapterContract(executor_id) {
  return baseAdapterContract(executor_id);
}

export const COPILOT_ADAPTER_CONTRACT = Object.freeze({
  adapter_id: "adapter:github-copilot-v1",
  operations: Object.freeze([
    "github_copilot_task_dispatch",
    "github_copilot_task_status"
  ]),
  requirements: Object.freeze([
    "verify_copilot_availability_for_repo",
    "pin_immutable_base_sha",
    "bounded_instructions_and_attachment_refs",
    "return_github_task_or_session_identity",
    "async_completion_status",
    "attach_pr_diff_test_evidence",
    "never_treat_pr_as_accepted"
  ]),
  live_path: false,
  notes: "Contract only in 10d — dry-run stub unless a safe live GitHub Copilot hook exists."
});

export const CURSOR_ADAPTER_CONTRACT = Object.freeze({
  adapter_id: "adapter:cursor-cloud-v1",
  operations: Object.freeze([
    "cursor_cloud_task_dispatch",
    "cursor_cloud_task_status"
  ]),
  requirements: Object.freeze([
    "verify_cursor_agent_availability",
    "pin_immutable_base_sha",
    "bounded_instructions_and_attachment_refs",
    "return_job_or_agent_run_identity",
    "async_completion_status",
    "attach_pr_diff_test_evidence",
    "never_treat_result_as_accepted"
  ]),
  live_path: false,
  notes: "Contract only in 10d — dry-run stub."
});

export const AFO_ADAPTER_CONTRACT = Object.freeze({
  adapter_id: "adapter:afo-specialist-v1",
  operations: Object.freeze([
    "afo_specialist_dispatch",
    "afo_specialist_status"
  ]),
  requirements: Object.freeze([
    "capability_discovery_not_stale_schema_copy",
    "bounded_specialist_work",
    "compact_receipt_return",
    "never_independent_accepted_state_authority"
  ]),
  live_path: false,
  notes: "AFO specialist adapter contract + stub."
});

export const DELEGATE_ADAPTER_CONTRACT = Object.freeze({
  adapter_id: "adapter:cairnstone-delegate-v1",
  operations: Object.freeze([
    "cairnstone_delegate_dispatch_stub",
    "cairnstone_delegate_status"
  ]),
  requirements: Object.freeze([
    "points_at_existing_delegate_path",
    "does_not_auto_run_on_route_or_propose",
    "human_commit_required_before_invoke"
  ]),
  live_path: false,
  notes: "Does not auto-run; dry-run stub records intent to use existing delegate path."
});

/**
 * Invoke adapter after human-commit dispatch.
 * @param {object} opts
 * @param {string} opts.executor_id
 * @param {object} opts.task_run
 * @param {object} opts.route_receipt
 * @param {object} [opts.env]
 * @param {function} [opts.invokeAllowlistedRead] - (tool_id, args) => Promise<result>
 */
export async function invokeExecutorAdapter({
  executor_id,
  task_run,
  route_receipt = null,
  env = null,
  invokeAllowlistedRead = null,
  allowlisted_tool_id = "cairnstone_executor_list",
  allowlisted_tool_args = {},
  base_commit_sha = null,
  now = null
} = {}) {
  const contract = baseAdapterContract(executor_id);
  if (!contract.ok) return contract;

  const createdAt = now || new Date().toISOString();
  const jobId = `adjobs:${crypto.randomUUID()}`;
  const receiptId = `adrcpt:${crypto.randomUUID()}`;

  if (executor_id === "exec:deterministic-mcp") {
    const toolId = isNonEmptyString(allowlisted_tool_id)
      ? String(allowlisted_tool_id).trim()
      : "cairnstone_executor_list";
    if (!DETERMINISTIC_MCP_ALLOWLIST.includes(toolId)) {
      return {
        ok: false,
        error: "deterministic_tool_not_allowlisted",
        tool_id: toolId,
        allowlist: [...DETERMINISTIC_MCP_ALLOWLIST],
        ...authorityClosedFields()
      };
    }

    let toolResult = null;
    let toolError = null;
    if (typeof invokeAllowlistedRead === "function") {
      try {
        toolResult = await invokeAllowlistedRead(toolId, allowlisted_tool_args || {}, env);
      } catch (error) {
        toolError = String(error.message || error);
      }
    } else {
      // In-process fallback without env wiring: local list health.
      const { listExecutorProfiles, getExecutorProfile, executorHealth } = await import("./executor-profile.js");
      if (toolId === "cairnstone_executor_list") toolResult = listExecutorProfiles();
      else if (toolId === "cairnstone_executor_get") {
        toolResult = getExecutorProfile(allowlisted_tool_args?.executor_id || "exec:deterministic-mcp");
      } else if (toolId === "cairnstone_executor_health") {
        toolResult = executorHealth(allowlisted_tool_args?.executor_id || null);
      } else if (toolId === "cairnstone_health") {
        toolResult = { ok: true, name: "cairnstone-v6", stub: true, note: "deterministic adapter local health stub" };
      }
    }

    const status = toolError || toolResult?.ok === false ? "failed" : "completed";
    const receipt = {
      schema: ADAPTER_RECEIPT_SCHEMA,
      receipt_id: receiptId,
      job_id: jobId,
      executor_id,
      adapter_id: contract.adapter_id,
      task_run_id: task_run?.task_run_id || null,
      route_receipt_id: route_receipt?.route_receipt_id || null,
      adapter_live: true,
      dry_run: false,
      status,
      sync: true,
      tool_id: toolId,
      tool_result_ok: toolResult?.ok !== false && !toolError,
      tool_error: toolError,
      result_summary: status === "completed"
        ? `deterministic-mcp executed allowlisted read ${toolId}`
        : `deterministic-mcp failed: ${toolError || toolResult?.error || "unknown"}`,
      failure_reason: status === "failed" ? (toolError || toolResult?.error || "tool_failed") : null,
      created_at: createdAt,
      completed_at: createdAt,
      accepted_state_authority: false
    };

    return {
      ok: status === "completed",
      schema: ADAPTER_RECEIPT_SCHEMA,
      job: {
        schema: ADAPTER_JOB_SCHEMA,
        job_id: jobId,
        executor_id,
        adapter_id: contract.adapter_id,
        status,
        async: false,
        created_at: createdAt
      },
      receipt,
      dispatch_state: status === "completed" ? "completed" : "failed",
      task_status: status === "completed" ? "completed" : "failed",
      ...authorityClosedFields()
    };
  }

  // Stub / dry-run path for coding agents, AFO, delegate
  let adapterContractMeta = null;
  if (executor_id === "exec:github-copilot") adapterContractMeta = COPILOT_ADAPTER_CONTRACT;
  else if (executor_id === "exec:cursor-cloud") adapterContractMeta = CURSOR_ADAPTER_CONTRACT;
  else if (executor_id === "exec:afo-specialist") adapterContractMeta = AFO_ADAPTER_CONTRACT;
  else if (executor_id === "exec:cairnstone-delegate") adapterContractMeta = DELEGATE_ADAPTER_CONTRACT;

  const receipt = {
    schema: ADAPTER_RECEIPT_SCHEMA,
    receipt_id: receiptId,
    job_id: jobId,
    executor_id,
    adapter_id: contract.adapter_id,
    task_run_id: task_run?.task_run_id || null,
    route_receipt_id: route_receipt?.route_receipt_id || null,
    adapter_live: false,
    dry_run: true,
    status: "queued",
    sync: false,
    base_commit_sha: base_commit_sha || null,
    adapter_contract: adapterContractMeta,
    result_summary: `dry-run stub job recorded for ${executor_id}; live adapter not invoked`,
    failure_reason: null,
    created_at: createdAt,
    completed_at: null,
    accepted_state_authority: false
  };

  return {
    ok: true,
    schema: ADAPTER_RECEIPT_SCHEMA,
    job: {
      schema: ADAPTER_JOB_SCHEMA,
      job_id: jobId,
      executor_id,
      adapter_id: contract.adapter_id,
      status: "queued",
      async: true,
      dry_run: true,
      adapter_live: false,
      created_at: createdAt
    },
    receipt,
    dispatch_state: "dispatched",
    task_status: "queued",
    ...authorityClosedFields()
  };
}
