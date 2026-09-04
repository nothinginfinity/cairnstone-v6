import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentBootstrapFromBody,
  computeAcceptedAuthorityManifest,
  REQUIRED_RUNTIME_RULE_IDS,
  sha256Text,
  validateRuntimeBriefDocument
} from "../src/agent-bootstrap.js";
import { latestAcceptedStateCursor, selectOrientationPathHeads } from "../src/index.js";

const INSTRUCTIONS_PATH = "docs/AI_OPERATING_GUIDE.md";
const RUNTIME_BRIEF_PATH = "docs/AI_RUNTIME_BRIEF.json";
const VALID_COMMIT_A = "55ec7b749fc8c21431d67c268646b43f60337612";
const VALID_COMMIT_B = "66ec7b749fc8c21431d67c268646b43f60337613";
const MOCK_GUIDE_BLOB_SHA = "4448e428eba37d0e687e7ca402b6c473757ad1da";
const MOCK_BRIEF_BLOB_SHA = "5558e428eba37d0e687e7ca402b6c473757ad1db";

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

test("V7.6.5 package-pressure regression: size discipline trims HISTORICAL evidence first and preserves the protected CHAIN_HEAD/PATH_HEAD floor", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const roadmapPath = "docs/ROADMAP_V7.md";
    const chainHead = "chain-head-stable";
    const roadmapHead = "roadmap-current";
    // Six sizable HISTORICAL candidates compete with the small protected
    // floor for the memory byte budget. Removing all six HISTORICAL items
    // is sufficient to fit; the floor must survive untouched.
    const historicalRows = Array.from({ length: 6 }, (_, index) => ({
      ref_id: `hist-${index}`,
      stone_hash: `hist-stone-${index}`,
      path: `project-memory/older-${index}.md`,
      score: -20 + index
    }));
    const rows = [
      ...historicalRows,
      { ref_id: "chain-head-ref", stone_hash: chainHead, path: "project-memory/current-start.md", score: -1 },
      { ref_id: "roadmap-head-ref", stone_hash: roadmapHead, path: roadmapPath, score: 0 }
    ];
    const refs = Object.fromEntries(rows.map(row => [row.ref_id, {
      ref_id: row.ref_id,
      raw_key: `raw/${row.ref_id}`,
      line_start: 1,
      line_end: 1
    }]));
    const raw = Object.fromEntries(rows.map(row => [
      `raw/${row.ref_id}`,
      row.ref_id.startsWith("hist-") ? "H".repeat(1500) : "C".repeat(300)
    ]));
    const deps = makeDeps({
      resumeChainFromBody: async () => resumeStateWithHead(chainHead, [
        { path: roadmapPath, stone_hash: roadmapHead, repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A }
      ])
    });

    const result = await agentBootstrapFromBody(
      {
        actor_id: "test:v765-pressure-historical",
        task: "what's next in the roadmap",
        chain: "cairnstone-v6-project-memory",
        include_inbox: false,
        limits: { max_package_bytes: 6000, max_memory_bytes: 60000, max_memory_hits: 10, max_inbox_items: 0 }
      },
      makeMemoryEnv({ rows, refs, raw }),
      deps
    );

    assert.equal(result.ok, true);
    assert.ok(result.limits.package_bytes <= result.limits.effective_max_package_bytes);
    assert.ok(result.limits.instructions_bytes > 0, "instructions must never be omitted");
    assert.deepEqual(result.memory.items.map(item => item.authority_class), ["CHAIN_HEAD", "PATH_HEAD"]);
    assert.equal(result.memory.items.find(item => item.authority_class === "CHAIN_HEAD").stone_hash, chainHead);
    const pathHeadItem = result.memory.items.find(item => item.authority_class === "PATH_HEAD");
    assert.equal(pathHeadItem.path, roadmapPath);
    assert.equal(pathHeadItem.stone_hash, roadmapHead);
    assert.equal(result.memory.truncated, true, "trimming must be reported, not silent");
  } finally {
    restore();
  }
});

