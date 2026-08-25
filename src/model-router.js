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

// ---------------------------------------------------------------------------
// V7.1.1: router core + capability registry + deterministic mock adapters
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_CAPABILITY_REGISTRY = Object.freeze([
  Object.freeze({
    provider: "mock-a",
    model: "mock-a/text-tools-v1",
    transport: "mock",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 32768,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-24T00:00:00.000Z",
    source: "v7.1.1-fixture"
  }),
  Object.freeze({
    provider: "mock-b",
    model: "mock-b/text-tools-v1",
    transport: "mock",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 32768,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-24T00:00:00.000Z",
    source: "v7.1.1-fixture"
  }),
  Object.freeze({
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    transport: "workers-ai-binding-gateway",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 24000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-24T23:50:00.000Z",
    source: "cloudflare-workers-ai-catalog-live-verified-2026-08-24"
  }),
  Object.freeze({
    provider: "openai",
    model: "gpt-4o-mini",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 128000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T00:00:00.000Z",
    source: "openai-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "deepseek",
    model: "deepseek-chat",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 64000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "deepseek-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    transport: "anthropic-messages",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 200000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "anthropic-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 128000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "groq-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "mistral",
    model: "mistral-large-latest",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 128000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "mistral-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "cerebras",
    model: "llama-3.3-70b",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 128000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "cerebras-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "sambanova",
    model: "Meta-Llama-3.3-70B-Instruct",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 128000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "sambanova-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "grok",
    model: "grok-4",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 128000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "xai-catalog-2026-08-credential-configured"
  }),
  Object.freeze({
    provider: "kimi",
    model: "kimi-k2-0711-preview",
    transport: "openai-rest-chat",
    supports: Object.freeze({ text: true, streaming: false, tool_calls: true, reasoning: false, vision: false }),
    context_window: 128000,
    max_output_tokens: 4096,
    status: "available",
    observed_at: "2026-08-25T01:00:00.000Z",
    source: "moonshot-catalog-2026-08-credential-configured"
  })
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function listModelCapabilities(registry = DEFAULT_MODEL_CAPABILITY_REGISTRY) {
  return (Array.isArray(registry) ? registry : []).map(cloneJson);
}

export function resolveModelCapability(route, registry = DEFAULT_MODEL_CAPABILITY_REGISTRY) {
  if (!route || typeof route !== "object") return { ok: false, error: "provider_not_supported", detail: "route_not_an_object" };
  const provider = typeof route.provider === "string" ? route.provider.trim() : "";
  const model = typeof route.model === "string" ? route.model.trim() : "";
  if (!provider) return { ok: false, error: "provider_not_supported", detail: "missing_provider" };
  const providerEntries = (Array.isArray(registry) ? registry : []).filter(item => item && item.provider === provider);
  if (!providerEntries.length) return { ok: false, error: "provider_not_supported", provider };
  if (!model) return { ok: false, error: "model_not_found", provider, detail: "missing_model" };
  const capability = providerEntries.find(item => item.model === model);
  if (!capability) return { ok: false, error: "model_not_found", provider, model };
  if (capability.status !== "available") return { ok: false, error: "model_unavailable", provider, model, status: capability.status || "unknown" };
  return { ok: true, value: capability };
}

export function validateRequestIrShape(requestIr) {
  if (!requestIr || typeof requestIr !== "object") return { ok: false, error: "invalid_request_ir", detail: "not_an_object" };
  if (requestIr.schema !== MODEL_REQUEST_SCHEMA) return { ok: false, error: "invalid_request_ir", detail: "wrong_schema" };
  if (typeof requestIr.package_id !== "string" || !PACKAGE_ID_RE.test(requestIr.package_id)) {
    return { ok: false, error: "invalid_request_ir", detail: "malformed_package_id" };
  }
  if (typeof requestIr.request_ir_id !== "string" || !PACKAGE_ID_RE.test(requestIr.request_ir_id)) {
    return { ok: false, error: "invalid_request_ir", detail: "malformed_request_ir_id" };
  }
  const policy = requestIr.tool_policy || {};
  if (policy.intent_only !== true || policy.execution_authority !== false || policy.mutation_authority !== false) {
    return { ok: false, error: "invalid_request_ir", detail: "tool_policy_invalid" };
  }
  if (!Array.isArray(requestIr.messages) || !Array.isArray(requestIr.tools)) {
    return { ok: false, error: "invalid_request_ir", detail: "messages_or_tools_not_array" };
  }
  const unavailable = requestIr.tools.filter(tool => !tool || tool.available !== true);
  if (unavailable.length) {
    return {
      ok: false,
      error: "invalid_request_ir",
      detail: "requested_tool_not_available_in_context",
      tools: unavailable.map(tool => tool && tool.tool_id).filter(Boolean)
    };
  }
  return { ok: true };
}

const SUPPORTED_FAILOVER_MODES = Object.freeze(["none", "explicit"]);

function hasForbiddenCredentialField(candidate) {
  return Object.prototype.hasOwnProperty.call(candidate, "credential") ||
    Object.prototype.hasOwnProperty.call(candidate, "api_key") ||
    Object.prototype.hasOwnProperty.call(candidate, "token") ||
    Object.prototype.hasOwnProperty.call(candidate, "secret");
}

// Validates one route candidate (primary or a failover chain member) against
// the SAME request IR capability requirements. This is what guarantees a
// fallback can never be used to quietly weaken required capabilities (e.g.
// tool support) below what the primary route needed -- every candidate is
// checked against the identical requestIr before any invocation is attempted.
function validateCandidateRoute(candidate, requestIr, registry) {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, error: "provider_not_supported", detail: "route_not_an_object" };
  }
  if (hasForbiddenCredentialField(candidate)) {
    return { ok: false, error: "provider_auth_failed", detail: "credential_material_not_accepted_in_router" };
  }
  const capabilityResult = resolveModelCapability(candidate, registry);
  if (!capabilityResult.ok) return capabilityResult;
  const capability = capabilityResult.value;
  if (requestIr.tools.length && capability.supports?.tool_calls !== true) {
    return { ok: false, error: "model_capability_mismatch", provider: capability.provider, model: capability.model, missing: ["tool_calls"] };
  }
  const requestedMax = Number(requestIr.generation?.max_output_tokens || 0);
  if (Number.isFinite(requestedMax) && capability.max_output_tokens > 0 && requestedMax > capability.max_output_tokens) {
    return {
      ok: false,
      error: "model_capability_mismatch",
      provider: capability.provider,
      model: capability.model,
      detail: "max_output_tokens_exceeds_model_capability",
      requested: requestedMax,
      supported: capability.max_output_tokens
    };
  }
  return { ok: true, value: { route: candidate, capability } };
}

