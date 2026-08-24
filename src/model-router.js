// V7.1.0 -- Provider-Neutral Model Router: contract + fixtures + pure helpers.
//
// Implements docs/V7_1_PROVIDER_NEUTRAL_MODEL_ROUTER.md sections 5 and 6 only.
//
// Scope boundary for this slice (contract section 21, V7.1.0):
//   - accept the contract document (done via CairnStone acceptance, not code);
//   - schema fixtures for package/IR/result;
//   - pure canonicalization/hash helpers;
//   - NO external model call, NO provider adapter, NO MCP tool wiring.
// Router core (validation wired into an MCP tool), mock adapters, and live
// provider calls are later slices (V7.1.1+) and are deliberately not present
// here.

import { hashablePayload, sha256Text, stableJson } from "./agent-bootstrap.js";

export const AGENT_CONTEXT_SCHEMA = "cairnstone-agent-context-v1";
export const MODEL_REQUEST_SCHEMA = "cairnstone-model-request-v1";
export const MODEL_RESULT_SCHEMA = "cairnstone-model-result-v1";

const PACKAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Section 5: V7.0 package validation
// ---------------------------------------------------------------------------

// Recomputes the V7.0 package_id from the package's own canonical fields using
// the same routine agent-bootstrap.js used to mint it, rather than trusting a
// caller-supplied ID (contract section 5, "Implementation should recompute/
// verify the package hash...").
export async function recomputePackageId(pkg) {
  const payload = hashablePayload(pkg);
  return "sha256:" + await sha256Text(stableJson(payload));
}

