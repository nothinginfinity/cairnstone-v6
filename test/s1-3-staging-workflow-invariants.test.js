// Source CI for issue #87: structural security invariants of the staging deploy workflow + committed lockfile.
// These fail the build if a later edit re-introduces job-wide credentials, floating installs, or a weaker order.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const wf = read(".github/workflows/s1-3-staging-deploy-v2.yml").toString("utf8");
// Assertions run on code with YAML comments stripped, so prose in comments can never satisfy or trip a check.
const code = wf.replace(/^[ \t]*#.*$/gm, "");
const lockBytes = read("deploy/s1-3-staging/package-lock.json");
const lock = JSON.parse(lockBytes.toString("utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const [head, stepsText] = code.split(/\n    steps:\n/);
const steps = stepsText.split(/\n      - (?=\S)/).map((s, i) => (i === 0 ? s.replace(/^      - /, "") : s));
const nameOf = (s) => (s.match(/^name: (.+)$/m) ?? s.match(/^uses: (.+)$/m) ?? [])[1] ?? "";
const idx = (frag) => steps.findIndex((s) => s.includes(frag));
const env = (key) => (head.match(new RegExp(`^      ${key}: (\\S+)$`, "m")) ?? [])[1];

test("trigger: manual dispatch only, from main, read-only permissions, protected environment", () => {
  const on = head.match(/^on:\n([\s\S]*?)\n\npermissions:/m)[1];
  assert.match(on, /^  workflow_dispatch:/m);
  assert.doesNotMatch(on, /push:|pull_request|schedule:|workflow_run|repository_dispatch/);
  assert.match(head, /^permissions:\n  contents: read\n\n/m);
  assert.doesNotMatch(code, /id-token|contents: write|packages: write|actions: write/);
  assert.match(head, /environment: s1-3-staging/);
  assert.match(code, /GITHUB_REF_NAME.*= "main"/);
});

test("credentials: never workflow- or job-level; only the preflight, deploy and readback steps", () => {
  assert.doesNotMatch(head, /secrets\./, "no secrets before steps (workflow/job env)");
  assert.doesNotMatch(head, /CLOUDFLARE_/);
  const withSecrets = steps.filter((s) => /secrets\./.test(s)).map(nameOf).sort();
  assert.deepEqual(withSecrets, [
    "Deploy isolated private staging Worker ONLY",
    "Live readback (bindings, key presence, no workers.dev/preview/routes/domains)",
    "Preflight live staging (D1 schema, HMAC key presence, bindings, exposure) BEFORE deploy"
  ].sort());
  for (const s of steps.filter((x) => /secrets\./.test(x))) {
    assert.match(s, /\n        env:\n          CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}\n          CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  }
  // Credentials must not reach install, config verification, tests or the dry-run.
  for (const frag of ["npm ci", "verify-config", "node --test", "--dry-run", "actions/checkout", "actions/setup-node"]) {
    assert.doesNotMatch(steps[idx(frag)], /CLOUDFLARE_/, frag);
  }
});

test("checkout: pinned, credential-less; trusted tooling comes from the workflow commit, source from the pinned SHA", () => {
  const checkouts = steps.filter((s) => s.startsWith("uses: actions/checkout@v4"));
  assert.equal(checkouts.length, 2);
  for (const c of checkouts) assert.match(c, /persist-credentials: false/);
  assert.match(checkouts[0], /ref: \$\{\{ github\.sha \}\}\n\s+path: trusted/);
  assert.match(checkouts[1], /ref: \$\{\{ github\.event\.inputs\.source_sha \}\}\n\s+path: source/);
});

test("source pin: only the reviewed 40-hex SHA, validated before ANY checkout", () => {
  assert.match(env("ALLOWED_SOURCE_SHA"), /^[0-9a-f]{40}$/);
  const validate = steps[idx("Validate inputs")];
  assert.match(validate, /\$SOURCE_SHA" = "\$ALLOWED_SOURCE_SHA"/);
  assert.ok(idx("Validate inputs") < idx("actions/checkout"));
});

test("dependencies: lockfile install only; hash pins match the committed lockfile", () => {
  assert.match(code, /npm ci --ignore-scripts/);
  assert.doesNotMatch(code, /npm install|npm i |npx wrangler/); // only `npx --no-install wrangler` (local, lockfile-pinned binary)
  assert.match(code, /npx --no-install wrangler deploy/);
  assert.equal(env("LOCKFILE_SHA256"), sha256(lockBytes), "LOCKFILE_SHA256 must equal the committed lockfile");
  assert.match(env("PACKAGE_JSON_SHA256"), /^[0-9a-f]{64}$/);
  assert.ok(idx("Pin source, lockfile") < idx("npm ci"));
  assert.match(code, /source tree unexpectedly carries its own lockfile/);
});

test("lockfile: v3, fully resolved from the npm registry with integrity hashes, expected roots only", () => {
  assert.equal(lock.lockfileVersion, 3);
  const root = lock.packages[""];
  assert.deepEqual(root.dependencies, { "@babel/parser": "^8.0.0" });
  assert.deepEqual(root.devDependencies, { wrangler: "^4.20.0" });
  let n = 0;
  for (const [path, p] of Object.entries(lock.packages)) {
    if (path === "") continue;
    n++;
    assert.match(p.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(p.integrity ?? "", /^sha512-/, path);
    assert.ok(!p.link, path);
  }
  assert.ok(n > 50);
});

test("order: config verify -> install -> gates -> preflight -> dry-run -> deploy -> readback", () => {
  const order = ["verify-config", "npm ci", "node --test", "s1-3-preflight.mjs preflight", "--dry-run", "wrangler deploy --config", "s1-3-preflight.mjs readback"].map(idx);
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "steps out of order");
});

test("deploy step: tagged, never keep-vars, never touches secrets, no ad-hoc API calls with the token", () => {
  const deploy = steps[idx("wrangler deploy --config")];
  assert.match(deploy, /--tag "s1-3-\$\{SOURCE_SHA:0:12\}"/);
  assert.doesNotMatch(code, /--keep-vars/);
  assert.doesNotMatch(code, /wrangler secret|secret put|secret bulk/);
  assert.doesNotMatch(code, /curl[^\n]*(Authorization|Bearer)/);
  assert.doesNotMatch(code, /\$CLOUDFLARE_API_TOKEN/); // token only flows through the process env of the three steps
});

test("receipts: uploaded without secrets", () => {
  assert.match(code, /actions\/upload-artifact@v4/);
  assert.match(code, /s1-3-preflight-receipt\.json/);
  assert.match(code, /s1-3-readback-receipt\.json/);
});
