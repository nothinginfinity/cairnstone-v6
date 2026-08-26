import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBootstrapFromBody } from "../src/agent-bootstrap.js";

const INSTRUCTIONS_PATH = "docs/AI_OPERATING_GUIDE.md";
const VALID_COMMIT_A = "55ec7b749fc8c21431d67c268646b43f60337612";

function makeEnv() {
  return {
    CAIRNSTONE_DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
          async first() { return null; }
        };
      }
    },
    CAIRNSTONE_RAW: { async get() { return null; } },
    GITHUB_TOKEN: "test-token"
  };
}

function resumeStateWithHead(hash, extraPathHeads = []) {
  return {
    ok: true,
    canonical_head: { hash, path: null, repo: null, commit_sha: null },
    path_heads: [
      { path: INSTRUCTIONS_PATH, stone_hash: "instructions-stone", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A },
      ...extraPathHeads
    ]
  };
}

function makeMemoryEnv({ rows, refs, raw }) {
  const env = makeEnv();
  env.CAIRNSTONE_DB = {
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async all() {
          if (sql.includes("FROM refs_fts WHERE")) return { results: rows };
          return { results: [] };
        },
        async first() {
          if (sql.includes("SELECT * FROM refs WHERE ref_id = ?")) return refs[bound[0]] || null;
          return null;
        }
      };
    }
  };
  env.CAIRNSTONE_RAW = {
    async get(key) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) return null;
      return { async text() { return raw[key]; } };
    }
  };
  return env;
}

function makeDeps(overrides = {}) {
  return {
    resumeChainFromBody: async () => resumeStateWithHead("chain-head-stable"),
    getInboxFromBody: async () => ({ ok: true, messages: [] }),
    resolveSkillsFromBody: async () => ({ ok: true, recommendations: [] }),
    getSkillBundleFromBody: async () => ({ ok: true, manifest_head: "skills-head-stable", bundle_identity: { algorithm: "sha256", sha256: "bundle" }, skills: [] }),
    listSkillsFromBody: async () => ({ ok: true, manifest: { stone_hash: "skills-head-stable" }, boot: [] }),
    version: "test",
    ...overrides
  };
}

function mockGithubFetchOnce() {
  const original = globalThis.fetch;
  const longGuide = "# Operating Guide\n" + "x".repeat(2000) + "\n";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      encoding: "base64",
      content: Buffer.from(longGuide).toString("base64"),
      sha: "4448e428eba37d0e687e7ca402b6c473757ad1da"
    })
  });
  return () => { globalThis.fetch = original; };
}

