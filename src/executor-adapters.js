// V7.7.10d / 10d.1 — Executor adapter contracts + stubs / dry-run
//
// Adapters are invoked ONLY after human_commit dispatch. Coding / AFO /
// Copilot / Cursor paths record async stub jobs (adapter_live=false,
// dry_run=true) unless a safe live hook already exists. Deterministic MCP
// may run one bounded allowlisted read and attach a receipt.
// Never stores raw API keys. Never moves HEADs.
//
// V7.7.10d.1: never dump large compiled context into a CairnStone-native
// executor prompt — dispatch min task envelope + refs only. External
// executors get a bounded provenance-preserving compiled pack + receipts.

import {
  getExecutorProfile,
  CONTEXT_MODES,
  CONTEXT_RESOLUTION,
  COMPILED_CONTEXT_BUDGET,
  resolveContextResolution
} from "./executor-profile.js";

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
  context_mode: CONTEXT_MODES.compiled_context,
  live_path: false,
  notes: "Contract only in 10d — dry-run stub unless a safe live GitHub Copilot hook exists. Compiled context."
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
  context_mode: CONTEXT_MODES.cairnstone_native,
  live_path: false,
  notes: "Contract only in 10d — dry-run stub. CairnStone-native context capable."
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
    base_commit_sha: base_commit_sha || contextEnvelope.envelope?.immutable_base_sha || null,
    adapter_contract: adapterContractMeta,
    context_mode: contextEnvelope.context_mode,
    context_resolution: contextEnvelope.context_resolution,
    compiled_pack_included: contextEnvelope.compiled_pack_included === true,
    compiled_pack_receipt_digest: contextEnvelope.compiled_pack?.receipt_digest || null,
    dispatch_envelope: contextEnvelope.envelope,
    result_summary: `dry-run stub job recorded for ${executor_id}; context_resolution=${contextEnvelope.context_resolution}; live adapter not invoked`,
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
