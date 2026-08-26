import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  canonicalAuthorizationArgumentDigest,
  prepareToolAuthorizationFromBody,
  recomputePackageId,
  requestToolAuthorizationFromBody
} from "../src/model-router.js";
import {
  authorizeToolRequestFromBody,
  executeAuthorizedToolFromBody,
  getToolAuthorizationStatusFromBody,
  listToolAuthorizationsCompactFromBody,
  TOOL_AUTHORIZATION_DECISION_SCHEMA,
  TOOL_AUTHORIZATION_LIST_SCHEMA,
  TOOL_AUTHORIZATION_STATUS_SCHEMA,
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

test("V7.3.3 read-only status proves executed authorization consumption without exposing mutation arguments", async () => {
  const h = await makeHarness();
  await approve(h);
  await executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  const status = await getToolAuthorizationStatusFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  assert.equal(status.ok, true);
  assert.equal(status.schema, TOOL_AUTHORIZATION_STATUS_SCHEMA);
  assert.equal(status.status, "executed");
  assert.equal(status.consumed, true);
  assert.ok(status.consumption_id);
  assert.ok(status.consumed_at);
  assert.equal(status.terminal, true);
  assert.equal(status.outcome.executed, true);
  assert.equal(status.outcome.mutation_performed, true);
  assert.equal(status.outcome.error, null);
  assert.equal(status.replay.safe_no_second_mutation, true);
  assert.equal(status.replay.behavior, "idempotent_replay_returns_existing_result");
  assert.equal(status.policy.read_only, true);
  assert.equal(status.policy.operator_authorization_required, false);
  assert.equal(status.policy.execution_authority, false);
  assert.equal(status.policy.mutation_authority, false);
  assert.equal(status.policy.arguments_exposed, false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "request"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "target"), false);
  assert.equal(h.invokeCount, 1);
});