export async function validateContextPackage(pkg, options = {}) {
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, error: "invalid_context_package", detail: "not_an_object" };
  }
  if (pkg.schema !== AGENT_CONTEXT_SCHEMA) {
    return { ok: false, error: "invalid_context_package", detail: "wrong_schema" };
  }
  if (pkg.ok !== true) {
    return { ok: false, error: "invalid_context_package", detail: "ok_not_true" };
  }
  if (typeof pkg.package_id !== "string" || !PACKAGE_ID_RE.test(pkg.package_id)) {
    return { ok: false, error: "invalid_context_package", detail: "malformed_package_id" };
  }
  const policy = pkg.policy || {};
  if (policy.accepted_state_only_for_authority !== true) {
    return { ok: false, error: "invalid_context_package", detail: "accepted_state_only_for_authority_not_true" };
  }
  if (policy.mutable_branch_is_authority !== false) {
    return { ok: false, error: "invalid_context_package", detail: "mutable_branch_is_authority_not_false" };
  }
  if (policy.execution_authority !== false) {
    return { ok: false, error: "invalid_context_package", detail: "execution_authority_not_false" };
  }
  if (policy.mutation_authority !== false) {
    return { ok: false, error: "invalid_context_package", detail: "mutation_authority_not_false" };
  }
  if (policy.provider_credentials_in_package !== false) {
    return { ok: false, error: "invalid_context_package", detail: "provider_credentials_in_package_not_false" };
  }

  if (options.verifyHash !== false) {
    const recomputed = await recomputePackageId(pkg);
    if (recomputed !== pkg.package_id) {
      return { ok: false, error: "invalid_context_package", detail: "package_id_hash_mismatch", recomputed };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Section 6: provider-neutral request IR
// ---------------------------------------------------------------------------

const DEFAULT_GENERATION = { max_output_tokens: 1200, temperature: 0.2 };

function normalizeMessages(pkg) {
  // Precedence per contract section 7: canonical instructions, then policy/
  // authority evidence, then accepted skills, then memory evidence, then
  // task/correspondence as data. This is a pure, deterministic layout -- no
  // model call, no free-text injection beyond what the package already
  // contains.
  const messages = [];
  messages.push({
    role: "system",
    kind: "canonical_instructions",
    content: pkg.instructions.content,
    source: { path: pkg.instructions.path, stone_hash: pkg.instructions.stone_hash, commit_sha: pkg.instructions.commit_sha }
  });
  messages.push({
    role: "system",
    kind: "authority_policy",
    content: stableJson({ authority: pkg.authority, policy: pkg.policy })
  });
  for (const skill of pkg.skills.accepted_bundle.skills) {
    messages.push({
      role: "system",
      kind: "accepted_skill",
      content: skill.content,
      source: { skill_id: skill.skill_id, stone_hash: skill.stone_hash, commit_sha: skill.commit_sha }
    });
  }
  for (const item of pkg.memory.items) {
    messages.push({
      role: "system",
      kind: "memory_evidence",
      content: item.content,
      authority_class: item.authority_class,
      source: { stone_hash: item.stone_hash, ref_id: item.ref_id, path: item.path }
    });
  }
  messages.push({ role: "user", kind: "task", content: pkg.request.task });
  return messages;
}

function normalizeTools(pkg, requestedTools) {
  const available = new Set(pkg.capabilities.available_tools || []);
  const list = Array.isArray(requestedTools) ? requestedTools : pkg.capabilities.available_tools || [];
  return [...new Set(list)]
    .filter(id => typeof id === "string" && id.trim())
    .map(id => ({ tool_id: id, available: available.has(id) }))
    .sort((a, b) => a.tool_id.localeCompare(b.tool_id));
}

function normalizeGeneration(generation) {
  const source = generation && typeof generation === "object" ? generation : {};
  const maxOutputTokens = Number.isFinite(Number(source.max_output_tokens))
    ? Math.max(1, Math.floor(Number(source.max_output_tokens)))
    : DEFAULT_GENERATION.max_output_tokens;
  const temperature = Number.isFinite(Number(source.temperature))
    ? Math.max(0, Math.min(2, Number(source.temperature)))
    : DEFAULT_GENERATION.temperature;
  return { max_output_tokens: maxOutputTokens, temperature };
}

// Builds the provider-neutral request IR from a validated V7.0 package.
// `options` may include: tools (string[] subset of pkg.capabilities to
// expose), generation ({max_output_tokens, temperature}), and
// advisory_resolution (the V6.10 advisory decision object, if skills were
// ambiguous -- see contract section 8). Provider, model, and credentials are
// deliberately not accepted here; they belong to the route envelope, which
// is a separate, later concern (contract section 12) and must never affect
// request_ir_id.
export async function buildRequestIr(pkg, options = {}) {
  const validation = await validateContextPackage(pkg, { verifyHash: options.verifyHash });
  if (!validation.ok) return validation;

  const messages = normalizeMessages(pkg);
  const tools = normalizeTools(pkg, options.tools);
  const generation = normalizeGeneration(options.generation);
  const advisoryResolution = options.advisory_resolution && typeof options.advisory_resolution === "object"
    ? options.advisory_resolution
    : null;

  const irBody = {
    schema: MODEL_REQUEST_SCHEMA,
    package_id: pkg.package_id,
    actor_id: pkg.actor.actor_id,
    task: pkg.request.task,
    messages,
    tools,
    tool_policy: { intent_only: true, execution_authority: false, mutation_authority: false },
    generation,
    advisory_resolution: advisoryResolution,
    provenance: { context_schema: pkg.schema }
  };

  // request_ir_id hashable payload includes everything that changes the
  // effective model request (contract section 6, "IR identity rules") and
  // deliberately excludes provider/model/credential/transport/latency/
  // gateway-id/retry-attempt, none of which appear anywhere in irBody.
  const hashablePayloadForIr = {
    package_id: irBody.package_id,
    actor_id: irBody.actor_id,
    task: irBody.task,
    messages: irBody.messages,
    tools: irBody.tools,
    tool_policy: irBody.tool_policy,
    generation: irBody.generation,
    advisory_resolution: irBody.advisory_resolution
  };
  const requestIrId = "sha256:" + await sha256Text(stableJson(hashablePayloadForIr));

  return { ok: true, value: { ...irBody, request_ir_id: requestIrId } };
}

// ---------------------------------------------------------------------------
// Section 15: normalized model result -- shape validation only (no model call)
// ---------------------------------------------------------------------------

export function validateModelResultShape(result) {
  if (!result || typeof result !== "object") return { ok: false, error: "invalid_model_result", detail: "not_an_object" };
  if (result.schema !== MODEL_RESULT_SCHEMA) return { ok: false, error: "invalid_model_result", detail: "wrong_schema" };
  if (typeof result.package_id !== "string" || !PACKAGE_ID_RE.test(result.package_id)) {
    return { ok: false, error: "invalid_model_result", detail: "malformed_package_id" };
  }
  if (typeof result.request_ir_id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(result.request_ir_id)) {
    return { ok: false, error: "invalid_model_result", detail: "malformed_request_ir_id" };
  }
  const policy = result.policy || {};
  if (policy.tool_intents_only !== true) return { ok: false, error: "invalid_model_result", detail: "tool_intents_only_not_true" };
  if (policy.execution_authority !== false) return { ok: false, error: "invalid_model_result", detail: "execution_authority_not_false" };
  if (policy.mutation_authority !== false) return { ok: false, error: "invalid_model_result", detail: "mutation_authority_not_false" };
  const output = result.output || {};
  if (!Array.isArray(output.tool_intents)) return { ok: false, error: "invalid_model_result", detail: "tool_intents_not_array" };
  for (const intent of output.tool_intents) {
    if (intent && intent.executed === true) {
      return { ok: false, error: "invalid_model_result", detail: "tool_intent_marked_executed" };
    }
  }
  return { ok: true };
}
