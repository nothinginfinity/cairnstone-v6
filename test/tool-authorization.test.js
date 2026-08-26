import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalAuthorizationArgumentDigest } from "../src/model-router.js";
import {
  authorizeToolRequestFromBody,
  executeAuthorizedToolFromBody,
  TOOL_AUTHORIZATION_DECISION_SCHEMA,
  TOOL_AUTHORIZED_EXECUTION_RECEIPT_SCHEMA
} from "../src/tool-authorization.js";

const REQUEST_ID = "sha256:" + "a".repeat(64);
const REQUEST_STONE = "b".repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function makeHarness(options = {}) {
  const args = options.arguments || {
    chain: "v733-acceptance",
    author: "test:v733",
    path: "acceptance/proof.txt",
    content: "guarded mutation proof",
    set_path_head: true
  };
  const digest = await canonicalAuthorizationArgumentDigest(args);
  const guard = Object.prototype.hasOwnProperty.call(options, "guard")
    ? options.guard
    : { type: "path_head", chain: "v733-acceptance", path: "acceptance/proof.txt", expected_value: null };
  const request = {
    schema: "cairnstone-tool-authorization-request-v1",
    authorization_request_id: REQUEST_ID,
    package_id: "sha256:" + "c".repeat(64),
    request_ir_id: "sha256:" + "d".repeat(64),
    decision_id: "sha256:" + "e".repeat(64),
    intent_id: "sha256:" + "f".repeat(64),
    tool_id: "cairnstone_commit_v2",
    argument_digest: digest,
    guard,
    required_authorization: "human_confirmation",
    model: { provider: "workers-ai", model: "fixture" },
    turn_id: "turn:v733-test",
    target: {
      connector: "cairnstone",
      handler: "cairnstone_commit_v2",
      tool_id: "cairnstone_commit_v2",
      arguments: args
    }
  };
  const state = {
    authorization_request_id: REQUEST_ID,
    request_stone_hash: REQUEST_STONE,
    argument_digest: digest,
    required_authorization: "human_confirmation",
    status: "pending",
    decision: null,
    authorization_subject: null,
    authorization_method: null,
    grant_stone_hash: null,
    denial_stone_hash: null,
    issued_at: null,
    expires_at: null,
    consumption_id: null,
    consumed_at: null,
    guard,
    tool_id: "cairnstone_commit_v2",
    package_id: request.package_id,
    request_ir_id: request.request_ir_id,
    decision_id: request.decision_id,
    model: request.model,
    turn_id: request.turn_id,
    target: request.target,
    request,
    execution_receipt_stone_hash: null,
    execution_result_json: null,
    error_type: null,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z"
  };
  let stoneCounter = 0;
  let invokeCount = 0;
  const links = [];

  const deps = {
    loadAuthorization: async id => id === REQUEST_ID ? clone(state) : null,
    transitionAuthorization: async (id, from, to, fields = {}) => {
      if (id !== REQUEST_ID || state.status !== from) return { ok: true, changed: false, changes: 0 };
      Object.assign(state, fields, { status: to, updated_at: new Date().toISOString() });
      return { ok: true, changed: true, changes: 1 };
    },
    updateAuthorization: async (id, fields = {}) => {
      if (id !== REQUEST_ID) return { ok: true, changed: false, changes: 0 };
      Object.assign(state, fields, { updated_at: new Date().toISOString() });
      return { ok: true, changed: true, changes: 1 };
    },
    createStone: async () => ({ ok: true, stone_hash: `evidence-${++stoneCounter}` }),
    linkStones: async body => { links.push(body); return { ok: true }; },
    validateRegisteredMutation: async (toolId, requiredAuthorization) => (
      toolId === "cairnstone_commit_v2" && requiredAuthorization === "human_confirmation"
        ? { ok: true }
        : { ok: false, error: "authorized_tool_policy_changed" }
    ),
    observeGuard: async requestedGuard => ({
      ok: true,
      value: Object.prototype.hasOwnProperty.call(options, "observedGuardValue")
        ? options.observedGuardValue
        : requestedGuard.expected_value
    }),
    invokeTool: async (_handler, storedArgs) => {
      invokeCount += 1;
      if (options.invokeDelayMs) await new Promise(resolve => setTimeout(resolve, options.invokeDelayMs));
      assert.deepEqual(storedArgs, args);
      return { ok: true, stone_hash: "result-stone", head_hash: "result-stone" };
    },
    verifyMutation: async (_toolId, storedArgs) => {
      assert.deepEqual(storedArgs, args);
      return { ok: true, read_back: { path: args.path, verified: true } };
    }
  };

  return {
    state,
    deps,
    args,
    get invokeCount() { return invokeCount; },
    links
  };
}

