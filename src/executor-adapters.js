// V7.7.10d / 10d.1 / 10d.3 — Executor adapter contracts + stubs / live hooks
//
// Adapters are invoked ONLY after human_commit dispatch. Coding / AFO /
// Copilot / Cursor paths record async stub jobs (adapter_live=false,
// dry_run=true) unless Worker secrets + allowlists enable a gated live path.
// Deterministic MCP may run one bounded allowlisted read and attach a receipt.
// Never stores raw API keys. Never moves HEADs. Never claims stub as live.
//
// V7.7.10d.1: never dump large compiled context into a CairnStone-native
// executor prompt — dispatch min task envelope + refs only. External
// executors get a bounded provenance-preserving compiled pack + receipts.
// V7.7.10d.3: GitHub Copilot Agent Tasks + Cursor Cloud Agents API v1 adapters.

import {
  getExecutorProfile,
  CONTEXT_MODES,
  CONTEXT_RESOLUTION,
  COMPILED_CONTEXT_BUDGET,
  resolveContextResolution
} from "./executor-profile.js";
import {
  dispatchGitHubCopilotTask,
  getGitHubCopilotTaskStatus,
  cancelGitHubCopilotTask,
  probeGitHubCopilotHealth
} from "./github-copilot-adapter.js";
import {
  dispatchCursorCloudAgent,
  getCursorCloudRunStatus,
  cancelCursorCloudRun,
  probeCursorCloudHealth
} from "./cursor-cloud-adapter.js";
import {
  normalizeFullSha,
  CODING_AGENT_SECRET_NAMES
} from "./coding-agent-common.js";

export const ADAPTER_JOB_SCHEMA = "cairnstone-executor-adapter-job-v1";
export const ADAPTER_RECEIPT_SCHEMA = "cairnstone-executor-adapter-receipt-v1";
export const DISPATCH_ENVELOPE_SCHEMA = "cairnstone-executor-dispatch-envelope-v1";
export const COMPILED_CONTEXT_PACK_SCHEMA = "cairnstone-executor-compiled-context-pack-v1";

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

function codingAgentTokenConfigured(executor_id, env) {
  if (!env) return false;
  if (executor_id === "exec:github-copilot") {
    return typeof env[CODING_AGENT_SECRET_NAMES.github_copilot_token] === "string"
      && env[CODING_AGENT_SECRET_NAMES.github_copilot_token].trim().length > 0;
  }
  if (executor_id === "exec:cursor-cloud") {
    return typeof env[CODING_AGENT_SECRET_NAMES.cursor_cloud_api_key] === "string"
      && env[CODING_AGENT_SECRET_NAMES.cursor_cloud_api_key].trim().length > 0;
  }
  return false;
}

function requireImmutableBaseSha(contextEnvelope, base_commit_sha) {
  const sha = normalizeFullSha(
    base_commit_sha
    || contextEnvelope?.envelope?.immutable_base_sha
    || contextEnvelope?.compiled_pack?.immutable_base_sha
  );
  if (!sha) {
    return {
      ok: false,
      error: "immutable_base_sha_required",
      detail: "Coding-agent live dispatch requires an exact 40-hex immutable base SHA",
      ...authorityClosedFields()
    };
  }
  return { ok: true, immutable_base_sha: sha };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true
  };
}