test("V7.6.5 package-pressure regression: size discipline fails closed rather than silently dropping protected CHAIN_HEAD/PATH_HEAD evidence when the floor alone exceeds budget", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const roadmapPath = "docs/ROADMAP_V7.md";
    const chainHead = "chain-head-stable";
    const roadmapHead = "roadmap-current";
    // Only the two protected floor items are present (no HISTORICAL
    // candidates at all -- mirrors the live production failure where a
    // mature vault's structural package plus just the guaranteed evidence
    // already exceeds the package budget). Before V7.6.5, enforceSizeDiscipline
    // popped indiscriminately from the end of memory.items and would return
    // ok:true with PATH_HEAD (and eventually CHAIN_HEAD) silently missing.
    const rows = [
      { ref_id: "chain-head-ref", stone_hash: chainHead, path: "project-memory/current-start.md", score: -1 },
      { ref_id: "roadmap-head-ref", stone_hash: roadmapHead, path: roadmapPath, score: 0 }
    ];
    const refs = Object.fromEntries(rows.map(row => [row.ref_id, {
      ref_id: row.ref_id,
      raw_key: `raw/${row.ref_id}`,
      line_start: 1,
      line_end: 1
    }]));
    const raw = Object.fromEntries(rows.map(row => [`raw/${row.ref_id}`, "X".repeat(2500)]));
    const deps = makeDeps({
      resumeChainFromBody: async () => resumeStateWithHead(chainHead, [
        { path: roadmapPath, stone_hash: roadmapHead, repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A }
      ])
    });

    // cap=8000: structural package + one 2500-byte floor item fits, but
    // structural + both floor items does not. The pre-fix implementation
    // would pop PATH_HEAD to fit and return ok:true with degraded evidence.
    const degraded = await agentBootstrapFromBody(
      {
        actor_id: "test:v765-floor-partial",
        task: "what's next in the roadmap",
        chain: "cairnstone-v6-project-memory",
        include_inbox: false,
        limits: { max_package_bytes: 8000, max_memory_bytes: 60000, max_memory_hits: 10, max_inbox_items: 0 }
      },
      makeMemoryEnv({ rows, refs, raw }),
      deps
    );
    assert.equal(degraded.ok, false, "must fail closed rather than return a package missing guaranteed PATH_HEAD evidence");
    assert.equal(degraded.error, "package_size_limit_exceeded");
    assert.ok(degraded.limits.instructions_bytes > 0, "instructions must still be measured, never silently omitted");

    // cap=6000: even more constrained -- structural + either single floor
    // item alone does not fit either. The pre-fix implementation would pop
    // BOTH items and return ok:true with memory.items completely empty.
    const empty = await agentBootstrapFromBody(
      {
        actor_id: "test:v765-floor-empty",
        task: "what's next in the roadmap",
        chain: "cairnstone-v6-project-memory",
        include_inbox: false,
        limits: { max_package_bytes: 6000, max_memory_bytes: 60000, max_memory_hits: 10, max_inbox_items: 0 }
      },
      makeMemoryEnv({ rows, refs, raw }),
      deps
    );
    assert.equal(empty.ok, false, "must fail closed rather than return a package with fully empty authority evidence");
    assert.equal(empty.error, "package_size_limit_exceeded");

    // Sanity: the same fixture with a generous budget succeeds and both
    // floor items are present, proving the failures above are genuinely
    // pressure-induced and not a fixture/data-shape mistake.
    const roomy = await agentBootstrapFromBody(
      {
        actor_id: "test:v765-floor-roomy",
        task: "what's next in the roadmap",
        chain: "cairnstone-v6-project-memory",
        include_inbox: false,
        limits: { max_package_bytes: 64000, max_memory_bytes: 60000, max_memory_hits: 10, max_inbox_items: 0 }
      },
      makeMemoryEnv({ rows, refs, raw }),
      deps
    );
    assert.equal(roomy.ok, true);
    assert.deepEqual(roomy.memory.items.map(item => item.authority_class), ["CHAIN_HEAD", "PATH_HEAD"]);
  } finally {
    restore();
  }
});

