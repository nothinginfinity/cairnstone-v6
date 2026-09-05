// V7.7.0 -- Vault catalog + cairnstone-scope-v1 contract.
//
// Read-only, additive. Scope is navigation/retrieval context, never
// accepted-state authority: this module never writes chain_heads,
// path_heads, stones, or edges. See
// project-memory/v77-vault-workspace-multi-chain-intelligence-plan.md
// for the full V7.7 product/contract spec this implements.

import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const SCOPE_REQUEST_SCHEMA = "cairnstone-scope-v1";
export const SCOPE_SNAPSHOT_SCHEMA = "cairnstone-scope-snapshot-v1";
const SCOPE_MODES = ["single_chain", "repo", "multi", "vault"];

const DEFAULT_CATALOG_LIMIT = 50;
const MAX_CATALOG_LIMIT = 200;
const DEFAULT_VAULT_MAX_CHAINS = 100;
const MAX_VAULT_MAX_CHAINS = 500;

export const VAULT_CATALOG_TOOL_DEFINITION = {
  name: "cairnstone_vault_catalog",
  description:
    "V7.7.0: read-only discovery of every known CairnStone chain, derived from accepted chain_heads/path_heads/stones state (never a second registry). Each record reports canonical_head sourced directly from chain_heads (never timestamp-inferred), derived repository provenance, stone/path-head counts, and provenance completeness. Chains without GitHub provenance and chains with stones but no accepted HEAD remain visible. Bounded, paginatable via limit/after_chain, optional q (chain-name substring) and repo (exact 'owner/repo') filters. Never mutates chain_heads/path_heads/stones.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: MAX_CATALOG_LIMIT },
      after_chain: { type: "string" },
      q: { type: "string" },
      repo: { type: "string" }
    },
    additionalProperties: false
  }
};

export const SCOPE_RESOLVE_TOOL_DEFINITION = {
  name: "cairnstone_resolve_scope",
  description:
    "V7.7.0: resolve a cairnstone-scope-v1 request (single_chain/repo/multi/vault) into a cairnstone-scope-snapshot-v1 -- an explicit, deterministic set of participating chains plus their exact chain_heads.head_hash values at resolution time, a scope_id identifying the selectors, and an authority_digest identifying the accepted chain-HEAD snapshot actually used. Follows the V7 authority-first pattern: reads every participating chain HEAD twice (before/after) and fails closed with scope_compile_race if any changed mid-resolution. Never combines evidence from two authority snapshots and never mutates chain_heads/path_heads/stones. vault mode is bounded by max_chains and reports truncated:true with coverage diagnostics rather than silently implying exhaustive results.",
  inputSchema: {
    type: "object",
    properties: {
      schema: { type: "string" },
      mode: { type: "string", enum: SCOPE_MODES },
      repos: { type: "array", items: { type: "string" } },
      chains: { type: "array", items: { type: "string" } },
      max_chains: { type: "integer", minimum: 1, maximum: MAX_VAULT_MAX_CHAINS }
    },
    required: ["mode"],
    additionalProperties: false
  }
};

function requireBindings(env) {
  if (!env || !env.CAIRNSTONE_DB) {
    throw Object.assign(new Error("missing_cairnstone_db_binding"), { code: "missing_cairnstone_db_binding" });
  }
}

function dedupSortStrings(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(v => typeof v === "string" && v.length > 0))].sort();
}

// Discover every chain known to the vault: the union of chain_heads.chain
// (chains with an accepted canonical HEAD) and distinct stones.chain_hash
// (chains that have stoned content but may not yet have a HEAD set). Rule:
// canonical_head always comes directly from chain_heads, never inferred --
// a chain with stones but no chain_heads row surfaces with canonical_head:
// null rather than a guessed value.
async function listAllKnownChains(env) {
  const [headRows, stoneChainRows] = await Promise.all([
    env.CAIRNSTONE_DB.prepare("SELECT chain, head_hash, updated_at FROM chain_heads").all(),
    env.CAIRNSTONE_DB.prepare(
      "SELECT DISTINCT chain_hash AS chain FROM stones WHERE chain_hash IS NOT NULL"
    ).all()
  ]);
  const heads = new Map((headRows.results || []).map(row => [row.chain, row]));
  const chainNames = new Set([
    ...(headRows.results || []).map(row => row.chain),
    ...(stoneChainRows.results || []).map(row => row.chain)
  ]);
  return { heads, chainNames: [...chainNames].sort() };
}

