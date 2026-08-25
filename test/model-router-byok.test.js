import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  buildRequestIr,
  DEFAULT_MODEL_ADAPTERS,
  DEFAULT_MODEL_CAPABILITY_REGISTRY,
  MODEL_RESULT_SCHEMA,
  modelRouteFromBody,
  recomputePackageId,
  validateModelResultShape
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

function mockFetchJson(status, jsonBody, headers = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] || null },
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody)
  });
  return () => { globalThis.fetch = original; };
}

test("openai adapter fails closed with provider_auth_failed when no BYOK secret is configured", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const env = {}; // no BYOK_OPENAI_API_KEY
  const result = await modelRouteFromBody(
    { context_package: pkg, route: { provider: "openai", model: "gpt-4o-mini" } },
    env
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_auth_failed");
  assert.equal(result.package_id, pkg.package_id);
});

test("openai adapter succeeds and produces a valid cairnstone-model-result-v1 when a BYOK secret is configured", async () => {
  const restore = mockFetchJson(200, {
    id: "chatcmpl-test",
    choices: [{ message: { role: "assistant", content: "Router online via BYOK." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 4 }
  }, { "x-request-id": "req-test-123" });
  try {
    const pkg = await withValidPackageId(baseFixturePackage());
    const env = { BYOK_OPENAI_API_KEY: "sk-test-not-real" };
    const result = await modelRouteFromBody(
      { context_package: pkg, route: { provider: "openai", model: "gpt-4o-mini" } },
      env
    );
    assert.equal(result.ok, true);
    assert.equal(validateModelResultShape(result).ok, true);
    assert.equal(result.route.provider, "openai");
    assert.equal(result.route.credential_mode, "byok");
    assert.equal(result.output.text, "Router online via BYOK.");
    assert.equal(result.output.tool_intents.length, 0);
    assert.equal(result.v7_1_3.tools_executed, 0);
    assert.equal(result.policy.execution_authority, false);
  } finally {
    restore();
  }
});

test("openai adapter resolves a non-default credential_alias to its own secret binding", async () => {
  const restore = mockFetchJson(200, {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: {}
  });
  try {
    const pkg = await withValidPackageId(baseFixturePackage());
    const env = { BYOK_OPENAI_API_KEY_TEAM_B: "sk-team-b-not-real" }; // no default key on purpose
    const result = await modelRouteFromBody(
      { context_package: pkg, route: { provider: "openai", model: "gpt-4o-mini", credential_alias: "team_b" } },
      env
    );
    assert.equal(result.ok, true);
  } finally {
    restore();
  }
});

test("route envelope still rejects any literal credential/api_key/token/secret field for the openai provider too", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await modelRouteFromBody(
    { context_package: pkg, route: { provider: "openai", model: "gpt-4o-mini", api_key: "sk-should-be-rejected" } },
    { BYOK_OPENAI_API_KEY: "sk-should-not-be-reached" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_auth_failed");
  assert.equal(result.detail, "credential_material_not_accepted_in_router");
});

test("a real OpenAI-shaped tool_call is normalized into an unexecuted tool intent with correct tool_id mapping", async () => {
  const restore = mockFetchJson(200, {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "cs_0_cairnstone_health", arguments: "{}" } }]
      },
      finish_reason: "tool_calls"
    }],
    usage: { prompt_tokens: 20, completion_tokens: 6 }
  });
  try {
    const pkg = await withValidPackageId(baseFixturePackage());
    const env = { BYOK_OPENAI_API_KEY: "sk-test-not-real" };
    const result = await modelRouteFromBody(
      {
        context_package: pkg,
        route: { provider: "openai", model: "gpt-4o-mini" },
        request: { tools: ["cairnstone_health"] }
      },
      env
    );
    assert.equal(result.ok, true);
    assert.equal(result.output.tool_intents.length, 1);
    const intent = result.output.tool_intents[0];
    assert.equal(intent.tool_id, "cairnstone_health");
    assert.equal(intent.executed, false);
    assert.equal(intent.policy.execution_authority, false);
    assert.equal(intent.validation.ok, true);
    assert.match(intent.intent_id, /^sha256:[0-9a-f]{64}$/);
  } finally {
    restore();
  }
});

test("HTTP 401 from the provider maps to provider_auth_failed via normalize_error", async () => {
  const restore = mockFetchJson(401, { error: { message: "Incorrect API key provided" } });
  try {
    const pkg = await withValidPackageId(baseFixturePackage());
    const env = { BYOK_OPENAI_API_KEY: "sk-invalid" };
    const result = await modelRouteFromBody(
      { context_package: pkg, route: { provider: "openai", model: "gpt-4o-mini" } },
      env
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "provider_auth_failed");
    assert.equal(result.package_id, pkg.package_id);
  } finally {
    restore();
  }
});

test("HTTP 429 from the provider maps to provider_rate_limited", async () => {
  const restore = mockFetchJson(429, { error: { message: "Rate limit exceeded" } });
  try {
    const pkg = await withValidPackageId(baseFixturePackage());
    const env = { BYOK_OPENAI_API_KEY: "sk-test-not-real" };
    const result = await modelRouteFromBody(
      { context_package: pkg, route: { provider: "openai", model: "gpt-4o-mini" } },
      env
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "provider_rate_limited");
  } finally {
    restore();
  }
});

test("R3 groundwork: mock-a and openai preserve identical package_id and request_ir_id for the same package + options", async () => {
  const restore = mockFetchJson(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
  try {
    const pkg = await withValidPackageId(baseFixturePackage());
    const options = { tools: ["cairnstone_health"], generation: { max_output_tokens: 800, temperature: 0.1 } };

    const irA = await buildRequestIr(pkg, options);
    const irOpenAi = await buildRequestIr(pkg, options);
    assert.equal(irA.value.request_ir_id, irOpenAi.value.request_ir_id);

    const resultMockA = await modelRouteFromBody(
      { context_package: pkg, route: { provider: "mock-a", model: "mock-a/text-tools-v1" }, request: options },
      {}
    );
    const resultOpenAi = await modelRouteFromBody(
      { context_package: pkg, route: { provider: "openai", model: "gpt-4o-mini" }, request: options },
      { BYOK_OPENAI_API_KEY: "sk-test-not-real" }
    );

    assert.equal(resultMockA.ok, true);
    assert.equal(resultOpenAi.ok, true);
    assert.equal(resultMockA.package_id, resultOpenAi.package_id);
    assert.equal(resultMockA.request_ir_id, resultOpenAi.request_ir_id);
    // Only route/output/observability differ -- never the identity fields.
    assert.notEqual(resultMockA.route.provider, resultOpenAi.route.provider);
  } finally {
    restore();
  }
});

test("openai is present in the default capability registry as evidence, independent of credential configuration", () => {
  const entry = DEFAULT_MODEL_CAPABILITY_REGISTRY.find(item => item.provider === "openai");
  assert.ok(entry, "expected an openai entry in the default registry");
  assert.equal(entry.status, "available");
  assert.equal(DEFAULT_MODEL_ADAPTERS.openai !== undefined, true);
});