test("V7.0 Test G: chain-HEAD change between snapshot and re-check fails closed with context_compile_race", async () => {
  const restore = mockGithubFetchOnce();
  try {
    let call = 0;
    const deps = makeDeps({
      resumeChainFromBody: async () => {
        call += 1;
        // First call = initial snapshot. Second call = pre-hash re-check.
        // A concurrent writer moves chain_head between them.
        return call === 1 ? resumeStateWithHead("chain-head-BEFORE") : resumeStateWithHead("chain-head-AFTER");
      }
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:race", task: "race test", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "context_compile_race");
  } finally {
    restore();
  }
});

test("V7.0 Test G: skills manifest HEAD change between snapshot and re-check fails closed with context_compile_race", async () => {
  const restore = mockGithubFetchOnce();
  try {
    let call = 0;
    const deps = makeDeps({
      listSkillsFromBody: async () => {
        call += 1;
        return call === 1
          ? { ok: true, manifest: { stone_hash: "skills-head-BEFORE" }, boot: [] }
          : { ok: true, manifest: { stone_hash: "skills-head-AFTER" }, boot: [] };
      }
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:race", task: "skills race test", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "context_compile_race");
  } finally {
    restore();
  }
});

test("V7.0 Test G (negative control): stable authority across the whole compile succeeds with no race", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const result = await agentBootstrapFromBody(
      { actor_id: "test:stable", task: "stable state test", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      makeDeps()
    );

    assert.equal(result.ok, true);
    assert.equal(result.schema, "cairnstone-agent-context-v1");
    assert.match(result.package_id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.policy.execution_authority, false);
    assert.equal(result.policy.mutation_authority, false);
    assert.equal(result.policy.context_compiler_called_llm, false);
  } finally {
    restore();
  }
});

test("V7.4.1 internal cross-project bootstrap keeps target authority while sourcing canonical instructions from the profile owner chain", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const targetState = {
      ok: true,
      canonical_head: { hash: "praxiq-head-stable", path: "content.txt", repo: null, commit_sha: null },
      path_heads: [
        { path: "src/index.js", stone_hash: "praxiq-index-stone", repo: "nothinginfinity/PraXiQ-call", commit_sha: "05e6f0e40c95d7f217fa1550bdb098923b300c81" }
      ]
    };
    const instructionsState = resumeStateWithHead("cairnstone-instructions-head");
    const calls = [];
    const deps = makeDeps({
      resumeChainFromBody: async ({ chain }) => {
        calls.push(chain);
        if (chain === "praxiq-call") return targetState;
        if (chain === "cairnstone-v6-project-memory") return instructionsState;
        return { ok: false, error: "chain_not_found" };
      }
    });

    const result = await agentBootstrapFromBody(
      {
        actor_id: "cairnstone:repo-debugger",
        task: "Is praxiq-call currently drifted from GitHub?",
        chain: "praxiq-call",
        instructions_chain: "cairnstone-v6-project-memory"
      },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, true);
    assert.equal(result.request.chain, "praxiq-call");
    assert.equal(result.authority.chain, "praxiq-call");
    assert.equal(result.authority.chain_head.stone_hash, "praxiq-head-stable");
    assert.equal(result.instructions.authority_chain, "cairnstone-v6-project-memory");
    assert.equal(result.instructions.stone_hash, "instructions-stone");
    assert.deepEqual(calls, [
      "praxiq-call",
      "cairnstone-v6-project-memory",
      "praxiq-call",
      "cairnstone-v6-project-memory"
    ]);
    assert.match(result.package_id, /^sha256:[0-9a-f]{64}$/);
  } finally {
    restore();
  }
});

test("V7.4.1 cross-project bootstrap fails closed if the canonical-instructions chain moves during compilation", async () => {
  const restore = mockGithubFetchOnce();
  try {
    let instructionsReads = 0;
    const targetState = {
      ok: true,
      canonical_head: { hash: "praxiq-head-stable", path: "content.txt", repo: null, commit_sha: null },
      path_heads: []
    };
    const deps = makeDeps({
      resumeChainFromBody: async ({ chain }) => {
        if (chain === "praxiq-call") return targetState;
        if (chain === "cairnstone-v6-project-memory") {
          instructionsReads += 1;
          return resumeStateWithHead(instructionsReads === 1 ? "instructions-BEFORE" : "instructions-AFTER");
        }
        return { ok: false, error: "chain_not_found" };
      }
    });

    const result = await agentBootstrapFromBody(
      {
        actor_id: "cairnstone:repo-debugger",
        task: "cross-project race test",
        chain: "praxiq-call",
        instructions_chain: "cairnstone-v6-project-memory"
      },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "context_compile_race");
    assert.equal(result.instructions_chain, "cairnstone-v6-project-memory");
    assert.equal(result.detail, "canonical_instructions_chain_or_path_heads_changed_during_compile");
  } finally {
    restore();
  }
});

test("V7.0 Test B (regression guard): identical input over identical state yields identical package_id", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const body = { actor_id: "test:determinism", task: "determinism check", chain: "cairnstone-v6-project-memory" };
    const first = await agentBootstrapFromBody(body, makeEnv(), makeDeps());
    const second = await agentBootstrapFromBody(body, makeEnv(), makeDeps());
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.package_id, second.package_id);
  } finally {
    restore();
  }
});

test("V7.0 Test D/E (regression guard): commit_sha not resolvable to immutable SHA fails closed", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const deps = makeDeps({
      resumeChainFromBody: async () => ({
        ok: true,
        canonical_head: { hash: "chain-head", path: null, repo: null, commit_sha: null },
        path_heads: [
          { path: INSTRUCTIONS_PATH, stone_hash: "instructions-stone", repo: "nothinginfinity/cairnstone-v6", commit_sha: "main" }
        ]
      })
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:immutable", task: "immutable commit check", chain: "cairnstone-v6-project-memory" },
      makeEnv(),
      deps
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "accepted_instruction_source_not_immutable");
  } finally {
    restore();
  }
});

test("V7.0 Test I (regression guard): impossible byte budget fails closed without omitting instructions", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const result = await agentBootstrapFromBody(
      {
        actor_id: "test:bounds",
        task: "size bounds check",
        chain: "cairnstone-v6-project-memory",
        limits: { max_package_bytes: 1000 }
      },
      makeEnv(),
      makeDeps()
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "package_size_limit_exceeded");
    assert.ok(result.limits.package_bytes > result.limits.effective_max_package_bytes);
    assert.ok(result.limits.instructions_bytes > 0, "instructions must still be measured, never silently omitted");
  } finally {
    restore();
  }
});

