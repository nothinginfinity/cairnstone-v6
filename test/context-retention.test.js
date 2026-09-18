import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION,
  CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION,
  RETENTION_SCHEMA,
  REHYDRATION_SCHEMA,
  RETENTION_ACTIONS,
  classifyCandidate,
  compileRetentionLedger,
  planRehydration,
  previewRetention,
  previewRetentionFromBody,
  previewRetentionFromLedger,
  rehydrateRoute,
  rehydrateRoutesFromBody
} from "../src/context-retention.js";

test("HEAD/stone/receipt/grant/secret classes are pinned", () => {
  const classes = [
    "chain_head",
    "path_head",
    "stone_identity",
    "execution_receipt",
    "work_receipt",
    "access_grant",
    "secret"
  ];

  for (const artifactClass of classes) {
    const decision = classifyCandidate({ class: artifactClass });
    assert.equal(decision.action, RETENTION_ACTIONS.PIN);
  }
});

test("current blocker is never dropped", () => {
  const decision = classifyCandidate({
    class: "diagnostic_output",
    flags: { current_blocker: true, rehydratable: true, redundant: true, newer_immutable_ref: "repo:foo/bar@sha/path" },
    success: true,
    repo_ref: "repo:foo/bar@sha/path"
  });

  assert.notEqual(decision.action, RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT);
  assert.ok(decision.action === RETENTION_ACTIONS.KEEP_FULL || decision.action === RETENTION_ACTIONS.PIN);
});

test("rehydratable repo read not current task is KEEP_REF", () => {
  const decision = classifyCandidate({
    class: "repo_read",
    flags: { rehydratable: true },
    repo_ref: "repo:nothinginfinity/cairnstone-v6@abc123/src/index.js"
  });

  assert.equal(decision.action, RETENTION_ACTIONS.KEEP_REF);
});

test("KEEP_REF allowlist keeps eligible classes and excludes ineligible ones", () => {
  const eligible = classifyCandidate({
    class: "search_expand",
    flags: { rehydratable: true },
    object_ref: "stone:abc123"
  });
  assert.equal(eligible.action, RETENTION_ACTIONS.KEEP_REF);

  const ineligible = classifyCandidate({
    class: "tool_result",
    flags: { rehydratable: true },
    object_ref: "stone:def456"
  });
  assert.equal(ineligible.action, RETENTION_ACTIONS.KEEP_FULL);
});

test("missing immutable ref cannot be dropped", () => {
  const decision = classifyCandidate({
    class: "repo_read",
    success: true,
    flags: { redundant: true, newer_immutable_ref: "repo:nothinginfinity/cairnstone-v6@def456/src/index.js" }
  });

  assert.equal(decision.action, RETENTION_ACTIONS.KEEP_FULL);
  assert.equal(decision.reason, "missing_rehydration_identity");
});

test("redundant successful read drop carries replacement immutable ref", () => {
  const decision = classifyCandidate({
    class: "repo_read",
    success: true,
    repo_ref: "repo:nothinginfinity/cairnstone-v6@abc123/src/index.js",
    flags: {
      redundant: true,
      newer_immutable_ref: "repo:nothinginfinity/cairnstone-v6@def456/src/index.js"
    }
  });

  assert.equal(decision.action, RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT);
  assert.equal(decision.newer_immutable_ref, "repo:nothinginfinity/cairnstone-v6@def456/src/index.js");
  assert.equal(decision.rehydration_ref, "repo:nothinginfinity/cairnstone-v6@def456/src/index.js");
});

