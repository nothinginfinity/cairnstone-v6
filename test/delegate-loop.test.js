import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTEXT_SCHEMA,
  DELEGATE_TOOL_DEFINITION,
  DELEGATION_RESULT_SCHEMA,
  DEFAULT_TOOL_BROKER_REGISTRY,
  SUBAGENT_RESULT_SCHEMA,
  delegateFromBody,
  executeToolIntentFromBody,
  recomputePackageId,
  resolveDelegateLoopControls,
  resolveLoopAllowlist,
  toolPolicyPreviewFromBody
} from "../src/model-router.js";
import {
  SUBAGENT_RESULT_MAX_ANSWER_BYTES,
  validateSubagentResult
} from "../src/subagent-result.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

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
    capabilities: { available_tools: ["cairnstone_health"], missing_required_tools: [], supports_tool_calls: true },
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

async function packageFromBootstrapArgs(args, turnCounter) {
  const pkg = baseFixturePackage();
  const tools = Array.isArray(args?.capabilities?.tools)
    ? args.capabilities.tools.map(tool => (typeof tool === "string" ? tool : tool.id)).filter(Boolean)
    : [];
  pkg.capabilities.available_tools = tools.length ? tools : [];
  pkg.capabilities.supports_tool_calls = args?.capabilities?.supports_tool_calls === true;
  pkg.request.task = typeof args?.task === "string" ? args.task : pkg.request.task;
  pkg.actor.actor_id = typeof args?.actor_id === "string" ? args.actor_id : pkg.actor.actor_id;
  // Unique package_id per turn via task salt so IR identities differ.
  pkg.runtime.compiled_at = `2026-09-07T00:00:0${(turnCounter.value % 9)}Z`;
  turnCounter.value += 1;
  pkg.package_id = await recomputePackageId(pkg);
  return pkg;
}

function routedOk(pkg, { text = "", tool_intents = [], finish_reason = null } = {}) {
  return {
    ok: true,
    schema: "cairnstone-model-result-v1",
    package_id: pkg.package_id,
    request_ir_id: "sha256:" + "7".repeat(64),
    route: {
      provider: "mock-a",
      model: "mock-a/text-tools-v1",
      transport: "mock",
      credential_mode: "none",
      failover_policy: "none"
    },
    output: {
      text,
      tool_intents,
      finish_reason: finish_reason || (tool_intents.length ? "tool_calls" : "stop")
    },
    usage: { input_tokens: 10, output_tokens: 5, cost: null },
    observability: { gateway_id: null, gateway_request_id: null, attempts: [] },
    policy: { tool_intents_only: true, execution_authority: false, mutation_authority: false },
    v7_1_1: { external_model_calls: 0, tools_executed: 0 }
  };
}

