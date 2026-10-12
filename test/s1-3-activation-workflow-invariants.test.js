// Source CI for issue #97: structural security invariants of the three staging activation workflows.
// Comments are stripped before assertions so prose can never satisfy or trip a check.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const NAMES = ["s1-3-staging-auth-d1", "s1-3-staging-harness-deploy", "s1-3-staging-activation-plan"];
const wfs = Object.fromEntries(NAMES.map((n) => [n, read(`.github/workflows/${n}.yml`).toString("utf8").replace(/^[ \t]*#.*$/gm, "")]));
const split = (code) => {
  const [head, stepsText] = code.split(/\n    steps:\n/);
  const steps = stepsText.split(/\n      - (?=\S)/).map((s, i) => (i === 0 ? s.replace(/^      - /, "") : s));
  return { head, steps };
};
const nameOf = (s) => (s.match(/^name: (.+)$/m) ?? s.match(/^uses: (.+)$/m) ?? [])[1] ?? "";

for (const [n, code] of Object.entries(wfs)) {
  const { head, steps } = split(code);
  test(`${n}: manual dispatch only, main-only, read-only permissions, protected environment, serialized`, () => {
    const on = head.match(/^on:\n([\s\S]*?)\n\npermissions:/m)[1];
    assert.match(on, /^  workflow_dispatch:/m);
    assert.doesNotMatch(on, /push:|pull_request|schedule:|workflow_run|repository_dispatch/);
    assert.match(head, /^permissions:\n  contents: read\n\n/m);
    assert.doesNotMatch(code, /id-token|contents: write|packages: write|actions: write/);
    assert.match(head, /environment: s1-3-staging/);
    assert.match(head, /group: s1-3-staging-activation\n\s+cancel-in-progress: false/);
    assert.match(code, /GITHUB_REF_NAME.*= "main"/);
    assert.match(code, /test "\$SOURCE_SHA" = "\$GITHUB_SHA"/);
    assert.match(head, /if: \$\{\{ github\.event\.inputs\.confirm_stage_only == '[A-Z0-9_]+' \}\}/);
  });

  test(`${n}: credentials are step-scoped, never job-level, never in checkout/install/test/dry-run`, () => {
    assert.doesNotMatch(head, /secrets\./);
    assert.doesNotMatch(head, /CLOUDFLARE_/);
    for (const s of steps.filter((x) => /secrets\./.test(x))) {
      assert.match(s, /\n        env:\n          CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}\n          CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
      assert.doesNotMatch(s, /secrets\.(?!CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)/);
    }
    for (const frag of ["npm ci", "verify-config", "verify-harness-config", "verify-auth-migration", "node --test", "--dry-run", "actions/checkout", "actions/setup-node"]) {
      for (const s of steps.filter((x) => x.includes(frag))) assert.doesNotMatch(s, /CLOUDFLARE_/, frag);
    }
  });

  test(`${n}: credential-less checkout of the workflow commit; no production/route/secret-write/old-D1-delete surface`, () => {
    const co = steps.find((s) => s.includes("actions/checkout"));
    assert.match(co, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(co, /persist-credentials: false/);
    assert.doesNotMatch(code, /wrangler (secret|delete|rollback|routes)|d1 delete|d1 execute|--route|--routes|workers_dev\s*=\s*true|DELETE\b/i);
    assert.doesNotMatch(code, /7c4ae99e-4ab0-44c3-afa3-3f1a2d64d319/);
    assert.doesNotMatch(code, /pull_request_target|\$\{\{ github\.event\.(issue|pull_request|head_commit|comment)/);
  });
}

test("auth D1 workflow: creates only via the guarded CLI, migrates with the pinned migration, verifies before and after", () => {
  const { steps } = split(wfs["s1-3-staging-auth-d1"]);
  const names = steps.map(nameOf);
  const at = (frag) => steps.findIndex((s) => s.includes(frag));
  assert.ok(at("verify-auth-migration") >= 0 && at("create-auth-d1") > at("verify-auth-migration"));
  assert.ok(at("migrations apply") > at("create-auth-d1"));
  assert.ok(steps.findLastIndex((s) => s.includes("verify-auth-d1")) > at("migrations apply"));
  assert.match(wfs["s1-3-staging-auth-d1"], /CREATE_ISOLATED_S1_3_STAGING_AUTH_D1/);
  assert.doesNotMatch(wfs["s1-3-staging-auth-d1"], /d1 create/, "creation goes only through the CLI that refuses existing databases");
  assert.ok(names.length > 5);
});

test("harness workflow: dormant by default, enable needs owner phrase, enabled only via deploy-time --var", () => {
  const code = wfs["s1-3-staging-harness-deploy"];
  assert.match(code, /default: dormant/);
  assert.match(code, /ENABLE_S1_3_STAGEC_HARNESS_FOR_OWNER_RUN/);
  assert.match(code, /DEPLOY_ISOLATED_S1_3_STAGE_HARNESS/);
  assert.equal((code.match(/--var STAGE_C_HARNESS_ENABLED:true/g) ?? []).length, 2, "dry-run + deploy for enable only");
  assert.doesNotMatch(code, /--var STAGE_C_HARNESS_TOKEN|--var [A-Z_]*(KEY|SECRET|TOKEN)/);
  const { steps } = split(code);
  const at = (frag) => steps.findIndex((s) => s.includes(frag));
  assert.ok(at("verify-harness-config") < at("npm ci") && at("npm ci") < at("harness-preflight") && at("harness-preflight") < at("Deploy isolated") && at("Deploy isolated") < at("harness-readback"));
  assert.match(code, /npm ci --ignore-scripts/);
  assert.doesNotMatch(code, /npm install/);
});

test("harness workflow: manifest and lockfile hashes match the committed files", () => {
  const code = wfs["s1-3-staging-harness-deploy"];
  assert.equal(code.match(/PACKAGE_JSON_SHA256: (\S+)/)[1], sha256(read("package.json")));
  assert.equal(code.match(/LOCKFILE_SHA256: (\S+)/)[1], sha256(read("deploy/s1-3-staging/package-lock.json")));
});

test("plan workflow: read-only, no wrangler, no deploy", () => {
  const code = wfs["s1-3-staging-activation-plan"];
  assert.doesNotMatch(code, /wrangler|npm ci|deploy /i);
  assert.match(code, /RUN_S1_3_STAGING_ACTIVATION_PLAN_READ_ONLY/);
});

test("existing deploy workflows are pinned to a main-lineage SHA and no activation workflow auto-triggers", () => {
  for (const f of ["s1-3-staging-deploy-v2", "s1-3stagec-e2e".replace("s1-3stagec", "s1-3-stagec")]) {
    const t = read(`.github/workflows/${f}.yml`).toString("utf8");
    assert.match(t, /ALLOWED_SOURCE_SHA: [0-9a-f]{40}/);
  }
  for (const f of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((x) => NAMES.some((n) => x.startsWith(n)))) {
    assert.doesNotMatch(read(`.github/workflows/${f}`).toString("utf8").replace(/^[ \t]*#.*$/gm, ""), /^  (push|pull_request|schedule):/m);
  }
});
