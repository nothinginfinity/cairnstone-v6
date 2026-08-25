import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  modelRouteFromBody,
  recomputePackageId
} from "../src/model-router.js";

function baseFixturePackage() {
  return {
    ok: true,
    schema: AGENT_CONTEXT_SCHEMA,
    package_id: null,
    actor: { actor_id: "test:fixture" },
    request: { task: "fixture task", chain: "cairnstone-v6-project-memory" },
    runtime: { cairnstone_version: "test", protocol: "FSL-CCR Stone v6", compiled_at: "2026-08-25T00:00:00.000Z" },
    authority: {
      chain: "cairnstone-v6-project-memory",
      chain_head: { stone_hash: "chain-head-hash", path: "project-memory/x.md", repo: null, commit_sha: null },
      path_heads: [
        { path: "docs/AI_OPERATING_GUIDE.md", stone_hash: "instructions-stone", repo: "nothinginfinity/cairnstone-v6", commit_sha: "55ec7b749fc8c21431d67c268646b43f60337612" }
      ],
      timestamp_ordering_used: false
    },
    instructions: {
      path: "docs/AI_OPERATING_GUIDE.md",
      stone_hash: "instructions-stone",
      repo: "nothinginfinity/cairnstone-v6",
      commit_sha: "55ec7b749fc8c21431d67c268646b43f60337612",
      content_identity: { sha256: "abc", git_blob_sha: "4448e428eba37d0e687e7ca402b6c473757ad1da", bytes: 3 },
      content: "Fixture instructions.",
      truncated: false
    },
    coordination: { recipient_id: "test:fixture", unread_count: 0, items: [] },
    skills: {
      chain: "cairnstone-v6-skills",
      manifest_head: "skills-head",
      resolution_mode: "deterministic",
      boot: [],
      recommendations: [],
      ambiguous: false,
      accepted_bundle: { bundle_identity: { algorithm: "sha256", sha256: "bundle" }, skills: [] }
    },
    memory: { query: "fixture", items: [], truncated: false },
    capabilities: { available_tools: ["cairnstone_health"], missing_required_tools: [], supports_tool_calls: true },
    policy: {
      context_compiler_called_llm: false,
      execution_authority: false,
      mutation_authority: false,
      provider_credentials_in_package: false,
      accepted_state_only_for_authority: true,
      mutable_branch_is_authority: false
    },
    limits: { effective_max_package_bytes: 64000, package_bytes: 1000, skills_bytes: 0, memory_bytes: 0, instructions_bytes: 22, truncated: false }
  };
}

async function withValidPackageId(pkg) {
  const clone = structuredClone(pkg);
  clone.package_id = await recomputePackageId(clone);
  return clone;
}

// A registry with two mock-shaped providers so failover tests aren't tied to
// the real mock-a/mock-b adapters' internal behavior.
function twoProviderRegistry() {
  return [
    { provider: "flaky", model: "flaky/v1", transport: "mock", supports: { text: true, tool_calls: true }, context_window: 32768, max_output_tokens: 4096, status: "available", observed_at: "2026-01-01T00:00:00.000Z" },
    { provider: "backup", model: "backup/v1", transport: "mock", supports: { text: true, tool_calls: true }, context_window: 32768, max_output_tokens: 4096, status: "available", observed_at: "2026-01-01T00:00:00.000Z" },
    { provider: "no-tools", model: "no-tools/v1", transport: "mock", supports: { text: true, tool_calls: false }, context_window: 32768, max_output_tokens: 4096, status: "available", observed_at: "2026-01-01T00:00:00.000Z" }
  ];
}

function makeFailingAdapter(provider) {
  return {
    can_handle: route => (route.provider === provider ? { ok: true } : { ok: false, error: "provider_not_supported" }),
    encode: () => ({}),
    invoke: async () => { const e = new Error("synthetic_primary_failure"); e.status = 503; throw e; },
    normalize: () => { throw new Error("unreachable"); },
    normalize_error: (_error, route, requestIr) => ({
      ok: false,
      error: "provider_capacity_exceeded",
      provider: route.provider,
      model: route.model,
      package_id: requestIr.package_id,
      request_ir_id: requestIr.request_ir_id
    })
  };
}

function makeSucceedingAdapter(provider) {
  return {
    can_handle: route => (route.provider === provider ? { ok: true } : { ok: false, error: "provider_not_supported" }),
    encode: (requestIr, route) => ({ package_id: requestIr.package_id, request_ir_id: requestIr.request_ir_id, model: route.model }),
    invoke: async providerRequest => ({ text: `ok-from-${provider}`, providerRequest }),
    normalize: (raw, route, requestIr, capability) => ({
      ok: true,
      schema: "cairnstone-model-result-v1",
      package_id: requestIr.package_id,
      request_ir_id: requestIr.request_ir_id,
      route: { provider: route.provider, model: route.model, transport: capability.transport, credential_mode: "none", failover_policy: "none" },
      output: { text: raw.text, tool_intents: [], finish_reason: "stop" },
      usage: { input_tokens: 1, output_tokens: 1, cost: null },
      observability: { gateway_id: null, gateway_request_id: null, attempts: [{ provider: route.provider, model: route.model, transport: capability.transport, status: "succeeded", mock: true }] },
      policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
    })
  };
}

test("V7.1.4: default (no failover field) behaves exactly as a single candidate -- one attempt only", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "backup", model: "backup/v1" },
    request: { tools: ["cairnstone_health"] }
  }, null, { registry: twoProviderRegistry(), adapters: { backup: makeSucceedingAdapter("backup") } });

  assert.equal(result.ok, true);
  assert.equal(result.observability.attempts.length, 1);
  assert.equal(result.observability.attempts[0].status, "succeeded");
  assert.equal(result.route.failover_policy, "none");
});