async function approve(harness, extra = {}) {
  return authorizeToolRequestFromBody({
    authorization_request_id: REQUEST_ID,
    decision: "approve",
    authorization_subject: "human:test-operator",
    authorization_method: "operator_bearer",
    ttl_seconds: 900,
    ...extra
  }, {}, harness.deps);
}

test("V7.3.3 trusted approval creates a distinct immutable grant bound to the exact request", async () => {
  const h = await makeHarness();
  const result = await approve(h);
  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_AUTHORIZATION_DECISION_SCHEMA);
  assert.equal(result.decision, "approved");
  assert.equal(result.idempotent_replay, false);
  assert.equal(h.state.status, "authorized");
  assert.equal(h.state.authorization_subject, "human:test-operator");
  assert.equal(h.state.authorization_method, "operator_bearer");
  assert.ok(h.state.grant_stone_hash);
  assert.equal(h.invokeCount, 0);
  assert.equal(h.links.some(link => link.to_hash === REQUEST_STONE), true);
});

test("V7.3.3 rejects replacement arguments or tool identity at authorization/execution time", async () => {
  const h = await makeHarness();
  const badApproval = await approve(h, { arguments: { content: "replacement" } });
  assert.equal(badApproval.ok, false);
  assert.equal(badApproval.error, "authorization_argument_substitution_not_accepted");
  assert.equal(badApproval.field, "arguments");
  assert.equal(h.state.status, "pending");

  await approve(h);
  const badExecution = await executeAuthorizedToolFromBody({
    authorization_request_id: REQUEST_ID,
    tool_id: "cairnstone_set_head"
  }, {}, h.deps);
  assert.equal(badExecution.ok, false);
  assert.equal(badExecution.error, "authorization_argument_substitution_not_accepted");
  assert.equal(badExecution.field, "tool_id");
  assert.equal(h.invokeCount, 0);
});

test("V7.3.3 unchanged guard executes stored arguments exactly once and replay never mutates twice", async () => {
  const h = await makeHarness();
  await approve(h);
  const first = await executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  assert.equal(first.ok, true);
  assert.equal(first.schema, TOOL_AUTHORIZED_EXECUTION_RECEIPT_SCHEMA);
  assert.equal(first.executed, true);
  assert.equal(first.mutation_performed, true);
  assert.equal(first.guard.matched, true);
  assert.equal(first.verification.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(h.state.status, "executed");
  assert.equal(h.invokeCount, 1);

  const replay = await executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(h.invokeCount, 1);
});

test("V7.3.3 concurrent consumers cannot both claim one authorization", async () => {
  const h = await makeHarness({ invokeDelayMs: 25 });
  await approve(h);
  const [a, b] = await Promise.all([
    executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps),
    executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps)
  ]);
  assert.equal(h.invokeCount, 1);
  assert.equal([a, b].filter(result => result.executed === true).length, 1);
  assert.equal([a, b].some(result => result.error === "authorization_already_consumed_or_claimed" || result.replayed === true), true);
});

test("V7.3.3 changed guarded state fails closed with zero target mutation and immutable failure evidence", async () => {
  const h = await makeHarness({ observedGuardValue: "changed-head" });
  await approve(h);
  const result = await executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "authorization_guard_mismatch");
  assert.equal(result.executed, false);
  assert.equal(result.mutation_performed, false);
  assert.equal(result.guard.expected_value, null);
  assert.equal(result.guard.observed_value, "changed-head");
  assert.equal(result.guard.matched, false);
  assert.equal(h.invokeCount, 0);
  assert.equal(h.state.status, "guard_failed");
  assert.ok(h.state.execution_receipt_stone_hash);
});

test("V7.3.3 denial is durable and cannot be executed", async () => {
  const h = await makeHarness();
  const denied = await authorizeToolRequestFromBody({
    authorization_request_id: REQUEST_ID,
    decision: "deny",
    authorization_subject: "human:test-operator",
    authorization_method: "operator_bearer"
  }, {}, h.deps);
  assert.equal(denied.ok, true);
  assert.equal(denied.decision, "denied");
  assert.equal(h.state.status, "denied");
  assert.ok(h.state.denial_stone_hash);

  const execution = await executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  assert.equal(execution.ok, false);
  assert.equal(execution.error, "authorization_not_executable");
  assert.equal(execution.status, "denied");
  assert.equal(h.invokeCount, 0);
});

test("V7.3.3 human-confirmation execution requires a concurrency guard", async () => {
  const h = await makeHarness({ guard: null });
  await approve(h);
  const execution = await executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  assert.equal(execution.ok, false);
  assert.equal(execution.error, "authorization_guard_required");
  assert.equal(h.invokeCount, 0);
  assert.equal(h.state.status, "authorized");
});
