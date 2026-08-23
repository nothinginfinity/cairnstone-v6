import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSkillFromBody,
  lintSkillCatalog,
  listSkillsFromBody,
  resolveSkillsFromBody
} from "../src/skills.js";

const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_MANIFEST = "m".repeat(64);
const HASH_SKILL = "s".repeat(64);

const manifest = {
  version: 1,
  boot: ["core.orient"],
  skills: [
    {
      id: "core.orient",
      title: "Orient",
      version: "1.0.0",
      path: "skills/core/orient/SKILL.md",
      tags: ["orientation", "resume"],
      triggers: ["catch me up"],
      enabled: true
    },
    {
      id: "github.actions-triage",
      title: "GitHub Actions triage",
      version: "1.0.0",
      path: "skills/github/actions-triage/SKILL.md",
      tags: ["github", "actions", "workflow", "deploy", "failure"],
      triggers: ["workflow failed", "deploy failed"],
      requires_tools: ["github.actions.list_runs"],
      dependencies: ["core.verify-live-state"],
      enabled: true
    }
  ]
};

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function makeEnv() {
  const rows = new Map([
    ["skills/manifest.json", { stone_hash: HASH_MANIFEST, accepted_at: "now", repo: "nothinginfinity/cairnstone-v6", path: "skills/manifest.json", commit_sha: COMMIT, title: "manifest" }],
    ["skills/core/orient/SKILL.md", { stone_hash: HASH_SKILL, accepted_at: "now", repo: "nothinginfinity/cairnstone-v6", path: "skills/core/orient/SKILL.md", commit_sha: COMMIT, title: "orient" }],
    ["skills/github/actions-triage/SKILL.md", { stone_hash: HASH_SKILL, accepted_at: "now", repo: "nothinginfinity/cairnstone-v6", path: "skills/github/actions-triage/SKILL.md", commit_sha: COMMIT, title: "triage" }]
  ]);
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM path_heads/);
      return {
        bind(_chain, path) {
          return { async first() { return rows.get(path) || null; } };
        }
      };
    }
  };
  return { CAIRNSTONE_DB: db, GITHUB_TOKEN: "test" };
}

