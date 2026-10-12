#!/usr/bin/env node
// S1-3 staging deploy preflight CLI (issue #87). Usage:
//   node s1-3-preflight.mjs verify-config <path-to-wrangler.private-staging.toml>     (no credentials)
//   node s1-3-preflight.mjs preflight [--receipt <file>]                              (needs CLOUDFLARE_* env)
//   node s1-3-preflight.mjs readback  [--receipt <file>]                              (needs CLOUDFLARE_* env)
// Exits non-zero on ANY failed or unverifiable check. Never prints the token or secret values.
import { readFileSync, writeFileSync } from "node:fs";
import { verifyConfig, createCloudflareClient, runPreflight, runReadback, CloudflareApiError } from "./s1-3-preflight-lib.mjs";

const [mode, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1); };

function receipt(phase, result) {
  return {
    schema: "cairnstone-s1-3-staging-deploy-receipt-v1",
    phase,
    ok: result.ok,
    source_sha: process.env.SOURCE_SHA ?? null,
    lockfile_sha256: process.env.LOCKFILE_SHA256 ?? null,
    github_run_id: process.env.GITHUB_RUN_ID ?? null,
    github_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    generated_at: new Date().toISOString(),
    checks: result.checks
  };
}

function summarize(r) {
  for (const c of r.checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` -> ${c.errors.join("; ")}`}`);
}

if (mode === "verify-config") {
  const path = rest[0];
  if (!path) fail("usage: verify-config <path>");
  const errors = verifyConfig(readFileSync(path, "utf8"));
  if (errors.length) { for (const e of errors) console.error(`FAIL config -> ${e}`); fail("staging wrangler config differs from the reviewed identity"); }
  console.log("PASS config matches reviewed staging identity exactly");
} else if (mode === "preflight" || mode === "readback") {
  let result;
  try {
    const client = createCloudflareClient({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
    result = await (mode === "preflight" ? runPreflight(client) : runReadback(client));
  } catch (e) {
    const code = e instanceof CloudflareApiError ? e.code : "preflight_internal_error";
    result = { ok: false, checks: [{ name: "cloudflare_api", ok: false, errors: [code] }] };
  }
  summarize(result);
  const r = receipt(mode, result);
  const out = flag("--receipt");
  if (out) writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
  if (!result.ok) fail(`${mode} failed closed; nothing was deployed by this step`);
  console.log(`PASS ${mode}`);
} else {
  fail("unknown mode; use verify-config | preflight | readback");
}