test("V7.1.4: explicit failover falls through to the fallback and preserves package_id/request_ir_id", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: {
      provider: "flaky",
      model: "flaky/v1",
      failover: { mode: "explicit", chain: [{ provider: "backup", model: "backup/v1" }] }
    },
    request: { tools: ["cairnstone_health"] }
  }, null, {
    registry: twoProviderRegistry(),
    adapters: { flaky: makeFailingAdapter("flaky"), backup: makeSucceedingAdapter("backup") }
  });

  assert.equal(result.ok, true);
  assert.equal(result.package_id, pkg.package_id);
  assert.match(result.request_ir_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.route.provider, "backup");
  assert.equal(result.route.failover_policy, "explicit");
  assert.equal(result.output.text, "ok-from-backup");

  // Full ordered history: the failed primary attempt, then the succeeding fallback.
  assert.equal(result.observability.attempts.length, 2);
  assert.equal(result.observability.attempts[0].provider, "flaky");
  assert.equal(result.observability.attempts[0].status, "failed");
  assert.equal(result.observability.attempts[0].error, "provider_capacity_exceeded");
  assert.equal(result.observability.attempts[1].provider, "backup");
  assert.equal(result.observability.attempts[1].status, "succeeded");
});

test("V7.1.4: identical package_id and request_ir_id whether or not failover is used at all", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const noFailover = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "backup", model: "backup/v1" },
    request: { tools: ["cairnstone_health"] }
  }, null, { registry: twoProviderRegistry(), adapters: { backup: makeSucceedingAdapter("backup") } });

  const withFailover = await modelRouteFromBody({
    context_package: pkg,
    route: {
      provider: "flaky",
      model: "flaky/v1",
      failover: { mode: "explicit", chain: [{ provider: "backup", model: "backup/v1" }] }
    },
    request: { tools: ["cairnstone_health"] }
  }, null, {
    registry: twoProviderRegistry(),
    adapters: { flaky: makeFailingAdapter("flaky"), backup: makeSucceedingAdapter("backup") }
  });

  assert.equal(noFailover.package_id, withFailover.package_id);
  assert.equal(noFailover.request_ir_id, withFailover.request_ir_id);
});

test("V7.1.4: every candidate failing returns the last failure plus the full attempts history", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: {
      provider: "flaky",
      model: "flaky/v1",
      failover: { mode: "explicit", chain: [{ provider: "flaky", model: "flaky/v1" }] }
    },
    request: { tools: ["cairnstone_health"] }
  }, null, { registry: twoProviderRegistry(), adapters: { flaky: makeFailingAdapter("flaky") } });

  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_capacity_exceeded");
  assert.equal(result.package_id, pkg.package_id);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].status, "failed");
  assert.equal(result.attempts[1].status, "failed");
  assert.equal(result.policy.execution_authority, false);
});

test("V7.1.4: a fallback candidate lacking required tool support fails the WHOLE request up front, never silently degrading capability", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: {
      provider: "flaky",
      model: "flaky/v1",
      failover: { mode: "explicit", chain: [{ provider: "no-tools", model: "no-tools/v1" }] }
    },
    request: { tools: ["cairnstone_health"] } // requires tool_calls support
  }, null, {
    registry: twoProviderRegistry(),
    // Even though the primary adapter would have succeeded, validation of the
    // incapable fallback candidate must reject the request before any
    // adapter (including the primary) is ever invoked.
    adapters: { flaky: makeSucceedingAdapter("flaky"), "no-tools": makeSucceedingAdapter("no-tools") }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "model_capability_mismatch");
  assert.deepEqual(result.missing, ["tool_calls"]);
});

test("V7.1.4: empty or missing failover chain under explicit mode fails closed", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "backup", model: "backup/v1", failover: { mode: "explicit", chain: [] } },
    request: { tools: ["cairnstone_health"] }
  }, null, { registry: twoProviderRegistry(), adapters: { backup: makeSucceedingAdapter("backup") } });

  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported_route_policy");
  assert.equal(result.detail, "failover_chain_empty_or_missing");
});

test("V7.1.4: a failover chain candidate carrying credential material is rejected, same as the primary", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: {
      provider: "flaky",
      model: "flaky/v1",
      failover: { mode: "explicit", chain: [{ provider: "backup", model: "backup/v1", api_key: "sk-should-be-rejected" }] }
    },
    request: { tools: ["cairnstone_health"] }
  }, null, { registry: twoProviderRegistry(), adapters: { flaky: makeFailingAdapter("flaky"), backup: makeSucceedingAdapter("backup") } });

  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_auth_failed");
  assert.equal(result.detail, "credential_material_not_accepted_in_router");
  assert.equal(JSON.stringify(result).includes("sk-should-be-rejected"), false);
});

test("V7.1.4: failover chain longer than 5 candidates fails closed", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const chain = Array.from({ length: 6 }, () => ({ provider: "backup", model: "backup/v1" }));
  const result = await modelRouteFromBody({
    context_package: pkg,
    route: { provider: "flaky", model: "flaky/v1", failover: { mode: "explicit", chain } },
    request: { tools: ["cairnstone_health"] }
  }, null, { registry: twoProviderRegistry(), adapters: { flaky: makeFailingAdapter("flaky"), backup: makeSucceedingAdapter("backup") } });

  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported_route_policy");
  assert.equal(result.detail, "failover_chain_too_long");
});
