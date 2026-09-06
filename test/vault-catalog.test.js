import assert from "node:assert/strict";
import { test } from "node:test";
import { vaultCatalogFromBody, resolveScopeFromBody, findScopeFromBody, askScopeFromBody } from "../src/vault-catalog.js";

// In-memory fixture: mirrors chain_heads / stones / path_heads schema.
function makeEnv(fixture) {
  const chainHeads = fixture.chainHeads || []; // { chain, head_hash, updated_at }
  const stones = fixture.stones || []; // { chain_hash, repo, created_at }
  const pathHeads = fixture.pathHeads || []; // { chain }
  let headMutationSchedule = fixture.headMutationSchedule || null; // { chain, sequence: [hash, hash, ...] }
  const headReadCounts = new Map();

  return {
    CAIRNSTONE_DB: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          async all() {
            if (sql.includes("FROM chain_heads")) {
              return { results: chainHeads.map(h => ({ chain: h.chain, head_hash: h.head_hash, updated_at: h.updated_at })) };
            }
            if (sql.includes("SELECT DISTINCT chain_hash AS chain FROM stones WHERE chain_hash IS NOT NULL")) {
              return { results: [...new Set(stones.map(s => s.chain_hash))].sort().map(chain => ({ chain })) };
            }
            if (sql.includes("SELECT DISTINCT repo FROM stones WHERE chain_hash = ?")) {
              const chain = bound[0];
              const repos = [...new Set(stones.filter(s => s.chain_hash === chain && s.repo).map(s => s.repo))].sort();
              return { results: repos.map(repo => ({ repo })) };
            }
            if (sql.includes("SELECT DISTINCT chain_hash AS chain FROM stones WHERE repo = ?")) {
              const repo = bound[0];
              const chains = [...new Set(stones.filter(s => s.repo === repo).map(s => s.chain_hash))].sort();
              return { results: chains.map(chain => ({ chain })) };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes("SELECT head_hash FROM chain_heads WHERE chain = ?")) {
              const chain = bound[0];
              if (headMutationSchedule && headMutationSchedule.chain === chain) {
                const n = headReadCounts.get(chain) || 0;
                headReadCounts.set(chain, n + 1);
                const seq = headMutationSchedule.sequence;
                return { head_hash: seq[Math.min(n, seq.length - 1)] };
              }
              const row = chainHeads.find(h => h.chain === chain);
              return row ? { head_hash: row.head_hash } : null;
            }
            if (sql.includes("SELECT hash FROM stones WHERE chain_hash = ? LIMIT 1")) {
              const chain = bound[0];
              return stones.some(s => s.chain_hash === chain) ? { hash: "x" } : null;
            }
            if (sql.includes("SELECT COUNT(*) AS c FROM stones WHERE chain_hash = ? AND repo IS NULL")) {
              const chain = bound[0];
              const c = stones.filter(s => s.chain_hash === chain && !s.repo).length;
              return { c };
            }
            if (sql.includes("SELECT COUNT(*) AS c FROM stones WHERE chain_hash = ?")) {
              const chain = bound[0];
              return { c: stones.filter(s => s.chain_hash === chain).length };
            }
            if (sql.includes("SELECT COUNT(*) AS c FROM path_heads WHERE chain = ?")) {
              const chain = bound[0];
              return { c: pathHeads.filter(p => p.chain === chain).length };
            }
            if (sql.includes("SELECT MAX(created_at) AS latest FROM stones WHERE chain_hash = ?")) {
              const chain = bound[0];
              const dates = stones.filter(s => s.chain_hash === chain).map(s => s.created_at).filter(Boolean).sort();
              return { latest: dates.length ? dates[dates.length - 1] : null };
            }
            return null;
          }
        };
      }
    }
  };
}

