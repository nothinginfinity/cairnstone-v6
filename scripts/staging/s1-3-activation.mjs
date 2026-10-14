#!/usr/bin/env node
// S1-3 staging activation CLI (issue #97). STAGING ONLY. Runs ONLY from the manual, protected-environment workflows.
//   verify-harness-config <wrangler.stagec-harness.toml> [--mode dormant|enable]     (no credentials)
//   verify-auth-migration <migrations/staging-auth/0001_staging_auth.sql>             (no credentials)
//   write-auth-d1-config --db-id <id> --migrations-dir <abs dir> --out <file>         (no credentials; temp wrangler config, never deployed)
//   create-auth-d1 --out <file>                                                        (CLOUDFLARE_*; creates ONLY the pinned auth D1, refuses if it exists)
//   verify-auth-d1 --db-id <id> [--name-only] [--require-empty] [--receipt <file>]                   (CLOUDFLARE_*; read-only)
//   harness-preflight|harness-readback --mode dormant|enable --harness-toml <file> [--receipt <file>]   (CLOUDFLARE_*; read-only)
//   harness-rollback-plan --harness-toml <file> [--receipt <file>]                    (CLOUDFLARE_*; read-only; exits non-zero until dormant AND detached)
//   plan --root <repo dir> [--receipt <file>] [--markdown <file>]                      (CLOUDFLARE_*; read-only go/no-go board)
// Exits non-zero on ANY failed or unverifiable check (plan exits 0 unless the API itself is unusable). Never prints token/secret values.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudflareApiError } from "./s1-3-preflight-lib.mjs";
import {
  ACTIVATION, verifyHarnessConfig, verifyAuthMigrationSha, verifyNewAuthD1Id, createActivationClient,
  checkAuthD1, checkAuthD1Identity, runHarnessChecks, runHarnessRollbackPlan, runActivationPlan, planMarkdown
} from "./s1-3-activation-lib.mjs";

