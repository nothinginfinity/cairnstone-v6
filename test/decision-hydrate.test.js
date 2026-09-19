import test from "node:test";
import assert from "node:assert/strict";
import { seedAutomaticReadCandidates, hydrateSelectedContract } from "../src/decision-hydrate.js";
import { routeDecisionFromBody } from "../src/decision-scorer.js";

const FIND_SCHEMA = { type: "object", properties: { query: { type: "string" } } };
const REG = [
  {
    tool_id: "cairnstone_find_v2",
    handler: "cairnstone_find_v2",
    risk_class: "read",
    authorization: "automatic",
    available: true,
    description: "search stones on a chain",
    input_schema: FIND_SCHEMA
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
const CATALOG = [
  { name: "cairnstone_find_v2", description: "search stones on a chain", inputSchema: FIND_SCHEMA },
  { name: "cairnstone_commit_v2", description: "commit a stone", inputSchema: { type: "object" } },
  { name: "cairnstone_health", description: "live worker health", inputSchema: { type: "object" } }
];
const ENV = { decisionRegistry: REG, mcpToolDefinitions: CATALOG };

test("seed keeps only automatic reads matching task tokens and never includes mutations", () => {
  const seeded = seedAutomaticReadCandidates(REG, { task: "search stones on the chain" });
  assert.deepEqual(seeded.map((c) => c.id), ["cairnstone_find_v2"]);
});

test("seed without task tokens does not dump the vault", () => {
  assert.deepEqual(seedAutomaticReadCandidates(REG, { task: "" }), []);
});

test("auto + missing candidates does not seed or invent", async () => {
  const result = await routeDecisionFromBody({ kind: "tool_route", task: "search stones", mode: "auto" }, ENV);
  assert.equal(result.ok, false);
  assert.equal(result.error, "candidates_required");
  assert.equal(result.hydrated, undefined);
});

test("deterministic + empty candidates does not seed", async () => {
  const result = await routeDecisionFromBody({
    kind: "tool_route",
    task: "search stones",
    mode: "deterministic",
    candidates: []
  }, ENV);
  assert.equal(result.error, "candidates_required");
});

test("hydrate + non-tool_route rejects", async () => {
  const result = await routeDecisionFromBody({
    kind: "retain",
    mode: "hydrate",
    task: "search",
    candidates: [{ id: "keep" }]
  }, ENV);
  assert.equal(result.ok, false);
  assert.equal(result.error, "hydrate_requires_tool_route");
});

test("hydrate attaches canonical schema_hash matching mcpTools", async () => {
  const hydrated = await hydrateSelectedContract({ id: "cairnstone_find_v2" }, ENV);
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.contract.schema_source, "canonical_mcpTools");
  assert.equal(hydrated.contract.schema_hash, hydrated.contract.registry_schema_hash);
  assert.match(hydrated.contract.schema_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hydrated.execution_authority, false);
});

test("hydrate refuses mutation and schema disagreement", async () => {
  const mut = await hydrateSelectedContract({ id: "cairnstone_commit_v2" }, ENV);
  assert.equal(mut.error, "hydrate_not_automatic_read");
  const disagreeReg = [{
    ...REG[0],
    input_schema: { type: "object", properties: { other: { type: "string" } } }
  }];
  const bad = await hydrateSelectedContract({ id: "cairnstone_find_v2" }, {
    decisionRegistry: disagreeReg,
    mcpToolDefinitions: CATALOG,
    registry: disagreeReg
  });
  assert.equal(bad.error, "schema_disagreement");
});

test("hydrate fail-closes the whole decision when contract cannot hydrate", async () => {
  const result = await routeDecisionFromBody({
    kind: "tool_route",
    mode: "hydrate",
    task: "x",
    candidates: [{ id: "not_a_tool", capability: "x" }]
  }, ENV);
  assert.equal(result.ok, false);
  assert.equal(result.hydrated.ok, false);
  assert.equal(result.selected, null);
});

test("routeDecisionFromBody hydrate seeds vault then attaches contract", async () => {
  const result = await routeDecisionFromBody({
    kind: "tool_route",
    task: "search stones",
    mode: "hydrate"
  }, ENV);
  assert.equal(result.ok, true);
  assert.equal(result.selected.id, "cairnstone_find_v2");
  assert.equal(result.hydrated.ok, true);
  assert.equal(result.hydrated.contract.schema_hash, result.hydrated.contract.registry_schema_hash);
  assert.equal(result.execution_authority, false);
});