test("V7.6.1 legacy_full remains the default and explicit legacy mode preserves package identity", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const extraPathHeads = [
      { path: "docs/ROADMAP_V7.md", stone_hash: "roadmap-head", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A },
      { path: "src/index.js", stone_hash: "index-head", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A }
    ];
    const deps = makeDeps({ resumeChainFromBody: async () => resumeStateWithHead("chain-head-stable", extraPathHeads) });
    const base = { actor_id: "test:v761-legacy", task: "roadmap status", chain: "cairnstone-v6-project-memory", include_inbox: false };
    const implicit = await agentBootstrapFromBody(base, makeEnv(), deps);
    const explicit = await agentBootstrapFromBody({ ...base, mode: "legacy_full" }, makeEnv(), deps);

    assert.equal(implicit.ok, true);
    assert.equal(explicit.ok, true);
    assert.equal(implicit.package_id, explicit.package_id);
    assert.deepEqual(implicit.authority, explicit.authority);
    assert.equal(Object.prototype.hasOwnProperty.call(implicit.authority, "sparse"), false);
    assert.equal(implicit.authority.path_heads.length, 3);
  } finally {
    restore();
  }
});

test("V7.6.1 optimized_sparse is deterministic, retains relevant accepted heads, and reduces authority transmission", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const extraPathHeads = [
      { path: "docs/ROADMAP_V7.md", stone_hash: "roadmap-head", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A },
      ...Array.from({ length: 40 }, (_, index) => ({
        path: `project-memory/archive/item-${String(index).padStart(2, "0")}.md`,
        stone_hash: `archive-head-${String(index).padStart(2, "0")}`,
        repo: null,
        commit_sha: null
      }))
    ];
    const deps = makeDeps({ resumeChainFromBody: async () => resumeStateWithHead("chain-head-stable", extraPathHeads) });
    const base = {
      actor_id: "test:v761-sparse",
      task: "What is next in the roadmap?",
      chain: "cairnstone-v6-project-memory",
      include_inbox: false,
      limits: { max_memory_hits: 0, max_memory_bytes: 0, max_inbox_items: 0 }
    };
    const legacy = await agentBootstrapFromBody({ ...base, mode: "legacy_full" }, makeEnv(), deps);
    const first = await agentBootstrapFromBody({ ...base, mode: "optimized_sparse" }, makeEnv(), deps);
    const second = await agentBootstrapFromBody({ ...base, mode: "optimized_sparse" }, makeEnv(), deps);

    assert.equal(legacy.ok, true);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.authority.sparse.schema, "cairnstone-sparse-authority-v1");
    assert.equal(first.authority.sparse.mode, "optimized_sparse");
    assert.match(first.authority.sparse.path_heads_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(first.authority.sparse.authority_manifest_id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.authority.sparse.full_path_head_count, 42);
    assert.equal(first.authority.sparse.represented_path_head_count, first.authority.path_heads.length);
    assert.equal(first.authority.sparse.omitted_path_head_count, 42 - first.authority.path_heads.length);
    assert.ok(first.authority.path_heads.length < legacy.authority.path_heads.length);
    assert.ok(first.authority.path_heads.some(item => item.path === INSTRUCTIONS_PATH));
    assert.ok(first.authority.path_heads.some(item => item.path === "docs/ROADMAP_V7.md"));
    assert.equal(first.authority.sparse.expansion.tool, "cairnstone_resume_chain");
    assert.equal(first.authority.sparse.path_heads_digest, second.authority.sparse.path_heads_digest);
    assert.equal(first.authority.sparse.authority_manifest_id, second.authority.sparse.authority_manifest_id);
    assert.equal(first.package_id, second.package_id);
    assert.ok(first.limits.package_bytes < legacy.limits.package_bytes);
    assert.equal(first.instructions.path, legacy.instructions.path);
    assert.equal(first.instructions.stone_hash, legacy.instructions.stone_hash);
    assert.equal(first.instructions.repo, legacy.instructions.repo);
    assert.equal(first.instructions.commit_sha, legacy.instructions.commit_sha);
    assert.deepEqual(first.instructions.content_identity, legacy.instructions.content_identity);
    assert.deepEqual(first.instructions.transmitted_content_identity, legacy.instructions.transmitted_content_identity);
    assert.equal(first.instructions.content, legacy.instructions.content);
    assert.equal(first.instructions.truncated, legacy.instructions.truncated);
    assert.equal(legacy.instructions.selection.representation, "full_guide");
    assert.equal(first.instructions.selection.representation, "full_guide_fallback");
    assert.equal(first.instructions.selection.fallback.code, "runtime_brief_unaccepted");
    assert.deepEqual(first.skills, legacy.skills);
    assert.deepEqual(first.policy, legacy.policy);
    assert.deepEqual(first.authority.chain_head, legacy.authority.chain_head);
  } finally {
    restore();
  }
});

