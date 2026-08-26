import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeToolRequestFromBody,
  canonicalArgumentsDigest,
  executeAuthorizedToolFromBody,
  TOOL_AUTHORIZATION_GRANT_SCHEMA,
  TOOL_AUTHORIZED_EXECUTION_SCHEMA,
  V733_ACCEPTANCE_HANDLER,
  V733_ACCEPTANCE_TOOL_ID
} from "../src/tool-authorization.js";

function requestFixture(id, args = { resource_id: "proof", expected_version: 0, next_value: "accepted" }) {
  return {
    schema: "cairnstone-tool-authorization-request-v1",
    authorization_request_id: id,
    package_id: "sha256:" + "a".repeat(64),
    request_ir_id: "sha256:" + "b".repeat(64),
    intent_id: "sha256:" + "c".repeat(64),
    decision_id: "sha256:" + "d".repeat(64),
    tool_id: V733_ACCEPTANCE_TOOL_ID,
    arguments: args,
    risk_class: "mutation",
    required_authorization: "human_confirmation",
    model: { provider: "workers-ai", model: "fixture" },
    turn_id: "turn:v733",
    justification: "isolated acceptance proof",
    status: "pending",
    authorization: { required: true, mode: "human_confirmation", status: "pending", consumed: false },
    target: { connector: "cairnstone", handler: V733_ACCEPTANCE_HANDLER, tool_id: V733_ACCEPTANCE_TOOL_ID, arguments: args },
    execution: { executed: false, target_mutation_performed: false }
  };
}

function registry() {
  return [{
    tool_id: V733_ACCEPTANCE_TOOL_ID,
    connector: "cairnstone",
    handler: V733_ACCEPTANCE_HANDLER,
    risk_class: "mutation",
    authorization: "human_confirmation",
    available: true,
    input_schema: {
      type: "object", required: ["resource_id", "expected_version", "next_value"],
      properties: { resource_id: { type: "string" }, expected_version: { type: "integer" }, next_value: { type: "string" } },
      additionalProperties: false
    }
  }];
}

function memoryStore(row) {
  let current = { ...row };
  return {
    async get() { return { ...current }; },
    async list() { return [{ ...current }]; },
    async recordPending() { return { inserted: false, row: { ...current } }; },
    async beginDecision(_id, decision, subject, method, issuedAt, expiresAt) {
      if (current.status !== "pending") return { claimed: false, row: { ...current } };
      current = { ...current, status: "authorizing", authorization_decision: decision, authorization_subject: subject, authorization_method: method, issued_at: issuedAt, expires_at: expiresAt };
      return { claimed: true, row: { ...current } };
    },
    async finishDecision(_id, decision, stoneHash) {
      if (current.status !== "authorizing") return { changed: false, row: { ...current } };
      current = { ...current, status: decision === "approved" ? "authorized" : "denied", authorization_stone_hash: stoneHash };
      return { changed: true, row: { ...current } };
    },
    async rollbackDecision() { current = { ...current, status: "pending" }; return { ...current }; },
    async markExpired() { current = { ...current, status: "expired" }; return { ...current }; },
    async claim(_id, claimId, at) {
      if (current.status !== "authorized") return { claimed: false, row: { ...current } };
      current = { ...current, status: "consuming", claim_id: claimId, claimed_at: at };
      return { claimed: true, row: { ...current } };
    },
    async finishExecution(_id, _claimId, status, fields) {
      current = { ...current, status, execution_id: fields.execution_id, execution_receipt_stone_hash: fields.execution_receipt_stone_hash, result_json: fields.result_json, failure_code: fields.failure_code };
      return { changed: true, row: { ...current } };
    },
    snapshot() { return { ...current }; }
  };
}

async function prepared(decisionStatus = "pending", args) {
  const id = "sha256:" + "1".repeat(64);
  const request = requestFixture(id, args);
  const digest = await canonicalArgumentsDigest(request.target.arguments);
  const row = {
    authorization_request_id: id,
    request_stone_hash: "request-stone",
    package_id: request.package_id,
    request_ir_id: request.request_ir_id,
    decision_id: request.decision_id,
    tool_id: request.tool_id,
    arguments_digest: digest,
    required_authorization: request.required_authorization,
    status: decisionStatus,
    authorization_stone_hash: decisionStatus === "authorized" ? "grant-stone" : null,
    expires_at: decisionStatus === "authorized" ? "2099-01-01T00:00:00.000Z" : null,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z"
  };
  return { id, request, row, store: memoryStore(row) };
}

const trusted = { trusted: true, method: "cairnstone-console-origin", channel: "console", evidence: { origin: "https://nothinginfinity.github.io" } };

function stoneDeps(store, request) {
  let n = 0;
  return {
    store,
    registry: registry(),
    trustedCaller: trusted,
    loadRequest: async () => ({ ok: true, request }),
    createStone: async () => ({ ok: true, stone_hash: `stone-${++n}` }),
    linkStones: async () => ({ ok: true }),
    now: () => "2026-08-26T12:00:00.000Z"
  };
}