const [mode, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const has = (name) => rest.includes(name);
const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1); };
const client = () => createActivationClient({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
const summarize = (r) => { for (const c of r.checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` -> ${c.errors.join("; ")}`}`); for (const n of r.notes ?? []) console.log(`NOTE ${n}`); };
const receipt = (phase, result, extra = {}) => ({
  schema: "cairnstone-s1-3-staging-activation-receipt-v1", phase, ok: result.ok, ...(result.notes ? { notes: result.notes } : {}),
  source_sha: process.env.SOURCE_SHA ?? null, github_run_id: process.env.GITHUB_RUN_ID ?? null,
  github_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, generated_at: new Date().toISOString(), ...extra, checks: result.checks
});
const write = (path, obj) => { if (path) writeFileSync(path, typeof obj === "string" ? obj : `${JSON.stringify(obj, null, 2)}\n`); };
const setOutput = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const needMode = () => { const m = flag("--mode"); if (m !== "dormant" && m !== "enable") fail("--mode must be dormant or enable"); return m; };

try {
  if (mode === "verify-harness-config") {
    const path = rest[0];
    if (!path || path.startsWith("--")) fail("usage: verify-harness-config <path> [--mode dormant|enable]");
    const m = flag("--mode") ?? "dormant";
    if (m !== "dormant" && m !== "enable") fail("--mode must be dormant or enable");
    const errors = verifyHarnessConfig(readFileSync(path, "utf8"), { mode: m });
    if (errors.length) { for (const e of errors) console.error(`FAIL config -> ${e}`); fail("harness wrangler config is not the reviewed, fully pinned identity"); }
    console.log(`PASS harness config exact (mode=${m}, auth D1 pinned)`);
  } else if (mode === "verify-auth-migration") {
    const path = rest[0];
    if (!path) fail("usage: verify-auth-migration <path>");
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    const errors = verifyAuthMigrationSha(sha);
    if (errors.length) { for (const e of errors) console.error(`FAIL migration -> ${e}`); fail("auth migration differs from the reviewed bytes"); }
    console.log(`PASS auth migration sha256 ${sha}`);
  } else if (mode === "write-auth-d1-config") {
    const id = flag("--db-id"), dir = flag("--migrations-dir"), out = flag("--out");
    if (!id || !dir || !out) fail("usage: write-auth-d1-config --db-id <id> --migrations-dir <abs dir> --out <file>");
    const errors = verifyNewAuthD1Id(id);
    if (errors.length) fail(errors.join("; "));
    if (!/^\/[A-Za-z0-9_\-./]+$/.test(dir)) fail("migrations dir must be a plain absolute path");
    write(out, [
      'name = "s1-3-staging-auth-d1-tool-never-deployed"',
      'compatibility_date = "2026-06-21"',
      "[[d1_databases]]",
      `binding = "${ACTIVATION.auth.binding}"`,
      `database_name = "${ACTIVATION.auth.dbName}"`,
      `database_id = "${id}"`,
      `migrations_dir = "${dir}"`, ""
    ].join("\n"));
    console.log("wrote temporary auth D1 migration config");
  } else if (mode === "create-auth-d1") {
    const c = client();
    const existing = await c.get(`/accounts/${c.accountId}/d1/database?name=${encodeURIComponent(ACTIVATION.auth.dbName)}`);
    if ((existing.result ?? []).some((d) => d?.name === ACTIVATION.auth.dbName)) fail(`database ${ACTIVATION.auth.dbName} already exists; refusing (verify it instead)`);
    const created = await c.createAuthD1();
    write(flag("--out"), { id: created.id, name: created.name });
    setOutput("db_id", created.id);
    console.log(`created ${created.name}`); // the id is printed by the verified summary step, never mixed with secrets
  } else if (mode === "verify-auth-d1") {
    const id = flag("--db-id");
    if (!id) fail("usage: verify-auth-d1 --db-id <id>");
    const check = has("--name-only") ? await checkAuthD1Identity(client(), id) : await checkAuthD1(client(), id, { requireEmpty: has("--require-empty") });
    const result = { ok: check.ok, checks: [check] };
    summarize(result);
    write(flag("--receipt"), receipt("auth_d1_verify", result, { auth_d1_id: id }));
    if (!result.ok) fail("auth D1 verification failed closed");
    console.log("PASS auth D1 verified");
  } else if (mode === "harness-preflight" || mode === "harness-readback") {
    const m = needMode();
    const tomlPath = flag("--harness-toml");
    if (!tomlPath) fail("--harness-toml is required");
    const result = await runHarnessChecks(client(), { mode: m, phase: mode === "harness-preflight" ? "preflight" : "readback", harnessToml: readFileSync(tomlPath, "utf8") });
    summarize(result);
    write(flag("--receipt"), receipt(mode, result, { harness_mode: m }));
    if (!result.ok) fail(`${mode} failed closed; nothing was deployed by this step`);
    console.log(`PASS ${mode} (${m})`);
  } else if (mode === "harness-rollback-plan") {
    const tomlPath = flag("--harness-toml");
    if (!tomlPath) fail("--harness-toml is required");
    const plan = await runHarnessRollbackPlan(client(), { harnessToml: readFileSync(tomlPath, "utf8") });
    console.log(`ROLLBACK_VERDICT ${plan.verdict}`);
    for (const step of plan.steps) console.log(`  ${step}`);
    write(flag("--receipt"), { schema: "cairnstone-s1-3-harness-rollback-plan-v1", source_sha: process.env.SOURCE_SHA ?? null, generated_at: new Date().toISOString(), ...plan });
    if (!plan.ok) fail("harness is not yet dormant and detached; follow the listed steps in order");
    console.log("PASS harness dormant and detached");
  } else if (mode === "plan") {
    const root = flag("--root") ?? ".";
    const files = {
      privateToml: readFileSync(join(root, "wrangler.private-staging.toml"), "utf8"),
      harnessToml: readFileSync(join(root, "wrangler.stagec-harness.toml"), "utf8")
    };
    const plan = await runActivationPlan(client(), { files });
    for (const i of plan.items) console.log(`${i.status.padEnd(12)} ${i.id}: ${i.detail}`);
    console.log(`READY ${JSON.stringify(plan.ready)}`);
    write(flag("--receipt"), { schema: "cairnstone-s1-3-staging-activation-plan-v1", source_sha: process.env.SOURCE_SHA ?? null, github_run_id: process.env.GITHUB_RUN_ID ?? null, generated_at: new Date().toISOString(), ...plan });
    write(flag("--markdown"), planMarkdown(plan));
    console.log(plan.ok ? "PLAN: no blocking defects (owner actions may remain)" : "PLAN: NO-GO items present");
  } else {
    fail("unknown mode; see header of s1-3-activation.mjs");
  }
} catch (e) {
  const code = e instanceof CloudflareApiError ? e.code : "activation_internal_error";
  fail(`${mode} failed closed: ${code}`);
}
