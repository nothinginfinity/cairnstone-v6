import assert from "node:assert/strict";

const BASE = process.env.CAIRNSTONE_BASE || "https://cairnstone-v6.jaredtechfit.workers.dev";
const MCP = `${BASE}/mcp`;
const EXPECTED_VERSION = "0.4.5";
const EXPECTED_ACCEPTED_COMMIT = "367dc1fea4df988388c65d35ec2b496c1fbc6032";

async function rpc(name, args = {}) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args }
    })
  });
  assert.equal(response.ok, true, `${name}: HTTP ${response.status}`);
  const envelope = await response.json();
  assert.equal(envelope.error, undefined, `${name}: JSON-RPC error ${JSON.stringify(envelope.error)}`);
  const text = envelope?.result?.content?.[0]?.text;
  assert.equal(typeof text, "string", `${name}: missing text result`);
  const parsed = JSON.parse(text);
  assert.notEqual(parsed.ok, false, `${name}: ${JSON.stringify(parsed)}`);
  return parsed;
}

const healthResponse = await fetch(`${BASE}/health`);
assert.equal(healthResponse.ok, true, `health HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
assert.equal(health.ok, true);
assert.equal(health.version, EXPECTED_VERSION);
for (const tool of ["cairnstone_list_skills", "cairnstone_get_skill", "cairnstone_resolve_skills"]) {
  assert.ok(health.mcp_tools.includes(tool), `health missing ${tool}`);
}

const list = await rpc("cairnstone_list_skills");
assert.equal(list.chain, "cairnstone-v6-skills");
assert.equal(list.total, 5);
assert.deepEqual(list.boot, ["core.orient"]);
assert.equal(list.manifest.commit_sha, EXPECTED_ACCEPTED_COMMIT);
assert.deepEqual(list.skills.map(skill => skill.id).sort(), [
  "core.choose-tools",
  "core.orient",
  "core.verify-live-state",
  "github.actions-job-logs",
  "github.actions-triage"
]);

const orient = await rpc("cairnstone_get_skill", { skill_id: "core.orient" });
assert.equal(orient.skill.id, "core.orient");
assert.equal(orient.provenance.commit_sha, EXPECTED_ACCEPTED_COMMIT);
assert.match(orient.content, /# Skill: Canonical orientation/);
assert.match(orient.content, /cairnstone_resolve_skills/);

const resolved = await rpc("cairnstone_resolve_skills", {
  task: "The deploy failed. Check the GitHub Actions workflow and raw logs.",
  loaded_skills: ["core.orient"],
  available_tools: [
    "AFO GitHub API MCP.list_workflow_runs",
    "AFO GitHub API MCP.list_workflow_run_jobs"
  ],
  max_skills: 3
});
assert.deepEqual(resolved.boot, []);
assert.equal(resolved.policy.accepted_state_only, true);
assert.equal(resolved.policy.mutable_branch_is_authority, false);
const recommended = new Set(resolved.recommendations.map(item => item.skill_id));
assert.ok(recommended.has("github.actions-triage"), "resolver did not recommend github.actions-triage");
assert.ok(recommended.has("github.actions-job-logs"), "resolver did not recommend github.actions-job-logs");

console.log(JSON.stringify({
  ok: true,
  version: health.version,
  accepted_commit: list.manifest.commit_sha,
  skills: list.skills.map(skill => skill.id),
  recommended: resolved.recommendations.map(item => ({ skill_id: item.skill_id, score: item.score }))
}, null, 2));