// V7.1.4: route envelope now describes an ordered candidate chain rather than
// a single destination. Default (`failover` omitted, or `{mode:"none"}`) is
// exactly the V7.1.1-V7.1.3 behavior: one candidate, no fallback. Explicit
// opt-in (`failover:{mode:"explicit", chain:[...]}`) adds ordered fallback
// candidates, each validated against the identical requestIr capability
// requirements as the primary -- an invalid or under-capable fallback fails
// the whole request up front, before any model is ever called, rather than
// being silently skipped or allowed to degrade capability at use time.
export function validateRouteEnvelope(route, requestIr, registry = DEFAULT_MODEL_CAPABILITY_REGISTRY) {
  const irValidation = validateRequestIrShape(requestIr);
  if (!irValidation.ok) return irValidation;
  if (!route || typeof route !== "object") return { ok: false, error: "provider_not_supported", detail: "route_not_an_object" };
  if (hasForbiddenCredentialField(route)) {
    return { ok: false, error: "provider_auth_failed", detail: "credential_material_not_accepted_in_router" };
  }

  const failoverMode = route.failover && typeof route.failover === "object" && typeof route.failover.mode === "string"
    ? route.failover.mode
    : "none";
  if (!SUPPORTED_FAILOVER_MODES.includes(failoverMode)) {
    return { ok: false, error: "unsupported_route_policy", detail: "failover_mode_not_supported", mode: failoverMode };
  }

  const primaryResult = validateCandidateRoute(route, requestIr, registry);
  if (!primaryResult.ok) return primaryResult;

  const candidates = [primaryResult.value];

  if (failoverMode === "explicit") {
    const chain = Array.isArray(route.failover.chain) ? route.failover.chain : null;
    if (!chain || !chain.length) {
      return { ok: false, error: "unsupported_route_policy", detail: "failover_chain_empty_or_missing" };
    }
    if (chain.length > 5) {
      return { ok: false, error: "unsupported_route_policy", detail: "failover_chain_too_long", max: 5 };
    }
    for (const candidateRoute of chain) {
      const candidateResult = validateCandidateRoute(candidateRoute, requestIr, registry);
      if (!candidateResult.ok) return candidateResult;
      candidates.push(candidateResult.value);
    }
  }

  return { ok: true, value: { failover_mode: failoverMode, candidates } };
}

function makeMockAdapter(provider) {
  return Object.freeze({
    can_handle(route) {
      return route && route.provider === provider
        ? { ok: true }
        : { ok: false, error: "provider_not_supported", provider: route && route.provider };
    },
    encode(requestIr, route) {
      return {
        schema: "cairnstone-mock-provider-request-v1",
        provider,
        model: route.model,
        package_id: requestIr.package_id,
        request_ir_id: requestIr.request_ir_id,
        messages: requestIr.messages,
        tools: requestIr.tools,
        generation: requestIr.generation
      };
    },
    async invoke(providerRequest) {
      // Deterministic fixture only. No fetch(), env.AI, gateway call, or tool invocation.
      return {
        ok: true,
        text: `mock-response:${providerRequest.request_ir_id}`,
        tool_calls: [],
        finish_reason: "stop",
        usage: { input_tokens: 0, output_tokens: 0 }
      };
    },
    normalize(raw, route, requestIr, capability) {
      return {
        ok: true,
        schema: MODEL_RESULT_SCHEMA,
        package_id: requestIr.package_id,
        request_ir_id: requestIr.request_ir_id,
        route: {
          provider: route.provider,
          model: route.model,
          transport: capability.transport,
          credential_mode: "none",
          failover_policy: "none"
        },
        output: {
          text: typeof raw.text === "string" ? raw.text : "",
          tool_intents: [],
          finish_reason: raw.finish_reason || "stop"
        },
        usage: {
          input_tokens: Number.isFinite(Number(raw.usage?.input_tokens)) ? Number(raw.usage.input_tokens) : null,
          output_tokens: Number.isFinite(Number(raw.usage?.output_tokens)) ? Number(raw.usage.output_tokens) : null,
          cost: null
        },
        observability: {
          gateway_id: null,
          gateway_request_id: null,
          attempts: [{ provider: route.provider, model: route.model, transport: capability.transport, status: "succeeded", mock: true }]
        },
        policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
        v7_1_1: { mock_adapter: true, external_model_calls: 0, tools_executed: 0 }
      };
    },
    normalize_error(error, route, requestIr) {
      return {
        ok: false,
        error: "provider_response_invalid",
        detail: "mock_adapter_error",
        provider: route && route.provider,
        model: route && route.model,
        package_id: requestIr && requestIr.package_id,
        request_ir_id: requestIr && requestIr.request_ir_id,
        diagnostic: String(error && error.message ? error.message : error)
      };
    }
  });
}

function providerToolName(toolId, index) {
  const safe = String(toolId || "tool").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "tool";
  return `cs_${index}_${safe}`.slice(0, 64);
}

function providerToolMap(requestIr) {
  const entries = (requestIr.tools || []).map((tool, index) => ({
    tool_id: tool.tool_id,
    provider_name: providerToolName(tool.tool_id, index)
  }));
  return {
    entries,
    by_provider_name: new Map(entries.map(item => [item.provider_name, item.tool_id]))
  };
}

function workersAiMessages(requestIr) {
  return (requestIr.messages || []).map(message => ({
    role: message.role === "user" ? "user" : "system",
    content: String(message.content || "")
  }));
}

function workersAiTools(requestIr) {
  return providerToolMap(requestIr).entries.map(item => ({
    name: item.provider_name,
    description: `Return a CairnStone tool intent for ${item.tool_id}. This does not execute the tool.`,
    parameters: { type: "object", properties: {}, additionalProperties: true }
  }));
}

function normalizeToolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, value: {}, error: "arguments_not_object" };
    } catch {
      return { ok: false, value: {}, error: "arguments_invalid_json" };
    }
  }
  if (value === undefined || value === null || value === "") return { ok: true, value: {} };
  return { ok: false, value: {}, error: "arguments_invalid_type" };
}

