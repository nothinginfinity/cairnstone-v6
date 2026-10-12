// Source CI for issue #89: structural security invariants of the Stage C live E2E workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = readFileSync(new URL("../.github/workflows/s1-3-stagec-e2e.yml", import.meta.url), "utf8");
const code = wf.replace(/^[ \t]*#.*$/gm, "");
const [head, stepsText] = code.split(/\n    steps:\n/);
const steps = stepsText.split(/\n      - (?=\S)/).map((s, i) => (i === 0 ? s.replace(/^      - /, "") : s));
const idx = (frag) => steps.findIndex((s) => s.includes(frag));
const nameOf = (s) => (s.match(/^name: (.+)$/m) ?? s.match(/^uses: (.+)$/m) ?? [])[1] ?? "";

test("trigger: manual dispatch only, from main, read-only permissions, protected environment, serialized", () => {
  const on = head.match(/^on:\n([\s\S]*?)\n\npermissions:/m)[1];
  assert.match(on, /^  workflow_dispatch:/m);
  assert.doesNotMatch(on, /push:|pull_request|schedule:|workflow_run|repository_dispatch/);
  assert.match(head, /^permissions:\n  contents: read\n\n/m);
  assert.doesNotMatch(code, /id-token|contents: write|packages: write|actions: write|deployments: write/);
  assert.match(head, /environment: s1-3-staging/);
  assert.match(head, /concurrency:\n      group: s1-3-stagec-e2e\n      cancel-in-progress: false/);
  assert.match(code, /GITHUB_REF_NAME.*= "main"/);
  assert.match(head, /confirm_stage_only == 'RUN_S1_3_STAGEC_E2E_STAGING_ONLY'/);
});

test("source pin: only the reviewed SHA, validated before any checkout", () => {
  assert.match(head, /ALLOWED_SOURCE_SHA: [0-9a-f]{40}\b/);
  assert.match(steps[idx("Validate inputs")], /\$SOURCE_SHA" = "\$ALLOWED_SOURCE_SHA"/);
  assert.ok(idx("Validate inputs") < idx("actions/checkout"));
  for (const c of steps.filter((s) => s.startsWith("uses: actions/checkout@v4"))) assert.match(c, /persist-credentials: false/);
});

test("credentials: only the single live step; never workflow/job level; never on checkout, gate or summary", () => {
  assert.doesNotMatch(head, /secrets\./);
  const withSecrets = steps.filter((s) => /secrets\./.test(s)).map(nameOf);
  assert.deepEqual(withSecrets, ["Live Stage C E2E (staging harness + read-only Cloudflare readback)"]);
  const live = steps[idx("s1-3-stagec.mjs run")];
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "STAGE_C_HARNESS_URL", "STAGE_C_HARNESS_TOKEN"]) assert.match(live, new RegExp(`${k}: \\$\\{\\{ secrets\\.${k} \\}\\}`));
  for (const frag of ["node --test", "actions/checkout", "actions/setup-node", "Pin check", "Write run summary"]) assert.doesNotMatch(steps[idx(frag)], /secrets\.|CLOUDFLARE_|STAGE_C_HARNESS/, frag);
});

test("order: validate -> checkouts -> pin -> credential-less gate -> live run -> summary -> upload", () => {
  const order = ["Validate inputs", "actions/checkout", "Pin check", "node --test trusted/test/s1-3-stagec.test.js", "s1-3-stagec.mjs run", "Write run summary", "actions/upload-artifact"].map(idx);
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(steps[idx("node --test")], /S1_3_SOURCE_DIR: \$\{\{ github\.workspace \}\}\/source/);
  assert.match(steps[idx("node --test")], /S1_3_REQUIRE_SOURCE: "1"/);
});

test("the tooling executed with credentials comes from the trusted checkout, never the deployed source", () => {
  const live = steps[idx("s1-3-stagec.mjs run")];
  assert.match(live, /node trusted\/scripts\/staging\/s1-3-stagec\.mjs/);
  assert.doesNotMatch(live, /source\//);
  assert.match(steps.filter((s) => s.startsWith("uses: actions/checkout@v4"))[0], /ref: \$\{\{ github\.sha \}\}\n\s+path: trusted/);
});

test("no deploy, no secret writes, no package installs, no ad-hoc API calls", () => {
  assert.doesNotMatch(code, /wrangler|npm (ci|install|i )|npx |curl |wget |secret put|secret bulk|--keep-vars/);
  assert.doesNotMatch(code, /\$CLOUDFLARE_API_TOKEN|\$STAGE_C_HARNESS_TOKEN/);
});

test("cleanup is opt-in and gated on the owner phrase + approval id (values flow only via env)", () => {
  assert.match(code, /cleanup_approval:\n[\s\S]*?default: ""/);
  assert.match(code, /cleanup_approval_id:\n[\s\S]*?default: ""/);
  assert.doesNotMatch(code, /run: [^\n]*\$\{\{ github\.event\.inputs\.cleanup/); // never interpolated into a shell command
  assert.match(steps[idx("s1-3-stagec.mjs run")], /STAGE_C_CLEANUP_APPROVAL: \$\{\{ github\.event\.inputs\.cleanup_approval \}\}/);
});

test("evidence is always uploaded, and the summary prints that this is not acceptance", () => {
  assert.match(steps[idx("actions/upload-artifact")], /if: \$\{\{ always\(\) \}\}/);
  assert.match(steps[idx("actions/upload-artifact")], /s1-3-stagec-evidence\.json/);
  assert.match(steps[idx("Write run summary")], /NOT acceptance by itself/);
});