async function loadCatalogRecord(env, chain, headRow) {
  const [countRow, pathHeadCountRow, repoRows, missingRepoRow, updatedAtRow] = await Promise.all([
    env.CAIRNSTONE_DB.prepare("SELECT COUNT(*) AS c FROM stones WHERE chain_hash = ?").bind(chain).first(),
    env.CAIRNSTONE_DB.prepare("SELECT COUNT(*) AS c FROM path_heads WHERE chain = ?").bind(chain).first(),
    env.CAIRNSTONE_DB.prepare(
      "SELECT DISTINCT repo FROM stones WHERE chain_hash = ? AND repo IS NOT NULL ORDER BY repo ASC"
    ).bind(chain).all(),
    env.CAIRNSTONE_DB.prepare(
      "SELECT COUNT(*) AS c FROM stones WHERE chain_hash = ? AND repo IS NULL"
    ).bind(chain).first(),
    env.CAIRNSTONE_DB.prepare("SELECT MAX(created_at) AS latest FROM stones WHERE chain_hash = ?").bind(chain).first()
  ]);

  const stoneCount = Number(countRow?.c || 0);
  const missingRepoCount = Number(missingRepoRow?.c || 0);
  const repos = (repoRows.results || []).map(row => row.repo).filter(Boolean);

  return {
    chain,
    canonical_head: headRow ? headRow.head_hash : null,
    repos,
    stone_count: stoneCount,
    path_head_count: Number(pathHeadCountRow?.c || 0),
    updated_at: headRow ? headRow.updated_at : (updatedAtRow?.latest || null),
    provenance_complete: missingRepoCount === 0
  };
}

export async function vaultCatalogFromBody(body, env) {
  requireBindings(env);
  const args = body && typeof body === "object" ? body : {};
  const limit = Math.max(1, Math.min(MAX_CATALOG_LIMIT, Number.isFinite(args.limit) ? Math.trunc(args.limit) : DEFAULT_CATALOG_LIMIT));
  const afterChain = typeof args.after_chain === "string" ? args.after_chain : null;
  const q = typeof args.q === "string" && args.q.length > 0 ? args.q.toLowerCase() : null;
  const repoFilter = typeof args.repo === "string" && args.repo.length > 0 ? args.repo : null;

  const { heads, chainNames } = await listAllKnownChains(env);

  let candidates = chainNames;
  if (afterChain) candidates = candidates.filter(chain => chain > afterChain);
  if (q) candidates = candidates.filter(chain => chain.toLowerCase().includes(q));

  const page = [];
  for (const chain of candidates) {
    if (page.length >= limit + 1) break; // +1 lookahead to compute has_more without a second pass
    const record = await loadCatalogRecord(env, chain, heads.get(chain) || null);
    if (repoFilter && !record.repos.includes(repoFilter)) continue;
    page.push(record);
    if (page.length > limit) break;
  }

  const hasMore = page.length > limit;
  const chains = hasMore ? page.slice(0, limit) : page;

  return {
    ok: true,
    schema: "cairnstone-vault-catalog-v1",
    chains,
    returned_count: chains.length,
    has_more: hasMore,
    next_after_chain: hasMore ? chains[chains.length - 1].chain : null,
    filters: { q: args.q || null, repo: repoFilter, after_chain: afterChain, limit }
  };
}

// -- cairnstone-scope-v1 resolution ------------------------------------

function normalizeScopeRequest(body) {
  const args = body && typeof body === "object" ? body : {};
  const mode = typeof args.mode === "string" ? args.mode : null;
  if (!mode || !SCOPE_MODES.includes(mode)) {
    return { ok: false, error: "invalid_scope_mode", allowed: SCOPE_MODES, received: mode };
  }
  const repos = dedupSortStrings(args.repos);
  const chains = dedupSortStrings(args.chains);
  const maxChains = Math.max(1, Math.min(MAX_VAULT_MAX_CHAINS, Number.isFinite(args.max_chains) ? Math.trunc(args.max_chains) : DEFAULT_VAULT_MAX_CHAINS));
  return { ok: true, schema: SCOPE_REQUEST_SCHEMA, mode, repos, chains, max_chains: maxChains };
}

async function chainExists(env, chain) {
  const headRow = await env.CAIRNSTONE_DB.prepare("SELECT head_hash FROM chain_heads WHERE chain = ?").bind(chain).first();
  if (headRow) return true;
  const stoneRow = await env.CAIRNSTONE_DB.prepare("SELECT hash FROM stones WHERE chain_hash = ? LIMIT 1").bind(chain).first();
  return Boolean(stoneRow);
}

async function chainsForRepo(env, repo) {
  const rows = await env.CAIRNSTONE_DB.prepare(
    "SELECT DISTINCT chain_hash AS chain FROM stones WHERE repo = ? AND chain_hash IS NOT NULL ORDER BY chain_hash ASC"
  ).bind(repo).all();
  return (rows.results || []).map(row => row.chain);
}

