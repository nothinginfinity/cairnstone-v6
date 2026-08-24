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

export function validateRouteEnvelope(route, requestIr, registry = DEFAULT_MODEL_CAPABILITY_REGISTRY) {
  const irValidation = validateRequestIrShape(requestIr);
  if (!irValidation.ok) return irValidation;
  if (!route || typeof route !== "object") return { ok: false, error: "provider_not_supported", detail: "route_not_an_object" };
  if (Object.prototype.hasOwnProperty.call(route, "credential") || Object.prototype.hasOwnProperty.call(route, "api_key") || Object.prototype.hasOwnProperty.call(route, "token") || Object.prototype.hasOwnProperty.call(route, "secret")) {
    return { ok: false, error: "provider_auth_failed", detail: "credential_material_not_accepted_in_v7_1_1" };
  }
  if (route.failover && route.failover.mode && route.failover.mode !== "none") {
    return { ok: false, error: "unsupported_route_policy", detail: "failover_not_implemented_until_v7_1_4" };
  }
  const capabilityResult = resolveModelCapability(route, registry);
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
  return { ok: true, value: capability };
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

export const DEFAULT_MOCK_ADAPTERS = Object.freeze({
  "mock-a": makeMockAdapter("mock-a"),
  "mock-b": makeMockAdapter("mock-b")
});

export async function modelRouteFromBody(body, _env, deps = {}) {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_request_ir", detail: "body_not_an_object" };
  const pkg = body.context_package;
  const requestOptions = body.request && typeof body.request === "object" ? body.request : {};
  const irResult = await buildRequestIr(pkg, requestOptions);
  if (!irResult.ok) return irResult;
  const requestIr = irResult.value;

  const registry = Array.isArray(deps.registry) ? deps.registry : DEFAULT_MODEL_CAPABILITY_REGISTRY;
  const adapters = deps.adapters && typeof deps.adapters === "object" ? deps.adapters : DEFAULT_MOCK_ADAPTERS;
  const route = body.route && typeof body.route === "object" ? body.route : null;
  const routeValidation = validateRouteEnvelope(route, requestIr, registry);
  if (!routeValidation.ok) return { ...routeValidation, package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };
  const capability = routeValidation.value;
  const adapter = adapters[route.provider];
  if (!adapter) return { ok: false, error: "provider_not_supported", provider: route.provider, package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };
  const verdict = typeof adapter.can_handle === "function" ? adapter.can_handle(route, requestIr) : { ok: false, error: "provider_not_supported" };
  if (!verdict || verdict.ok !== true) return { ...(verdict || { ok: false, error: "provider_not_supported" }), package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };

  try {
    const providerRequest = adapter.encode(requestIr, route, capability);
    const raw = await adapter.invoke(providerRequest, { credentials: null });
    const normalized = adapter.normalize(raw, route, requestIr, capability);
    const shape = validateModelResultShape(normalized);
    if (!shape.ok) {
      return { ok: false, error: "provider_response_invalid", detail: shape.detail, package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id };
    }
    return normalized;
  } catch (error) {
    if (typeof adapter.normalize_error === "function") return adapter.normalize_error(error, route, requestIr);
    return {
      ok: false,
      error: "provider_response_invalid",
      provider: route.provider,
      model: route.model,
      package_id: requestIr.package_id,
      request_ir_id: requestIr.request_ir_id,
      diagnostic: String(error && error.message ? error.message : error)
    };
  }
}

export const MODEL_ROUTE_TOOL_DEFINITION = {
  name: "cairnstone_model_route",
  description: "V7.1.1 provider-neutral router core. Validates a V7.0 context package, deterministically builds request IR, checks a runtime model capability registry, and invokes only deterministic mock-a/mock-b adapters in this slice. Returns normalized model results with zero external model calls, zero tool execution, and zero execution/mutation authority.",
  inputSchema: {
    type: "object",
    required: ["context_package", "route"],
    properties: {
      context_package: { type: "object", description: "Completed cairnstone-agent-context-v1 package from V7.0." },
      route: {
        type: "object",
        required: ["provider", "model"],
        properties: {
          provider: { type: "string", description: "V7.1.1 accepts mock-a or mock-b only." },
          model: { type: "string", description: "Exact model ID from the V7.1.1 runtime capability registry." }
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