test("previewRetention always reports authority closed", () => {
  const preview = previewRetention({
    candidates: [
      { class: "chain_head" },
      { class: "repo_read", flags: { rehydratable: true }, repo_ref: "repo:nothinginfinity/cairnstone-v6@abc123/src/index.js" }
    ]
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.schema, RETENTION_SCHEMA);
  assert.equal(preview.accepted_state_authority, false);
  assert.equal(preview.chain_heads_mutated, false);
  assert.equal(preview.path_heads_mutated, false);
  assert.equal(preview.storage_deleted, false);
});

test("previewRetention reports estimated bytes for direct candidates when present", () => {
  const preview = previewRetention({
    candidates: [
      { class: "repo_read", bytes: 12 },
      { class: "tool_result" }
    ]
  });

  assert.equal(preview.telemetry.estimated_bytes_before, 12);
});

test("previewRetention ignores negative direct candidate bytes in telemetry", () => {
  const preview = previewRetention({
    candidates: [
      { class: "repo_read", bytes: -1 },
      { class: "tool_result", bytes: 5 }
    ]
  });

  assert.equal(preview.telemetry.estimated_bytes_before, 5);
});

test("compileRetentionLedger emits compact deterministic baseline rows", () => {
  const rows = compileRetentionLedger([{
    message_id: "msg:retention-1",
    repo_ref: "repo:nothinginfinity/cairnstone-v6@abc123/src/index.js",
    bytes: 128,
    rehydratable: true,
    referenced_by_active_turn: true,
    accepted_state_authority: true
  }]);

  assert.deepEqual(rows, [{
    id: "msg:retention-1",
    class: "repo_read",
    current_task: false,
    current_blocker: false,
    rehydratable: true,
    referenced_by_active_turn: true,
    accepted_state_authority: false,
    flags: {
      current_blocker: false,
      rehydratable: true,
      referenced_by_active_turn: true
    },
    bytes: 128,
    repo_ref: "repo:nothinginfinity/cairnstone-v6@abc123/src/index.js"
  }]);
});

test("previewRetentionFromLedger keeps protected classes pinned and reports estimated bytes", () => {
  const preview = previewRetentionFromLedger([{
    id: "sec:1",
    class: "secret",
    bytes: 64,
    rehydratable: true,
    object_ref: "stone:deadbeef",
    referenced_by_active_turn: true
  }]);

  assert.equal(preview.decisions[0].action, RETENTION_ACTIONS.PIN);
  assert.equal(preview.decisions[0].accepted_state_authority, false);
  assert.equal(preview.telemetry.estimated_bytes_before, 64);
});

test("previewRetentionFromBody totals estimated bytes across direct and ledger candidates", () => {
  const preview = previewRetentionFromBody({
    actor_id: "console:jared",
    candidates: [{ class: "repo_read", bytes: 16 }],
    items: [{ message_id: "msg:retention-2", repo_ref: "repo:nothinginfinity/cairnstone-v6@def456/src/index.js", bytes: 32 }]
  });

  assert.equal(preview.decisions.length, 2);
  assert.equal(preview.telemetry.estimated_bytes_before, 48);
});

test("previewRetentionFromBody requires actor_id", () => {
  const preview = previewRetentionFromBody({});
  assert.equal(preview.ok, false);
  assert.equal(preview.error, "actor_id_required");
  assert.equal(preview.accepted_state_authority, false);
});

test("context retention preview MCP definition is shaped and registered", () => {
  assert.equal(CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION.name, "cairnstone_context_retention_preview");
  assert.deepEqual(CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION.inputSchema.required, ["actor_id"]);
  assert.equal(CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION.inputSchema.properties.actor_id.type, "string");
  assert.equal(CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION.inputSchema.properties.candidates.type, "array");
  assert.equal(CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION.inputSchema.properties.items.type, "array");

  const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(indexSource, /previewRetentionFromBody/);
  assert.match(indexSource, /cairnstone_context_retention_preview/);
});

test("rehydrateRoute accepts exact repo sha snapshots", () => {
  const route = rehydrateRoute("repo:nothinginfinity/cairnstone-v6@0123456789abcdef0123456789abcdef01234567/src/index.js");

  assert.equal(route.ok, true);
  assert.equal(route.schema, REHYDRATION_SCHEMA);
  assert.equal(route.route, "repo_at_sha");
  assert.equal(route.exact, true);
  assert.equal(route.snapshot, true);
  assert.equal(route.accepted_state_authority, false);
  assert.equal(route.chain_heads_mutated, false);
  assert.equal(route.storage_deleted, false);
});

test("rehydrateRoute refuses floating repo refs", () => {
  const route = rehydrateRoute("repo:nothinginfinity/cairnstone-v6@main/src/index.js");

  assert.equal(route.ok, false);
  assert.equal(route.exact, false);
  assert.equal(route.error, "mutable_head_ref_refused");
  assert.equal(route.reason, "would replace snapshot with current mutable state");
});

test("rehydrateRoute prefers candidate stone refs over repo refs", () => {
  const route = rehydrateRoute({
    object_ref: "stone:deadbeef",
    repo_ref: "repo:nothinginfinity/cairnstone-v6@main/src/index.js"
  });

  assert.equal(route.ok, true);
  assert.equal(route.route, "stone_expand");
  assert.equal(route.ref, "stone:deadbeef");
});

test("rehydrateRoute reports unavailable for missing refs", () => {
  const route = rehydrateRoute({ class: "repo_read" });

  assert.equal(route.ok, false);
  assert.equal(route.exact, false);
  assert.equal(route.error, "rehydration_unavailable");
});

test("planRehydration only attaches routes for KEEP_REF and DROP entries with refs", () => {
  const planned = planRehydration([
    {
      action: RETENTION_ACTIONS.KEEP_REF,
      repo_ref: "repo:nothinginfinity/cairnstone-v6@0123456789abcdef0123456789abcdef01234567/src/index.js"
    },
    {
      action: RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT,
      object_ref: "stone:deadbeef"
    },
    {
      action: RETENTION_ACTIONS.KEEP_FULL,
      repo_ref: "repo:nothinginfinity/cairnstone-v6@0123456789abcdef0123456789abcdef01234567/src/index.js"
    },
    {
      action: RETENTION_ACTIONS.PIN,
      object_ref: "stone:feedface"
    }
  ]);

  assert.equal(planned[0].rehydrate.route, "repo_at_sha");
  assert.equal(planned[1].rehydrate.route, "stone_expand");
  assert.equal("rehydrate" in planned[2], false);
  assert.equal("rehydrate" in planned[3], false);
});

test("planRehydration classifies raw candidates before attaching routes", () => {
  const planned = planRehydration([{
    class: "repo_read",
    flags: { rehydratable: true },
    repo_ref: "repo:nothinginfinity/cairnstone-v6@0123456789abcdef0123456789abcdef01234567/src/index.js"
  }]);

  assert.equal(planned[0].action, RETENTION_ACTIONS.KEEP_REF);
  assert.equal(planned[0].rehydrate.route, "repo_at_sha");
});

test("context retention rehydrate MCP definition is shaped and registered", () => {
  assert.equal(CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION.name, "cairnstone_context_retention_rehydrate");
  assert.deepEqual(CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION.inputSchema.required, ["actor_id"]);
  assert.equal(CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION.inputSchema.properties.actor_id.type, "string");
  assert.equal(CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION.inputSchema.properties.refs.type, "array");
  assert.equal(CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION.inputSchema.properties.candidates.type, "array");

  const routes = rehydrateRoutesFromBody({
    actor_id: "console:jared",
    refs: ["repo:nothinginfinity/cairnstone-v6@0123456789abcdef0123456789abcdef01234567/src/index.js"]
  });
  assert.equal(routes.ok, true);
  assert.equal(routes.schema, REHYDRATION_SCHEMA);
  assert.equal(routes.routes[0].route, "repo_at_sha");

  const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(indexSource, /rehydrateRoutesFromBody/);
  assert.match(indexSource, /cairnstone_context_retention_rehydrate/);
});

test("context-retention module has no D1 or set_head mutation calls", () => {
  const source = readFileSync(new URL("../src/context-retention.js", import.meta.url), "utf8");
  assert.equal(/\bD1\b/.test(source), false);
  assert.equal(/set_head/.test(source), false);
});
