import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  buildRequestIr,
  MODEL_RESULT_SCHEMA,
  recomputePackageId,
  validateContextPackage,
  validateModelResultShape
} from "../src/model-router.js";

// A minimal but shape-complete V7.0 fixture package, built the same way
// agent-bootstrap.js assembles one (see hashablePayload in src/agent-bootstrap.js).
// package_id below is computed once via recomputePackageId() in a setup test
// and reused, so this fixture always has a genuinely valid, matching hash --
// not a hand-typed guess.
function baseFixturePackage() {
  return {
    ok: true,
    schema: AGENT_CONTEXT_SCHEMA,
    package_id: null, // filled in by withValidPackageId()
    actor: { actor_id: "test:fixture" },
    request: { task: "fixture task", chain: "cairnstone-v6-project-memory" },
    runtime: { cairnstone_version: "test", protocol: "FSL-CCR Stone v6", compiled_at: "2026-08-24T00:00:00.000Z" },
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

test("R1: a genuinely valid V7.0 package is accepted", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, true);
});

test("R1: a tampered package_id fails closed", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  pkg.package_id = "sha256:" + "0".repeat(64); // syntactically valid, wrong value
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_context_package");
  assert.equal(result.detail, "package_id_hash_mismatch");
});

test("R1: a package whose content was tampered after hashing fails closed", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  pkg.request.task = "a different task the hash was never computed over";
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "package_id_hash_mismatch");
});

test("R1: execution_authority:true in policy fails closed even with a correct hash", async () => {
  const pkg = baseFixturePackage();
  pkg.policy.execution_authority = true;
  pkg.package_id = await recomputePackageId(pkg); // hash matches, but policy itself is disqualifying
  const result = await validateContextPackage(pkg);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "execution_authority_not_false");
});

test("R2: identical package + identical provider-neutral settings yields identical request_ir_id", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const first = await buildRequestIr(pkg, { tools: ["cairnstone_health"], generation: { max_output_tokens: 800, temperature: 0.1 } });
  const second = await buildRequestIr(pkg, { tools: ["cairnstone_health"], generation: { max_output_tokens: 800, temperature: 0.1 } });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.value.request_ir_id, second.value.request_ir_id);
});

test("provider identity is not accepted by buildRequestIr and cannot affect request_ir_id", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const withoutProviderField = await buildRequestIr(pkg, { tools: ["cairnstone_health"] });
  // Even if a caller mistakenly stuffs provider/model into options, buildRequestIr
  // has no code path that reads them, so the IR (and its id) must be unaffected.
  const withExtraneousProviderHint = await buildRequestIr(pkg, {
    tools: ["cairnstone_health"],
    provider: "anthropic",
    model: "claude-opus-4-8",
    credential: { mode: "byok", alias: "default" }
  });
  assert.equal(withoutProviderField.ok, true);
  assert.equal(withExtraneousProviderHint.ok, true);
  assert.equal(withoutProviderField.value.request_ir_id, withExtraneousProviderHint.value.request_ir_id);
  assert.equal(withExtraneousProviderHint.value.provider, undefined);
  assert.equal(withExtraneousProviderHint.value.model, undefined);
});

test("changing generation parameters changes request_ir_id (it is part of the effective request)", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const a = await buildRequestIr(pkg, { generation: { max_output_tokens: 800, temperature: 0.1 } });
  const b = await buildRequestIr(pkg, { generation: { max_output_tokens: 1600, temperature: 0.1 } });
  assert.notEqual(a.value.request_ir_id, b.value.request_ir_id);
});

test("buildRequestIr rejects an invalid package before doing any IR work", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  pkg.policy.mutation_authority = true;
  const result = await buildRequestIr(pkg, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_context_package");
});

test("validateModelResultShape accepts a well-formed unexecuted-tool-intent result", () => {
  const result = validateModelResultShape({
    ok: true,
    schema: MODEL_RESULT_SCHEMA,
    package_id: "sha256:" + "1".repeat(64),
    request_ir_id: "sha256:" + "2".repeat(64),
    route: { provider: "anthropic", model: "claude-opus-4-8", transport: "ai-rest-chat", credential_mode: "byok", failover_policy: "none" },
    output: { text: "ok", tool_intents: [{ intent_id: "sha256:" + "3".repeat(64), tool_id: "cairnstone_health", arguments: {}, policy: { intent_only: true, executed: false, execution_authority: false, mutation_authority: false } }], finish_reason: "stop" },
    usage: { input_tokens: 10, output_tokens: 5, cost: null },
    observability: { gateway_id: null, gateway_request_id: null, attempts: [] },
    policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
  });
  assert.equal(result.ok, true);
});

test("validateModelResultShape rejects a result claiming a tool intent was executed", () => {
  const result = validateModelResultShape({
    schema: MODEL_RESULT_SCHEMA,
    package_id: "sha256:" + "1".repeat(64),
    request_ir_id: "sha256:" + "2".repeat(64),
    output: { tool_intents: [{ executed: true }] },
    policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "tool_intent_marked_executed");
});
