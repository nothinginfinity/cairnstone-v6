# V7.1 — Provider-Neutral Model Router Contract

Status: **architecture contract planned / implementation not started**
Planning date: **2026-08-24**
Phase boundary: **first model-calling V7 slice after V7.0 context compilation**
Predecessor: `docs/V7_0_CONTEXT_COMPILER_CONTRACT.md`

## 1. Purpose

V7.1 makes the reasoning engine replaceable without allowing provider choice to redefine the CairnStone agent.

The router consumes one completed `cairnstone-agent-context-v1` package from V7.0 and produces a normalized model result. Provider/model choice, credentials, retries, billing mode, and failover policy are outer runtime concerns. They must never become accepted-state authority.

The central invariant is:

> The same V7.0 package is the same agent state regardless of which compatible model reasons over it.

V7.1 introduces two stable runtime contracts:

1. `cairnstone-model-request-v1` — provider-neutral request IR derived from a V7.0 package.
2. `cairnstone-model-result-v1` — normalized model output/tool-intent envelope.

Provider adapters translate only at the edge.

## 2. Phase gate from V7.0

Planning may proceed now.

Before the first production V7.1 implementation slice, the default gate is to close V7.0 acceptance **Test G (deliberate mid-compile race injection)**. An explicit canonical waiver may defer G, but it must not disappear from project state.

V7.0 **Test C (cross-provider neutrality)** is intentionally completed by V7.1 acceptance because V7.0 itself has no second provider consumer.

Current accepted V7.0 evidence covers A, B, D, E, F, H, I, and J.

## 3. Non-goals

V7.1 does **not**:

- change CairnStone chain/path HEADs;
- choose canonical instructions or accepted memory;
- load unaccepted skills;
- mutate the V7.0 `package_id`;
- execute model-requested tools;
- grant mutation/execution authority;
- create the V7.2 console;
- create persistent cross-turn chat memory outside existing CairnStone/AC1 state;
- implement the V7.3 permissioned execution loop;
- persist provider secrets into stones, AC1, logs, evidence payloads, or model results.

Model tool calls end in normalized **tool intents** only.

## 4. Runtime data flow

```text
actor + task + chain
        ↓
V7.0 cairnstone_agent_bootstrap
        ↓
cairnstone-agent-context-v1
package_id = sha256:...
        ↓
validate package + authority invariants
        ↓
cairnstone-model-request-v1
request_ir_id = sha256:...
        ↓
explicit route envelope
(provider/model/credential mode/failover policy)
        ↓
provider adapter
        ↓
Cloudflare AI Gateway / AI REST API
        ↓
provider/model
        ↓
provider adapter normalize
        ↓
cairnstone-model-result-v1
        ↓
text + tool intents only
```

`package_id` identifies accepted agent context.
`request_ir_id` identifies the provider-neutral prompt/tool request derived from that package.
Provider/model identity belongs outside both authority identities.

## 5. V7.0 package validation

The router must reject a package unless all of these hold:

- `schema === "cairnstone-agent-context-v1"`;
- `ok === true`;
- `package_id` is present and syntactically valid;
- `policy.accepted_state_only_for_authority === true`;
- `policy.mutable_branch_is_authority === false`;
- `policy.execution_authority === false`;
- `policy.mutation_authority === false`;
- `policy.provider_credentials_in_package === false`.

Implementation should recompute/verify the package hash using the V7.0 canonicalization routine rather than trusting a caller-supplied ID.

Typed failure: `invalid_context_package`.

## 6. Provider-neutral request IR

Schema:

`cairnstone-model-request-v1`

Proposed shape:

```json
{
  "schema": "cairnstone-model-request-v1",
  "request_ir_id": "sha256:<hex>",
  "package_id": "sha256:<hex>",
  "actor_id": "chatgpt:cairnstone-v6",
  "task": "...",
  "messages": [],
  "tools": [],
  "tool_policy": {
    "intent_only": true,
    "execution_authority": false,
    "mutation_authority": false
  },
  "generation": {
    "max_output_tokens": 1200,
    "temperature": 0.2
  },
  "advisory_resolution": null,
  "provenance": {
    "context_schema": "cairnstone-agent-context-v1"
  }
}
```