test("V7.3.3 authorization rejects an untrusted caller even with an approval-shaped body", async () => {
  const p = await prepared();
  const result = await authorizeToolRequestFromBody({ authorization_request_id: p.id, decision: "approved", authorization_subject: "human:test" }, {}, { ...stoneDeps(p.store, p.request), trustedCaller: { trusted: false } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "trusted_human_confirmation_required");
  assert.equal(p.store.snapshot().status, "pending");
});

test("V7.3.3 trusted approval creates a separate immutable grant and no mutation", async () => {
  const p = await prepared();
  let mutationCalls = 0;
  const deps = { ...stoneDeps(p.store, p.request), invokeAuthorizedMutation: async () => { mutationCalls += 1; return { ok: true }; } };
  const result = await authorizeToolRequestFromBody({ authorization_request_id: p.id, decision: "approved", authorization_subject: "human:test" }, {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_AUTHORIZATION_GRANT_SCHEMA);
  assert.equal(result.status, "authorized");
  assert.equal(result.decision, "approved");
  assert.equal(result.authorization_stone_hash, "stone-1");
  assert.equal(mutationCalls, 0);
  assert.equal(p.store.snapshot().status, "authorized");
});

test("V7.3.3 execution rejects replacement arguments after approval", async () => {
  const p = await prepared("authorized");
  const result = await executeAuthorizedToolFromBody({ authorization_request_id: p.id, arguments: { next_value: "substitute" } }, {}, stoneDeps(p.store, p.request));
  assert.equal(result.ok, false);
  assert.equal(result.error, "authorized_execution_argument_substitution_not_accepted");
  assert.equal(p.store.snapshot().status, "authorized");
});

test("V7.3.3 approved request executes exact arguments once, verifies, then replays without a second mutation", async () => {
  const p = await prepared("authorized");
  let mutationCalls = 0;
  const deps = {
    ...stoneDeps(p.store, p.request),
    inspectGuard: async () => ({ ok: true, type: "fixture_version", expected: 0, observed: 0, matched: true }),
    invokeAuthorizedMutation: async (_entry, args) => { mutationCalls += 1; return { ok: true, value: args.next_value, version: 1 }; },
    verifyMutation: async () => ({ ok: true, passed: true, type: "fixture_readback" })
  };
  const first = await executeAuthorizedToolFromBody({ authorization_request_id: p.id }, {}, deps);
  assert.equal(first.ok, true);
  assert.equal(first.schema, TOOL_AUTHORIZED_EXECUTION_SCHEMA);
  assert.equal(first.executed, true);
  assert.equal(first.mutation_performed, true);
  assert.equal(first.replayed, false);
  assert.equal(mutationCalls, 1);
  assert.equal(p.store.snapshot().status, "executed");

  const replay = await executeAuthorizedToolFromBody({ authorization_request_id: p.id }, {}, deps);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.mutation_performed, false);
  assert.equal(mutationCalls, 1);
});

test("V7.3.3 changed guard fails closed and performs zero mutation", async () => {
  const p = await prepared("authorized");
  let mutationCalls = 0;
  const deps = {
    ...stoneDeps(p.store, p.request),
    inspectGuard: async () => ({ ok: true, type: "fixture_version", expected: 0, observed: 1, matched: false }),
    invokeAuthorizedMutation: async () => { mutationCalls += 1; return { ok: true }; }
  };
  const result = await executeAuthorizedToolFromBody({ authorization_request_id: p.id }, {}, deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "authorization_guard_mismatch");
  assert.equal(result.executed, false);
  assert.equal(result.mutation_performed, false);
  assert.equal(mutationCalls, 0);
  assert.equal(p.store.snapshot().status, "guard_failed");
});

test("V7.3.3 two concurrent consumers cannot both claim the same grant", async () => {
  const p = await prepared("authorized");
  let mutationCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const deps = {
    ...stoneDeps(p.store, p.request),
    inspectGuard: async () => ({ ok: true, type: "fixture_version", expected: 0, observed: 0, matched: true }),
    invokeAuthorizedMutation: async () => { mutationCalls += 1; await gate; return { ok: true }; },
    verifyMutation: async () => ({ ok: true, passed: true })
  };
  const firstPromise = executeAuthorizedToolFromBody({ authorization_request_id: p.id }, {}, deps);
  await new Promise(resolve => setImmediate(resolve));
  const second = await executeAuthorizedToolFromBody({ authorization_request_id: p.id }, {}, deps);
  assert.equal(second.ok, false);
  assert.equal(second.error, "authorization_already_consuming");
  release();
  const first = await firstPromise;
  assert.equal(first.ok, true);
  assert.equal(mutationCalls, 1);
});