test("V7.6.1 optimized_sparse package identity commits to omitted accepted path heads", async () => {
  const restore = mockGithubFetchOnce();
  try {
    const makeState = omittedStone => resumeStateWithHead("chain-head-stable", [
      { path: "docs/ROADMAP_V7.md", stone_hash: "roadmap-head", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A },
      { path: "unrelated/omitted.txt", stone_hash: omittedStone, repo: null, commit_sha: null }
    ]);
    const body = {
      actor_id: "test:v761-root",
      task: "roadmap",
      chain: "cairnstone-v6-project-memory",
      mode: "optimized_sparse",
      include_inbox: false,
      limits: { max_memory_hits: 0, max_memory_bytes: 0, max_inbox_items: 0 }
    };
    const before = await agentBootstrapFromBody(body, makeEnv(), makeDeps({ resumeChainFromBody: async () => makeState("omitted-BEFORE") }));
    const after = await agentBootstrapFromBody(body, makeEnv(), makeDeps({ resumeChainFromBody: async () => makeState("omitted-AFTER") }));

    assert.equal(before.ok, true);
    assert.equal(after.ok, true);
    assert.equal(before.authority.path_heads.some(item => item.path === "unrelated/omitted.txt"), false);
    assert.equal(after.authority.path_heads.some(item => item.path === "unrelated/omitted.txt"), false);
    assert.deepEqual(before.authority.path_heads, after.authority.path_heads);
    assert.notEqual(before.authority.sparse.path_heads_digest, after.authority.sparse.path_heads_digest);
    assert.notEqual(before.authority.sparse.authority_manifest_id, after.authority.sparse.authority_manifest_id);
    assert.notEqual(before.package_id, after.package_id);
  } finally {
    restore();
  }
});

test("V7.6.1 optimized_sparse race protection includes omitted accepted path heads", async () => {
  const restore = mockGithubFetchOnce();
  try {
    let call = 0;
    const state = omittedStone => resumeStateWithHead("chain-head-stable", [
      { path: "docs/ROADMAP_V7.md", stone_hash: "roadmap-head", repo: "nothinginfinity/cairnstone-v6", commit_sha: VALID_COMMIT_A },
      { path: "unrelated/omitted.txt", stone_hash: omittedStone, repo: null, commit_sha: null }
    ]);
    const deps = makeDeps({
      resumeChainFromBody: async () => {
        call += 1;
        return call === 1 ? state("omitted-BEFORE") : state("omitted-AFTER");
      }
    });
    const result = await agentBootstrapFromBody({
      actor_id: "test:v761-race",
      task: "roadmap",
      chain: "cairnstone-v6-project-memory",
      mode: "optimized_sparse",
      include_inbox: false,
      limits: { max_memory_hits: 0, max_memory_bytes: 0, max_inbox_items: 0 }
    }, makeEnv(), deps);

    assert.equal(result.ok, false);
    assert.equal(result.error, "context_compile_race");
    assert.equal(result.detail, "chain_or_path_heads_changed_during_compile");
  } finally {
    restore();
  }
});

test("V7.6.1 invalid bootstrap mode fails closed", async () => {
  const result = await agentBootstrapFromBody({
    actor_id: "test:v761-invalid",
    task: "invalid mode",
    chain: "cairnstone-v6-project-memory",
    mode: "sparse-ish"
  }, makeEnv(), makeDeps());
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_bootstrap_mode");
});

