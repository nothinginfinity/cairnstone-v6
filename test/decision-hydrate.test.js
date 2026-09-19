import test from "node:test";
import assert from "node:assert/strict";
import { seedAutomaticReadCandidates, hydrateSelectedContract } from "../src/decision-hydrate.js";
import { routeDecisionFromBody } from "../src/decision-scorer.js";

const REG = [
  {
    tool_id: "cairnstone_find_v2",
    handler: "cairnstone_find_v2",
    risk_class: "read",
    authorization: "automatic",
    available: true,
    description: "search stones on a chain",
    input_schema: { type: "object", properties: { query: { type: "string" } } }
  },
  {
    tool_id: "cairnstone_commit_v2",
    handler: "cairnstone_commit_v2",
    risk_class: "mutation",
    authorization: "scoped_grant",
    available: true,
    description: "commit a stone",
    input_schema: { type: "object" }
  },
  {
    tool_id: "cairnstone_health",
    handler: "cairnstone_health",
    risk_class: "read",
    authorization: "automatic",
    available: true,
    description: "live worker health",
    input_schema: { type: "object" }
  }
];

test("seed keeps only automatic reads matching task tokens and never includes mutations", () => {
  const seeded = seedAutomaticReadCandidates(REG, { task: "search stones on the chain" });
  assert.deepEqual(seeded.map((c) => c.id), ["cairnstone_find_v2"]);
  assert.equal(seeded[0].authorization, "automatic");
});

test("seed without task tokens does not dump the vault", () => {
  assert.deepEqual(seedAutomaticReadCandidates(REG, { task: "" }), []);
});

test("hydrate attaches schema_hash and never grants execution", async () => {
  const hydrated = await hydrateSelectedContract({ id: "cairnstone_find_v2" }, REG);
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.execution_authority, false);
  assert.match(hydrated.contract.schema_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hydrated.contract.name, "cairnstone_find_v2");
});

test("hydrate refuses mutation tools", async () => {
  const hydrated = await hydrateSelectedContract({ id: "cairnstone_commit_v2" }, REG);
  assert.equal(hydrated.ok, false);
  assert.equal(hydrated.error, "hydrate_not_automatic_read");
  assert.equal(hydrated.execution_authority, false);
});

test("routeDecisionFromBody hydrate seeds vault then attaches contract", async () => {
  const result = await routeDecisionFromBody({
    kind: "tool_route",
    task: "search stones",
    mode: "hydrate",
    candidates: []
  }, { decisionRegistry: REG });
  assert.equal(result.ok, true);
  assert.equal(result.selected.id, "cairnstone_find_v2");
  assert.equal(result.hydrated.ok, true);
  assert.equal(result.execution_authority, false);
});