function makeSearchEnv(fixture) {
  const chainHeads = fixture.chainHeads || [];
  const stones = fixture.stones || [];
  const pathHeads = fixture.pathHeads || [];
  const refs = fixture.refs || [];
  const rawByKey = fixture.rawByKey || {};
  const headMutationSchedule = fixture.headMutationSchedule || null;
  const headReadCounts = new Map();

  function stoneFor(hash) {
    return stones.find(stone => stone.hash === hash) || null;
  }

  return {
    CAIRNSTONE_DB: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          async all() {
            if (sql.includes("SELECT chain, head_hash, updated_at FROM chain_heads")) {
              return { results: chainHeads.map(row => ({ ...row })) };
            }
            if (sql.includes("SELECT DISTINCT chain_hash AS chain FROM stones WHERE chain_hash IS NOT NULL")) {
              return { results: [...new Set(stones.map(s => s.chain_hash).filter(Boolean))].sort().map(chain => ({ chain })) };
            }
            if (sql.includes("SELECT DISTINCT chain_hash AS chain FROM stones WHERE repo = ?")) {
              const repo = bound[0];
              return {
                results: [...new Set(stones.filter(s => s.repo === repo).map(s => s.chain_hash).filter(Boolean))]
                  .sort()
                  .map(chain => ({ chain }))
              };
            }
            if (sql.includes("FROM refs_fts LEFT JOIN stones s")) {
              const chain = bound[1];
              const limit = Number(bound[bound.length - 1]);
              const repoFilters = bound.slice(2, -1);
              const rows = refs
                .filter(ref => {
                  if (ref.chain !== chain) return false;
                  if (!repoFilters.length) return true;
                  return repoFilters.includes(stoneFor(ref.stone_hash)?.repo || null);
                })
                .sort((a, b) => a.score - b.score || a.ref_id.localeCompare(b.ref_id))
                .slice(0, limit)
                .map(ref => {
                  const stone = stoneFor(ref.stone_hash);
                  return {
                    ref_id: ref.ref_id,
                    stone_hash: ref.stone_hash,
                    chain: ref.chain,
                    path: ref.path,
                    preview: ref.preview,
                    score: ref.score,
                    repo: stone?.repo || null,
                    commit_sha: stone?.commit_sha || null
                  };
                });
              return { results: rows };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes("SELECT head_hash FROM chain_heads WHERE chain = ?")) {
              const chain = bound[0];
              if (headMutationSchedule && headMutationSchedule.chain === chain) {
                const count = headReadCounts.get(chain) || 0;
                headReadCounts.set(chain, count + 1);
                const sequence = headMutationSchedule.sequence;
                return { head_hash: sequence[Math.min(count, sequence.length - 1)] };
              }
              const row = chainHeads.find(item => item.chain === chain);
              return row ? { head_hash: row.head_hash } : null;
            }
            if (sql.includes("SELECT hash FROM stones WHERE chain_hash = ? LIMIT 1")) {
              const chain = bound[0];
              const row = stones.find(item => item.chain_hash === chain);
              return row ? { hash: row.hash } : null;
            }
            if (sql.includes("SELECT hash,title,path,repo,commit_sha,stone_json FROM stones WHERE hash = ?")) {
              const row = stones.find(item => item.hash === bound[0]);
              return row ? {
                hash: row.hash,
                title: row.title || row.path || row.hash,
                path: row.path || null,
                repo: row.repo || null,
                commit_sha: row.commit_sha || null,
                stone_json: row.stone_json || JSON.stringify({ layers: { lod4: row.lod4 || row.title || row.hash } })
              } : null;
            }
            if (sql.includes("SELECT head_hash FROM path_heads WHERE chain = ? AND path = ?")) {
              const [chain, path] = bound;
              const row = pathHeads.find(item => item.chain === chain && item.path === path);
              return row ? { head_hash: row.head_hash } : null;
            }
            if (sql.includes("SELECT raw_key,line_start,line_end FROM refs WHERE ref_id = ?")) {
              const ref = refs.find(item => item.ref_id === bound[0]);
              return ref ? { raw_key: ref.raw_key, line_start: ref.line_start, line_end: ref.line_end } : null;
            }
            return null;
          }
        };
      }
    },
    CAIRNSTONE_RAW: {
      async get(key) {
        if (!Object.prototype.hasOwnProperty.call(rawByKey, key)) return null;
        return { async text() { return rawByKey[key]; } };
      }
    },
    AI: fixture.aiRun || fixture.aiResponse ? {
      async run(model, input) {
        if (typeof fixture.aiRun === "function") return fixture.aiRun(model, input);
        return { response: fixture.aiResponse };
      }
    } : undefined
  };
}