test("V7.6.3 shared accepted-authority manifest is order-independent and changes when an omitted head changes", async () => {
  const base = {
    chain: "cairnstone-v6-project-memory",
    chain_head: "chain-head-stable",
    path_heads: [
      { path: "z-last.md", stone_hash: "stone-z" },
      { path: "a-first.md", stone_hash: "stone-a" }
    ]
  };
  const first = await computeAcceptedAuthorityManifest(base);
  const reordered = await computeAcceptedAuthorityManifest({ ...base, path_heads: [...base.path_heads].reverse() });
  const changed = await computeAcceptedAuthorityManifest({
    ...base,
    path_heads: [base.path_heads[0], { path: "a-first.md", stone_hash: "stone-a-CHANGED" }]
  });

  assert.equal(first.schema, "cairnstone-sparse-authority-v1");
  assert.equal(first.full_path_head_count, 2);
  assert.match(first.path_heads_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.authority_manifest_id, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(first, reordered);
  assert.notEqual(first.path_heads_digest, changed.path_heads_digest);
  assert.notEqual(first.authority_manifest_id, changed.authority_manifest_id);
});

test("V7.6.3 compact orientation selects only requested/recent accepted heads and advances an accepted-state cursor", () => {
  const pathHeads = [
    { path: "a-old.md", stone_hash: "a", updated_at: "2026-09-01T00:00:00.000Z" },
    { path: "b-recent.md", stone_hash: "b", updated_at: "2026-09-02T13:00:00.000Z" },
    { path: "c-requested.md", stone_hash: "c", updated_at: "2026-08-31T00:00:00.000Z" }
  ];
  const selected = selectOrientationPathHeads(pathHeads, {
    paths: ["c-requested.md"],
    since: "2026-09-02T12:00:00.000Z"
  });

  assert.deepEqual(selected.map(item => item.path), ["b-recent.md", "c-requested.md"]);
  assert.deepEqual(selectOrientationPathHeads(pathHeads), []);
  assert.equal(
    latestAcceptedStateCursor("2026-09-02T12:30:00.000Z", pathHeads),
    "2026-09-02T13:00:00.000Z"
  );
});

async function makeRuntimeBriefDocument({
  guideContent,
  guideStone = "instructions-stone",
  guideCommit = VALID_COMMIT_A,
  guideSha256 = null,
  requiredRuleIds = REQUIRED_RUNTIME_RULE_IDS,
  rules = null
}) {
  return {
    schema: "cairnstone-canonical-instruction-runtime-brief-v1",
    authority: {
      guide: {
        path: INSTRUCTIONS_PATH,
        stone_hash: guideStone,
        repo: "nothinginfinity/cairnstone-v6",
        commit_sha: guideCommit,
        content_identity: {
          sha256: guideSha256 || await sha256Text(guideContent),
          git_blob_sha: MOCK_GUIDE_BLOB_SHA,
          bytes: Buffer.byteLength(guideContent)
        }
      },
      full_guide_remains_canonical: true,
      provider_neutral: true,
      authority_expansion: false
    },
    required_rule_ids: [...requiredRuleIds],
    rules: rules || requiredRuleIds.map(id => ({ id, text: `Preserve canonical runtime rule ${id}.` }))
  };
}

function resumeStateWithRuntimeBrief(hash, { briefStone = "runtime-brief-stone", briefCommit = VALID_COMMIT_B } = {}) {
  return resumeStateWithHead(hash, [
    {
      path: RUNTIME_BRIEF_PATH,
      stone_hash: briefStone,
      repo: "nothinginfinity/cairnstone-v6",
      commit_sha: briefCommit
    }
  ]);
}

function mockGithubFetchForRuntimeBrief(guideContent, briefDocument) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const brief = String(url).includes("AI_RUNTIME_BRIEF.json");
    const content = brief ? JSON.stringify(briefDocument) : guideContent;
    return {
      ok: true,
      json: async () => ({
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        sha: brief ? MOCK_BRIEF_BLOB_SHA : MOCK_GUIDE_BLOB_SHA
      })
    };
  };
  return () => { globalThis.fetch = original; };
}

