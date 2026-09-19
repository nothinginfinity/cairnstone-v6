import test from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  digestCandidateSet,
  DECISION_SCHEMA,
  CANDIDATE_SCHEMA,
  DECISION_RECEIPT_SCHEMA
} from "../src/decision-plane.js";

const CANDIDATES = [
  { id: "cairnstone_find_v2", capability: "stone.search", tool: "cairnstone_find_v2" },
  { id: "cairnstone_ask_scope", capability: "scope.retrieve", tool: "cairnstone_ask_scope" }
];

test("unique eligible candidate skips scorer", async () => {
  const result = await decide({
    kind: "tool_route",
    task: "search stones",
    candidates: [CANDIDATES[0]],
    scorer_source: "jev"
  });
  assert.equal(result.schema, DECISION_SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.policy_outcome, "deterministic_winner");
  assert.equal(result.selected.id, "cairnstone_find_v2");
  assert.equal(result.selected.schema, CANDIDATE_SCHEMA);
  assert.equal(result.receipt.schema, DECISION_RECEIPT_SCHEMA);
  assert.equal(result.receipt.policy_outcome, "skipped_scorer");
  assert.equal(result.receipt.scorer_source, "deterministic");
  assert.equal(result.execution_authority, false);
  assert.equal(result.accepted_state_authority, false);
});

test("invented selected_id is rejected", async () => {
  const result = await decide({
    kind: "tool_route",
    candidates: CANDIDATES,
    selected_id: "invented_tool"
  });
  assert.equal(result.ok, false);
  assert.equal(result.policy_outcome, "invented_candidate_rejected");
  assert.equal(result.selected, null);
  assert.equal(result.receipt.invented_id, "invented_tool");
  assert.equal(result.invented_candidate_executable, false);
});

test("candidate-set digest mismatch fails closed", async () => {
  const result = await decide({
    kind: "tool_route",
    candidates: CANDIDATES,
    selected_id: "cairnstone_find_v2",
    candidate_set_digest: "sha256:deadbeef"
  });
  assert.equal(result.ok, false);
  assert.equal(result.policy_outcome, "candidate_set_mismatch");
});

test("valid selected_id binds digest and does not execute", async () => {
  const digest = await digestCandidateSet(CANDIDATES);
  const result = await decide({
    kind: "retain",
    candidates: CANDIDATES,
    selected_id: "cairnstone_find_v2",
    scorer_source: "jev",
    confidence: 0.81,
    candidate_set_digest: digest
  });
  assert.equal(result.ok, true);
  assert.equal(result.policy_outcome, "selected");
  assert.equal(result.selected.id, "cairnstone_find_v2");
  assert.equal(result.receipt.candidate_set_digest, digest);
  assert.equal(result.receipt.scorer_source, "jev");
  assert.equal(result.execution_authority, false);
});

test("ambiguous set without selection does not invent a winner", async () => {
  const result = await decide({
    kind: "tool_route",
    candidates: CANDIDATES
  });
  assert.equal(result.ok, false);
  assert.equal(result.policy_outcome, "ambiguous_no_winner");
  assert.equal(result.selected, null);
  assert.equal(result.ranked.length, 2);
});

test("unsupported kind fails closed", async () => {
  const result = await decide({
    kind: "execute_anything",
    candidates: CANDIDATES
  });
  assert.equal(result.ok, false);
  assert.equal(result.policy_outcome, "kind_unsupported");
});
