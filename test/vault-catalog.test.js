import assert from "node:assert/strict";
import { test } from "node:test";
import { vaultCatalogFromBody, resolveScopeFromBody } from "../src/vault-catalog.js";

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