function withFetch(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const decoded = decodeURIComponent(String(url));
    if (decoded.includes("skills/manifest.json")) return new Response(JSON.stringify({ encoding: "base64", content: encode(JSON.stringify(manifest)) }), { status: 200 });
    if (decoded.includes("actions-triage/SKILL.md")) return new Response(JSON.stringify({ encoding: "base64", content: encode("# GitHub Actions triage\nUse Actions runs first.") }), { status: 200 });
    if (decoded.includes("core/orient/SKILL.md")) return new Response(JSON.stringify({ encoding: "base64", content: encode("# Orient\nResume canonical state first.") }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test("list skills returns compact accepted manifest metadata", () => withFetch(async () => {
  const result = await listSkillsFromBody({}, makeEnv());
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.deepEqual(result.boot, ["core.orient"]);
  assert.equal(result.manifest.commit_sha, COMMIT);
  assert.equal(result.skills[0].content, undefined);
}));

test("get skill uses path HEAD provenance and immutable commit", () => withFetch(async () => {
  const result = await getSkillFromBody({ skill_id: "github.actions-triage" }, makeEnv());
  assert.equal(result.ok, true);
  assert.match(result.content, /Actions runs first/);
  assert.equal(result.provenance.commit_sha, COMMIT);
  assert.equal(result.provenance.path, "skills/github/actions-triage/SKILL.md");
}));

test("resolver returns boot separately and selects only relevant extra skills", () => withFetch(async () => {
  const result = await resolveSkillsFromBody({
    task: "The deploy failed. Check the GitHub Actions workflow.",
    available_tools: ["github.actions.list_runs"],
    max_skills: 3
  }, makeEnv());
  assert.equal(result.ok, true);
  assert.deepEqual(result.boot, ["core.orient"]);
  assert.equal(result.recommendations[0].skill_id, "github.actions-triage");
  assert.ok(result.recommendations[0].score >= 8);
  assert.deepEqual(result.recommendations[0].missing_tools, []);
  assert.equal(result.policy.accepted_state_only, true);
}));

test("already-loaded skills are not recommended again", () => withFetch(async () => {
  const result = await resolveSkillsFromBody({
    task: "workflow failed",
    loaded_skills: ["core.orient", "github.actions-triage"]
  }, makeEnv());
  assert.deepEqual(result.boot, []);
  assert.deepEqual(result.recommendations, []);
}));

test("non-immutable accepted commit fails closed", () => withFetch(async () => {
  const env = makeEnv();
  const originalPrepare = env.CAIRNSTONE_DB.prepare;
  env.CAIRNSTONE_DB.prepare = sql => {
    const prepared = originalPrepare(sql);
    return {
      bind(chain, path) {
        const bound = prepared.bind(chain, path);
        return {
          async first() {
            const row = await bound.first();
            return row ? { ...row, commit_sha: "main" } : row;
          }
        };
      }
    };
  };
  const result = await listSkillsFromBody({}, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "accepted_skill_commit_not_immutable");
}));

function lintCodes(result) {
  return new Set(result.issues.map(issue => issue.code));
}

test("candidate skill catalog lint accepts a valid canonical manifest", () => {
  const candidate = {
    version: 2,
    boot: ["core.orient"],
    tool_registry: ["cairnstone_health", "AFO GitHub API MCP.call"],
    skills: [
      {
        id: "core.orient",
        version: "1.0.0",
        path: "skills/core/orient/SKILL.md",
        triggers: ["orient canonical project"],
        requires_tools: ["cairnstone_health"],
        dependencies: [],
        estimated_tokens: 500
      },
      {
        id: "github.repo-read",
        version: "1.2.3",
        path: "skills/github/repo-read/SKILL.md",
        triggers: ["inspect repository content"],
        requires_tools: ["AFO GitHub API MCP.call"],
        dependencies: ["core.orient"],
        estimated_tokens: 600
      }
    ]
  };
  const bodies = {
    "skills/core/orient/SKILL.md": "# Orient\nUse accepted state first.\n",
    "skills/github/repo-read/SKILL.md": "# Repository read\nUse read-only GitHub evidence.\n"
  };
  const result = lintSkillCatalog({ manifest: candidate, bodies, require_bodies: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.summary, { errors: 0, warnings: 0, issues: 0 });
});

test("skill catalog lint catches structural, dependency, tool, trigger, and semver faults", () => {
  const candidate = {
    boot: ["missing.boot"],
    tool_registry: ["AFO GitHub API MCP.call"],
    skills: [
      {
        id: "core.alpha",
        version: "1",
        path: "skills/wrong/SKILL.md",
        triggers: ["shared trigger"],
        requires_tools: ["not a tool"],
        dependencies: ["core.beta"]
      },
      {
        id: "core.beta",
        version: "1.0.0",
        path: "skills/core/beta/SKILL.md",
        triggers: ["shared trigger"],
        dependencies: ["core.alpha"]
      },
      {
        id: "core.duplicate",
        version: "1.0.0",
        path: "skills/core/duplicate/SKILL.md",
        dependencies: []
      },
      {
        id: "core.duplicate",
        version: "1.0.0",
        path: "skills/core/duplicate/SKILL.md",
        dependencies: ["missing.skill"]
      }
    ]
  };
  const result = lintSkillCatalog({ manifest: candidate, bodies: {}, require_bodies: true });
  const codes = lintCodes(result);
  assert.equal(result.valid, false);
  for (const code of [
    "duplicate_skill_id",
    "duplicate_skill_path",
    "skill_version_invalid_semver",
    "manifest_path_mismatch",
    "missing_dependency",
    "dependency_cycle",
    "trigger_collision",
    "invalid_tool_reference",
    "skill_file_missing",
    "boot_skill_missing"
  ]) assert.ok(codes.has(code), `expected lint code ${code}`);
});

test("accepted-state and size budgets are linted explicitly", () => {
  const candidate = {
    boot: ["core.orient"],
    skills: [{
      id: "core.orient",
      version: "1.0.0",
      path: "skills/core/orient/SKILL.md",
      dependencies: [],
      estimated_tokens: 2501
    }]
  };
  const result = lintSkillCatalog({
    manifest: candidate,
    bodies: { "skills/core/orient/SKILL.md": "x".repeat(100001) },
    accepted_paths: {},
    require_accepted_paths: true,
    max_estimated_tokens: 2000
  });
  const codes = lintCodes(result);
  assert.equal(result.valid, false);
  assert.ok(codes.has("missing_accepted_path"));
  assert.ok(codes.has("skill_too_large"));
  assert.ok(codes.has("estimated_tokens_large"));
});
