import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOOL_SEARCH_SCHEMA,
  TOOL_CONTRACT_SCHEMA,
  TOOL_SEARCH_TOOL_DEFINITION,
  TOOL_CONTRACT_TOOL_DEFINITION,
  toolSearchFromBody,
  toolContractFromBody
} from "../src/tool-catalog.js";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "../src/model-router.js";
import {
  VAULT_CATALOG_TOOL_DEFINITION,
  SCOPE_RESOLVE_TOOL_DEFINITION,
  SCOPE_FIND_TOOL_DEFINITION
} from "../src/vault-catalog.js";

const CLASSIFIED_TOOL = {
  name: "cairnstone_health",
  description: "Check CairnStone v6 MCP, D1, R2, and GitHub fetch status.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
};

const UNCLASSIFIED_TOOL = {
  name: "cairnstone_totally_unclassified_tool",
  description: "A tool with no broker registry entry, for testing discovery-without-authority.",
  inputSchema: { type: "object", properties: { foo: { type: "string" } }, additionalProperties: false }
};

const DISAGREEING_TOOL = {
  name: "cairnstone_disagreeing_tool",
  description: "A tool whose live schema no longer matches its registered broker entry.",
  inputSchema: { type: "object", properties: { changed: { type: "string" } }, additionalProperties: false }
};

const STALE_REGISTRY = Object.freeze([
  ...DEFAULT_TOOL_BROKER_REGISTRY,
  Object.freeze({
    tool_id: "cairnstone_disagreeing_tool",
    connector: "cairnstone",
    handler: "cairnstone_disagreeing_tool",
    risk_class: "read",
    authorization: "automatic",
    available: true,
    description: "Stale registry copy that no longer matches the live schema.",
    input_schema: { type: "object", properties: { original: { type: "string" } }, additionalProperties: false }
  })
]);

const FIXTURE_CATALOG = [CLASSIFIED_TOOL, UNCLASSIFIED_TOOL, DISAGREEING_TOOL, TOOL_SEARCH_TOOL_DEFINITION, TOOL_CONTRACT_TOOL_DEFINITION];

test("tool_search: classified tool from the real DEFAULT_TOOL_BROKER_REGISTRY reports honest classification", async () => {
  const result = await toolSearchFromBody({ query: "health" }, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_SEARCH_SCHEMA);
  const hit = result.tools.find(t => t.name === "cairnstone_health");
  assert.ok(hit, "expected cairnstone_health in results");
  assert.equal(hit.classification_status, "classified");
  assert.equal(hit.risk_class, "read");
  assert.equal(hit.authorization, "automatic");
  assert.equal(hit.broker_eligible, true);
});

test("tool_search: unclassified tool never fabricates a risk class and is never hidden", async () => {
  const result = await toolSearchFromBody({ query: "unclassified" }, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, true);
  const hit = result.tools.find(t => t.name === "cairnstone_totally_unclassified_tool");
  assert.ok(hit, "unclassified tool must still be discoverable");
  assert.equal(hit.classification_status, "unclassified");
  assert.equal(hit.risk_class, null);
  assert.equal(hit.authorization, null);
  assert.equal(hit.broker_eligible, false);
});

test("tool_search: schema-disagreeing tool fails closed to non-authoritative nulls, stays discoverable", async () => {
  const result = await toolSearchFromBody({ query: "disagreeing" }, null, {
    mcpToolDefinitions: FIXTURE_CATALOG,
    registry: STALE_REGISTRY
  });
  assert.equal(result.ok, true);
  const hit = result.tools.find(t => t.name === "cairnstone_disagreeing_tool");
  assert.ok(hit, "schema-disagreeing tool must still be discoverable");
  assert.equal(hit.classification_status, "schema_disagreement");
  assert.equal(hit.risk_class, null);
  assert.equal(hit.authorization, null);
  assert.equal(hit.broker_eligible, false);
});

test("tool_search: with no query, lists the full supplied catalog (subject to limit)", async () => {
  const result = await toolSearchFromBody({}, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, true);
  assert.equal(result.catalog_total, FIXTURE_CATALOG.length);
  assert.equal(result.total, FIXTURE_CATALOG.length);
});

test("tool_search: risk_class filter excludes unclassified/disagreeing tools (risk_class:null)", async () => {
  const result = await toolSearchFromBody({ risk_class: "read" }, null, {
    mcpToolDefinitions: FIXTURE_CATALOG,
    registry: STALE_REGISTRY
  });
  assert.equal(result.ok, true);
  assert.ok(!result.tools.some(t => t.name === "cairnstone_totally_unclassified_tool"));
  assert.ok(!result.tools.some(t => t.name === "cairnstone_disagreeing_tool"));
  assert.ok(result.tools.some(t => t.name === "cairnstone_health"));
});