test("V7.0 authority-first retrieval: current roadmap question ranks accepted authority first and suppresses superseded same-path history", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const roadmapPath = "docs/ROADMAP_V7.md";
    const chainHead = "chain-head-stable";
    const roadmapHead = "roadmap-current";
    const rows = [
      { ref_id: "hist-roadmap-1", stone_hash: "roadmap-old-1", path: roadmapPath, score: -9 },
      { ref_id: "hist-other", stone_hash: "other-old", path: "project-memory/older-note.md", score: -8 },
      { ref_id: "hist-roadmap-2", stone_hash: "roadmap-old-2", path: roadmapPath, score: -7 },
      { ref_id: "chain-head-ref", stone_hash: chainHead, path: "project-memory/current-start.md", score: -6 },
      { ref_id: "roadmap-head-ref", stone_hash: roadmapHead, path: roadmapPath, score: -5 }
    ];
    const refs = Object.fromEntries(rows.map(row => [row.ref_id, {
      ref_id: row.ref_id,
      raw_key: `raw/${row.ref_id}`,
      line_start: 1,
      line_end: 1
    }]));
    const raw = Object.fromEntries(rows.map(row => [
      `raw/${row.ref_id}`,
      row.ref_id === "roadmap-head-ref" ? "V7.3.3 is next" : row.ref_id
    ]));
    const deps = makeDeps({
      resumeChainFromBody: async () => resumeStateWithHead(chainHead, [
        { path: roadmapPath, stone_hash: roadmapHead, repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A }
      ])
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:authority", task: "what's next in the roadmap", chain: "cairnstone-v6-project-memory" },
      makeMemoryEnv({ rows, refs, raw }),
      deps
    );

    assert.equal(result.ok, true);
    assert.equal(result.memory.retrieval_policy.authority_first, true);
    assert.equal(result.memory.retrieval_policy.current_state_query, true);
    assert.equal(result.memory.retrieval_policy.historical_same_path_suppressed, 2);
    assert.deepEqual(result.memory.items.map(item => item.authority_class), ["CHAIN_HEAD", "PATH_HEAD", "HISTORICAL"]);
    const roadmapItems = result.memory.items.filter(item => item.path === roadmapPath);
    assert.equal(roadmapItems.length, 1);
    assert.equal(roadmapItems[0].stone_hash, roadmapHead);
    assert.equal(roadmapItems[0].authority_class, "PATH_HEAD");
  } finally {
    restore();
  }
});

test("V7.0 authority-first retrieval: explicit historical roadmap question keeps superseded same-path evidence after current authority", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const roadmapPath = "docs/ROADMAP_V7.md";
    const chainHead = "chain-head-stable";
    const roadmapHead = "roadmap-current";
    const rows = [
      { ref_id: "hist-roadmap-1", stone_hash: "roadmap-old-1", path: roadmapPath, score: -9 },
      { ref_id: "hist-roadmap-2", stone_hash: "roadmap-old-2", path: roadmapPath, score: -8 },
      { ref_id: "chain-head-ref", stone_hash: chainHead, path: "project-memory/current-start.md", score: -7 },
      { ref_id: "roadmap-head-ref", stone_hash: roadmapHead, path: roadmapPath, score: -6 }
    ];
    const refs = Object.fromEntries(rows.map(row => [row.ref_id, {
      ref_id: row.ref_id,
      raw_key: `raw/${row.ref_id}`,
      line_start: 1,
      line_end: 1
    }]));
    const raw = Object.fromEntries(rows.map(row => [`raw/${row.ref_id}`, row.ref_id]));
    const deps = makeDeps({
      resumeChainFromBody: async () => resumeStateWithHead(chainHead, [
        { path: roadmapPath, stone_hash: roadmapHead, repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A }
      ])
    });

    const result = await agentBootstrapFromBody(
      { actor_id: "test:history", task: "How did the roadmap change before V7.3.3?", chain: "cairnstone-v6-project-memory" },
      makeMemoryEnv({ rows, refs, raw }),
      deps
    );

    assert.equal(result.ok, true);
    assert.equal(result.memory.retrieval_policy.authority_first, true);
    assert.equal(result.memory.retrieval_policy.current_state_query, false);
    assert.equal(result.memory.retrieval_policy.historical_same_path_suppressed, 0);
    assert.deepEqual(result.memory.items.map(item => item.authority_class), ["CHAIN_HEAD", "PATH_HEAD", "HISTORICAL", "HISTORICAL"]);
    assert.equal(result.memory.items.filter(item => item.path === roadmapPath && item.authority_class === "HISTORICAL").length, 2);
  } finally {
    restore();
  }
});
