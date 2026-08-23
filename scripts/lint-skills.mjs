import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { lintSkillCatalog } from "../src/skills.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "skills/manifest.json"), "utf8"));
const bodies = {};
for (const skill of Array.isArray(manifest.skills) ? manifest.skills : []) {
  if (!skill || typeof skill.path !== "string" || !skill.path.trim()) continue;
  try { bodies[skill.path] = await readFile(resolve(root, skill.path), "utf8"); } catch {}
}
const result = lintSkillCatalog({ manifest, bodies, require_bodies: true });
console.log(JSON.stringify({ valid: result.valid, summary: result.summary, issues: result.issues }, null, 2));
if (!result.valid) process.exitCode = 1;