test("tool_search: rejects an invalid classification_status filter", async () => {
  const result = await toolSearchFromBody({ classification_status: "bogus" }, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_classification_status");
});

test("tool_search: fails cleanly when no catalog is supplied", async () => {
  const result = await toolSearchFromBody({}, null, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "tool_catalog_unavailable");
});

test("get_tool_contract: classified tool returns exact schema + matching schema_hash + true classification", async () => {
  const result = await toolContractFromBody({ name: "cairnstone_health" }, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, true);
  assert.equal(result.schema, TOOL_CONTRACT_SCHEMA);
  assert.deepEqual(result.input_schema, CLASSIFIED_TOOL.inputSchema);
  assert.equal(result.classification_status, "classified");
  assert.equal(result.risk_class, "read");
  assert.equal(result.authorization, "automatic");
  assert.equal(result.broker_eligible, true);
  assert.equal(result.schema_hash, result.registry_schema_hash);
  assert.match(result.schema_hash, /^sha256:[0-9a-f]{64}$/);
});

test("get_tool_contract: unclassified tool still hydrates the real schema with honest nulls", async () => {
  const result = await toolContractFromBody({ name: "cairnstone_totally_unclassified_tool" }, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, true);
  assert.deepEqual(result.input_schema, UNCLASSIFIED_TOOL.inputSchema);
  assert.equal(result.classification_status, "unclassified");
  assert.equal(result.risk_class, null);
  assert.equal(result.authorization, null);
  assert.equal(result.broker_eligible, false);
});

test("get_tool_contract: schema disagreement fails closed but still returns the live canonical schema", async () => {
  const result = await toolContractFromBody({ name: "cairnstone_disagreeing_tool" }, null, {
    mcpToolDefinitions: FIXTURE_CATALOG,
    registry: STALE_REGISTRY
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.input_schema, DISAGREEING_TOOL.inputSchema, "live canonical schema must still be returned, never hidden");
  assert.equal(result.classification_status, "schema_disagreement");
  assert.equal(result.risk_class, null);
  assert.equal(result.authorization, null);
  assert.equal(result.broker_eligible, false);
  assert.notEqual(result.schema_hash, result.registry_schema_hash);
});

test("get_tool_contract: unknown tool name fails with tool_not_found, not a fabricated contract", async () => {
  const result = await toolContractFromBody({ name: "cairnstone_does_not_exist" }, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, false);
  assert.equal(result.error, "tool_not_found");
});

test("get_tool_contract: missing name is rejected", async () => {
  const result = await toolContractFromBody({}, null, { mcpToolDefinitions: FIXTURE_CATALOG });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_tool_name");
});

test("V7.6.2a broker registry: cairnstone_tool_search and cairnstone_get_tool_contract are classified read+automatic", () => {
  const searchEntry = DEFAULT_TOOL_BROKER_REGISTRY.find(e => e.tool_id === "cairnstone_tool_search");
  const contractEntry = DEFAULT_TOOL_BROKER_REGISTRY.find(e => e.tool_id === "cairnstone_get_tool_contract");
  assert.ok(searchEntry, "cairnstone_tool_search must be registered in the broker");
  assert.ok(contractEntry, "cairnstone_get_tool_contract must be registered in the broker");
  assert.equal(searchEntry.risk_class, "read");
  assert.equal(searchEntry.authorization, "automatic");
  assert.equal(contractEntry.risk_class, "read");
  assert.equal(contractEntry.authorization, "automatic");
});

test("V7.6.2a self-consistency: real registry copies of the two tools' input_schema exactly match tool-catalog.js definitions (schema_hash agrees)", async () => {
  const searchResult = await toolContractFromBody(
    { name: "cairnstone_tool_search" },
    null,
    { mcpToolDefinitions: [TOOL_SEARCH_TOOL_DEFINITION, TOOL_CONTRACT_TOOL_DEFINITION] }
  );
  assert.equal(searchResult.ok, true);
  assert.equal(searchResult.classification_status, "classified", "real registry copy must byte-match the live tool-catalog.js schema");
  assert.equal(searchResult.schema_hash, searchResult.registry_schema_hash);

  const contractResult = await toolContractFromBody(
    { name: "cairnstone_get_tool_contract" },
    null,
    { mcpToolDefinitions: [TOOL_SEARCH_TOOL_DEFINITION, TOOL_CONTRACT_TOOL_DEFINITION] }
  );
  assert.equal(contractResult.ok, true);
  assert.equal(contractResult.classification_status, "classified", "real registry copy must byte-match the live tool-catalog.js schema");
  assert.equal(contractResult.schema_hash, contractResult.registry_schema_hash);
});

test("V7.7.1 Tool Vault: catalog, scope resolver, and scoped search are read+automatic with exact live schema parity", async () => {
  const definitions = [VAULT_CATALOG_TOOL_DEFINITION, SCOPE_RESOLVE_TOOL_DEFINITION, SCOPE_FIND_TOOL_DEFINITION];
  for (const definition of definitions) {
    const registryEntry = DEFAULT_TOOL_BROKER_REGISTRY.find(entry => entry.tool_id === definition.name);
    assert.ok(registryEntry, `${definition.name} must be classified in the broker registry`);
    assert.equal(registryEntry.risk_class, "read");
    assert.equal(registryEntry.authorization, "automatic");

    const contract = await toolContractFromBody(
      { name: definition.name },
      null,
      { mcpToolDefinitions: definitions }
    );
    assert.equal(contract.ok, true);
    assert.equal(contract.classification_status, "classified", `${definition.name} live/registry schema must agree`);
    assert.equal(contract.risk_class, "read");
    assert.equal(contract.authorization, "automatic");
    assert.equal(contract.broker_eligible, true);
    assert.equal(contract.schema_hash, contract.registry_schema_hash);
  }
});