### IR identity rules

`request_ir_id` must include all provider-neutral data that changes the effective model request, including:

- `package_id`;
- normalized system/user message material derived from the package;
- selected already-accepted skill material;
- normalized tool schemas exposed to the model;
- generation parameters that materially affect the request;
- any V6.10 advisory skill-routing decision.

It must **exclude**:

- provider;
- model;
- API/gateway credentials;
- transport URL;
- request latency;
- gateway request IDs;
- retry attempt number.

For the same `package_id` and same provider-neutral settings, switching providers must leave `request_ir_id` unchanged.

## 7. Prompt/message construction

The router may translate the V7.0 package into a provider-neutral message sequence, but must preserve precedence:

1. canonical accepted operating instructions;
2. explicit V7.0 policy and authority evidence;
3. accepted skill content;
4. accepted/retrieved memory evidence with authority labels;
5. correspondence and user task as data/context.

Historical memory, correspondence text, skill examples, or retrieved content cannot self-promote into higher-precedence instructions.

No provider adapter may independently rebuild the agent from mutable Git, local files, or provider-specific memory.

## 8. Skills ambiguity

If V7.0 returns `skills.ambiguous:true`, V7.1 may optionally call the V6.10 Skills Sub-Agent **before provider selection**.

Rules:

- candidates remain limited to V7.0's deterministic accepted candidates;
- no unaccepted skill may be introduced;
- no new authority may be granted;
- the advisory decision is recorded in `advisory_resolution`;
- the advisory decision changes `request_ir_id`, not `package_id`;
- cross-provider acceptance must reuse the same resolved IR for both providers.

If advisory routing fails, fall back to the deterministic V7.0 baseline or return a typed routing error; never invent a skill.

## 9. Model capability registry

V7.1 needs a runtime capability registry. It is operational configuration, **not CairnStone accepted-state authority**.

Suggested fields:

```json
{
  "provider": "workers-ai",
  "model": "@cf/author/model",
  "transport": "ai-rest-chat",
  "supports": {
    "text": true,
    "streaming": true,
    "tool_calls": true,
    "reasoning": true,
    "vision": false
  },
  "context_window": 0,
  "max_output_tokens": 0,
  "status": "available",
  "observed_at": "ISO-8601"
}
```

Rules:

- resolve model IDs against the live provider/Cloudflare catalog at implementation and acceptance time;
- do not hard-code one "best" model as architecture;
- tool-capability mismatch fails explicitly unless the caller opted into a declared downgrade;
- current model examples are evidence only, never immutable authority.

## 10. Provider adapter contract

Each adapter implements the same logical interface:

```text
can_handle(route, request_ir) -> capability verdict
encode(request_ir, route) -> provider request
invoke(provider request, runtime credentials) -> raw response
normalize(raw response, route, request_ir) -> cairnstone-model-result-v1
normalize_error(error, route) -> typed router error
```

Adapters may translate:

- message format;
- tool/function schema;
- reasoning/thinking options;
- streaming chunks;
- token accounting fields;
- provider-specific finish reasons.

Adapters may not alter accepted authority, silently remove required tools, or change `package_id` / `request_ir_id`.

## 11. Cloudflare transport baseline

As of the V7.1 planning date, new normal single-model integrations should prefer Cloudflare's **AI REST API** rather than the deprecated AI Gateway Universal Endpoint.

Primary transports:

- `/ai/v1/chat/completions` — common text/tool-calling baseline where compatible;
- `/ai/v1/responses` — agentic/response-style models where supported;
- `/ai/run` — model-specific or non-chat modalities when needed;
- provider-native AI Gateway endpoints — only when a provider-specific feature or non-default BYOK alias requires them.

Dynamic Routing is a separate optional policy path. It is not the default transport for V7.1.

If Dynamic Routing is used, it must be invoked under an explicit route/failover policy and its selected provider/model must be observable in the result envelope.

## 12. Provider and credential modes

Provider identity and credential mode are independent.

Proposed route envelope:

