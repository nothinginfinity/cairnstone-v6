import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION,
  RETENTION_SCHEMA,
  RETENTION_ACTIONS,
  classifyCandidate,
  compileRetentionLedger,
  previewRetention,
  previewRetentionFromBody,
  previewRetentionFromLedger
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

test("context-retention module has no D1 or set_head mutation calls", () => {
  const source = readFileSync(new URL("../src/context-retention.js", import.meta.url), "utf8");
  assert.equal(/\bD1\b/.test(source), false);
  assert.equal(/set_head/.test(source), false);
});