const FIXTURE = {
  chainHeads: [
    { chain: "cairnstone-v6-project-memory", head_hash: "head-cs6", updated_at: "2026-09-05T00:00:00Z" },
    { chain: "infinite-radio", head_hash: "head-ir", updated_at: "2026-09-04T00:00:00Z" }
  ],
  stones: [
    { chain_hash: "cairnstone-v6-project-memory", repo: "nothinginfinity/cairnstone-v6", created_at: "2026-09-05T00:00:00Z" },
    { chain_hash: "cairnstone-v6-project-memory", repo: "nothinginfinity/cairnstone-v6", created_at: "2026-09-04T00:00:00Z" },
    { chain_hash: "infinite-radio", repo: "nothinginfinity/infinite-radio", created_at: "2026-09-04T00:00:00Z" },
    { chain_hash: "headless-notes", repo: null, created_at: "2026-08-01T00:00:00Z" }
  ],
  pathHeads: [
    { chain: "cairnstone-v6-project-memory" },
    { chain: "cairnstone-v6-project-memory" },
    { chain: "infinite-radio" }
  ]
};

test("vault catalog discovers headed and headless chains", async () => {
  const env = makeEnv(FIXTURE);
  const result = await vaultCatalogFromBody({}, env);
  assert.equal(result.ok, true);
  const names = result.chains.map(c => c.chain);
  assert.deepEqual(names, ["cairnstone-v6-project-memory", "headless-notes", "infinite-radio"]);
  const headless = result.chains.find(c => c.chain === "headless-notes");
  assert.equal(headless.canonical_head, null);
  assert.deepEqual(headless.repos, []);
  assert.equal(headless.provenance_complete, false);
  const cs6 = result.chains.find(c => c.chain === "cairnstone-v6-project-memory");
  assert.equal(cs6.canonical_head, "head-cs6");
  assert.equal(cs6.stone_count, 2);
  assert.equal(cs6.path_head_count, 2);
  assert.equal(cs6.provenance_complete, true);
});

test("vault catalog repo filter narrows to matching chains only", async () => {
  const env = makeEnv(FIXTURE);
  const result = await vaultCatalogFromBody({ repo: "nothinginfinity/infinite-radio" }, env);
  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].chain, "infinite-radio");
});

test("vault catalog q filter substring-matches chain name", async () => {
  const env = makeEnv(FIXTURE);
  const result = await vaultCatalogFromBody({ q: "radio" }, env);
  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].chain, "infinite-radio");
});

test("vault catalog pagination via limit + after_chain", async () => {
  const env = makeEnv(FIXTURE);
  const page1 = await vaultCatalogFromBody({ limit: 1 }, env);
  assert.equal(page1.chains.length, 1);
  assert.equal(page1.has_more, true);
  assert.equal(page1.chains[0].chain, "cairnstone-v6-project-memory");
  const page2 = await vaultCatalogFromBody({ limit: 1, after_chain: page1.next_after_chain }, env);
  assert.equal(page2.chains[0].chain, "headless-notes");
});

test("resolve_scope: invalid mode fails closed", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({ mode: "bogus" }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_scope_mode");
});

