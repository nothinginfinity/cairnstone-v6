import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "../src/model-router.js";
import { CAPABILITY_ROUTE_TOOL_DEFINITION } from "../src/decision-scorer.js";
import { ASK_JEV_TOOL_DEFINITION } from "../src/decision-jev.js";

function entry(id) {
  return DEFAULT_TOOL_BROKER_REGISTRY.find((tool) => tool.tool_id === id);
}

test("ask_jev and capability_route are classified read + automatic", () => {
  for (const id of ["cairnstone_capability_route", "ask_jev"]) {
    const found = entry(id);
    assert.ok(found, id);
    assert.equal(found.risk_class, "read");
    assert.equal(found.authorization, "automatic");
    assert.equal(found.available, true);
  }
});

test("broker input_schema matches published MCP definitions", () => {
  assert.deepEqual(entry("ask_jev").input_schema, ASK_JEV_TOOL_DEFINITION.inputSchema);
  assert.deepEqual(entry("cairnstone_capability_route").input_schema, CAPABILITY_ROUTE_TOOL_DEFINITION.inputSchema);
});
