import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  DELEGATE_TOOL_DEFINITION,
  DELEGATION_RESULT_SCHEMA,
  delegateFromBody,
  modelRouteFromBody,
  recomputePackageId,
  SUBAGENT_RESULT_SCHEMA
} from "../src/model-router.js";
import {
  SUBAGENT_RESULT_MAX_ANSWER_BYTES,
  buildCitationsFromDelegationEvidence,
  buildSubagentResultFromDelegation,
  buildTaskFingerprint,
  estimateAnswerTokens,
  validateSubagentResult
} from "../src/subagent-result.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const PACKAGE_ID = "sha256:" + "d".repeat(64);

function baseFixturePackage() {
  return {
    ok: true,
    schema: AGENT_CONTEXT_SCHEMA,
    package_id: null,
    actor: { actor_id: "test:fixture" },
    request: { task: "fixture task", chain: "cairnstone-v6-project-memory" },
    runtime: { cairnstone_version: "test", protocol: "FSL-CCR Stone v6", compiled_at: "2026-08-24T00:00:00.000Z" },
    authority: {
      chain: "cairnstone-v6-project-memory",
      chain_head: { stone_hash: HASH_A, path: "project-memory/x.md", repo: null, commit_sha: null },
      path_heads: [
        {
          path: "docs/AI_OPERATING_GUIDE.md",
          stone_hash: HASH_B,
          repo: "nothinginfinity/cairnstone-v6",
          commit_sha: "55ec7b749fc8c21431d67c268646b43f60337612"
        }
      ],
      timestamp_ordering_used: false
    },
    instructions: {
      path: "docs/AI_OPERATING_GUIDE.md",
      stone_hash: HASH_B,
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
    memory: {
      query: "fixture",
      items: [
        {
          authority_class: "PATH_HEAD",
          stone_hash: HASH_C,
          path: "project-memory/decisions.md",
          ref_id: "ref-decisions",
          line_start: 4,
          line_end: 12,
          freshness: "fresh"
        }
      ],
      truncated: false
    },
    capabilities: { available_tools: ["cairnstone_health"], missing_required_tools: [], supports_tool_calls: false },
    policy: {
      context_compiler_called_llm: false,
      execution_authority: false,
      mutation_authority: false,
      provider_credentials_in_package: false,
      accepted_state_only_for_authority: true,
      mutable_branch_is_authority: false
    },
    limits: {
      effective_max_package_bytes: 64000,
      package_bytes: 1000,
      skills_bytes: 0,
      memory_bytes: 0,
      instructions_bytes: 22,
      truncated: false
    }
  };
}

async function withValidPackageId(pkg) {
  const clone = structuredClone(pkg);
  clone.package_id = await recomputePackageId(clone);
  return clone;
}

test("compact_result MCP input schema rejects unknown properties and documents the flag", () => {
  assert.equal(DELEGATE_TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(DELEGATE_TOOL_DEFINITION.inputSchema.properties.compact_result.type, "boolean");
  assert.ok(DELEGATE_TOOL_DEFINITION.description.includes("cairnstone-subagent-result-v1"));
});

test("task_fingerprint is deterministic for identical inputs", async () => {
  const a = await buildTaskFingerprint({
    actor_id: "test:delegate",
    chain: "cairnstone-v6-project-memory",
    task: "Summarize decisions",
    profile_id: null
  });
  const b = await buildTaskFingerprint({
    actor_id: "test:delegate",
    chain: "cairnstone-v6-project-memory",
    task: "Summarize decisions",
    profile_id: null
  });
  const c = await buildTaskFingerprint({
    actor_id: "test:delegate",
    chain: "cairnstone-v6-project-memory",
    task: "Different task",
    profile_id: null
  });
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("citations are present when evidence exists", () => {
  const citations = buildCitationsFromDelegationEvidence({
    chain_head: HASH_A,
    path_heads: [{ path: "docs/AI_OPERATING_GUIDE.md", stone_hash: HASH_B }],
    memory_refs: [
      {
        authority_class: "PATH_HEAD",
        stone_hash: HASH_C,
        path: "project-memory/decisions.md",
        ref_id: "ref-1"
      }
    ],
    selected_skills: []
  }, `See [stone:${HASH_C.slice(0, 12)}]`);
  assert.ok(citations.length >= 1);
  assert.equal(citations[0].stone_hash, HASH_C);
  assert.equal(citations[0].authority, "PATH_HEAD");
  assert.equal(citations[0].path, "project-memory/decisions.md");
  assert.ok(citations.some(item => item.stone_hash === HASH_B));
});

test("buildSubagentResultFromDelegation produces a valid schema shape", async () => {
  const built = await buildSubagentResultFromDelegation({
    actor_id: "test:delegate",
    chain: "cairnstone-v6-project-memory",
    task: "Summarize",
    profile_id: null,
    delegation: {
      ok: true,
      schema: DELEGATION_RESULT_SCHEMA,
      actor_id: "test:delegate",
      chain: "cairnstone-v6-project-memory",
      package_id: PACKAGE_ID,
      request_ir_id: PACKAGE_ID,
      output: { text: "Short answer grounded in accepted state.", finish_reason: "stop" },
      route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
      usage: { input_tokens: 10, output_tokens: 5, cost: null },
      evidence: {
        chain_head: HASH_A,
        path_heads: [{ path: "docs/AI_OPERATING_GUIDE.md", stone_hash: HASH_B }],
        memory_refs: [
          {
            authority_class: "HISTORICAL",
            stone_hash: HASH_C,
            path: "project-memory/notes.md",
            ref_id: "r1",
            line_start: 1,
            line_end: 3
          }
        ],
        selected_skills: []
      },
      policy: {
        delegation_mode: "read_only",
        tools_exposed_to_model: 0,
        tools_executed: 0,
        execution_authority: false,
        mutation_authority: false,
        accepted_state_mutation: false
      },
      diagnostics: {
        context_package_returned: false,
        server_carried_context_package: true,
        package_bytes: 1000,
        tools_executed: 0
      }
    }
  });

  assert.equal(built.ok, true);
  assert.equal(built.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(built.answer, "Short answer grounded in accepted state.");
  assert.ok(built.citations.length >= 1);
  assert.ok(built.expand_hints.length >= 1);
  assert.deepEqual(built.tool_receipts, []);
  assert.equal(built.diagnostics.answer_truncated, false);
  assert.equal(built.diagnostics.turns, 1);
  assert.equal(built.policy.execution_authority, false);
  assert.equal(built.policy.mutation_authority, false);
  assert.equal(built.policy.accepted_state_mutation, false);
  assert.deepEqual(built.policy.parent_should_keep, ["answer", "citations"]);

  const validated = validateSubagentResult(built);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));
});

test("oversized answer fails closed (never ok:true truncated)", async () => {
  const oversized = "x".repeat(SUBAGENT_RESULT_MAX_ANSWER_BYTES + 1);
  const built = await buildSubagentResultFromDelegation({
    actor_id: "test:delegate",
    chain: "cairnstone-v6-project-memory",
    task: "Too long",
    delegation: {
      ok: true,
      actor_id: "test:delegate",
      chain: "cairnstone-v6-project-memory",
      package_id: PACKAGE_ID,
      output: { text: oversized, finish_reason: "length" },
      evidence: {
        memory_refs: [{ authority_class: "PATH_HEAD", stone_hash: HASH_C, path: "p.md" }],
        path_heads: [],
        selected_skills: []
      },
      policy: { tools_executed: 0, execution_authority: false, mutation_authority: false, accepted_state_mutation: false },
      usage: { input_tokens: 1, output_tokens: 9999 }
    }
  });

  assert.equal(built.ok, false);
  assert.equal(built.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(built.error, "subagent_answer_exceeds_cap");
  assert.equal(built.answer, "");
  assert.equal(built.diagnostics.answer_truncated, true);
  assert.equal(built.diagnostics.fail_closed, true);
  assert.equal(built.detail.answer_bytes, SUBAGENT_RESULT_MAX_ANSWER_BYTES + 1);
  assert.ok(built.citations.length >= 1);
  assert.equal(built.policy.mutation_authority, false);
  assert.equal(built.detail.max_answer_bytes, SUBAGENT_RESULT_MAX_ANSWER_BYTES);
  assert.ok(estimateAnswerTokens(oversized) >= Math.ceil((SUBAGENT_RESULT_MAX_ANSWER_BYTES + 1) / 4));
});

test("delegate compact_result wraps success and preserves zero mutation side effects", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  let bootstrapCalls = 0;
  let routeCalls = 0;
  let setHeadCalls = 0;

  const result = await delegateFromBody({
    actor_id: "test:delegate",
    task: "Summarize the accepted state.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    generation: { max_output_tokens: 256, temperature: 0 },
    compact_result: true
  }, {}, {
    agentBootstrapFromBody: async () => {
      bootstrapCalls += 1;
      return pkg;
    },
    modelRouteFromBody: async body => {
      routeCalls += 1;
      assert.deepEqual(body.request.tools, []);
      assert.ok(body.request.generation.max_output_tokens <= 1200);
      return {
        ok: true,
        package_id: pkg.package_id,
        request_ir_id: "sha256:" + "7".repeat(64),
        route: {
          provider: "mock-a",
          model: "mock-a/text-tools-v1",
          transport: "mock",
          credential_mode: "none",
          failover_policy: "none"
        },
        output: { text: "Compact answer.", tool_intents: [], finish_reason: "stop" },
        usage: { input_tokens: 1, output_tokens: 1, cost: null },
        observability: { gateway_id: null, gateway_request_id: null, attempts: [] },
        policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
        v7_1_1: { external_model_calls: 0, tools_executed: 0 }
      };
    },
    // Intentionally not providing set_head / set_path_head — compact path must not need them.
    setHeadFromBody: async () => {
      setHeadCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(bootstrapCalls, 1);
  assert.equal(routeCalls, 1);
  assert.equal(setHeadCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(result.answer, "Compact answer.");
  assert.ok(result.citations.length >= 1, "expected citations from bootstrap evidence");
  assert.ok(result.citations.some(item => item.stone_hash === HASH_C));
  assert.ok(result.expand_hints.some(item => item.stone_hash === HASH_C && item.ref_id === "ref-decisions"));
  assert.equal(result.policy.execution_authority, false);
  assert.equal(result.policy.mutation_authority, false);
  assert.equal(result.policy.accepted_state_mutation, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "context_package"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "evidence"), false);
  assert.match(result.task_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(validateSubagentResult(result).ok, true);
});

test("delegate without compact_result preserves legacy delegation schema", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await delegateFromBody({
    actor_id: "test:delegate",
    task: "Summarize the accepted state.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" }
  }, {}, {
    agentBootstrapFromBody: async () => pkg,
    modelRouteFromBody
  });
  assert.equal(result.ok, true);
  assert.equal(result.schema, DELEGATION_RESULT_SCHEMA);
  assert.ok(result.output && typeof result.output.text === "string");
  assert.ok(result.evidence);
});

test("delegate compact_result fails closed on oversized routed text", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  const result = await delegateFromBody({
    actor_id: "test:delegate",
    task: "Summarize",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    compact_result: true
  }, {}, {
    agentBootstrapFromBody: async () => pkg,
    modelRouteFromBody: async () => ({
      ok: true,
      package_id: pkg.package_id,
      request_ir_id: "sha256:" + "8".repeat(64),
      route: { provider: "mock-a", model: "mock-a/text-tools-v1", transport: "mock" },
      output: {
        text: "y".repeat(SUBAGENT_RESULT_MAX_ANSWER_BYTES + 50),
        tool_intents: [],
        finish_reason: "length"
      },
      usage: { input_tokens: 1, output_tokens: 2000, cost: null },
      observability: { attempts: [] },
      policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(result.error, "subagent_answer_exceeds_cap");
  assert.equal(result.policy.accepted_state_mutation, false);
});

test("compact_result clamps generation budget to the subagent token ceiling", async () => {
  const pkg = await withValidPackageId(baseFixturePackage());
  let routedBody = null;
  await delegateFromBody({
    actor_id: "test:delegate",
    task: "Read only.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    generation: { max_output_tokens: 999999, temperature: 0 },
    compact_result: true
  }, {}, {
    agentBootstrapFromBody: async () => pkg,
    modelRouteFromBody: async body => {
      routedBody = body;
      return {
        ok: true,
        package_id: pkg.package_id,
        request_ir_id: "sha256:" + "9".repeat(64),
        route: { provider: "mock-a", model: "mock-a/text-tools-v1", transport: "mock" },
        output: { text: "ok", tool_intents: [], finish_reason: "stop" },
        usage: { input_tokens: 1, output_tokens: 1, cost: null },
        observability: { attempts: [] },
        policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false }
      };
    }
  });
  assert.equal(routedBody.request.generation.max_output_tokens, 1200);
});