test("resolve_scope: single_chain happy path", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({ mode: "single_chain", chains: ["infinite-radio"] }, env);
  assert.equal(result.ok, true);
  assert.equal(result.schema, "cairnstone-scope-snapshot-v1");
  assert.deepEqual(result.chains, [{ chain: "infinite-radio", head_hash: "head-ir" }]);
  assert.ok(result.scope_id.startsWith("sha256:"));
  assert.ok(result.authority_digest.startsWith("sha256:"));
});

test("resolve_scope: single_chain unknown chain fails closed", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({ mode: "single_chain", chains: ["does-not-exist"] }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "chain_not_found");
});

test("resolve_scope: repo mode resolves all chains for that repo", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({ mode: "repo", repos: ["nothinginfinity/cairnstone-v6"] }, env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.chains.map(c => c.chain), ["cairnstone-v6-project-memory"]);
});

test("resolve_scope: repo mode with no matches fails closed", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({ mode: "repo", repos: ["nobody/nothing"] }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "repo_not_found");
});

test("resolve_scope: multi mode unions repos and explicit chains, deduplicated", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({
    mode: "multi",
    repos: ["nothinginfinity/infinite-radio"],
    chains: ["cairnstone-v6-project-memory", "infinite-radio"]
  }, env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.chains.map(c => c.chain).sort(), ["cairnstone-v6-project-memory", "infinite-radio"]);
});

test("resolve_scope: vault mode returns every known chain and is not truncated below max_chains", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({ mode: "vault" }, env);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.chains.map(c => c.chain).sort(), ["cairnstone-v6-project-memory", "headless-notes", "infinite-radio"]);
});

test("resolve_scope: vault mode respects explicit max_chains and reports truncation", async () => {
  const env = makeEnv(FIXTURE);
  const result = await resolveScopeFromBody({ mode: "vault", max_chains: 1 }, env);
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.chains.length, 1);
  assert.equal(result.coverage.full_count, 3);
});

test("resolve_scope: same selectors + same heads produce identical scope_id and authority_digest", async () => {
  const env = makeEnv(FIXTURE);
  const a = await resolveScopeFromBody({ mode: "multi", chains: ["infinite-radio", "cairnstone-v6-project-memory"] }, env);
  const b = await resolveScopeFromBody({ mode: "multi", chains: ["cairnstone-v6-project-memory", "infinite-radio"] }, env);
  assert.equal(a.scope_id, b.scope_id);
  assert.equal(a.authority_digest, b.authority_digest);
});

test("resolve_scope: changing a participating chain HEAD changes authority_digest", async () => {
  const env1 = makeEnv(FIXTURE);
  const r1 = await resolveScopeFromBody({ mode: "single_chain", chains: ["infinite-radio"] }, env1);

  const fixture2 = JSON.parse(JSON.stringify(FIXTURE));
  fixture2.chainHeads.find(h => h.chain === "infinite-radio").head_hash = "head-ir-v2";
  const env2 = makeEnv(fixture2);
  const r2 = await resolveScopeFromBody({ mode: "single_chain", chains: ["infinite-radio"] }, env2);

  assert.notEqual(r1.authority_digest, r2.authority_digest);
});

test("resolve_scope: mid-resolution authority change fails closed with scope_compile_race", async () => {
  const env = makeEnv({
    ...FIXTURE,
    // index 0 satisfies the pre-flight chainExists() read inside
    // resolveChainSet; index 1 is the first authority snapshot; index 2 is
    // the second authority snapshot where the simulated external change is
    // observed.
    headMutationSchedule: { chain: "infinite-radio", sequence: ["head-ir", "head-ir", "head-ir-changed"] }
  });
  const result = await resolveScopeFromBody({ mode: "single_chain", chains: ["infinite-radio"] }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "scope_compile_race");
  assert.equal(result.first_head_hash, "head-ir");
  assert.equal(result.second_head_hash, "head-ir-changed");
});