function usageNumber(usage, ...keys) {
  for (const key of keys) {
    const value = Number(usage && usage[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function mapWorkersAiError(error) {
  const text = String(error && error.message ? error.message : error || "").toLowerCase();
  const status = Number(error && (error.status || error.statusCode || error.code));
  if (status === 401 || status === 403 || text.includes("unauthorized") || text.includes("forbidden") || text.includes("auth")) return "provider_auth_failed";
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) return "provider_rate_limited";
  if (status === 408 || status === 504 || text.includes("timeout") || text.includes("timed out")) return "provider_timeout";
  if (status === 400 || status === 422 || text.includes("bad request") || text.includes("invalid request")) return "provider_bad_request";
  if (status === 503 || text.includes("capacity") || text.includes("overloaded")) return "provider_capacity_exceeded";
  return "gateway_error";
}

function makeWorkersAiAdapter() {
  return Object.freeze({
    can_handle(route) {
      return route && route.provider === "workers-ai"
        ? { ok: true }
        : { ok: false, error: "provider_not_supported", provider: route && route.provider };
    },
    encode(requestIr, route) {
      const tools = workersAiTools(requestIr);
      const input = {
        messages: workersAiMessages(requestIr),
        max_tokens: requestIr.generation.max_output_tokens,
        temperature: requestIr.generation.temperature
      };
      if (tools.length) input.tools = tools;
      return {
        model: route.model,
        gateway_id: typeof route.gateway_id === "string" && route.gateway_id.trim() ? route.gateway_id.trim() : "default",
        gateway_metadata: {
          package_id: requestIr.package_id,
          request_ir_id: requestIr.request_ir_id,
          provider: route.provider,
          model: route.model
        },
        input
      };
    },
    async invoke(providerRequest, runtime = {}) {
      const ai = runtime.env && runtime.env.AI;
      if (!ai || typeof ai.run !== "function") {
        const error = new Error("workers_ai_binding_missing");
        error.code = 503;
        throw error;
      }
      const started = Date.now();
      const raw = await ai.run(
        providerRequest.model,
        providerRequest.input,
        {
          gateway: {
            id: providerRequest.gateway_id,
            skipCache: true,
            collectLog: true,
            metadata: providerRequest.gateway_metadata
          }
        }
      );
      return {
        raw,
        telemetry: {
          gateway_id: providerRequest.gateway_id,
          gateway_request_id: typeof ai.aiGatewayLogId === "string" ? ai.aiGatewayLogId : null,
          latency_ms: Math.max(0, Date.now() - started)
        }
      };
    },
    async normalize(invocation, route, requestIr, capability) {
      const raw = invocation && invocation.raw && typeof invocation.raw === "object" ? invocation.raw : {};
      const telemetry = invocation && invocation.telemetry && typeof invocation.telemetry === "object" ? invocation.telemetry : {};
      const map = providerToolMap(requestIr);
      const rawCalls = Array.isArray(raw.tool_calls)
        ? raw.tool_calls
        : Array.isArray(raw.toolCalls)
          ? raw.toolCalls
          : [];
      const toolIntents = [];
      for (let index = 0; index < rawCalls.length; index += 1) {
        const call = rawCalls[index] || {};
        const providerName = typeof call.name === "string"
          ? call.name
          : typeof call.function?.name === "string"
            ? call.function.name
            : "";
        const rawArguments = call.arguments !== undefined ? call.arguments : call.function?.arguments;
        const args = normalizeToolArguments(rawArguments);
        const toolId = map.by_provider_name.get(providerName) || null;
        const validation = !toolId
          ? { ok: false, error: "unknown_tool_id", provider_name: providerName || null }
          : !args.ok
            ? { ok: false, error: args.error }
            : { ok: true };
        const intentPayload = {
          request_ir_id: requestIr.request_ir_id,
          provider: route.provider,
          model: route.model,
          ordinal: index,
          provider_name: providerName || null,
          tool_id: toolId,
          arguments: args.value
        };
        const intentId = "sha256:" + await sha256Text(stableJson(intentPayload));
        toolIntents.push({
          intent_id: intentId,
          tool_id: toolId,
          arguments: args.value,
          source: { provider: route.provider, model: route.model, provider_name: providerName || null },
          validation,
          policy: { intent_only: true, executed: false, execution_authority: false, mutation_authority: false },
          executed: false
        });
      }
      const text = typeof raw.response === "string"
        ? raw.response
        : typeof raw.output_text === "string"
          ? raw.output_text
          : typeof raw.result === "string"
            ? raw.result
            : "";
      const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
      return {
        ok: true,
        schema: MODEL_RESULT_SCHEMA,
        package_id: requestIr.package_id,
        request_ir_id: requestIr.request_ir_id,
        route: {
          provider: route.provider,
          model: route.model,
          transport: capability.transport,
          credential_mode: "workers_ai_billing",
          failover_policy: "none"
        },
        output: {
          text,
          tool_intents: toolIntents,
          finish_reason: raw.finish_reason || raw.finishReason || (toolIntents.length ? "tool_calls" : "stop")
        },
        usage: {
          input_tokens: usageNumber(usage, "input_tokens", "prompt_tokens"),
          output_tokens: usageNumber(usage, "output_tokens", "completion_tokens"),
          cost: null
        },
        observability: {
          gateway_id: telemetry.gateway_id || null,
          gateway_request_id: telemetry.gateway_request_id || (typeof raw.request_id === "string" ? raw.request_id : null),
          attempts: [{
            provider: route.provider,
            model: route.model,
            transport: capability.transport,
            status: "succeeded",
            latency_ms: Number.isFinite(Number(telemetry.latency_ms)) ? Number(telemetry.latency_ms) : null,
            mock: false
          }]
        },
        policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
        v7_1_2: { workers_ai_adapter: true, external_model_calls: 1, tools_executed: 0, gateway_routed: Boolean(telemetry.gateway_id) }
      };
    },
    normalize_error(error, route, requestIr) {
      return {
        ok: false,
        error: mapWorkersAiError(error),
        provider: route && route.provider,
        model: route && route.model,
        package_id: requestIr && requestIr.package_id,
        request_ir_id: requestIr && requestIr.request_ir_id,
        diagnostic: String(error && error.message ? error.message : error).slice(0, 500),
        policy: { execution_authority: false, mutation_authority: false }
      };
    }
  });
}

// ---------------------------------------------------------------------------
// V7.1.3: BYOK / Unified Billing third-party adapter (OpenAI reference impl)
// ---------------------------------------------------------------------------

// Resolves a BYOK credential from a Worker secret binding by (provider, alias).
// Naming convention: alias "default" -> BYOK_<PROVIDER>_API_KEY; any other
// alias -> BYOK_<PROVIDER>_API_KEY_<ALIAS>. This is deliberately a static,
// deploy-time binding name, not a caller-suppliable value -- the route
// envelope may carry credential_mode/credential_alias (plain strings, never
// the key names of "credential"/"api_key"/"token"/"secret" that
// validateRouteEnvelope already rejects), but the actual secret material
// only ever comes from the Worker's own bindings, never from MCP tool input.
function resolveByokSecret(env, provider, alias) {
  const providerUpper = String(provider || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const normalizedAlias = String(alias || "default").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const keyName = normalizedAlias === "DEFAULT"
    ? `BYOK_${providerUpper}_API_KEY`
    : `BYOK_${providerUpper}_API_KEY_${normalizedAlias}`;
  const value = env && env[keyName];
  return typeof value === "string" && value.trim()
    ? { ok: true, value: value.trim(), keyName }
    : { ok: false, keyName };
}

function mapOpenAiError(error) {
  const text = String(error && error.message ? error.message : error || "").toLowerCase();
  const status = Number(error && (error.status || error.statusCode || error.code));
  if (status === 401 || status === 403 || text.includes("unauthorized") || text.includes("forbidden") || text.includes("auth") || text.includes("byok_credential_not_configured")) return "provider_auth_failed";
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) return "provider_rate_limited";
  if (status === 408 || status === 504 || text.includes("timeout") || text.includes("timed out")) return "provider_timeout";
  if (status === 400 || status === 422 || text.includes("bad request") || text.includes("invalid request")) return "provider_bad_request";
  if (status === 503 || text.includes("capacity") || text.includes("overloaded")) return "provider_capacity_exceeded";
  return "gateway_error";
}

function openAiMessages(requestIr) {
  return (requestIr.messages || []).map(message => ({
    role: message.role === "user" ? "user" : "system",
    content: String(message.content || "")
  }));
}

function openAiTools(requestIr) {
  return providerToolMap(requestIr).entries.map(item => ({
    type: "function",
    function: {
      name: item.provider_name,
      description: `Return a CairnStone tool intent for ${item.tool_id}. This does not execute the tool.`,
      parameters: { type: "object", properties: {}, additionalProperties: true }
    }
  }));
}

// OpenAI-compatible chat-completions providers: same request/response shape,
// different base URL and credential binding. Covers OpenAI itself plus every
// third-party provider whose API mirrors the OpenAI chat completions schema.
const OPENAI_COMPATIBLE_PROVIDERS = Object.freeze({
  openai: "https://api.openai.com/v1/chat/completions",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  cerebras: "https://api.cerebras.ai/v1/chat/completions",
  sambanova: "https://api.sambanova.ai/v1/chat/completions",
  grok: "https://api.x.ai/v1/chat/completions",
  kimi: "https://api.moonshot.ai/v1/chat/completions"
});

function makeOpenAiCompatibleAdapter(provider, baseUrl) {
  return Object.freeze({
    can_handle(route) {
      return route && route.provider === provider
        ? { ok: true }
        : { ok: false, error: "provider_not_supported", provider: route && route.provider };
    },
    encode(requestIr, route) {
      const tools = openAiTools(requestIr);
      const requestBody = {
        model: route.model,
        messages: openAiMessages(requestIr),
        max_tokens: requestIr.generation.max_output_tokens,
        temperature: requestIr.generation.temperature
      };
      if (tools.length) {
        requestBody.tools = tools;
        requestBody.tool_choice = "auto";
      }
      return {
        url: baseUrl,
        body: requestBody,
        package_id: requestIr.package_id,
        request_ir_id: requestIr.request_ir_id
      };
    },
    async invoke(providerRequest, runtime = {}) {
      const alias = (runtime.route && typeof runtime.route.credential_alias === "string" && runtime.route.credential_alias.trim())
        ? runtime.route.credential_alias.trim()
        : "default";
      const secret = resolveByokSecret(runtime.env, provider, alias);
      if (!secret.ok) {
        const error = new Error("byok_credential_not_configured");
        error.status = 401;
        error.missing_binding = secret.keyName;
        throw error;
      }
      const started = Date.now();
      const response = await fetch(providerRequest.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret.value}`
        },
        body: JSON.stringify(providerRequest.body)
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(text || `${provider}_http_${response.status}`);
        error.status = response.status;
        throw error;
      }
      const raw = await response.json();
      return {
        raw,
        telemetry: {
          latency_ms: Math.max(0, latencyMs),
          request_id: response.headers.get("x-request-id") || null
        }
      };
    },
    async normalize(invocation, route, requestIr, capability) {
      const raw = invocation && invocation.raw && typeof invocation.raw === "object" ? invocation.raw : {};
      const telemetry = invocation && invocation.telemetry && typeof invocation.telemetry === "object" ? invocation.telemetry : {};
      const choice = (Array.isArray(raw.choices) && raw.choices[0]) || {};
      const message = choice.message || {};
      const map = providerToolMap(requestIr);
      const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolIntents = [];
      for (let index = 0; index < rawCalls.length; index += 1) {
        const call = rawCalls[index] || {};
        const providerName = typeof call.function?.name === "string" ? call.function.name : "";
        const args = normalizeToolArguments(call.function?.arguments);
        const toolId = map.by_provider_name.get(providerName) || null;
        const validation = !toolId
          ? { ok: false, error: "unknown_tool_id", provider_name: providerName || null }
          : !args.ok
            ? { ok: false, error: args.error }
            : { ok: true };
        const intentPayload = {
          request_ir_id: requestIr.request_ir_id,
          provider: route.provider,
          model: route.model,
          ordinal: index,
          provider_name: providerName || null,
          tool_id: toolId,
          arguments: args.value
        };
        const intentId = "sha256:" + await sha256Text(stableJson(intentPayload));
        toolIntents.push({
          intent_id: intentId,
          tool_id: toolId,
          arguments: args.value,
          source: { provider: route.provider, model: route.model, provider_name: providerName || null },
          validation,
          policy: { intent_only: true, executed: false, execution_authority: false, mutation_authority: false },
          executed: false
        });
      }
      const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
      return {
        ok: true,
        schema: MODEL_RESULT_SCHEMA,
        package_id: requestIr.package_id,
        request_ir_id: requestIr.request_ir_id,
        route: {
          provider: route.provider,
          model: route.model,
          transport: capability.transport,
          credential_mode: "byok",
          failover_policy: "none"
        },
        output: {
          text: typeof message.content === "string" ? message.content : "",
          tool_intents: toolIntents,
          finish_reason: choice.finish_reason || (toolIntents.length ? "tool_calls" : "stop")
        },
        usage: {
          input_tokens: usageNumber(usage, "prompt_tokens", "input_tokens"),
          output_tokens: usageNumber(usage, "completion_tokens", "output_tokens"),
          cost: null
        },
        observability: {
          gateway_id: null,
          gateway_request_id: telemetry.request_id || (typeof raw.id === "string" ? raw.id : null),
          attempts: [{
            provider: route.provider,
            model: route.model,
            transport: capability.transport,
            status: "succeeded",
            latency_ms: Number.isFinite(Number(telemetry.latency_ms)) ? Number(telemetry.latency_ms) : null,
            mock: false
          }]
        },
        policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
        v7_1_3: { byok_adapter: true, external_model_calls: 1, tools_executed: 0 }
      };
    },
    normalize_error(error, route, requestIr) {
      return {
        ok: false,
        error: mapOpenAiError(error),
        provider: route && route.provider,
        model: route && route.model,
        package_id: requestIr && requestIr.package_id,
        request_ir_id: requestIr && requestIr.request_ir_id,
        diagnostic: String(error && error.message ? error.message : error).slice(0, 500),
        policy: { execution_authority: false, mutation_authority: false }
      };
    }
  });
}

// ---------------------------------------------------------------------------
// V7.1.3: Anthropic adapter (Messages API -- distinct shape from OpenAI-style)
// ---------------------------------------------------------------------------

function anthropicMessages(requestIr) {
  // Anthropic's Messages API takes `system` as a separate top-level string,
  // not a system-role message, and only accepts user/assistant roles in the
  // messages array. All of our IR's "system" content (instructions, policy,
  // skills, memory) is concatenated into one system block in a fixed order;
  // the task becomes the sole user turn.
  const systemParts = [];
  const messages = [];
  for (const message of requestIr.messages || []) {
    if (message.role === "user") {
      messages.push({ role: "user", content: String(message.content || "") });
    } else {
      systemParts.push(String(message.content || ""));
    }
  }
  return { system: systemParts.join("\n\n---\n\n"), messages };
}

function anthropicTools(requestIr) {
  return providerToolMap(requestIr).entries.map(item => ({
    name: item.provider_name,
    description: `Return a CairnStone tool intent for ${item.tool_id}. This does not execute the tool.`,
    input_schema: { type: "object", properties: {}, additionalProperties: true }
  }));
}

function mapAnthropicError(error) {
  const text = String(error && error.message ? error.message : error || "").toLowerCase();
  const status = Number(error && (error.status || error.statusCode || error.code));
  if (status === 401 || text.includes("authentication") || text.includes("invalid x-api-key") || text.includes("unauthorized") || text.includes("byok_credential_not_configured")) return "provider_auth_failed";
  if (status === 429 || text.includes("rate_limit") || text.includes("rate limit")) return "provider_rate_limited";
  if (status === 408 || status === 504 || text.includes("timeout")) return "provider_timeout";
  if (status === 400 || status === 422 || text.includes("invalid_request")) return "provider_bad_request";
  if (status === 529 || status === 503 || text.includes("overloaded")) return "provider_capacity_exceeded";
  return "gateway_error";
}

function makeAnthropicAdapter() {
  const baseUrl = "https://api.anthropic.com/v1/messages";
  return Object.freeze({
    can_handle(route) {
      return route && route.provider === "anthropic"
        ? { ok: true }
        : { ok: false, error: "provider_not_supported", provider: route && route.provider };
    },
    encode(requestIr, route) {
      const { system, messages } = anthropicMessages(requestIr);
      const tools = anthropicTools(requestIr);
      const requestBody = {
        model: route.model,
        system,
        messages,
        max_tokens: requestIr.generation.max_output_tokens,
        temperature: requestIr.generation.temperature
      };
      if (tools.length) requestBody.tools = tools;
      return {
        url: baseUrl,
        body: requestBody,
        package_id: requestIr.package_id,
        request_ir_id: requestIr.request_ir_id
      };
    },
    async invoke(providerRequest, runtime = {}) {
      const alias = (runtime.route && typeof runtime.route.credential_alias === "string" && runtime.route.credential_alias.trim())
        ? runtime.route.credential_alias.trim()
        : "default";
      const secret = resolveByokSecret(runtime.env, "anthropic", alias);
      if (!secret.ok) {
        const error = new Error("byok_credential_not_configured");
        error.status = 401;
        error.missing_binding = secret.keyName;
        throw error;
      }
      const started = Date.now();
      const response = await fetch(providerRequest.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": secret.value,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(providerRequest.body)
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(text || `anthropic_http_${response.status}`);
        error.status = response.status;
        throw error;
      }
      const raw = await response.json();
      return {
        raw,
        telemetry: {
          latency_ms: Math.max(0, latencyMs),
          request_id: response.headers.get("request-id") || null
        }
      };
    },
    async normalize(invocation, route, requestIr, capability) {
      const raw = invocation && invocation.raw && typeof invocation.raw === "object" ? invocation.raw : {};
      const telemetry = invocation && invocation.telemetry && typeof invocation.telemetry === "object" ? invocation.telemetry : {};
      const blocks = Array.isArray(raw.content) ? raw.content : [];
      const map = providerToolMap(requestIr);
      const toolIntents = [];
      let text = "";
      let ordinal = 0;
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block.type === "tool_use") {
          const providerName = typeof block.name === "string" ? block.name : "";
          const args = normalizeToolArguments(block.input);
          const toolId = map.by_provider_name.get(providerName) || null;
          const validation = !toolId
            ? { ok: false, error: "unknown_tool_id", provider_name: providerName || null }
            : !args.ok
              ? { ok: false, error: args.error }
              : { ok: true };
          const intentPayload = {
            request_ir_id: requestIr.request_ir_id,
            provider: route.provider,
            model: route.model,
            ordinal,
            provider_name: providerName || null,
            tool_id: toolId,
            arguments: args.value
          };
          const intentId = "sha256:" + await sha256Text(stableJson(intentPayload));
          toolIntents.push({
            intent_id: intentId,
            tool_id: toolId,
            arguments: args.value,
            source: { provider: route.provider, model: route.model, provider_name: providerName || null },
            validation,
            policy: { intent_only: true, executed: false, execution_authority: false, mutation_authority: false },
            executed: false
          });
          ordinal += 1;
        }
      }
      const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
      return {
        ok: true,
        schema: MODEL_RESULT_SCHEMA,
        package_id: requestIr.package_id,
        request_ir_id: requestIr.request_ir_id,
        route: {
          provider: route.provider,
          model: route.model,
          transport: capability.transport,
          credential_mode: "byok",
          failover_policy: "none"
        },
        output: {
          text,
          tool_intents: toolIntents,
          finish_reason: raw.stop_reason || (toolIntents.length ? "tool_calls" : "stop")
        },
        usage: {
          input_tokens: usageNumber(usage, "input_tokens"),
          output_tokens: usageNumber(usage, "output_tokens"),
          cost: null
        },
        observability: {
          gateway_id: null,
          gateway_request_id: telemetry.request_id || (typeof raw.id === "string" ? raw.id : null),
          attempts: [{
            provider: route.provider,
            model: route.model,
            transport: capability.transport,
            status: "succeeded",
            latency_ms: Number.isFinite(Number(telemetry.latency_ms)) ? Number(telemetry.latency_ms) : null,
            mock: false
          }]
        },
        policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
        v7_1_3: { byok_adapter: true, external_model_calls: 1, tools_executed: 0 }
      };
    },
    normalize_error(error, route, requestIr) {
      return {
        ok: false,
        error: mapAnthropicError(error),
        provider: route && route.provider,
        model: route && route.model,
        package_id: requestIr && requestIr.package_id,
        request_ir_id: requestIr && requestIr.request_ir_id,
        diagnostic: String(error && error.message ? error.message : error).slice(0, 500),
        policy: { execution_authority: false, mutation_authority: false }
      };
    }
  });
}

export const DEFAULT_MOCK_ADAPTERS = Object.freeze({
  "mock-a": makeMockAdapter("mock-a"),
  "mock-b": makeMockAdapter("mock-b")
});

export const DEFAULT_MODEL_ADAPTERS = Object.freeze({
  ...DEFAULT_MOCK_ADAPTERS,
  "workers-ai": makeWorkersAiAdapter(),
  "anthropic": makeAnthropicAdapter(),
  ...Object.fromEntries(
    Object.entries(OPENAI_COMPATIBLE_PROVIDERS).map(([provider, baseUrl]) => [provider, makeOpenAiCompatibleAdapter(provider, baseUrl)])
  )
});

export async function modelRouteFromBody(body, _env, deps = {}) {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_request_ir", detail: "body_not_an_object" };
  const pkg = body.context_package;
  const requestOptions = body.request && typeof body.request === "object" ? body.request : {};
  const irResult = await buildRequestIr(pkg, requestOptions);
  if (!irResult.ok) return irResult;
  const requestIr = irResult.value;

  const registry = Array.isArray(deps.registry) ? deps.registry : DEFAULT_MODEL_CAPABILITY_REGISTRY;
  const adapters = deps.adapters && typeof deps.adapters === "object" ? deps.adapters : DEFAULT_MODEL_ADAPTERS;
  const route = body.route && typeof body.route === "object" ? body.route : null;
  const routeValidation = validateRouteEnvelope(route, requestIr, registry);
  if (!routeValidation.ok) return { ...routeValidation, package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };

  const { failover_mode, candidates } = routeValidation.value;
  const attempts = [];
  let lastFailure = null;

  for (const { route: candidateRoute, capability } of candidates) {
    const adapter = adapters[candidateRoute.provider];
    if (!adapter) {
      attempts.push({ provider: candidateRoute.provider, model: candidateRoute.model, transport: capability.transport, status: "failed", error: "provider_not_supported", latency_ms: null, mock: false });
      lastFailure = { ok: false, error: "provider_not_supported", provider: candidateRoute.provider, package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };
      continue;
    }
    const verdict = typeof adapter.can_handle === "function" ? adapter.can_handle(candidateRoute, requestIr) : { ok: false, error: "provider_not_supported" };
    if (!verdict || verdict.ok !== true) {
      const failure = verdict || { ok: false, error: "provider_not_supported" };
      attempts.push({ provider: candidateRoute.provider, model: candidateRoute.model, transport: capability.transport, status: "failed", error: failure.error, latency_ms: null, mock: false });
      lastFailure = { ...failure, package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };
      continue;
    }

    const startedAt = Date.now();
    try {
      const providerRequest = adapter.encode(requestIr, candidateRoute, capability);
      const raw = await adapter.invoke(providerRequest, { credentials: null, env: _env, route: candidateRoute });
      const normalized = await adapter.normalize(raw, candidateRoute, requestIr, capability);
      const shape = validateModelResultShape(normalized);
      if (!shape.ok) {
        attempts.push({ provider: candidateRoute.provider, model: candidateRoute.model, transport: capability.transport, status: "failed", error: "provider_response_invalid", latency_ms: Date.now() - startedAt, mock: false });
        lastFailure = { ok: false, error: "provider_response_invalid", detail: shape.detail, package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };
        continue;
      }
      // Success: merge any earlier failed attempts with this adapter's own
      // attempt record(s) so observability.attempts reflects the full ordered
      // history, not just the winning call. package_id/request_ir_id are
      // untouched -- they were fixed before any candidate was ever tried.
      const ownAttempts = Array.isArray(normalized.observability?.attempts) ? normalized.observability.attempts : [];
      normalized.observability = { ...normalized.observability, attempts: [...attempts, ...ownAttempts] };
      normalized.route = { ...normalized.route, failover_policy: failover_mode };
      return normalized;
    } catch (error) {
      const normalizedError = typeof adapter.normalize_error === "function"
        ? adapter.normalize_error(error, candidateRoute, requestIr)
        : {
            ok: false,
            error: "provider_response_invalid",
            provider: candidateRoute.provider,
            model: candidateRoute.model,
            package_id: requestIr.package_id,
            request_ir_id: requestIr.request_ir_id,
            diagnostic: String(error && error.message ? error.message : error)
          };
      attempts.push({ provider: candidateRoute.provider, model: candidateRoute.model, transport: capability.transport, status: "failed", error: normalizedError.error, latency_ms: Date.now() - startedAt, mock: false });
      lastFailure = normalizedError;
    }
  }

  // Every candidate failed. Return the last candidate's normalized error,
  // augmented with the full ordered attempts history so the caller can see
  // exactly what was tried, in what order, and why each one failed.
  return { ...lastFailure, attempts, policy: { execution_authority: false, mutation_authority: false } };
}

export function modelCapabilitiesFromBody(body = {}, _env, deps = {}) {
  const registry = Array.isArray(deps.registry) ? deps.registry : DEFAULT_MODEL_CAPABILITY_REGISTRY;
  const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const models = listModelCapabilities(registry).filter(item => {
    if (provider && item.provider !== provider) return false;
    if (model && item.model !== model) return false;
    return true;
  });
  return {
    ok: true,
    schema: "cairnstone-model-capabilities-v1",
    authority: "operational_configuration",
    accepted_state_authority: false,
    external_model_calls: 0,
    total: models.length,
    models
  };
}

export const MODEL_CAPABILITIES_TOOL_DEFINITION = {
  name: "cairnstone_model_capabilities",
  description: "V7.1 runtime model capability registry. Operational configuration only, never CairnStone accepted-state authority. Includes deterministic mock providers, the V7.1.2 live Workers AI adapter model, and the V7.1.3 BYOK adapter models (OpenAI, DeepSeek, Anthropic, Groq, Mistral, Cerebras, SambaNova, xAI/Grok, Kimi/Moonshot); listing capabilities performs zero model calls and does not indicate whether a BYOK credential is actually configured.",
  inputSchema: {
    type: "object",
    properties: {
      provider: { type: "string" },
      model: { type: "string" }
    },
    additionalProperties: false
  }
};

// V7.2 -- bounded read-only server-side delegation.
// Composes V7.0 bootstrap + V7.1 routing inside the Worker. The full context
// package stays server-side; no tools are exposed or executed. Multi-turn tool
// execution remains a V7.3 concern.
export const DELEGATION_RESULT_SCHEMA = "cairnstone-delegation-result-v1";
const DELEGATION_MAX_TASK_LENGTH = 4000;
const DELEGATION_MAX_OUTPUT_TOKENS = 2048;
const DELEGATION_DEFAULT_OUTPUT_TOKENS = 800;
const DELEGATION_MAX_EVIDENCE_REFS = 20;
const DELEGATION_MAX_PATH_HEADS = 100;

export const DELEGATE_TOOL_DEFINITION = {
  name: "cairnstone_delegate",
  description: "V7.2: bounded read-only server-side delegation. Compiles V7.0 accepted state and routes through V7.1 entirely inside CairnStone, returning compact text, identities, evidence refs, usage, and diagnostics instead of the full context package. Exposes zero tools and grants zero execution/mutation authority; tool execution remains deferred to V7.3.",
  inputSchema: {
    type: "object",
    required: ["actor_id", "task", "chain", "route"],
    properties: {
      actor_id: { type: "string", description: "namespace:identifier for the delegated actor." },
      task: { type: "string", maxLength: DELEGATION_MAX_TASK_LENGTH, description: "Read-only reasoning task. Descriptive input grants no execution authority." },
      chain: { type: "string", maxLength: 300, description: "Accepted-state CairnStone chain compiled server-side." },
      route: {
        type: "object",
        required: ["provider", "model"],
        properties: {
          provider: { type: "string" }, model: { type: "string" }, gateway_id: { type: "string" },
          credential_mode: { type: "string", enum: ["workers_ai_billing", "unified_billing", "byok"] },
          credential_alias: { type: "string" },
          failover: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["none", "explicit"] },
              chain: {
                type: "array", maxItems: 5,
                items: {
                  type: "object", required: ["provider", "model"],
                  properties: {
                    provider: { type: "string" }, model: { type: "string" }, gateway_id: { type: "string" },
                    credential_mode: { type: "string", enum: ["workers_ai_billing", "unified_billing", "byok"] },
                    credential_alias: { type: "string" }
                  },
                  additionalProperties: false
                }
              }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      generation: {
        type: "object",
        properties: {
          max_output_tokens: { type: "number", minimum: 1, maximum: DELEGATION_MAX_OUTPUT_TOKENS },
          temperature: { type: "number", minimum: 0, maximum: 2 }
        },
        additionalProperties: false
      },
      limits: {
        type: "object",
        description: "Optional V7.0 context-package limits; the context compiler still enforces its own hard ceilings.",
        properties: {
          max_skills: { type: "number", minimum: 1, maximum: 10 },
          max_memory_hits: { type: "number", minimum: 0, maximum: 15 },
          max_memory_bytes: { type: "number", minimum: 0, maximum: 60000 },
          max_inbox_items: { type: "number", minimum: 0, maximum: 50 },
          max_package_bytes: { type: "number", minimum: 1000, maximum: 180000 }
        },
        additionalProperties: false
      },
      include_inbox: { type: "boolean", description: "Include the non-mutating AC1 inbox snapshot in the server-side V7.0 package. Defaults to true." }
    },
    additionalProperties: false
  }
};

export async function delegateFromBody(body, env, deps = {}) {
  try {
    if (!body || typeof body !== "object") return delegationFailure("invalid_delegation_request", "body_not_an_object");
    if (typeof deps.agentBootstrapFromBody !== "function" || typeof deps.modelRouteFromBody !== "function") {
      return delegationFailure("delegation_dependencies_missing");
    }
    const actorId = delegationRequiredText(body.actor_id, "actor_id", 240);
    const task = delegationRequiredText(body.task, "task", DELEGATION_MAX_TASK_LENGTH);
    const chain = delegationRequiredText(body.chain, "chain", 300);
    const route = body.route && typeof body.route === "object" ? body.route : null;
    if (!route) return delegationFailure("invalid_delegation_request", "route_not_an_object");
    const generation = normalizeDelegationGeneration(body.generation);

    const bootstrap = await deps.agentBootstrapFromBody({
      actor_id: actorId,
      task,
      chain,
      capabilities: { tools: [], supports_tool_calls: false },
      limits: body.limits,
      include_inbox: body.include_inbox !== false
    }, env);
    if (!bootstrap || bootstrap.ok !== true) {
      return {
        ok: false,
        error: "delegation_bootstrap_failed",
        detail: bootstrap && bootstrap.error ? bootstrap.error : "unknown",
        bootstrap_error: compactDelegationFailure(bootstrap),
        policy: delegationReadOnlyPolicy()
      };
    }

    const routed = await deps.modelRouteFromBody({
      context_package: bootstrap,
      route,
      request: { tools: [], generation }
    }, env);
    if (!routed || routed.ok !== true) {
      return {
        ok: false,
        schema: DELEGATION_RESULT_SCHEMA,
        error: routed && routed.error ? routed.error : "delegation_route_failed",
        detail: routed && routed.detail ? routed.detail : undefined,
        diagnostic: routed && routed.diagnostic ? routed.diagnostic : undefined,
        actor_id: actorId,
        chain,
        package_id: bootstrap.package_id,
        request_ir_id: routed && routed.request_ir_id ? routed.request_ir_id : null,
        route: compactDelegationRoute(routed && routed.route ? routed.route : route),
        observability: compactDelegationObservability(routed),
        policy: delegationReadOnlyPolicy(),
        evidence: compactDelegationEvidence(bootstrap),
        diagnostics: compactDelegationDiagnostics(bootstrap, routed)
      };
    }

    const toolIntents = Array.isArray(routed.output?.tool_intents) ? routed.output.tool_intents : [];
    if (toolIntents.length) {
      return {
        ok: false,
        schema: DELEGATION_RESULT_SCHEMA,
        error: "delegation_tool_intent_forbidden",
        detail: "V7.2 read-only delegation exposes no tools; any returned tool intent fails closed.",
        actor_id: actorId,
        chain,
        package_id: bootstrap.package_id,
        request_ir_id: routed.request_ir_id || null,
        route: compactDelegationRoute(routed.route),
        observability: compactDelegationObservability(routed),
        policy: delegationReadOnlyPolicy(),
        evidence: compactDelegationEvidence(bootstrap),
        diagnostics: { ...compactDelegationDiagnostics(bootstrap, routed), tool_intents_returned: toolIntents.length }
      };
    }

    return {
      ok: true,
      schema: DELEGATION_RESULT_SCHEMA,
      actor_id: actorId,
      chain,
      package_id: bootstrap.package_id,
      request_ir_id: routed.request_ir_id,
      output: { text: typeof routed.output?.text === "string" ? routed.output.text : "", finish_reason: routed.output?.finish_reason || null },
      route: compactDelegationRoute(routed.route),
      usage: compactDelegationUsage(routed.usage),
      observability: compactDelegationObservability(routed),
      evidence: compactDelegationEvidence(bootstrap),
      policy: delegationReadOnlyPolicy(),
      diagnostics: compactDelegationDiagnostics(bootstrap, routed)
    };
  } catch (error) {
    return delegationFailure("invalid_delegation_request", String(error && error.message ? error.message : error));
  }
}

function normalizeDelegationGeneration(value) {
  const source = value && typeof value === "object" ? value : {};
  const requested = Number(source.max_output_tokens);
  const maxOutputTokens = Number.isFinite(requested)
    ? Math.max(1, Math.min(DELEGATION_MAX_OUTPUT_TOKENS, Math.floor(requested)))
    : DELEGATION_DEFAULT_OUTPUT_TOKENS;
  const requestedTemperature = Number(source.temperature);
  const temperature = Number.isFinite(requestedTemperature) ? Math.max(0, Math.min(2, requestedTemperature)) : 0.2;
  return { max_output_tokens: maxOutputTokens, temperature };
}

function compactDelegationEvidence(pkg) {
  const allPathHeads = Array.isArray(pkg.authority?.path_heads) ? pkg.authority.path_heads : [];
  const pathHeads = allPathHeads.slice(0, DELEGATION_MAX_PATH_HEADS);
  const allMemory = Array.isArray(pkg.memory?.items) ? pkg.memory.items : [];
  const memoryItems = allMemory.slice(0, DELEGATION_MAX_EVIDENCE_REFS);
  const skillItems = Array.isArray(pkg.skills?.accepted_bundle?.skills) ? pkg.skills.accepted_bundle.skills : [];
  return {
    chain_head: pkg.authority?.chain_head || null,
    path_heads: pathHeads.map(item => ({ path: item.path, stone_hash: item.stone_hash, repo: item.repo || null, commit_sha: item.commit_sha || null })),
    path_heads_truncated: allPathHeads.length > pathHeads.length,
    skill_manifest_head: pkg.skills?.manifest_head || null,
    selected_skills: skillItems.map(skill => ({ skill_id: skill.skill_id, skill_version: skill.skill_version, stone_hash: skill.stone_hash, commit_sha: skill.commit_sha })),
    memory_refs: memoryItems.map(item => ({
      authority_class: item.authority_class, stone_hash: item.stone_hash, path: item.path, ref_id: item.ref_id,
      line_start: item.line_start, line_end: item.line_end, freshness: item.freshness
    })),
    memory_refs_truncated: allMemory.length > memoryItems.length || pkg.memory?.truncated === true
  };
}

function compactDelegationRoute(route) {
  if (!route || typeof route !== "object") return null;
  return {
    provider: route.provider || null, model: route.model || null, transport: route.transport || null,
    credential_mode: route.credential_mode || null,
    failover_policy: route.failover_policy || (route.failover?.mode || "none")
  };
}

function compactDelegationUsage(usage) {
  return {
    input_tokens: delegationNumberOrNull(usage && usage.input_tokens),
    output_tokens: delegationNumberOrNull(usage && usage.output_tokens),
    cost: usage && Object.prototype.hasOwnProperty.call(usage, "cost") ? usage.cost : null
  };
}

function compactDelegationObservability(result) {
  const source = result && result.observability && typeof result.observability === "object" ? result.observability : {};
  const attempts = Array.isArray(source.attempts) ? source.attempts : Array.isArray(result && result.attempts) ? result.attempts : [];
  return {
    gateway_id: source.gateway_id || null,
    gateway_request_id: source.gateway_request_id || null,
    attempts: attempts.map(item => ({
      provider: item.provider || null, model: item.model || null, transport: item.transport || null,
      status: item.status || null, error: item.error || null,
      latency_ms: delegationNumberOrNull(item.latency_ms), mock: item.mock === true
    }))
  };
}

function compactDelegationDiagnostics(pkg, result) {
  return {
    context_package_returned: false,
    server_carried_context_package: true,
    package_bytes: delegationNumberOrNull(pkg.limits?.package_bytes),
    package_truncated: pkg.limits?.truncated === true,
    memory_truncated: pkg.memory?.truncated === true,
    coordination_items: Array.isArray(pkg.coordination?.items) ? pkg.coordination.items.length : 0,
    external_model_calls: delegationModelCallCount(result),
    tools_executed: 0
  };
}

function delegationModelCallCount(result) {
  const candidates = [
    result && result.v7_1_4 && result.v7_1_4.external_model_calls,
    result && result.v7_1_3 && result.v7_1_3.external_model_calls,
    result && result.v7_1_2 && result.v7_1_2.external_model_calls,
    result && result.v7_1_1 && result.v7_1_1.external_model_calls
  ];
  for (const value of candidates) if (Number.isFinite(Number(value))) return Number(value);
  const attempts = result && result.observability && Array.isArray(result.observability.attempts) ? result.observability.attempts : [];
  return attempts.filter(item => item && item.mock !== true).length;
}

function delegationReadOnlyPolicy() {
  return {
    delegation_mode: "read_only", tools_exposed_to_model: 0, tools_executed: 0,
    execution_authority: false, mutation_authority: false, accepted_state_mutation: false
  };
}

function compactDelegationFailure(value) {
  if (!value || typeof value !== "object") return null;
  return { error: value.error || null, detail: value.detail || null };
}

function delegationFailure(error, detail) {
  return { ok: false, error, ...(detail ? { detail } : {}), policy: delegationReadOnlyPolicy() };
}

function delegationRequiredText(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_${name}`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`invalid_${name}`);
  return text;
}

function delegationNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export const MODEL_ROUTE_TOOL_DEFINITION = {
  name: "cairnstone_model_route",
  description: "V7.1.4 provider-neutral router. Validates a V7.0 context package, deterministically builds request IR, checks runtime model capabilities, and routes to deterministic mocks, the live Workers AI adapter, or a BYOK third-party adapter, with optional explicit ordered failover. Model tool calls are normalized into unexecuted intents; the router never executes tools or grants execution/mutation authority. Third-party credentials are never accepted as tool input -- they resolve server-side from a Worker secret binding by (provider, credential_alias). Failover is off by default; every fallback candidate is validated against the identical capability requirements as the primary before any call is attempted, so a fallback can never quietly run with weaker tool/capability support.",
  inputSchema: {
    type: "object",
    required: ["context_package", "route"],
    properties: {
      context_package: { type: "object", description: "Completed cairnstone-agent-context-v1 package from V7.0." },
      route: {
        type: "object",
        required: ["provider", "model"],
        properties: {
          provider: { type: "string", description: "Supported providers in V7.1.4: mock-a, mock-b, workers-ai, openai, deepseek, anthropic, groq, mistral, cerebras, sambanova, grok, kimi." },
          model: { type: "string", description: "Exact model ID from the runtime capability registry." },
          gateway_id: { type: "string", description: "Workers AI Gateway ID. Defaults to 'default'. Route metadata only; never part of package_id or request_ir_id." },
          credential_mode: { type: "string", enum: ["workers_ai_billing", "unified_billing", "byok"], description: "Credential mode for third-party/BYOK providers. Route metadata only; never part of package_id or request_ir_id." },
          credential_alias: { type: "string", description: "Alias name identifying which Worker secret binding to resolve server-side for a BYOK provider. Never the secret value itself; the router rejects any route field literally named credential/api_key/token/secret." },
          failover: {
            type: "object",
            description: "Optional explicit fallback policy. Omit or set mode:'none' for the default (no fallback, single candidate). Never affects package_id or request_ir_id.",
            properties: {
              mode: { type: "string", enum: ["none", "explicit"] },
              chain: {
                type: "array",
                description: "Ordered fallback candidates, tried in order only if the primary (and each prior candidate) fails. Each candidate uses the same shape as route minus 'failover'. Max 5. Every candidate is validated against the same capability requirements as the primary before any call is attempted.",
                maxItems: 5,
                items: {
                  type: "object",
                  required: ["provider", "model"],
                  properties: {
                    provider: { type: "string" },
                    model: { type: "string" },
                    gateway_id: { type: "string" },
                    credential_mode: { type: "string", enum: ["workers_ai_billing", "unified_billing", "byok"] },
                    credential_alias: { type: "string" }
                  },
                  additionalProperties: false
                }
              }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      request: {
        type: "object",
        properties: {
          tools: { type: "array", items: { type: "string" }, maxItems: 250 },
          generation: {
            type: "object",
            properties: {
              max_output_tokens: { type: "number", minimum: 1, maximum: 4096 },
              temperature: { type: "number", minimum: 0, maximum: 2 }
            },
            additionalProperties: false
          },
          advisory_resolution: { type: "object" }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
};
