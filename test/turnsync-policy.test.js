import test from "node:test";
import assert from "node:assert/strict";
import {
  effectivePolicyFromRows,
  evaluateTurnSyncStandingPolicy,
  policyScopeCandidates
} from "../src/turnsync-policy.js";

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