```json
{
  "provider": "anthropic",
  "model": "anthropic/<model>",
  "transport": "ai-rest-chat",
  "credential": {
    "mode": "byok",
    "alias": "default"
  },
  "failover": {
    "mode": "none"
  }
}
```

Allowed credential modes may include:

- `workers_ai_billing`;
- `unified_billing`;
- `byok`;
- `request_scoped_provider_key` only if a later security review explicitly allows it.

Default design preference: stored BYOK or Unified Billing. Raw provider keys should not be accepted by CairnStone MCP tool inputs if avoidable.

The route may carry a **BYOK alias name**, but never the secret value.

Credential precedence must be treated as runtime behavior and surfaced in evidence where Cloudflare exposes it, without exposing key material.

## 13. Initial provider classes

Acceptance should prove at least two distinct provider classes:

1. **Workers AI hosted model**
   - model resolved from the live Workers AI catalog;
   - current high-capability candidates may include DeepSeek/Kimi/GLM families where available and account-eligible.

2. **Third-party model through AI Gateway**
   - OpenAI, Anthropic, xAI, Google, DeepSeek, Groq, Cerebras, Mistral, or another supported provider;
   - use Unified Billing or stored BYOK according to the test.

The contract must not depend on any one vendor.

## 14. Tool intent normalization

V7.1 may expose tools listed by V7.0 capability evidence when the selected model supports tool calling.

Normalized intent:

```json
{
  "intent_id": "sha256:<hex>",
  "tool_id": "AFO GitHub API MCP.list_workflow_runs",
  "arguments": {},
  "source": {
    "provider": "openai",
    "model": "openai/<model>"
  },
  "policy": {
    "intent_only": true,
    "executed": false,
    "execution_authority": false,
    "mutation_authority": false
  }
}
```

The router must never invoke the tool in V7.1.

Unknown tool IDs, malformed arguments, or tools not represented in the V7.0 capability evidence return explicit validation status and remain unexecuted.

## 15. Normalized model result

Schema:

`cairnstone-model-result-v1`

Proposed shape:

```json
{
  "ok": true,
  "schema": "cairnstone-model-result-v1",
  "package_id": "sha256:<hex>",
  "request_ir_id": "sha256:<hex>",
  "route": {
    "provider": "openai",
    "model": "openai/<model>",
    "transport": "ai-rest-chat",
    "credential_mode": "byok",
    "failover_policy": "none"
  },
  "output": {
    "text": "...",
    "tool_intents": [],
    "finish_reason": "stop"
  },
  "usage": {
    "input_tokens": null,
    "output_tokens": null,
    "cost": null
  },
  "observability": {
    "gateway_id": null,
    "gateway_request_id": null,
    "attempts": []
  },
  "policy": {
    "tool_intents_only": true,
    "execution_authority": false,
    "mutation_authority": false
  }
}
```

Provider-specific raw response bodies should not become the stable public contract.

## 16. Explicit routing and failover

Default: **no implicit failover**.

A request either:

- names one provider/model; or
- names an explicit, versioned routing policy.

Failover must never be inferred merely because another provider is available.

When failover is enabled:

- preserve the same `package_id`;
- preserve the same `request_ir_id`;
- record every attempt in order;
- record the provider/model that ultimately succeeded;
- normalize why each prior attempt failed;
- never change tool/execution authority;
- never silently drop required capabilities to make a fallback succeed.

Dynamic Routing may implement the transport-level fallback graph, but CairnStone still owns the explicit policy decision to use that route.

## 17. Observability

Every model call should produce enough evidence to answer:

- which `package_id` was used;
- which `request_ir_id` was used;
- which provider/model actually handled the request;
- whether failover occurred;
- which credential mode was selected (never the credential);
- latency;
- provider/gateway request identifier when available;
- token usage;
- normalized cost when available;
- normalized error category on failure.

Logs must avoid canonical instruction bodies, secret material, and unnecessary user content by default. Metadata-first observability is preferred.

## 18. Error model

Typed router failures should include at least:

- `invalid_context_package`
- `invalid_request_ir`
- `model_not_found`
- `model_unavailable`
- `model_capability_mismatch`
- `provider_not_supported`
- `provider_auth_failed`
- `provider_rate_limited`
- `provider_capacity_exceeded`
- `provider_timeout`
- `provider_bad_request`
- `provider_response_invalid`
- `gateway_error`
- `explicit_failover_exhausted`
- `tool_intent_invalid`
- `advisory_skill_routing_failed`

Errors preserve `package_id` and `request_ir_id` whenever those identities were successfully established.

## 19. Security boundaries

V7.1 must fail closed on secret leakage.

Provider credentials must never appear in:

- V7.0 context packages;
- request IR;
- result envelopes;
- CairnStone stones;
- AC1 messages;
- model-visible prompt bodies;
- normal logs or tracing metadata.

Adapters should receive credentials only through Worker bindings / AI Gateway / Secrets Store integration.

Do not expose environment enumeration or secret presence values to the model.

## 20. Acceptance contract

V7.1 is complete only when all of the following pass.

### R1. Package integrity

A valid V7.0 package is accepted; a tampered package or mismatched `package_id` fails closed.

### R2. Request-IR determinism

Same V7.0 package + same provider-neutral settings produces identical `request_ir_id`.

### R3. Cross-provider neutrality / V7.0 Test C

Send the same request IR to:

- one Workers AI model; and
- one third-party provider model.

Require identical `package_id` and `request_ir_id` on both result envelopes.

This closes V7.0 Test C.

### R4. Provider identity separation

Switching provider/model changes only the route/result envelope, never V7.0 authority.

### R5. Tool capability truth

A tool-capable model receives normalized tool schemas. A model lacking required tool support returns `model_capability_mismatch` unless an explicit downgrade policy exists.

### R6. Tool intent only

Trigger at least one real model tool call and prove it returns a normalized `tool_intent` with `executed:false`; no external tool is invoked.

### R7. Secret isolation

Exercise Workers AI, Unified Billing, and/or stored BYOK and prove no provider secret appears in package, IR, result, CairnStone, AC1, or logs.

### R8. Explicit failover

Prove default requests do not fail over. Then enable an explicit fallback policy, induce a primary failure, and prove attempts/provider selection are recorded while `package_id` and `request_ir_id` remain unchanged.

### R9. Error normalization

Exercise at least timeout/rate-limit or deterministic fixtures and prove provider-specific failures map to typed router errors without losing provider diagnostics.

### R10. AI Gateway observability

Prove the actual provider/model used can be correlated to AI Gateway/runtime telemetry.

### R11. Advisory skill ambiguity

When V7.0 returns genuine ambiguity, prove any Skills Sub-Agent decision remains inside deterministic accepted candidates and changes only request IR, not package authority.

### R12. Direct MCP acceptance

Verify the production router through direct MCP JSON-RPC, not only unit tests or health advertisement.

## 21. Implementation slices

### V7.1.0 — Contract + fixtures

- accept this document;
- add schema fixtures for package/IR/result;
- build pure canonicalization/hash helpers;
- no external model call.

### V7.1.1 — Router core + mock adapters

- package validation;
- request IR;
- capability registry interface;
- normalized results/errors;
- mock provider A/B proves package/IR neutrality.

### V7.1.2 — Workers AI adapter

- live model-catalog validation;
- AI REST API transport;
- text + tool-call normalization;
- telemetry.

### V7.1.3 — Third-party / BYOK adapter

- choose one supported provider for first live proof;
- prove Unified Billing or stored BYOK;
- keep provider-specific translation isolated in adapter.

### V7.1.4 — Explicit failover + observability

- no-failover default;
- versioned explicit policy;
- optional Dynamic Routing integration;
- attempts/cost/error normalization.

### V7.1.5 — Live acceptance closure

- cross-provider proof closes V7.0 Test C;
- all R1-R12 evidence stoned;
- update V7 roadmap;
- only then unblock V7.2.

## 22. Definition of done

V7.1 is done when CairnStone can answer:

> "Given this exact immutable agent context and this provider-neutral reasoning request, which model reasoned over it, what did it return, and can we swap the model without changing the agent or accidentally executing anything?"

with stable package/request identities, inspectable provider evidence, explicit routing policy, normalized outputs/tool intents, and zero secret or authority leakage.