test("resolve_scope: no read-only operation mutates chain_heads/path_heads/stones (no write methods invoked)", async () => {
  const env = makeEnv(FIXTURE);
  // The mock only implements prepare/bind/all/first (no run/exec) -- any
  // attempt by resolveScopeFromBody or vaultCatalogFromBody to write would
  // throw here, since no mutation method exists on the mock at all.
  await resolveScopeFromBody({ mode: "vault" }, env);
  await vaultCatalogFromBody({}, env);
});

const SEARCH_FIXTURE = {
  chainHeads: [
    { chain: "alpha", head_hash: "a-head", updated_at: "2026-09-05T00:00:00Z" },
    { chain: "beta", head_hash: "b-head", updated_at: "2026-09-05T00:00:00Z" },
    { chain: "gamma", head_hash: "g-head", updated_at: "2026-09-05T00:00:00Z" }
  ],
  stones: [
    { hash: "a-head", chain_hash: "alpha", repo: "org/a", commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { hash: "a-path", chain_hash: "alpha", repo: "org/a", commit_sha: "abababababababababababababababababababab" },
    { hash: "a-hist", chain_hash: "alpha", repo: "org/a", commit_sha: "acacacacacacacacacacacacacacacacacacacac" },
    { hash: "a-other", chain_hash: "alpha", repo: "org/other", commit_sha: "adadadadadadadadadadadadadadadadadadadad" },
    { hash: "b-head", chain_hash: "beta", repo: "org/b", commit_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { hash: "g-head", chain_hash: "gamma", repo: "org/g", commit_sha: "cccccccccccccccccccccccccccccccccccccccc" }
  ],
  pathHeads: [
    { chain: "alpha", path: "src/current.js", head_hash: "a-path" }
  ],
  refs: [
    { ref_id: "ref-a-head", stone_hash: "a-head", chain: "alpha", path: "README.md", preview: "shared alpha head", score: -9, raw_key: "raw-a-head", line_start: 1, line_end: 2 },
    { ref_id: "ref-a-path", stone_hash: "a-path", chain: "alpha", path: "src/current.js", preview: "shared alpha path", score: -8, raw_key: "raw-a-path", line_start: 1, line_end: 1 },
    { ref_id: "ref-a-hist", stone_hash: "a-hist", chain: "alpha", path: "src/old.js", preview: "shared alpha historical", score: -7, raw_key: "raw-a-hist", line_start: 1, line_end: 1 },
    { ref_id: "ref-a-other", stone_hash: "a-other", chain: "alpha", path: "foreign.md", preview: "shared alpha foreign repo", score: -6, raw_key: "raw-a-other", line_start: 1, line_end: 1 },
    { ref_id: "ref-b-head", stone_hash: "b-head", chain: "beta", path: "README.md", preview: "shared beta head", score: -5, raw_key: "raw-b-head", line_start: 1, line_end: 1 },
    { ref_id: "ref-g-head", stone_hash: "g-head", chain: "gamma", path: "README.md", preview: "shared gamma head", score: -4, raw_key: "raw-g-head", line_start: 1, line_end: 1 }
  ],
  rawByKey: {
    "raw-a-head": "alpha first line\nalpha second line with enough bytes for clipping behavior",
    "raw-a-path": "alpha path accepted content",
    "raw-a-hist": "alpha historical content",
    "raw-a-other": "alpha foreign repository content",
    "raw-b-head": "beta head content",
    "raw-g-head": "gamma head content"
  }
};

test("V7.7.1 find_scope: single-chain search preserves authority/provenance and historical evidence", async () => {
  const env = makeSearchEnv(SEARCH_FIXTURE);
  const result = await findScopeFromBody({
    query: "shared",
    scope: { mode: "single_chain", chains: ["alpha"] },
    top_k: 3,
    per_chain_k: 3
  }, env);
  assert.equal(result.ok, true);
  assert.equal(result.schema, "cairnstone-scope-search-v1");
  assert.deepEqual(result.matches.map(item => item.chain), ["alpha", "alpha", "alpha"]);
  assert.deepEqual(result.matches.map(item => item.authority_class), ["CHAIN_HEAD", "PATH_HEAD", "HISTORICAL"]);
  assert.equal(result.matches[0].repo, "org/a");
  assert.equal(result.matches[0].commit_sha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(result.scope_snapshot.chains[0].head_hash, "a-head");
  assert.equal(result.read_only.chain_heads_written, false);
  assert.equal(result.read_only.path_heads_written, false);
});

test("V7.7.1 find_scope: repo scope does not leak another repository", async () => {
  const env = makeSearchEnv(SEARCH_FIXTURE);
  const result = await findScopeFromBody({
    query: "shared",
    scope: { mode: "repo", repos: ["org/a"] },
    top_k: 10,
    per_chain_k: 5
  }, env);
  assert.equal(result.ok, true);
  assert.ok(result.matches.length > 0);
  assert.ok(result.matches.every(item => item.repo === "org/a"));
  assert.ok(!result.matches.some(item => item.stone_hash === "a-other"), "same-chain stone from org/other must not leak through an org/a repo scope");
  assert.ok(!result.matches.some(item => item.chain === "beta"));
  assert.deepEqual(result.coverage.per_chain[0].repo_filter, ["org/a"]);
});

test("V7.7.1 find_scope: multi-chain fair merge returns a smaller chain before a large chain's second candidate", async () => {
  const env = makeSearchEnv(SEARCH_FIXTURE);
  const result = await findScopeFromBody({
    query: "shared",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 3
  }, env);
  assert.equal(result.ok, true);
  assert.deepEqual(result.matches.map(item => item.chain), ["alpha", "beta"]);
  assert.deepEqual(result.matches.map(item => item.ranking.chain_rank), [1, 1]);
  assert.equal(result.coverage.matched_chain_count, 2);
});

test("V7.7.1 find_scope: identical selectors and heads produce deterministic merged matches", async () => {
  const env = makeSearchEnv(SEARCH_FIXTURE);
  const request = {
    query: "shared",
    scope: { mode: "multi", chains: ["beta", "alpha"] },
    top_k: 4,
    per_chain_k: 3
  };
  const first = await findScopeFromBody(request, env);
  const second = await findScopeFromBody(request, env);
  assert.equal(first.scope_snapshot.scope_id, second.scope_snapshot.scope_id);
  assert.equal(first.scope_snapshot.authority_digest, second.scope_snapshot.authority_digest);
  assert.deepEqual(first.matches, second.matches);
});

test("V7.7.1 find_scope: vault candidate budget reports skipped coverage instead of implying exhaustive results", async () => {
  const env = makeSearchEnv(SEARCH_FIXTURE);
  const result = await findScopeFromBody({
    query: "shared",
    scope: { mode: "vault", max_chains: 3 },
    top_k: 5,
    per_chain_k: 5,
    max_total_candidates: 2
  }, env);
  assert.equal(result.ok, true);
  assert.equal(result.coverage.resolved_chain_count, 3);
  assert.equal(result.coverage.queried_chain_count, 2);
  assert.deepEqual(result.coverage.skipped_chains, ["gamma"]);
  assert.equal(result.coverage.complete, false);
});

test("V7.7.1 find_scope: expanded bytes are strictly capped", async () => {
  const env = makeSearchEnv(SEARCH_FIXTURE);
  const result = await findScopeFromBody({
    query: "shared",
    scope: { mode: "single_chain", chains: ["alpha"] },
    top_k: 1,
    per_chain_k: 1,
    expand: true,
    max_expansions: 1,
    max_expanded_bytes: 20,
    context_lines: 0
  }, env);
  assert.equal(result.ok, true);
  assert.equal(result.expanded.length, 1);
  assert.ok(result.expanded[0].bytes <= 20);
  assert.ok(result.coverage.expansion_bytes <= 20);
  assert.equal(result.coverage.expansion_truncated, true);
});

test("V7.7.1 find_scope: authority change after retrieval fails closed", async () => {
  const env = makeSearchEnv({
    ...SEARCH_FIXTURE,
    headMutationSchedule: {
      chain: "alpha",
      sequence: ["a-head", "a-head", "a-head", "a-head-changed"]
    }
  });
  const result = await findScopeFromBody({
    query: "shared",
    scope: { mode: "single_chain", chains: ["alpha"] },
    top_k: 1,
    per_chain_k: 1
  }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "scope_compile_race");
  assert.equal(result.phase, "post_search");
  assert.equal(result.first_head_hash, "a-head");
  assert.equal(result.second_head_hash, "a-head-changed");
});

test("V7.7.1 find_scope: read-only fixture has no write methods and still completes", async () => {
  const env = makeSearchEnv(SEARCH_FIXTURE);
  const result = await findScopeFromBody({
    query: "shared",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2
  }, env);
  assert.equal(result.ok, true);
});

const ASK_ALPHA_HEAD = "a".repeat(64);
const ASK_BETA_HEAD = "b".repeat(64);
const ASK_ALPHA_PATH = "c".repeat(64);
const ASK_BETA_PATH = "d".repeat(64);

function makeAskFixture(overrides = {}) {
  const fixture = {
    chainHeads: [
      { chain: "alpha", head_hash: ASK_ALPHA_HEAD, updated_at: "2026-09-06T00:00:00Z" },
      { chain: "beta", head_hash: ASK_BETA_HEAD, updated_at: "2026-09-06T00:00:00Z" }
    ],
    stones: [
      {
        hash: ASK_ALPHA_HEAD,
        chain_hash: "alpha",
        repo: "org/a",
        path: "project-memory/start.md",
        commit_sha: "1".repeat(40),
        title: "Alpha accepted orientation",
        stone_json: JSON.stringify({ layers: { lod4: "Alpha is the accepted orientation for repository A." } })
      },
      {
        hash: ASK_BETA_HEAD,
        chain_hash: "beta",
        repo: "org/b",
        path: "project-memory/start.md",
        commit_sha: "2".repeat(40),
        title: "Beta accepted orientation",
        stone_json: JSON.stringify({ layers: { lod4: "Beta is the accepted orientation for repository B." } })
      },
      { hash: ASK_ALPHA_PATH, chain_hash: "alpha", repo: "org/a", path: "src/current.js", commit_sha: "3".repeat(40) },
      { hash: ASK_BETA_PATH, chain_hash: "beta", repo: "org/b", path: "src/current.js", commit_sha: "4".repeat(40) }
    ],
    pathHeads: [
      { chain: "alpha", path: "src/current.js", head_hash: ASK_ALPHA_PATH },
      { chain: "beta", path: "src/current.js", head_hash: ASK_BETA_PATH }
    ],
    refs: [
      { ref_id: "ref-alpha", stone_hash: ASK_ALPHA_PATH, chain: "alpha", path: "src/current.js", preview: "shared scope alpha accepted behavior", score: -10, raw_key: "raw-alpha", line_start: 1, line_end: 1 },
      { ref_id: "ref-beta", stone_hash: ASK_BETA_PATH, chain: "beta", path: "src/current.js", preview: "shared scope beta accepted behavior", score: -9, raw_key: "raw-beta", line_start: 1, line_end: 1 }
    ],
    rawByKey: {
      "raw-alpha": "Alpha current accepted source says shared scope behavior is enabled.",
      "raw-beta": "Beta current accepted source says shared scope behavior is integrated."
    },
    aiResponse: `Alpha and Beta both expose current accepted scope behavior [stone:${ASK_ALPHA_PATH} ref:ref-alpha] [stone:${ASK_BETA_PATH} ref:ref-beta]`
  };
  return { ...fixture, ...overrides };
}

test("V7.7.2 ask_scope: multi-chain answer is citation-valid across two real repository identities", async () => {
  const env = makeSearchEnv(makeAskFixture());
  const result = await askScopeFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(result.ok, true);
  assert.equal(result.schema, "cairnstone-scope-answer-v1");
  assert.equal(result.scope_snapshot.chains.length, 2);
  assert.deepEqual(new Set(result.evidence.filter(item => item.ref_id).map(item => item.repo)), new Set(["org/a", "org/b"]));
  assert.deepEqual(new Set(result.evidence.filter(item => item.ref_id).map(item => item.authority_class)), new Set(["PATH_HEAD"]));
  assert.deepEqual(new Set(result.cited_stones), new Set([ASK_ALPHA_PATH, ASK_BETA_PATH]));
  assert.equal(result.citation_validation.ok, true);
  assert.equal(result.coverage.orientation_chain_count, 2);
  assert.equal(result.persistence, null);
  assert.deepEqual(result.read_only, {
    chain_heads_written: false,
    path_heads_written: false,
    stones_written: false,
    edges_written: false
  });
});

test("V7.7.2 ask_scope: invented citation fails closed", async () => {
  const env = makeSearchEnv(makeAskFixture({
    aiResponse: `Unsupported claim [stone:${"e".repeat(64)} ref:not-supplied]`
  }));
  const result = await askScopeFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2
  }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "citation_validation_failed");
  assert.equal(result.citation_validation.ok, false);
});

test("V7.7.2 ask_scope: synthesis refuses a scope broader than the bounded chain ceiling", async () => {
  const chains = Array.from({ length: 26 }, (_, i) => ({
    chain: `chain-${String(i).padStart(2, "0")}`,
    head_hash: i.toString(16).padStart(64, "0"),
    updated_at: "2026-09-06T00:00:00Z"
  }));
  const stones = chains.map(item => ({ hash: item.head_hash, chain_hash: item.chain, repo: `org/repo-${item.chain}` }));
  const env = makeSearchEnv({ chainHeads: chains, stones, pathHeads: [], refs: [], rawByKey: {}, aiResponse: "unused" });
  const result = await askScopeFromBody({
    question: "Summarize everything.",
    scope: { mode: "vault", max_chains: 26 }
  }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "scope_too_broad_for_synthesis");
  assert.equal(result.max_chains, 25);
  assert.equal(result.resolved_chain_count, 26);
});

test("V7.7.2 ask_scope: a participating headless chain fails closed before synthesis", async () => {
  const fixture = makeAskFixture({
    chainHeads: [{ chain: "alpha", head_hash: ASK_ALPHA_HEAD, updated_at: "2026-09-06T00:00:00Z" }]
  });
  fixture.stones.push({ hash: "e".repeat(64), chain_hash: "headless", repo: "org/headless" });
  const env = makeSearchEnv(fixture);
  const result = await askScopeFromBody({
    question: "Compare alpha and headless.",
    scope: { mode: "multi", chains: ["alpha", "headless"] }
  }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "scope_chain_head_missing");
  assert.equal(result.chain, "headless");
});

test("V7.7.2 ask_scope: authority movement detected after model synthesis fails closed", async () => {
  const fixture = makeAskFixture({
    headMutationSchedule: {
      chain: "alpha",
      sequence: [
        ASK_ALPHA_HEAD, ASK_ALPHA_HEAD, ASK_ALPHA_HEAD, ASK_ALPHA_HEAD,
        ASK_ALPHA_HEAD, ASK_ALPHA_HEAD, ASK_ALPHA_HEAD, ASK_ALPHA_HEAD,
        "f".repeat(64)
      ]
    }
  });
  const env = makeSearchEnv(fixture);
  const result = await askScopeFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2
  }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "scope_compile_race");
  assert.equal(result.phase, "post_model");
  assert.equal(result.chain, "alpha");
});