test("delegate MCP schema advertises max_turns with additionalProperties false", () => {
  assert.equal(DELEGATE_TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(DELEGATE_TOOL_DEFINITION.inputSchema.properties.max_turns.type, "number");
  assert.equal(DELEGATE_TOOL_DEFINITION.inputSchema.properties.max_turns.minimum, 1);
  assert.equal(DELEGATE_TOOL_DEFINITION.inputSchema.properties.max_turns.maximum, 8);
  assert.ok(DELEGATE_TOOL_DEFINITION.description.includes("max_turns"));
});

test("resolveDelegateLoopControls defaults compact true only in loop mode", () => {
  assert.deepEqual(
    { ...resolveDelegateLoopControls({}), ok: true, maxTurns: 1, loopEnabled: false, compactResult: false },
    resolveDelegateLoopControls({})
  );
  const loopDefault = resolveDelegateLoopControls({ max_turns: 4 });
  assert.equal(loopDefault.ok, true);
  assert.equal(loopDefault.loopEnabled, true);
  assert.equal(loopDefault.maxTurns, 4);
  assert.equal(loopDefault.compactResult, true);

  const loopExplicit = resolveDelegateLoopControls({ max_turns: 4, compact_result: false });
  assert.equal(loopExplicit.compactResult, false);

  const invalid = resolveDelegateLoopControls({ max_turns: 99 });
  assert.equal(invalid.ok, false);
});

test("resolveLoopAllowlist intersects profile tool_allowlist with automatic reads", () => {
  const all = resolveLoopAllowlist({ registry: DEFAULT_TOOL_BROKER_REGISTRY, profile: null });
  assert.ok(all.includes("cairnstone_health"));
  assert.ok(!all.includes("cairnstone_set_head"));
  assert.ok(!all.includes("cairnstone_commit_v2"));

  const narrowed = resolveLoopAllowlist({
    registry: DEFAULT_TOOL_BROKER_REGISTRY,
    profile: { tool_allowlist: ["cairnstone_health", "cairnstone_set_head"] }
  });
  assert.deepEqual(narrowed, ["cairnstone_health"]);
});

test("mid-loop automatic read executes via broker then final answer", async () => {
  const turnCounter = { value: 0 };
  let routeCalls = 0;
  let executeCalls = 0;
  let setHeadCalls = 0;
  let setPathHeadCalls = 0;
  const receiptHashes = [];

  const result = await delegateFromBody({
    actor_id: "test:loop",
    task: "Check runtime health then answer.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    max_turns: 4
  }, {}, {
    agentBootstrapFromBody: async args => packageFromBootstrapArgs(args, turnCounter),
    modelRouteFromBody: async body => {
      routeCalls += 1;
      assert.ok(Array.isArray(body.request.tools));
      assert.ok(body.request.tools.includes("cairnstone_health"));
      assert.ok(!body.request.tools.includes("cairnstone_set_head"));
      const pkg = body.context_package;
      if (routeCalls === 1) {
        return routedOk(pkg, {
          text: "",
          tool_intents: [{ tool_id: "cairnstone_health", arguments: {}, executed: false }]
        });
      }
      return routedOk(pkg, { text: "Runtime is healthy.", tool_intents: [] });
    },
    executeReadToolIntent: async (body, env) => {
      executeCalls += 1;
      const executed = await executeToolIntentFromBody(body, env, {
        invokeTool: async (handler) => {
          assert.equal(handler, "cairnstone_health");
          return { ok: true, version: "test-loop" };
        },
        createStone: async stoneBody => {
          assert.equal(stoneBody.set_as_head, false);
          assert.equal(stoneBody.chain, "cairnstone-v7-tool-execution-receipts");
          const hash = "e".repeat(64);
          receiptHashes.push(hash);
          return { ok: true, stone_hash: hash };
        }
      });
      return executed;
    },
    toolPolicyPreview: (body, env) => toolPolicyPreviewFromBody(body, env),
    setHeadFromBody: async () => {
      setHeadCalls += 1;
      return { ok: true };
    },
    setPathHeadFromBody: async () => {
      setPathHeadCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(routeCalls, 2);
  assert.equal(executeCalls, 1);
  assert.equal(setHeadCalls, 0);
  assert.equal(setPathHeadCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(result.answer, "Runtime is healthy.");
  assert.equal(result.policy.delegation_mode, "brokered_read_loop");
  assert.equal(result.policy.execution_authority, false);
  assert.equal(result.policy.mutation_authority, false);
  assert.equal(result.policy.accepted_state_mutation, false);
  assert.ok(result.policy.tools_executed >= 1);
  assert.equal(result.diagnostics.turns, 2);
  assert.equal(result.diagnostics.stop_reason, "final_answer");
  assert.ok(result.tool_receipts.some(item => item.tool_id === "cairnstone_health"));
  assert.equal(validateSubagentResult(result).ok, true);
  assert.equal(receiptHashes.length, 1);
});

test("max_turns stops the brokered read loop", async () => {
  const turnCounter = { value: 0 };
  let routeCalls = 0;

  const result = await delegateFromBody({
    actor_id: "test:loop",
    task: "Keep reading forever.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    max_turns: 2,
    compact_result: false
  }, {}, {
    agentBootstrapFromBody: async args => packageFromBootstrapArgs(args, turnCounter),
    modelRouteFromBody: async body => {
      routeCalls += 1;
      return routedOk(body.context_package, {
        text: `turn-${routeCalls}`,
        tool_intents: [{ tool_id: "cairnstone_health", arguments: {}, executed: false }]
      });
    },
    executeReadToolIntent: async (body, env) => executeToolIntentFromBody(body, env, {
      invokeTool: async () => ({ ok: true, version: "x" }),
      createStone: async () => ({ ok: true, stone_hash: "f".repeat(64) })
    }),
    toolPolicyPreview: (body, env) => toolPolicyPreviewFromBody(body, env)
  });

  assert.equal(routeCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.schema, DELEGATION_RESULT_SCHEMA);
  assert.equal(result.loop.stop_reason, "max_turns");
  assert.equal(result.loop.max_turns, 2);
  assert.equal(result.diagnostics.turns, 2);
  assert.equal(result.policy.mutation_authority, false);
  assert.equal(result.policy.accepted_state_mutation, false);
  assert.ok(result.policy.tools_executed >= 1);
});

test("deny / require_authorization stops loop without mutating HEAD", async () => {
  const turnCounter = { value: 0 };
  let executeCalls = 0;
  let setHeadCalls = 0;
  let invokeMutation = 0;

  const result = await delegateFromBody({
    actor_id: "test:loop",
    task: "Try to advance HEAD.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    max_turns: 4
  }, {}, {
    agentBootstrapFromBody: async args => packageFromBootstrapArgs(args, turnCounter),
    modelRouteFromBody: async body => routedOk(body.context_package, {
      text: "",
      tool_intents: [{
        tool_id: "cairnstone_set_head",
        arguments: { chain: "cairnstone-v6-project-memory", stone_hash: HASH_A },
        executed: false
      }]
    }),
    executeReadToolIntent: async (body, env) => {
      executeCalls += 1;
      return executeToolIntentFromBody(body, env, {
        invokeTool: async (handler) => {
          if (handler === "cairnstone_set_head") invokeMutation += 1;
          return { ok: true };
        },
        createStone: async () => ({ ok: true, stone_hash: "1".repeat(64) })
      });
    },
    toolPolicyPreview: async (body, env) => {
      // Simulate a package that could classify the mutation if it were in capabilities,
      // but the loop allowlist/preview path must still refuse execution.
      return toolPolicyPreviewFromBody(body, env);
    },
    setHeadFromBody: async () => {
      setHeadCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.schema, SUBAGENT_RESULT_SCHEMA);
  assert.ok(
    result.error === "delegate_loop_denied" || result.error === "delegate_loop_require_authorization",
    `unexpected error ${result.error}`
  );
  assert.ok(
    result.diagnostics?.stop_reason === "deny" || result.diagnostics?.stop_reason === "require_authorization"
    || result.diagnostics?.delegation?.stop_reason === "deny"
    || result.diagnostics?.delegation?.stop_reason === "require_authorization"
    || result.diagnostics?.loop?.stop_reason === "deny"
    || result.diagnostics?.loop?.stop_reason === "require_authorization"
  );
  assert.equal(setHeadCalls, 0);
  assert.equal(invokeMutation, 0);
  // Preview deny happens before execute for non-allowlisted / capability-missing mutation.
  assert.equal(executeCalls, 0);
  assert.equal(result.policy.mutation_authority, false);
  assert.equal(result.policy.accepted_state_mutation, false);
});

test("require_authorization from preview never auto-runs mutation tools", async () => {
  const turnCounter = { value: 0 };
  let executeCalls = 0;
  let setHeadCalls = 0;

  const result = await delegateFromBody({
    actor_id: "test:loop",
    task: "Propose a commit.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    max_turns: 3,
    compact_result: false
  }, {}, {
    agentBootstrapFromBody: async args => packageFromBootstrapArgs(args, turnCounter),
    modelRouteFromBody: async body => routedOk(body.context_package, {
      tool_intents: [{
        tool_id: "cairnstone_commit_v2",
        arguments: {
          chain: "cairnstone-v6-project-memory",
          path: "project-memory/x.md",
          content: "nope"
        },
        executed: false
      }]
    }),
    executeReadToolIntent: async () => {
      executeCalls += 1;
      return { ok: true, executed: true };
    },
    toolPolicyPreview: async () => ({
      ok: true,
      decision: "require_authorization",
      reason: "human_confirmation",
      authorization_required: true
    }),
    setHeadFromBody: async () => {
      setHeadCalls += 1;
      return { ok: true };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "delegate_loop_require_authorization");
  assert.equal(result.detail.decision, "require_authorization");
  assert.equal(result.loop.stop_reason, "require_authorization");
  assert.equal(executeCalls, 0);
  assert.equal(setHeadCalls, 0);
  assert.equal(result.policy.accepted_state_mutation, false);
});

test("compact result size fail-closed still holds when loop ends", async () => {
  const turnCounter = { value: 0 };
  const oversized = "z".repeat(SUBAGENT_RESULT_MAX_ANSWER_BYTES + 40);

  const result = await delegateFromBody({
    actor_id: "test:loop",
    task: "Write a huge answer.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    max_turns: 2
  }, {}, {
    agentBootstrapFromBody: async args => packageFromBootstrapArgs(args, turnCounter),
    modelRouteFromBody: async body => routedOk(body.context_package, {
      text: oversized,
      tool_intents: []
    }),
    executeReadToolIntent: async () => {
      throw new Error("should_not_execute");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(result.error, "subagent_answer_exceeds_cap");
  assert.equal(result.policy.accepted_state_mutation, false);
  assert.equal(result.diagnostics.fail_closed, true);
  assert.ok(result.diagnostics.turns >= 1);
});

test("single-shot max_turns=1 preserves zero-tool legacy path", async () => {
  const turnCounter = { value: 0 };
  let exposedTools = null;

  const result = await delegateFromBody({
    actor_id: "test:loop",
    task: "One shot.",
    chain: "cairnstone-v6-project-memory",
    route: { provider: "mock-a", model: "mock-a/text-tools-v1" },
    max_turns: 1,
    compact_result: true
  }, {}, {
    agentBootstrapFromBody: async args => {
      assert.equal(args.capabilities.supports_tool_calls, false);
      assert.deepEqual(args.capabilities.tools, []);
      return packageFromBootstrapArgs(args, turnCounter);
    },
    modelRouteFromBody: async body => {
      exposedTools = body.request.tools;
      return routedOk(body.context_package, { text: "done", tool_intents: [] });
    }
  });

  assert.deepEqual(exposedTools, []);
  assert.equal(result.ok, true);
  assert.equal(result.schema, SUBAGENT_RESULT_SCHEMA);
  assert.equal(result.answer, "done");
  assert.equal(result.policy.delegation_mode, "read_only");
});