test("V7.6.4 runtime brief validator requires exact guide identity, rule vector, rule order, and closed shape", async () => {
  const guideContent = "# Canonical guide\nfull authority\n";
  const valid = await makeRuntimeBriefDocument({ guideContent });
  const expectedGuide = {
    path: INSTRUCTIONS_PATH,
    stone_hash: "instructions-stone",
    repo: "nothinginfinity/cairnstone-v6",
    commit_sha: VALID_COMMIT_A,
    content_identity: valid.authority.guide.content_identity
  };

  const accepted = validateRuntimeBriefDocument(valid, expectedGuide);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.rendered_content.split("\n").length, REQUIRED_RUNTIME_RULE_IDS.length);
  assert.match(accepted.rendered_content, /^AUTH-CHAIN-001:/);

  const wrongGuide = structuredClone(valid);
  wrongGuide.authority.guide.content_identity.sha256 = "0".repeat(64);
  assert.equal(validateRuntimeBriefDocument(wrongGuide, expectedGuide).error, "runtime_brief_guide_identity_mismatch");

  const missingRule = structuredClone(valid);
  missingRule.required_rule_ids.pop();
  assert.equal(validateRuntimeBriefDocument(missingRule, expectedGuide).error, "runtime_brief_required_rule_coverage_invalid");

  const authorityExpansion = structuredClone(valid);
  authorityExpansion.authority.untrusted_new_field = true;
  assert.equal(validateRuntimeBriefDocument(authorityExpansion, expectedGuide).error, "runtime_brief_shape_invalid");
});

test("V7.6.4 legacy_full transmits the complete accepted guide with no legacy truncation", async () => {
  const guideContent = "# Operating Guide\n" + "full-guide-line\n".repeat(2200);
  const restore = mockGithubFetchForRuntimeBrief(guideContent, {});
  try {
    const result = await agentBootstrapFromBody({
      actor_id: "test:v764-full-guide",
      task: "full guide compatibility",
      chain: "cairnstone-v6-project-memory",
      mode: "legacy_full",
      include_inbox: false,
      limits: { max_memory_hits: 0, max_memory_bytes: 0, max_inbox_items: 0, max_package_bytes: 180000 }
    }, makeEnv(), makeDeps());

    assert.equal(result.ok, true);
    assert.equal(result.instructions.content, guideContent);
    assert.equal(result.instructions.truncated, false);
    assert.equal(result.instructions.selection.representation, "full_guide");
    assert.equal(result.instructions.transmitted_content_identity.bytes, Buffer.byteLength(guideContent));
    assert.equal(result.limits.instructions_bytes, Buffer.byteLength(guideContent));
  } finally {
    restore();
  }
});

test("V7.6.4 optimized_sparse with no accepted brief uses typed full-guide fallback and binds fallback state into package identity", async () => {
  const guideContent = "# Operating Guide\n" + "authority\n".repeat(200);
  const restore = mockGithubFetchForRuntimeBrief(guideContent, {});
  try {
    const base = {
      actor_id: "test:v764-fallback",
      task: "runtime brief fallback",
      chain: "cairnstone-v6-project-memory",
      include_inbox: false,
      limits: { max_memory_hits: 0, max_memory_bytes: 0, max_inbox_items: 0 }
    };
    const legacy = await agentBootstrapFromBody({ ...base, mode: "legacy_full" }, makeEnv(), makeDeps());
    const optimized = await agentBootstrapFromBody({ ...base, mode: "optimized_sparse" }, makeEnv(), makeDeps());

    assert.equal(legacy.ok, true);
    assert.equal(optimized.ok, true);
    assert.equal(optimized.instructions.content, guideContent);
    assert.equal(optimized.instructions.selection.representation, "full_guide_fallback");
    assert.equal(optimized.instructions.selection.fallback.code, "runtime_brief_unaccepted");
    assert.notEqual(optimized.package_id, legacy.package_id, "typed selection/fallback metadata must be cryptographically bound");
  } finally {
    restore();
  }
});