test("V7.3.3 read-only status reports stale-guard consumption and zero mutation", async () => {
  const h = await makeHarness({ observedGuardValue: "changed-head" });
  await approve(h);
  await executeAuthorizedToolFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  const status = await getToolAuthorizationStatusFromBody({ authorization_request_id: REQUEST_ID }, {}, h.deps);
  assert.equal(status.ok, true);
  assert.equal(status.status, "guard_failed");
  assert.equal(status.consumed, true);
  assert.ok(status.consumption_id);
  assert.equal(status.terminal, true);
  assert.equal(status.outcome.executed, false);
  assert.equal(status.outcome.mutation_performed, false);
  assert.equal(status.outcome.error, "authorization_guard_mismatch");
  assert.equal(status.outcome.guard.expected_value, null);
  assert.equal(status.outcome.guard.observed_value, "changed-head");
  assert.equal(status.outcome.guard.matched, false);
  assert.equal(status.replay.safe_no_second_mutation, true);
  assert.equal(status.replay.behavior, "non_executable_or_already_claimed");
  assert.equal(h.invokeCount, 0);
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

test("V7.3.3 approval revalidates stored request digest and current broker policy before granting", async () => {
  const tampered = await makeHarness();
  tampered.state.request.target.arguments.content = "tampered after proposal";
  const digestFailure = await approve(tampered);
  assert.equal(digestFailure.ok, false);
  assert.equal(digestFailure.error, "authorization_argument_digest_mismatch");
  assert.equal(tampered.state.status, "pending");
  assert.equal(tampered.state.grant_stone_hash, null);

  const policyChanged = await makeHarness();
  policyChanged.deps.validateRegisteredMutation = async () => ({ ok: false, error: "authorized_tool_policy_changed" });
  const policyFailure = await approve(policyChanged);
  assert.equal(policyFailure.ok, false);
  assert.equal(policyFailure.error, "authorized_tool_policy_changed");
  assert.equal(policyChanged.state.status, "pending");
  assert.equal(policyChanged.state.grant_stone_hash, null);
});

test("V7.3.3 identical pending request retry reuses the first immutable request Stone", async () => {
  const pkg = {
    schema: "cairnstone-agent-context-v1",
    ok: true,
    package_id: "sha256:" + "0".repeat(64),
    actor: { actor_id: "test:v733-request-replay" },
    request: { task: "propose one guarded mutation", chain: "v733-request-replay" },
    authority: {
      chain_head: { stone_hash: "a".repeat(64), path: "project-memory/start.md", repo: null, commit_sha: null },
      path_heads: []
    },
    instructions: {
      path: "docs/AI_OPERATING_GUIDE.md",
      stone_hash: "b".repeat(64),
      commit_sha: "c".repeat(40),
      content_identity: { sha256: "d".repeat(64), git_blob_sha: "e".repeat(40), bytes: 1 },
      truncated: false
    },
    coordination: { items: [] },
    skills: { manifest_head: "f".repeat(64), accepted_bundle: { skills: [] } },
    memory: { retrieval_policy: { authority_first: true }, items: [] },
    capabilities: { available_tools: ["cairnstone_commit_v2"], missing_required_tools: [] },
    limits: { effective_max_package_bytes: 64000 },
    policy: {
      accepted_state_only_for_authority: true,
      mutable_branch_is_authority: false,
      execution_authority: false,
      mutation_authority: false,
      provider_credentials_in_package: false
    }
  };
  pkg.package_id = await recomputePackageId(pkg);
  const args = {
    chain: "v733-request-replay",
    author: "test:v733",
    path: "acceptance/replay.txt",
    content: "same immutable proposal"
  };
  const body = {
    context_package: pkg,
    tool_intent: {
      intent_id: "intent:v733-request-replay",
      tool_id: "cairnstone_commit_v2",
      arguments: args
    },
    request_ir_id: "sha256:" + "1".repeat(64),
    model: { provider: "workers-ai", model: "fixture" },
    turn_id: "turn:v733-request-replay",
    guard: { type: "path_head", chain: args.chain, path: args.path, expected_value: null }
  };

  let existing = null;
  let createCount = 0;
  const deps = {
    getExistingAuthorization: async () => existing
      ? { ok: true, authorization: clone(existing) }
      : { ok: false, error: "authorization_not_found" },
    createStone: async () => ({ ok: true, stone_hash: `request-stone-${++createCount}` }),
    persistPendingAuthorization: async record => {
      const request = JSON.parse(record.request_json);
      existing = {
        authorization_request_id: record.authorization_request_id,
        request_stone_hash: record.request_stone_hash,
        argument_digest: record.argument_digest,
        required_authorization: record.required_authorization,
        status: "pending",
        tool_id: request.tool_id,
        package_id: request.package_id,
        request_ir_id: request.request_ir_id,
        decision_id: request.decision_id,
        request
      };
      return { ok: true, authorization: existing };
    }
  };

  const first = await requestToolAuthorizationFromBody(body, {}, deps);
  const replay = await requestToolAuthorizationFromBody(body, {}, deps);
  assert.equal(first.ok, true);
  assert.equal(first.request_created, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.request_created, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.authorization_request_id, first.authorization_request_id);
  assert.equal(replay.receipt.stone_hash, first.receipt.stone_hash);
  assert.equal(createCount, 1);
});

test("V7.3.3 compact prepare compiles context server-side and creates only a pending request", async () => {
  const args = {
    chain: "v733-prepare",
    author: "test:v733-prepare",
    path: "acceptance/prepare.txt",
    content: "prepared without client context round-trip",
    set_path_head: true
  };
  const guard = { type: "path_head", chain: args.chain, path: args.path, expected_value: null };
  let bootstrapInput = null;
  let createCount = 0;
  let persisted = null;

  const deps = {
    agentBootstrapFromBody: async input => {
      bootstrapInput = clone(input);
      const pkg = {
        schema: "cairnstone-agent-context-v1",
        ok: true,
        package_id: "sha256:" + "0".repeat(64),
        actor: { actor_id: input.actor_id },
        request: { task: input.task, chain: input.chain },
        authority: {
          chain_head: { stone_hash: "a".repeat(64), path: "project-memory/start.md", repo: null, commit_sha: null },
          path_heads: []
        },
        instructions: {
          path: "docs/AI_OPERATING_GUIDE.md",
          stone_hash: "b".repeat(64),
          commit_sha: "c".repeat(40),
          content_identity: { sha256: "d".repeat(64), git_blob_sha: "e".repeat(40), bytes: 1 },
          truncated: false
        },
        coordination: { items: [] },
        skills: { manifest_head: "f".repeat(64), accepted_bundle: { skills: [] } },
        memory: { retrieval_policy: { authority_first: true }, items: [] },
        capabilities: { available_tools: ["cairnstone_commit_v2"], missing_required_tools: [] },
        limits: { effective_max_package_bytes: 50000 },
        policy: {
          accepted_state_only_for_authority: true,
          mutable_branch_is_authority: false,
          execution_authority: false,
          mutation_authority: false,
          provider_credentials_in_package: false
        }
      };
      pkg.package_id = await recomputePackageId(pkg);
      return pkg;
    },
    getExistingAuthorization: async () => ({ ok: false, error: "authorization_not_found" }),
    createStone: async () => ({ ok: true, stone_hash: `prepare-request-stone-${++createCount}` }),
    persistPendingAuthorization: async record => {
      persisted = clone(record);
      return { ok: true };
    }
  };

  const result = await prepareToolAuthorizationFromBody({
    actor_id: "test:v733-prepare",
    task: "propose one guarded commit",
    chain: "cairnstone-v6-project-memory",
    tool_intent: { intent_id: "intent:v733-prepare", tool_id: "cairnstone_commit_v2", arguments: args, executed: false },
    turn_id: "turn:v733-prepare",
    justification: "Human must approve in Console.",
    guard
  }, {}, deps);

  assert.equal(result.ok, true);
  assert.equal(result.request_created, true);
  assert.equal(result.required_authorization, "human_confirmation");
  assert.equal(result.execution.executed, false);
  assert.equal(result.execution.target_tool_invoked, false);
  assert.equal(result.execution.target_mutation_performed, false);
  assert.deepEqual(bootstrapInput.capabilities, {
    tools: [{ id: "cairnstone_commit_v2", available: true, class: "mutation" }],
    supports_tool_calls: true
  });
  assert.equal(bootstrapInput.include_inbox, false);
  assert.equal(bootstrapInput.limits.max_memory_hits, 0);
  assert.equal(createCount, 1);
  assert.ok(persisted);
  assert.equal(persisted.guard.expected_value, null);
});

test("V7.3.3 schema-repair migration matches the lifecycle columns used by the runtime", async () => {
  const repair = await readFile(new URL("../migrations/0010_v7_3_3_tool_authorizations_schema_repair.sql", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../src/tool-authorization.js", import.meta.url), "utf8");

  assert.match(repair, /ALTER TABLE tool_authorizations RENAME TO tool_authorizations_v733_legacy/);
  assert.match(repair, /DROP INDEX IF EXISTS idx_tool_authorizations_tool/);
  assert.match(repair, /CREATE TABLE tool_authorizations/);

  const requiredColumns = [
    "authorization_request_id",
    "request_stone_hash",
    "request_json",
    "argument_digest",
    "required_authorization",
    "status",
    "decision",
    "authorization_subject",
    "authorization_method",
    "grant_stone_hash",
    "denial_stone_hash",
    "issued_at",
    "expires_at",
    "consumption_id",
    "consumed_at",
    "guard_type",
    "guard_expected",
    "guard_observed",
    "guard_matched",
    "execution_receipt_stone_hash",
    "execution_result_json",
    "error_type",
    "created_at",
    "updated_at"
  ];
  for (const column of requiredColumns) {
    assert.match(repair, new RegExp(`\\b${column}\\b`), `repair migration must define ${column}`);
    assert.equal(runtime.includes(column), true, `runtime must reference ${column}`);
  }
});

test("V7.4.0 authorization list discovery returns compact non-secret metadata only, most recent first", async () => {
  const execExecuted = JSON.stringify({
    executed: true,
    mutation_performed: true,
    error: null,
    guard: { type: "path_head", expected_value: null, observed_value: null, matched: true }
  });
  const execGuardFailed = JSON.stringify({
    executed: false,
    mutation_performed: false,
    error: "authorization_guard_mismatch",
    guard: { type: "path_head", expected_value: null, observed_value: "changed-head", matched: false }
  });
  const rows = [
    {
      authorization_request_id: "sha256:" + "1".repeat(64),
      tool_id: "cairnstone_commit_v2",
      status: "executed",
      decision: "approved",
      created_at: "2026-08-26T18:00:00.000Z",
      issued_at: "2026-08-26T18:00:01.000Z",
      consumption_id: "sha256:" + "2".repeat(64),
      consumed_at: "2026-08-26T18:00:02.000Z",
      request_stone_hash: "stone-request-1",
      grant_stone_hash: "stone-grant-1",
      denial_stone_hash: null,
      execution_receipt_stone_hash: "stone-receipt-1",
      execution_result_json: execExecuted,
      error_type: null,
      target: { tool_id: "cairnstone_commit_v2", arguments: { secret_field: "must-not-leak" } },
      justification: "should not leak either",
      model: { provider: "anthropic", model: "should-not-leak" }
    },
    {
      authorization_request_id: "sha256:" + "3".repeat(64),
      tool_id: "cairnstone_commit_v2",
      status: "guard_failed",
      decision: "approved",
      created_at: "2026-08-26T17:00:00.000Z",
      issued_at: "2026-08-26T17:00:01.000Z",
      consumption_id: "sha256:" + "4".repeat(64),
      consumed_at: "2026-08-26T17:00:02.000Z",
      request_stone_hash: "stone-request-2",
      grant_stone_hash: "stone-grant-2",
      denial_stone_hash: null,
      execution_receipt_stone_hash: "stone-receipt-2",
      execution_result_json: execGuardFailed,
      error_type: "authorization_guard_mismatch",
      target: { tool_id: "cairnstone_commit_v2", arguments: { secret_field: "must-not-leak" } },
      justification: "should not leak either",
      model: { provider: "anthropic", model: "should-not-leak" }
    }
  ];
  const deps = { listAuthorizations: async () => ({ ok: true, total: rows.length, authorizations: rows }) };

  const result = await listToolAuthorizationsCompactFromBody({}, {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_AUTHORIZATION_LIST_SCHEMA);
  assert.equal(result.total, 2);
  assert.equal(result.authorizations.length, 2);
  assert.equal(result.authorizations[0].authorization_request_id, rows[0].authorization_request_id);
  assert.equal(result.authorizations[0].status, "executed");
  assert.equal(result.authorizations[0].outcome.mutation_performed, true);
  assert.equal(result.authorizations[1].status, "guard_failed");
  assert.equal(result.authorizations[1].outcome.mutation_performed, false);
  assert.equal(result.authorizations[1].outcome.error, "authorization_guard_mismatch");
  assert.equal(result.policy.read_only, true);
  assert.equal(result.policy.arguments_exposed, false);
  assert.equal(result.policy.operator_authorization_required, false);

  for (const entry of result.authorizations) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "target"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "arguments"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "justification"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "model"), false);
    assert.equal(JSON.stringify(entry).includes("must-not-leak"), false);
  }
});

test("V7.4.0 authorization list rejects invalid status/decision filters and clamps limit", async () => {
  const deps = { listAuthorizations: async () => ({ ok: true, total: 0, authorizations: [] }) };
  const badStatus = await listToolAuthorizationsCompactFromBody({ status: "not-a-real-status" }, {}, deps);
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.error, "invalid_status_filter");

  const badDecision = await listToolAuthorizationsCompactFromBody({ decision: "maybe" }, {}, deps);
  assert.equal(badDecision.ok, false);
  assert.equal(badDecision.error, "invalid_decision_filter");

  const clamped = await listToolAuthorizationsCompactFromBody({ limit: 9999 }, {}, deps);
  assert.equal(clamped.ok, true);
  assert.equal(clamped.filters.limit, 50);
});

test("V7.4.0 approved authorization discovery filters server-side and orders by human decision time", async () => {
  const rows = [
    {
      authorization_request_id: "sha256:" + "5".repeat(64),
      tool_id: "cairnstone_commit_v2",
      status: "executed",
      decision: "approved",
      created_at: "2026-08-26T19:00:00.000Z",
      issued_at: "2026-08-26T19:01:00.000Z"
    },
    {
      authorization_request_id: "sha256:" + "6".repeat(64),
      tool_id: "cairnstone_commit_v2",
      status: "executed",
      decision: "approved",
      created_at: "2026-08-26T17:00:00.000Z",
      issued_at: "2026-08-26T20:00:00.000Z"
    },
    {
      authorization_request_id: "sha256:" + "7".repeat(64),
      tool_id: "cairnstone_commit_v2",
      status: "denied",
      decision: "denied",
      created_at: "2026-08-26T20:30:00.000Z",
      issued_at: "2026-08-26T20:31:00.000Z"
    }
  ];
  let received = null;
  const deps = {
    listAuthorizations: async body => {
      received = body;
      return { ok: true, total: rows.length, authorizations: rows };
    }
  };
  const result = await listToolAuthorizationsCompactFromBody({ decision: "approved", limit: 5 }, {}, deps);
  assert.equal(result.ok, true);
  assert.equal(received.decision, "approved");
  assert.equal(result.total, 2);
  assert.equal(result.authorizations[0].authorization_request_id, rows[1].authorization_request_id);
  assert.equal(result.authorizations[1].authorization_request_id, rows[0].authorization_request_id);
  assert.equal(result.authorizations.some(entry => entry.decision === "denied"), false);
});
