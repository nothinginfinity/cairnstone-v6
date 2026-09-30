import test from "node:test";
import assert from "node:assert/strict";
import {
  effectivePolicyFromRows,
  evaluateTurnSyncStandingPolicy,
  policyScopeCandidates,
  TURNSYNC_POLICY_GET_TOOL_ID,
  TURNSYNC_POLICY_SET_TOOL_ID
} from "../src/turnsync-policy.js";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { handleMcpRpc, mcpToolsForProfile } from "../src/index.js";

const row = (scope_kind, scope_key, mode, payload_mode = "full_turns", revision = 1) => ({
  policy_id: `tsp:${scope_kind}:${scope_key}`,
  account_id: "acct_demo",
  tenant_id: "tenant_demo",
  scope_kind,
  scope_key,
  mode,
  payload_mode,
  revision,
  updated_by_principal_id: "prin_demo",
  updated_by_connection_id: "conn_demo",
  created_at: "2026-09-29T20:00:00.000Z",
  updated_at: "2026-09-29T20:00:00.000Z"
});

test("scope precedence is workspace then chain then account", () => {
  assert.deepEqual(policyScopeCandidates({ workspace_id: "ws:demo", chain: "chain-demo" }), [
    { scope_kind: "workspace", scope_key: "ws:demo" },
    { scope_kind: "chain", scope_key: "chain-demo" },
    { scope_kind: "account", scope_key: "*" }
  ]);

  const rows = [
    row("account", "*", "off"),
    row("chain", "chain-demo", "ask"),
    row("workspace", "ws:demo", "on")
  ];
  const got = effectivePolicyFromRows(rows, { workspace_id: "ws:demo", chain: "chain-demo" });
  assert.equal(got.ok, true);
  assert.equal(got.effective.scope_kind, "workspace");
  assert.equal(got.effective.mode, "on");
  assert.equal(got.defaulted, false);
  assert.equal(got.accepted_state_authority, false);
});

test("missing stored policy defaults safely to ASK/full_turns", () => {
  const got = effectivePolicyFromRows([], { workspace_id: "ws:missing", chain: "chain-missing" });
  assert.equal(got.ok, true);
  assert.equal(got.defaulted, true);
  assert.equal(got.effective.mode, "ask");
  assert.equal(got.effective.payload_mode, "full_turns");
  assert.equal(got.effective.source, "safe_default");
});

test("standing policy gate allows only ON + full_turns in this slice", () => {
  const allowed = evaluateTurnSyncStandingPolicy({ mode: "on", payload_mode: "full_turns" });
  assert.equal(allowed.allow_append, true);
  assert.equal(allowed.requires_human_confirmation, false);

  const off = evaluateTurnSyncStandingPolicy({ mode: "off", payload_mode: "full_turns" });
  assert.equal(off.allow_append, false);
  assert.equal(off.error, "turnsync_sync_disabled");

  const ask = evaluateTurnSyncStandingPolicy({ mode: "ask", payload_mode: "full_turns" });
  assert.equal(ask.allow_append, false);
  assert.equal(ask.error, "turnsync_confirmation_required");
  assert.equal(ask.requires_human_confirmation, true);

  for (const payload_mode of ["decisions_tasks", "summaries"]) {
    const selective = evaluateTurnSyncStandingPolicy({ mode: "on", payload_mode });
    assert.equal(selective.allow_append, false);
    assert.equal(selective.error, "turnsync_payload_transform_required");
  }
});

test("invalid policy never widens to allow", () => {
  const got = evaluateTurnSyncStandingPolicy({ mode: "magic", payload_mode: "full_turns" });
  assert.equal(got.ok, false);
  assert.equal(got.allow_append, false);
  assert.equal(got.error, "turnsync_policy_invalid");
});

test("TurnSync policy tools are catalogued as scoped account settings and never automatic model reads", () => {
  const names = mcpToolsForProfile(false).map(tool => tool.name);
  assert.ok(names.includes(TURNSYNC_POLICY_GET_TOOL_ID));
  assert.ok(names.includes(TURNSYNC_POLICY_SET_TOOL_ID));

  const getEntry = DEFAULT_TOOL_BROKER_REGISTRY.find(tool => tool.tool_id === TURNSYNC_POLICY_GET_TOOL_ID);
  const setEntry = DEFAULT_TOOL_BROKER_REGISTRY.find(tool => tool.tool_id === TURNSYNC_POLICY_SET_TOOL_ID);
  assert.ok(getEntry);
  assert.ok(setEntry);
  assert.equal(getEntry.risk_class, "read");
  assert.equal(getEntry.authorization, "scoped_grant");
  assert.equal(setEntry.risk_class, "mutation");
  assert.equal(setEntry.authorization, "scoped_grant");

  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  assert.equal(automatic.includes(TURNSYNC_POLICY_GET_TOOL_ID), false);
  assert.equal(automatic.includes(TURNSYNC_POLICY_SET_TOOL_ID), false);
});

test("authenticated Core exposes TurnSync native surfaces without widening legacy Core", async () => {
  const authListed = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, {}, { core: true, auth: true });
  const authNames = authListed.result.tools.map(tool => tool.name);
  for (const name of [
    "cairnstone_unified_conversations",
    "cairnstone_turnsync_append",
    TURNSYNC_POLICY_GET_TOOL_ID,
    TURNSYNC_POLICY_SET_TOOL_ID
  ]) assert.ok(authNames.includes(name), `${name} missing from authenticated Core profile`);

  const legacyListed = await handleMcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {}, { core: true, auth: false });
  const legacyNames = legacyListed.result.tools.map(tool => tool.name);
  assert.equal(legacyNames.includes("cairnstone_unified_conversations"), false);
  assert.equal(legacyNames.includes("cairnstone_turnsync_append"), false);
  assert.equal(legacyNames.includes(TURNSYNC_POLICY_GET_TOOL_ID), false);
  assert.equal(legacyNames.includes(TURNSYNC_POLICY_SET_TOOL_ID), false);
});