// Resolve request selectors into the ordered, deduplicated set of
// participating chains. Never touches chain_heads/path_heads/stones state.
async function resolveChainSet(env, normalized) {
  const { mode, repos, chains, max_chains } = normalized;

  if (mode === "single_chain") {
    if (chains.length !== 1) return { ok: false, error: "single_chain_requires_exactly_one_chain", chains };
    const [chain] = chains;
    if (!(await chainExists(env, chain))) return { ok: false, error: "chain_not_found", chain };
    return { ok: true, resolved: [chain], truncated: false };
  }

  if (mode === "repo") {
    if (repos.length !== 1) return { ok: false, error: "repo_mode_requires_exactly_one_repo", repos };
    const [repo] = repos;
    const resolved = await chainsForRepo(env, repo);
    if (resolved.length === 0) return { ok: false, error: "repo_not_found", repo };
    return { ok: true, resolved: dedupSortStrings(resolved), truncated: false };
  }

  if (mode === "multi") {
    if (repos.length === 0 && chains.length === 0) return { ok: false, error: "multi_requires_repos_or_chains" };
    for (const chain of chains) {
      if (!(await chainExists(env, chain))) return { ok: false, error: "chain_not_found", chain };
    }
    const fromRepos = [];
    for (const repo of repos) {
      const repoChains = await chainsForRepo(env, repo);
      if (repoChains.length === 0) return { ok: false, error: "repo_not_found", repo };
      fromRepos.push(...repoChains);
    }
    return { ok: true, resolved: dedupSortStrings([...chains, ...fromRepos]), truncated: false };
  }

  // mode === "vault"
  const { chainNames } = await listAllKnownChains(env);
  const truncated = chainNames.length > max_chains;
  return { ok: true, resolved: chainNames.slice(0, max_chains), truncated, full_count: chainNames.length };
}

async function readHeadsSnapshot(env, resolvedChains) {
  const rows = await Promise.all(
    resolvedChains.map(chain => env.CAIRNSTONE_DB.prepare("SELECT head_hash FROM chain_heads WHERE chain = ?").bind(chain).first())
  );
  const map = new Map();
  resolvedChains.forEach((chain, i) => map.set(chain, rows[i] ? rows[i].head_hash : null));
  return map;
}

export async function resolveScopeFromBody(body, env) {
  requireBindings(env);
  const normalized = normalizeScopeRequest(body);
  if (!normalized.ok) return normalized;

  const resolution = await resolveChainSet(env, normalized);
  if (!resolution.ok) return resolution;

  const resolvedChains = resolution.resolved;
  if (resolvedChains.length === 0) {
    return { ok: false, error: "scope_resolves_no_chains", mode: normalized.mode };
  }

  // Authority-first race discipline: read every participating chain HEAD
  // once, perform the (trivial, read-only) bounded operation, then re-read
  // before returning a result that claims snapshot consistency. If any
  // pointer moved mid-resolution, fail closed rather than silently mix
  // evidence from two authority snapshots.
  const firstSnapshot = await readHeadsSnapshot(env, resolvedChains);
  const secondSnapshot = await readHeadsSnapshot(env, resolvedChains);
  for (const chain of resolvedChains) {
    if (firstSnapshot.get(chain) !== secondSnapshot.get(chain)) {
      return {
        ok: false,
        error: "scope_compile_race",
        chain,
        first_head_hash: firstSnapshot.get(chain) || null,
        second_head_hash: secondSnapshot.get(chain) || null
      };
    }
  }

  const chainsPayload = resolvedChains.map(chain => ({ chain, head_hash: secondSnapshot.get(chain) || null }));

  const selectorPayload = {
    schema: normalized.schema,
    mode: normalized.mode,
    repos: normalized.repos,
    chains: normalized.chains,
    resolved_chains: resolvedChains
  };
  const authorityPayload = chainsPayload.map(item => ({ chain: item.chain, head_hash: item.head_hash })).sort((a, b) => a.chain.localeCompare(b.chain));

  const scopeId = "sha256:" + await sha256Text(stableJson(selectorPayload));
  const authorityDigest = "sha256:" + await sha256Text(stableJson(authorityPayload));

  const response = {
    ok: true,
    schema: SCOPE_SNAPSHOT_SCHEMA,
    mode: normalized.mode,
    chains: chainsPayload,
    scope_id: scopeId,
    authority_digest: authorityDigest
  };

  if (normalized.mode === "vault") {
    response.truncated = resolution.truncated;
    response.coverage = {
      resolved_count: resolvedChains.length,
      full_count: resolution.full_count,
      max_chains: normalized.max_chains
    };
  }

  return response;
}
