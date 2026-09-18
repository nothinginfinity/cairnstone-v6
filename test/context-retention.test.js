import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RETENTION_SCHEMA,
  RETENTION_ACTIONS,
  classifyCandidate,
  previewRetention
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

test("missing immutable ref cannot be dropped", () => {
  const decision = classifyCandidate({
    class: "repo_read",
    success: true,
    flags: { redundant: true, newer_immutable_ref: "repo:nothinginfinity/cairnstone-v6@def456/src/index.js" }
  });

  assert.notEqual(decision.action, RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT);
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

test("context-retention module has no D1 or set_head mutation calls", () => {
  const source = readFileSync(new URL("../src/context-retention.js", import.meta.url), "utf8");
  assert.equal(/\bD1\b/.test(source), false);
  assert.equal(/set_head/.test(source), false);
});