function utf8ByteLength(value) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  // Fallback approximate
  return Buffer.byteLength(String(value), "utf8");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function simpleDigest(text) {
  // Deterministic non-crypto receipt digest for stub packs (not a security hash).
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a32:${(h >>> 0).toString(16).padStart(8, "0")}`;
}

function extractRepoSha(refs = []) {
  for (const ref of refs) {
    const s = String(ref || "");
    const m = s.match(/@([0-9a-f]{7,40})\b/i) || s.match(/\brepo_sha:([0-9a-f]{7,40})\b/i);
    if (m) return m[1];
  }
  return null;
}

function normalizeAccessGrantIds(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of list) {
    if (!isNonEmptyString(item)) continue;
    out.push(String(item).trim().slice(0, 128));
  }
  return [...new Set(out)].slice(0, 32);
}

/**
 * Build dispatch context for an executor.
 * - cairnstone_native → minimum task envelope + canonical refs (NO large body)
 * - compiled_context → bounded provenance-preserving pack + omission/receipt
 *
 * Fail closed if a forced compiled body exceeds COMPILED_CONTEXT_BUDGET.
 */
export function buildDispatchContextEnvelope({
  executor_id,
  task_run = null,
  route_receipt = null,
  base_commit_sha = null,
  access_grant_ids = null,
  scope_hints = null,
  compiled_body = null,
  compiled_pack_budget = null,
  force_compiled_pack = false
} = {}) {
  const profileResult = getExecutorProfile(executor_id);
  if (!profileResult.ok) return { ...profileResult, ...authorityClosedFields() };
  const profile = profileResult.executor;

  const contextMeta = route_receipt?.context_mode
    ? {
      context_mode: route_receipt.context_mode,
      context_resolution: route_receipt.context_resolution,
      context_resolution_reason: route_receipt.context_resolution_reason,
      requires_compiled_context: route_receipt.requires_compiled_context === true,
      compiled_pack_required: route_receipt.compiled_pack_required === true,
      supported_ref_types: route_receipt.supported_ref_types || profile.supported_ref_types,
      context_resolution_endpoint: route_receipt.context_resolution_endpoint
        ?? profile.context_resolution_endpoint
    }
    : resolveContextResolution(profile, {
      selection_reason: route_receipt?.selection_reason || null
    });

  const attachmentRefs = Array.isArray(task_run?.attachment_refs) ? [...task_run.attachment_refs] : [];
  const objectRefs = Array.isArray(task_run?.object_refs) ? [...task_run.object_refs] : [];
  const allRefs = [...new Set([...attachmentRefs, ...objectRefs])];
  const immutableBaseSha = base_commit_sha
    || task_run?.base_commit_sha
    || extractRepoSha(allRefs)
    || null;
  const grants = normalizeAccessGrantIds(
    access_grant_ids
    || task_run?.access_grant_ids
    || task_run?.grant_ids
    || []
  );
  const scopes = Array.isArray(scope_hints)
    ? scope_hints.map(s => String(s).trim()).filter(Boolean).slice(0, 16)
    : (Array.isArray(task_run?.scope_hints) ? task_run.scope_hints.slice(0, 16) : []);

  const minEnvelope = {
    schema: DISPATCH_ENVELOPE_SCHEMA,
    envelope_kind: "min_task_envelope",
    task_run_id: task_run?.task_run_id || null,
    selected_executor_id: executor_id,
    intent: task_run?.requested_intent || null,
    note: task_run?.note || null,
    attachment_refs: attachmentRefs,
    object_refs: objectRefs,
    scope_hints: scopes,
    access_grant_ids: grants,
    immutable_base_sha: immutableBaseSha,
    code_session_id: task_run?.code_session_id || null,
    parent_task_run_id: task_run?.parent_task_run_id || null,
    // Explicitly omit large compiled bodies for native mode
    compiled_body_omitted: true,
    compiled_pack: null
  };

  const wantsNative = contextMeta.context_mode === CONTEXT_MODES.cairnstone_native
    && force_compiled_pack !== true;

  if (wantsNative) {
    // Hard invariant: native dispatch never carries a large compiled dump
    if (isNonEmptyString(compiled_body) && String(compiled_body).length > 0) {
      return {
        ok: false,
        error: "native_executor_rejects_compiled_body_dump",
        detail: "CairnStone-native executors resolve canonical refs themselves; do not transmit compiled prompt dumps",
        context_mode: CONTEXT_MODES.cairnstone_native,
        context_resolution: CONTEXT_RESOLUTION.reference_only_native,
        ...authorityClosedFields()
      };
    }
    return {
      ok: true,
      schema: DISPATCH_ENVELOPE_SCHEMA,
      context_mode: CONTEXT_MODES.cairnstone_native,
      context_resolution: CONTEXT_RESOLUTION.reference_only_native,
      context_resolution_reason: contextMeta.context_resolution_reason
        || "executor_cairnstone_aware_resolves_canonical_refs",
      requires_compiled_context: false,
      compiled_pack_required: false,
      compiled_pack_included: false,
      envelope: minEnvelope,
      compiled_pack: null,
      supported_ref_types: [...(contextMeta.supported_ref_types || [])],
      context_resolution_endpoint: contextMeta.context_resolution_endpoint || null,
      ...authorityClosedFields()
    };
  }

  // compiled_context path — bounded provenance-preserving pack
  const budget = {
    ...COMPILED_CONTEXT_BUDGET,
    ...(isObject(compiled_pack_budget) ? compiled_pack_budget : {})
  };
  const omissions = [];
  let body = isNonEmptyString(compiled_body) ? String(compiled_body) : null;
  if (body && body.length > budget.max_body_chars) {
    return {
      ok: false,
      error: "compiled_context_budget_exceeded",
      detail: "compiled_body exceeds max_body_chars; fail closed (no unbounded dump)",
      max_body_chars: budget.max_body_chars,
      actual_chars: body.length,
      context_mode: CONTEXT_MODES.compiled_context,
      ...authorityClosedFields()
    };
  }

  if (!body) {
    // Deterministic stub body: provenance refs + short intent only (not a vault dump)
    const stubLines = [
      `task_run_id=${minEnvelope.task_run_id || ""}`,
      `intent=${minEnvelope.intent || ""}`,
      `note=${(minEnvelope.note || "").slice(0, 512)}`,
      `refs=${allRefs.slice(0, budget.max_refs).join(",")}`,
      `immutable_base_sha=${immutableBaseSha || ""}`,
      `access_grant_ids=${grants.join(",")}`
    ];
    body = stubLines.join("\n");
    omissions.push({
      kind: "full_stone_bodies",
      reason: "compiled_stub_omits_unbounded_stone_bodies"
    });
    omissions.push({
      kind: "vault_dump",
      reason: "never_transmit_blanket_vault"
    });
  }

  if (allRefs.length > budget.max_refs) {
    omissions.push({
      kind: "excess_refs",
      reason: "refs_truncated_to_budget",
      omitted_count: allRefs.length - budget.max_refs
    });
  }

  const pack = {
    schema: COMPILED_CONTEXT_PACK_SCHEMA,
    pack_kind: "bounded_provenance_preserving",
    task_run_id: minEnvelope.task_run_id,
    selected_executor_id: executor_id,
    provenance_refs: allRefs.slice(0, budget.max_refs),
    immutable_base_sha: immutableBaseSha,
    access_grant_ids: grants,
    scope_hints: scopes,
    body,
    body_chars: body.length,
    omissions: omissions.slice(0, budget.max_omission_entries),
    budget: {
      max_pack_bytes: budget.max_pack_bytes,
      max_body_chars: budget.max_body_chars,
      max_refs: budget.max_refs
    }
  };
  pack.receipt_digest = simpleDigest(stableJson({
    provenance_refs: pack.provenance_refs,
    immutable_base_sha: pack.immutable_base_sha,
    body: pack.body,
    omissions: pack.omissions
  }));

  const packBytes = utf8ByteLength(stableJson(pack));
  if (packBytes > budget.max_pack_bytes) {
    return {
      ok: false,
      error: "compiled_context_budget_exceeded",
      detail: "compiled pack exceeds max_pack_bytes; fail closed",
      max_pack_bytes: budget.max_pack_bytes,
      actual_bytes: packBytes,
      context_mode: CONTEXT_MODES.compiled_context,
      ...authorityClosedFields()
    };
  }

  return {
    ok: true,
    schema: DISPATCH_ENVELOPE_SCHEMA,
    context_mode: CONTEXT_MODES.compiled_context,
    context_resolution: CONTEXT_RESOLUTION.compiled_transmitted,
    context_resolution_reason: contextMeta.context_resolution_reason
      || "executor_requires_compiled_context_no_cairnstone_access",
    requires_compiled_context: true,
    compiled_pack_required: true,
    compiled_pack_included: true,
    envelope: {
      ...minEnvelope,
      envelope_kind: "compiled_context_envelope",
      compiled_body_omitted: false,
      compiled_pack: { receipt_digest: pack.receipt_digest, body_chars: pack.body_chars }
    },
    compiled_pack: pack,
    supported_ref_types: [...(contextMeta.supported_ref_types || [])],
    context_resolution_endpoint: contextMeta.context_resolution_endpoint || null,
    ...authorityClosedFields()
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
    context_mode: profile.executor.context_mode,
    requires_compiled_context: profile.executor.requires_compiled_context,
    supported_ref_types: [...(profile.executor.supported_ref_types || [])],
    contract: {
      verify_availability: true,
      pin_immutable_base_sha: Boolean(profile.executor.bounds?.requires_immutable_base_sha),
      carry_attachment_refs: true,
      return_async_status: profile.executor.execution_mode === "async",
      attach_evidence_to_task_run: true,
      never_self_accept: true,
      never_store_raw_secrets: true,
      discovery_over_stale_schemas: true,
      // 10d.1
      cairnstone_native_context: profile.executor.context_mode === CONTEXT_MODES.cairnstone_native,
      omit_compiled_prompt_dump_when_native: true
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
    "github_copilot_task_status",
    "github_copilot_task_cancel_local_only"
  ]),
  requirements: Object.freeze([
    "verify_copilot_availability_for_repo",
    "pin_immutable_base_sha",
    "bounded_instructions_and_attachment_refs",
    "return_github_task_or_session_identity",
    "async_completion_status",
    "attach_pr_diff_test_evidence",
    "never_treat_pr_as_accepted",
    "fail_closed_without_token_or_allowlist",
    "idempotent_dispatch_per_task_run"
  ]),
  context_mode: CONTEXT_MODES.compiled_context,
  // live_path means the code path exists; availability still requires secrets + probe.
  live_path: true,
  live_path_gated_by: Object.freeze([
    CODING_AGENT_SECRET_NAMES.github_copilot_token,
    CODING_AGENT_SECRET_NAMES.github_copilot_allowed_repo
  ]),
  notes: "10d.3: gated live path via GitHub Agent Tasks API. Stub/blocked until token + allowlist + live evidence."
});

export const CURSOR_ADAPTER_CONTRACT = Object.freeze({
  adapter_id: "adapter:cursor-cloud-v1",
  operations: Object.freeze([
    "cursor_cloud_task_dispatch",
    "cursor_cloud_task_status",
    "cursor_cloud_task_cancel"
  ]),
  requirements: Object.freeze([
    "verify_cursor_agent_availability",
    "pin_immutable_base_sha",
    "bounded_instructions_and_attachment_refs",
    "return_job_or_agent_run_identity",
    "async_completion_status",
    "attach_pr_diff_test_evidence",
    "never_treat_result_as_accepted",
    "fail_closed_without_token_or_allowlist",
    "idempotent_dispatch_per_task_run"
  ]),
  context_mode: CONTEXT_MODES.cairnstone_native,
  live_path: true,
  live_path_gated_by: Object.freeze([
    CODING_AGENT_SECRET_NAMES.cursor_cloud_api_key,
    CODING_AGENT_SECRET_NAMES.cursor_cloud_allowed_repo_url
  ]),
  notes: "10d.3: gated live path via Cursor Cloud Agents API v1. Stub/blocked until API key + allowlist + live evidence."
});

export { probeGitHubCopilotHealth, probeCursorCloudHealth };

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
  context_mode: CONTEXT_MODES.compiled_context,
  live_path: false,
  notes: "AFO specialist adapter contract + stub. Compiled context required."
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
  context_mode: CONTEXT_MODES.cairnstone_native,
  live_path: false,
  notes: "Does not auto-run; dry-run stub records intent to use existing delegate path. Native context."
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
  access_grant_ids = null,
  scope_hints = null,
  compiled_body = null,
  compiled_pack_budget = null,
  force_compiled_pack = false,
  now = null
} = {}) {
  const contract = baseAdapterContract(executor_id);
  if (!contract.ok) return contract;

  const createdAt = now || new Date().toISOString();
  const jobId = `adjobs:${crypto.randomUUID()}`;
  const receiptId = `adrcpt:${crypto.randomUUID()}`;

  const contextEnvelope = buildDispatchContextEnvelope({
    executor_id,
    task_run,
    route_receipt,
    base_commit_sha,
    access_grant_ids,
    scope_hints,
    compiled_body,
    compiled_pack_budget,
    force_compiled_pack
  });
  if (!contextEnvelope.ok) {
    return {
      ok: false,
      error: contextEnvelope.error || "dispatch_context_envelope_failed",
      detail: contextEnvelope,
      ...authorityClosedFields()
    };
  }

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
      context_mode: contextEnvelope.context_mode,
      context_resolution: contextEnvelope.context_resolution,
      compiled_pack_included: false,
      dispatch_envelope: contextEnvelope.envelope,
      result_summary: status === "completed"
        ? `deterministic-mcp executed allowlisted read ${toolId} (reference_only_native)`
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
        context_mode: contextEnvelope.context_mode,
        context_resolution: contextEnvelope.context_resolution,
        created_at: createdAt
      },
      receipt,
      dispatch_context: contextEnvelope,
      dispatch_state: status === "completed" ? "completed" : "failed",
      task_status: status === "completed" ? "completed" : "failed",
      ...authorityClosedFields()
    };
  }

  // Coding agents: gated live path when Worker secrets are configured.
  // Without secrets → dry-run stub (never claims live). With secrets → fail closed
  // on missing SHA / allowlist / permission; never invent running/complete.
  if (executor_id === "exec:github-copilot" || executor_id === "exec:cursor-cloud") {
    const wantsLive = codingAgentTokenConfigured(executor_id, env);
    if (wantsLive) {
      const shaGate = requireImmutableBaseSha(contextEnvelope, base_commit_sha);
      if (!shaGate.ok) return shaGate;

      const fetchImpl = env?.__coding_agent_fetch || null;
      const sleepFn = env?.__coding_agent_sleep || null;
      const existingExternal = isObject(task_run?.external_job)
        ? task_run.external_job
        : (isObject(env?.__existing_external_job) ? env.__existing_external_job : null);

      let live = null;
      if (executor_id === "exec:github-copilot") {
        live = await dispatchGitHubCopilotTask({
          env,
          task_run,
          envelope: contextEnvelope.envelope,
          compiled_pack: contextEnvelope.compiled_pack,
          immutable_base_sha: shaGate.immutable_base_sha,
          existing_external_task_id: existingExternal?.external_task_id || null,
          fetchImpl,
          sleepFn,
          now: createdAt
        });
      } else {
        live = await dispatchCursorCloudAgent({
          env,
          task_run,
          envelope: contextEnvelope.envelope,
          immutable_base_sha: shaGate.immutable_base_sha,
          existing_external_agent_id: existingExternal?.external_agent_id || null,
          existing_external_run_id: existingExternal?.external_run_id || null,
          fetchImpl,
          sleepFn,
          now: createdAt
        });
      }

      if (!live.ok) {
        return {
          ok: false,
          error: live.error || "coding_agent_live_dispatch_failed",
          detail: live,
          dispatch_context: contextEnvelope,
          ...authorityClosedFields()
        };
      }

      const adapterContractMeta = executor_id === "exec:github-copilot"
        ? COPILOT_ADAPTER_CONTRACT
        : CURSOR_ADAPTER_CONTRACT;
      const externalJob = {
        provider: live.provider,
        ...(live.external_identity || {}),
        external_task_id: live.external_task_id || null,
        external_agent_id: live.external_agent_id || null,
        external_run_id: live.external_run_id || null,
        immutable_base_sha: live.immutable_base_sha || shaGate.immutable_base_sha
      };
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
        status: live.task_status || "queued",
        sync: false,
        base_commit_sha: shaGate.immutable_base_sha,
        external_job: externalJob,
        provider_state: live.provider_state || null,
        idempotent_replay: live.idempotent_replay === true,
        adapter_contract: adapterContractMeta,
        context_mode: contextEnvelope.context_mode,
        context_resolution: contextEnvelope.context_resolution,
        compiled_pack_included: contextEnvelope.compiled_pack_included === true,
        compiled_pack_receipt_digest: contextEnvelope.compiled_pack?.receipt_digest || null,
        dispatch_envelope: contextEnvelope.envelope,
        pr_refs: live.pr_refs || [],
        artifact_refs: live.artifact_refs || [],
        result_summary: live.result_summary || `live ${executor_id} dispatched`,
        failure_reason: live.failure_reason || null,
        created_at: createdAt,
        completed_at: ["completed", "failed", "cancelled"].includes(live.task_status) ? createdAt : null,
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
          status: live.task_status || "queued",
          async: true,
          dry_run: false,
          adapter_live: true,
          external_job: externalJob,
          context_mode: contextEnvelope.context_mode,
          context_resolution: contextEnvelope.context_resolution,
          created_at: createdAt
        },
        receipt,
        dispatch_context: contextEnvelope,
        dispatch_state: live.dispatch_state || "dispatched",
        task_status: live.task_status || "queued",
        pr_refs: live.pr_refs || [],
        artifact_refs: live.artifact_refs || [],
        ...authorityClosedFields()
      };
    }
  }

  // Stub / dry-run path for coding agents (no token), AFO, delegate
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
    base_commit_sha: base_commit_sha || contextEnvelope.envelope?.immutable_base_sha || null,
    adapter_contract: adapterContractMeta,
    context_mode: contextEnvelope.context_mode,
    context_resolution: contextEnvelope.context_resolution,
    compiled_pack_included: contextEnvelope.compiled_pack_included === true,
    compiled_pack_receipt_digest: contextEnvelope.compiled_pack?.receipt_digest || null,
    dispatch_envelope: contextEnvelope.envelope,
    result_summary: `dry-run stub job recorded for ${executor_id}; context_resolution=${contextEnvelope.context_resolution}; live adapter not invoked (token absent or not configured)`,
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
      context_mode: contextEnvelope.context_mode,
      context_resolution: contextEnvelope.context_resolution,
      created_at: createdAt
    },
    receipt,
    dispatch_context: contextEnvelope,
    dispatch_state: "dispatched",
    task_status: "queued",
    ...authorityClosedFields()
  };
}

/**
 * Poll provider status for a live coding-agent job. Never invents terminal success.
 */
export async function pollCodingAgentStatus({
  executor_id,
  external_job = null,
  env = null,
  fetchImpl = null,
  sleepFn = null
} = {}) {
  if (!external_job || !isObject(external_job)) {
    return { ok: false, error: "external_job_required", ...authorityClosedFields() };
  }
  const impl = fetchImpl || env?.__coding_agent_fetch || null;
  const sleep = sleepFn || env?.__coding_agent_sleep || null;

  if (executor_id === "exec:github-copilot" || external_job.kind === "github_agent_task") {
    return getGitHubCopilotTaskStatus({
      env,
      owner: external_job.owner || null,
      repo: external_job.repo || null,
      task_id: external_job.external_task_id || external_job.task_id,
      fetchImpl: impl,
      sleepFn: sleep
    });
  }
  if (executor_id === "exec:cursor-cloud" || external_job.kind === "cursor_cloud_agent_run") {
    return getCursorCloudRunStatus({
      env,
      agent_id: external_job.external_agent_id || external_job.agent_id,
      run_id: external_job.external_run_id || external_job.run_id,
      fetchImpl: impl,
      sleepFn: sleep
    });
  }
  return { ok: false, error: "unsupported_coding_agent_executor", ...authorityClosedFields() };
}

/**
 * Provider-side cancel when supported. Copilot: local-only (API has no cancel).
 */
export async function cancelCodingAgentJob({
  executor_id,
  external_job = null,
  env = null,
  fetchImpl = null,
  sleepFn = null
} = {}) {
  const impl = fetchImpl || env?.__coding_agent_fetch || null;
  const sleep = sleepFn || env?.__coding_agent_sleep || null;

  if (executor_id === "exec:github-copilot" || external_job?.kind === "github_agent_task") {
    return cancelGitHubCopilotTask();
  }
  if (executor_id === "exec:cursor-cloud" || external_job?.kind === "cursor_cloud_agent_run") {
    return cancelCursorCloudRun({
      env,
      agent_id: external_job?.external_agent_id || external_job?.agent_id,
      run_id: external_job?.external_run_id || external_job?.run_id,
      fetchImpl: impl,
      sleepFn: sleep
    });
  }
  return {
    ok: true,
    provider_cancel: false,
    provider_cancel_unsupported: true,
    ...authorityClosedFields()
  };
}
