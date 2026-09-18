import test from "node:test";
import assert from "node:assert/strict";
import { RETENTION_ACTIONS, planRehydration } from "../src/context-retention.js";
import {
  executeRehydrate,
  parseExactRepoSnapshot
} from "../src/rehydrate-execute.js";

const OLD_SHA = "6fed72f49c23c5caedadaba83df64135cfda4535";
const OLD_REF = `repo:nothinginfinity/cairnstone-v6@${OLD_SHA}/src/context-retention.js`;

test("parseExactRepoSnapshot extracts 40-hex only", () => {
  const parsed = parseExactRepoSnapshot(OLD_REF);
  assert.equal(parsed.commit_sha, OLD_SHA);
  assert.equal(parseExactRepoSnapshot("repo:nothinginfinity/cairnstone-v6@main/src/context-retention.js"), null);
});

test("executeRehydrate repo@sha calls fetch once with that sha not main", async () => {
  const calls = [];
  const result = await executeRehydrate(OLD_REF, {
    fetchGitHubFile: async (spec) => {
      calls.push(spec);
      return { content: "OLD_SNAPSHOT", sha256: "dff09799", bytes: 10058 };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.commit_sha, OLD_SHA);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, OLD_SHA);
  assert.notEqual(calls[0].ref, "main");
});

test("executeRehydrate @main refuses and does not fetch", async () => {
  let calls = 0;
  const result = await executeRehydrate("repo:nothinginfinity/cairnstone-v6@main/src/context-retention.js", {
    fetchGitHubFile: async () => { calls += 1; return { content: "NO" }; }
  });
  assert.equal(result.error, "mutable_head_ref_refused");
  assert.equal(calls, 0);
});

test("executeRehydrate repo without sha refuses and does not fetch", async () => {
  let calls = 0;
  const result = await executeRehydrate("repo:nothinginfinity/cairnstone-v6/src/context-retention.js", {
    fetchGitHubFile: async () => { calls += 1; return {}; }
  });
  assert.equal(result.error, "mutable_head_ref_refused");
  assert.equal(calls, 0);
});

test("PIN is not planned for rehydration; KEEP_REF is", () => {
  const planned = planRehydration([
    { class: "secret", flags: { secret: true } },
    { class: "repo_read", repo_ref: OLD_REF, flags: { rehydratable: true } }
  ]);
  assert.equal(planned[0].action, RETENTION_ACTIONS.PIN);
  assert.equal(planned[0].rehydrate, undefined);
  assert.equal(planned[1].rehydrate.route, "repo_at_sha");
});

test("receipt route stays fail-closed", async () => {
  const result = await executeRehydrate("receipt:abc", {});
  assert.equal(result.reason, "receipt_lookup_not_wired");
});