test("V7.6.4 accepted identity-bound runtime brief is deterministic and materially smaller than the full guide", async () => {
  const guideContent = "# Operating Guide\n" + "canonical authority detail and maintainer explanation\n".repeat(900);
  const briefDocument = await makeRuntimeBriefDocument({ guideContent });
  const restore = mockGithubFetchForRuntimeBrief(guideContent, briefDocument);
  try {
    const deps = makeDeps({ resumeChainFromBody: async () => resumeStateWithRuntimeBrief("chain-head-v764") });
    const body = {
      actor_id: "test:v764-brief",
      task: "roadmap status",
      chain: "cairnstone-v6-project-memory",
      mode: "optimized_sparse",
      include_inbox: false,
      limits: { max_memory_hits: 0, max_memory_bytes: 0, max_inbox_items: 0, max_package_bytes: 180000 }
    };
    const first = await agentBootstrapFromBody(body, makeEnv(), deps);
    const second = await agentBootstrapFromBody(body, makeEnv(), deps);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.package_id, second.package_id);
    assert.equal(first.instructions.path, INSTRUCTIONS_PATH);
    assert.equal(first.instructions.stone_hash, "instructions-stone");
    assert.equal(first.instructions.content_identity.bytes, Buffer.byteLength(guideContent));
    assert.equal(first.instructions.selection.representation, "runtime_brief");
    assert.equal(first.instructions.selection.runtime_brief.path, RUNTIME_BRIEF_PATH);
    assert.equal(first.instructions.selection.runtime_brief.stone_hash, "runtime-brief-stone");
    assert.equal(first.instructions.selection.fallback, null);
    assert.ok(first.instructions.transmitted_content_identity.bytes < first.instructions.content_identity.bytes);
    assert.equal(first.limits.instructions_bytes, first.instructions.transmitted_content_identity.bytes);
    assert.equal(first.instructions.content.split("\n").length, REQUIRED_RUNTIME_RULE_IDS.length);
    assert.ok(first.authority.path_heads.some(item => item.path === RUNTIME_BRIEF_PATH));
  } finally {
    restore();
  }
});

test("V7.6.4 stale or coverage-invalid accepted brief fails safely to the complete accepted guide", async () => {
  const guideContent = "# Operating Guide\n" + "authority\n".repeat(120);
  const stale = await makeRuntimeBriefDocument({ guideContent, guideSha256: "f".repeat(64) });
  let restore = mockGithubFetchForRuntimeBrief(guideContent, stale);
  try {
    const deps = makeDeps({ resumeChainFromBody: async () => resumeStateWithRuntimeBrief("chain-head-v764-stale") });
    const result = await agentBootstrapFromBody({
      actor_id: "test:v764-stale",
      task: "stale brief",
      chain: "cairnstone-v6-project-memory",
      mode: "optimized_sparse",
      include_inbox: false
    }, makeEnv(), deps);
    assert.equal(result.ok, true);
    assert.equal(result.instructions.selection.representation, "full_guide_fallback");
    assert.equal(result.instructions.selection.fallback.code, "runtime_brief_guide_identity_mismatch");
    assert.equal(result.instructions.content, guideContent);
  } finally {
    restore();
  }

  const invalidCoverage = await makeRuntimeBriefDocument({
    guideContent,
    requiredRuleIds: REQUIRED_RUNTIME_RULE_IDS.slice(0, -1)
  });
  restore = mockGithubFetchForRuntimeBrief(guideContent, invalidCoverage);
  try {
    const deps = makeDeps({ resumeChainFromBody: async () => resumeStateWithRuntimeBrief("chain-head-v764-coverage") });
    const result = await agentBootstrapFromBody({
      actor_id: "test:v764-coverage",
      task: "coverage invalid brief",
      chain: "cairnstone-v6-project-memory",
      mode: "optimized_sparse",
      include_inbox: false
    }, makeEnv(), deps);
    assert.equal(result.ok, true);
    assert.equal(result.instructions.selection.fallback.code, "runtime_brief_required_rule_coverage_invalid");
    assert.equal(result.instructions.content, guideContent);
  } finally {
    restore();
  }
});

test("V7.6.4 accepted runtime-brief path HEAD participates in V7.0 race protection", async () => {
  const guideContent = "# Operating Guide\n" + "authority\n".repeat(80);
  const briefDocument = await makeRuntimeBriefDocument({ guideContent });
  const restore = mockGithubFetchForRuntimeBrief(guideContent, briefDocument);
  try {
    let call = 0;
    const deps = makeDeps({
      resumeChainFromBody: async () => {
        call += 1;
        return call === 1
          ? resumeStateWithRuntimeBrief("chain-head-v764-race", { briefStone: "brief-BEFORE" })
          : resumeStateWithRuntimeBrief("chain-head-v764-race", { briefStone: "brief-AFTER" });
      }
    });
    const result = await agentBootstrapFromBody({
      actor_id: "test:v764-race",
      task: "brief race",
      chain: "cairnstone-v6-project-memory",
      mode: "optimized_sparse",
      include_inbox: false
    }, makeEnv(), deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, "context_compile_race");
    assert.equal(result.detail, "chain_or_path_heads_changed_during_compile");
  } finally {
    restore();
  }
});
