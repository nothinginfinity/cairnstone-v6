#!/usr/bin/env node
// S1-3 pin-surface guard (source-only, read-only, zero dependencies, no network, no credentials).
// Replaces the stale runbook check `git diff --stat ce565ef <main> -- ...` with an executable verdict.
// The deployed Worker source stays pinned to the reviewed commit (BASE). Everything that gets bundled/deployed
// (src, wrangler.private-staging.toml, migrations, deploy, package.json) must be byte-identical to BASE; only the
// reviewed trusted-tooling files below may differ (PR #103 access/activation + PR #105 preflight, plus the owner pin PR).
// Usage: node scripts/staging/s1-3-pin-surface.mjs --base <40-hex> [--head <ref, default HEAD>] [--root .]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SURFACE = Object.freeze(["src", "wrangler.private-staging.toml", "migrations", "scripts/staging", "deploy", "package.json", "wrangler.stagec-harness.toml"]);
// Trusted tooling that is allowed to differ from BASE (checked out from main, never deployed as Worker source).
export const REVIEWED_TOOLING = Object.freeze([
  "scripts/staging/s1-3-activation-lib.mjs",
  "scripts/staging/s1-3-activation.mjs",
  "scripts/staging/s1-3-preflight-lib.mjs",
  "scripts/staging/s1-3-stagec-lib.mjs",
  "scripts/staging/s1-3-stagec.mjs",
  "scripts/staging/s1-3-pin-surface.mjs",
  "wrangler.stagec-harness.toml"
]);
export const PIN_WORKFLOWS = Object.freeze([".github/workflows/s1-3-staging-deploy-v2.yml", ".github/workflows/s1-3-stagec-e2e.yml"]);
const SHA40 = /^[0-9a-f]{40}$/;

/** Pure verdict. `changed` = paths differing between BASE and head inside SURFACE; `workflowTexts` = { path: text }. */
export function evaluatePinSurface({ base, changed, workflowTexts = {}, baseIsAncestor = true }) {
  const errors = [];
  if (!SHA40.test(String(base))) errors.push("base_not_full_sha");
  if (baseIsAncestor !== true) errors.push("base_not_ancestor_of_head");
  if (!Array.isArray(changed)) errors.push("changed_unreadable");
  const unexpected = Array.isArray(changed) ? changed.filter((f) => !REVIEWED_TOOLING.includes(f)).sort() : [];
  for (const f of unexpected) errors.push(`pin_surface_changed_unreviewed: ${f}`);
  for (const f of PIN_WORKFLOWS) {
    const t = workflowTexts[f];
    if (typeof t !== "string") { errors.push(`pin_workflow_unreadable: ${f}`); continue; }
    const m = [...t.matchAll(/^\s*ALLOWED_SOURCE_SHA:\s*([0-9a-f]{40})\s*$/gm)];
    if (m.length !== 1) errors.push(`pin_workflow_source_sha_count_${m.length}: ${f}`);
    else if (m[0][1] !== base) errors.push(`pin_workflow_source_sha_differs_from_base: ${f}`);
  }
  return { ok: errors.length === 0, base, reviewedToolingChanged: Array.isArray(changed) ? changed.filter((f) => REVIEWED_TOOLING.includes(f)).sort() : [], unexpected, errors };
}

function git(root, args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

export function readPinSurface({ root = ".", base, head = "HEAD" }) {
  const r = resolve(root);
  if (!SHA40.test(String(base))) return evaluatePinSurface({ base, changed: [], workflowTexts: {} });
  let baseIsAncestor = true;
  try { git(r, ["merge-base", "--is-ancestor", base, head]); } catch { baseIsAncestor = false; }
  const changed = git(r, ["diff", "--name-only", base, head, "--", ...SURFACE]).split("\n").filter(Boolean);
  const workflowTexts = {};
  for (const f of PIN_WORKFLOWS) { try { workflowTexts[f] = readFileSync(resolve(r, f), "utf8"); } catch { /* reported as unreadable */ } }
  return evaluatePinSurface({ base, changed, workflowTexts, baseIsAncestor });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = process.argv.slice(2), opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  let res;
  try { res = readPinSurface({ root: opt("--root", "."), base: opt("--base"), head: opt("--head", "HEAD") }); }
  catch (e) { res = { ok: false, errors: [`pin_surface_unreadable: ${e?.code ?? "git_error"}`] }; }
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
