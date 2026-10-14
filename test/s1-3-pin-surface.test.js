import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePinSurface, readPinSurface, REVIEWED_TOOLING, PIN_WORKFLOWS } from "../scripts/staging/s1-3-pin-surface.mjs";

const BASE = "ce565ef97eb7b5a6847679604e1abb42daaef700";
const wf = (sha) => `env:\n  ALLOWED_SOURCE_SHA: ${sha}\n`;
const good = () => Object.fromEntries(PIN_WORKFLOWS.map((f) => [f, wf(BASE)]));

test("pin surface: reviewed tooling may differ, nothing deployed may", () => {
  assert.equal(evaluatePinSurface({ base: BASE, changed: [], workflowTexts: good() }).ok, true);
  assert.equal(evaluatePinSurface({ base: BASE, changed: [...REVIEWED_TOOLING], workflowTexts: good() }).ok, true);
  for (const f of ["src/index.ts", "wrangler.private-staging.toml", "migrations/0001.sql", "deploy/s1-3-staging/package-lock.json", "package.json", "scripts/staging/s1-3-other.mjs"]) {
    const r = evaluatePinSurface({ base: BASE, changed: [f], workflowTexts: good() });
    assert.equal(r.ok, false, f);
    assert.deepEqual(r.errors, [`pin_surface_changed_unreviewed: ${f}`]);
  }
});

test("pin surface: workflow source pins must equal BASE exactly (weakening or repinning fails)", () => {
  const w = good();
  w[PIN_WORKFLOWS[0]] = wf("d08f8e1" + "0".repeat(33));
  assert.ok(evaluatePinSurface({ base: BASE, changed: [], workflowTexts: w }).errors.some((e) => e.startsWith("pin_workflow_source_sha_differs_from_base")));
  w[PIN_WORKFLOWS[0]] = "env: {}\n";
  assert.ok(evaluatePinSurface({ base: BASE, changed: [], workflowTexts: w }).errors.some((e) => e.startsWith("pin_workflow_source_sha_count_0")));
  w[PIN_WORKFLOWS[0]] = wf(BASE) + wf(BASE);
  assert.ok(evaluatePinSurface({ base: BASE, changed: [], workflowTexts: w }).errors.some((e) => e.startsWith("pin_workflow_source_sha_count_2")));
  assert.ok(evaluatePinSurface({ base: BASE, changed: [], workflowTexts: {} }).errors.some((e) => e.startsWith("pin_workflow_unreadable")));
});

test("pin surface: abbreviated or non-ancestor base and unreadable input fail closed", () => {
  assert.ok(evaluatePinSurface({ base: "ce565ef", changed: [], workflowTexts: good() }).errors.includes("base_not_full_sha"));
  assert.ok(evaluatePinSurface({ base: BASE, changed: [], workflowTexts: good(), baseIsAncestor: false }).errors.includes("base_not_ancestor_of_head"));
  assert.ok(evaluatePinSurface({ base: BASE, changed: undefined, workflowTexts: good() }).errors.includes("changed_unreadable"));
});

test("pin surface: real git repo, diff of the surface between BASE and head", () => {
  const d = mkdtempSync(join(tmpdir(), "pinsurface-"));
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8" }).trim();
  g("init", "-q");
  for (const p of ["src", "scripts/staging", ".github/workflows"]) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(join(d, "src/a.ts"), "a");
  writeFileSync(join(d, "scripts/staging/s1-3-activation-lib.mjs"), "1");
  g("add", "-A"); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  for (const f of PIN_WORKFLOWS) writeFileSync(join(d, f), wf(base));
  writeFileSync(join(d, "scripts/staging/s1-3-activation-lib.mjs"), "2");
  g("add", "-A"); g("commit", "-qm", "tooling");
  const ok = readPinSurface({ root: d, base });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.reviewedToolingChanged, ["scripts/staging/s1-3-activation-lib.mjs"]);
  writeFileSync(join(d, "src/a.ts"), "changed");
  g("add", "-A"); g("commit", "-qm", "src");
  const bad = readPinSurface({ root: d, base });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unexpected, ["src/a.ts"]);
});

const hasBase = (() => { try { execFileSync("git", ["cat-file", "-e", `${BASE}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; } })();
// CI checkouts are shallow; the activation-plan workflow uses fetch-depth: 0 and runs this guard for real.
test("pin surface CLI on this repository: BASE is the reviewed pin and the verdict is green on the current head", { skip: !hasBase && "reviewed base commit not in this shallow checkout" }, () => {
  const out = execFileSync(process.execPath, ["scripts/staging/s1-3-pin-surface.mjs", "--base", BASE, "--head", "HEAD"], { encoding: "utf8" });
  assert.equal(JSON.parse(out).ok, true);
});
