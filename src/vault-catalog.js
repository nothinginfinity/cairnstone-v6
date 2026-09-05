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

// V7.7.1 bounded multi-chain search limits. These are deliberately explicit
// so vault/repo/multi searches cannot turn Scope into an unbounded context
// dump. Candidate fairness is enforced per participating chain below.
const DEFAULT_SCOPE_TOP_K = 10;
const MAX_SCOPE_TOP_K = 50;
const DEFAULT_PER_CHAIN_CANDIDATES = 5;
const MAX_PER_CHAIN_CANDIDATES = 25;
const DEFAULT_MAX_SCOPE_CANDIDATES = 200;
const MAX_SCOPE_CANDIDATES = 500;
const DEFAULT_MAX_SCOPE_EXPANSIONS = 3;
const MAX_SCOPE_EXPANSIONS = 10;
const DEFAULT_MAX_EXPANDED_BYTES = 20000;
const MAX_EXPANDED_BYTES = 100000;
const DEFAULT_SCOPE_CONTEXT_LINES = 20;
const MAX_SCOPE_CONTEXT_LINES = 200;
const SCOPE_MATCH_MODES = ["any", "all", "phrase"];
const SCOPE_FTS_BM25_WEIGHTS = "0, 0, 0, 2.0, 4.0, 1.0";

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

export const SCOPE_FIND_TOOL_DEFINITION = {
  name: "cairnstone_find_scope",
  description:
    "V7.7.1: server-side scope-aware deterministic search across a cairnstone-scope-v1 selection. Resolves the exact participating chain HEAD snapshot, retrieves a bounded candidate pool per chain, merges fairly by per-chain textual rank with explicit authority classification, preserves repo/chain/stone/ref/path/immutable-commit provenance, optionally expands only bounded winners, and re-checks every participating chain HEAD before returning. Fails closed with scope_compile_race on authority movement. Vault/multi limits return coverage diagnostics instead of implying exhaustive search. Read-only with respect to accepted CairnStone state.",
  inputSchema: {
    type: "object",
    required: ["query", "scope"],
    properties: {
      query: { type: "string" },
      scope: {
        type: "object",
        required: ["mode"],
        properties: {
          schema: { type: "string" },
          mode: { type: "string", enum: SCOPE_MODES },
          repos: { type: "array", items: { type: "string" } },
          chains: { type: "array", items: { type: "string" } },
          max_chains: { type: "integer", minimum: 1, maximum: MAX_VAULT_MAX_CHAINS }
        },
        additionalProperties: false
      },
      top_k: { type: "integer", minimum: 1, maximum: MAX_SCOPE_TOP_K },
      per_chain_k: { type: "integer", minimum: 1, maximum: MAX_PER_CHAIN_CANDIDATES },
      max_total_candidates: { type: "integer", minimum: 1, maximum: MAX_SCOPE_CANDIDATES },
      match_mode: { type: "string", enum: SCOPE_MATCH_MODES },
      expand: { type: "boolean" },
      max_expansions: { type: "integer", minimum: 0, maximum: MAX_SCOPE_EXPANSIONS },
      max_expanded_bytes: { type: "integer", minimum: 1, maximum: MAX_EXPANDED_BYTES },
      context_lines: { type: "integer", minimum: 0, maximum: MAX_SCOPE_CONTEXT_LINES }
    },
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

// -- V7.7.1 scope-aware deterministic search -------------------------------

const SCOPE_SEARCH_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
  "have", "has", "not", "you", "your", "but", "can", "will", "all", "into",
  "our", "out", "use", "using", "true", "false", "null"
]);

function clampScopeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function tokenizeScopeQuery(query) {
  const terms = [];
  const seen = new Set();
  for (const match of String(query || "").toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) {
    const term = match[0];
    if (SCOPE_SEARCH_STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function buildScopeMatchExpr(query, matchMode) {
  const trimmed = String(query || "").trim();
  const isFullyQuoted = trimmed.length > 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  if (isFullyQuoted || matchMode === "phrase") {
    const phraseText = (isFullyQuoted ? trimmed.slice(1, -1) : trimmed).trim();
    if (!phraseText) return { ok: false, error: "empty_query_terms" };
    return { ok: true, match_expr: `"${phraseText.replaceAll('"', '""')}"`, mode: "phrase" };
  }
  const terms = tokenizeScopeQuery(trimmed);
  if (!terms.length) return { ok: false, error: "empty_query_terms" };
  const quoted = terms.map(term => `"${String(term).replaceAll('"', '""')}"`);
  if (matchMode === "all") return { ok: true, match_expr: quoted.join(" AND "), mode: "all" };
  return { ok: true, match_expr: quoted.join(" OR "), mode: "any" };
}

function roundScopeScore(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000000) / 1000000
    : null;
}

async function queryScopeChainCandidates(env, { chain, query, matchExpr, limit, repos = [] }) {
  const repoFilters = dedupSortStrings(repos);
  try {
    let sql = `SELECT refs_fts.ref_id AS ref_id, refs_fts.stone_hash AS stone_hash, refs_fts.chain AS chain,
      refs_fts.path AS path, refs_fts.preview AS preview,
      bm25(refs_fts, ${SCOPE_FTS_BM25_WEIGHTS}) AS score,
      s.repo AS repo, s.commit_sha AS commit_sha
      FROM refs_fts LEFT JOIN stones s ON s.hash = refs_fts.stone_hash
      WHERE refs_fts MATCH ? AND refs_fts.chain = ?`;
    const binds = [matchExpr, chain];
    if (repoFilters.length) {
      sql += ` AND s.repo IN (${repoFilters.map(() => "?").join(",")})`;
      binds.push(...repoFilters);
    }
    sql += ` ORDER BY bm25(refs_fts, ${SCOPE_FTS_BM25_WEIGHTS}) ASC, refs_fts.ref_id ASC LIMIT ?`;
    binds.push(limit);
    const rows = await env.CAIRNSTONE_DB.prepare(sql).bind(...binds).all();
    return { mode: "fts", rows: rows.results || [] };
  } catch {
    const like = `%${String(query).toLowerCase().replaceAll("%", "").replaceAll("_", "")}%`;
    let sql = `SELECT r.ref_id AS ref_id, r.stone_hash AS stone_hash, s.chain_hash AS chain,
      r.path AS path, r.preview AS preview, 0 AS score,
      s.repo AS repo, s.commit_sha AS commit_sha
      FROM refs r LEFT JOIN stones s ON s.hash = r.stone_hash
      WHERE (LOWER(r.keywords) LIKE ? OR LOWER(r.preview) LIKE ?) AND s.chain_hash = ?`;
    const binds = [like, like, chain];
    if (repoFilters.length) {
      sql += ` AND s.repo IN (${repoFilters.map(() => "?").join(",")})`;
      binds.push(...repoFilters);
    }
    sql += " ORDER BY r.ref_id ASC LIMIT ?";
    binds.push(limit);
    const rows = await env.CAIRNSTONE_DB.prepare(sql).bind(...binds).all();
    return { mode: "like_fallback", rows: rows.results || [] };
  }
}

async function scopeAuthorityClass(env, row, chainHeadHash) {
  if (chainHeadHash && row.stone_hash === chainHeadHash) return { authority_class: "CHAIN_HEAD", authority_rank: 0 };
  const pathHead = await env.CAIRNSTONE_DB.prepare(
    "SELECT head_hash FROM path_heads WHERE chain = ? AND path = ?"
  ).bind(row.chain, row.path).first();
  if (pathHead && pathHead.head_hash === row.stone_hash) return { authority_class: "PATH_HEAD", authority_rank: 1 };
  return { authority_class: "HISTORICAL", authority_rank: 2 };
}

function scopeCandidateCompare(a, b) {
  if (a.ranking.chain_rank !== b.ranking.chain_rank) return a.ranking.chain_rank - b.ranking.chain_rank;
  if (a.ranking.authority_rank !== b.ranking.authority_rank) return a.ranking.authority_rank - b.ranking.authority_rank;
  const aScore = a.ranking.textual_score === null ? 0 : a.ranking.textual_score;
  const bScore = b.ranking.textual_score === null ? 0 : b.ranking.textual_score;
  if (aScore !== bScore) return aScore - bScore;
  const chainCmp = a.chain.localeCompare(b.chain);
  if (chainCmp) return chainCmp;
  const stoneCmp = a.stone_hash.localeCompare(b.stone_hash);
  if (stoneCmp) return stoneCmp;
  return a.ref_id.localeCompare(b.ref_id);
}

async function expandScopeCandidate(env, candidate, contextLines, maxBytes) {
  const refRow = await env.CAIRNSTONE_DB.prepare(
    "SELECT raw_key,line_start,line_end FROM refs WHERE ref_id = ?"
  ).bind(candidate.ref_id).first();
  if (!refRow) return { ok: false, error: "ref_not_found", ref_id: candidate.ref_id };
  if (!env.CAIRNSTONE_RAW) return { ok: false, error: "missing_cairnstone_raw_binding", ref_id: candidate.ref_id };
  const raw = await env.CAIRNSTONE_RAW.get(refRow.raw_key);
  if (!raw) return { ok: false, error: "raw_not_found", ref_id: candidate.ref_id };
  const source = await raw.text();
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, Number(refRow.line_start) - contextLines);
  const end = Math.min(lines.length, Number(refRow.line_end) + contextLines);
  const fullText = lines.slice(start - 1, end).join("\n");
  const encoded = new TextEncoder().encode(fullText);
  const clipped = encoded.length > maxBytes ? encoded.slice(0, maxBytes) : encoded;
  const text = new TextDecoder().decode(clipped);
  return {
    ok: true,
    ref_id: candidate.ref_id,
    stone_hash: candidate.stone_hash,
    chain: candidate.chain,
    repo: candidate.repo,
    path: candidate.path,
    commit_sha: candidate.commit_sha,
    authority_class: candidate.authority_class,
    line_start: start,
    line_end: end,
    bytes: clipped.length,
    truncated: clipped.length < encoded.length,
    text
  };
}

export async function findScopeFromBody(body, env) {
  requireBindings(env);
  const args = body && typeof body === "object" ? body : {};
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { ok: false, error: "missing_query" };
  if (!args.scope || typeof args.scope !== "object" || Array.isArray(args.scope)) {
    return { ok: false, error: "missing_scope" };
  }

  const matchMode = SCOPE_MATCH_MODES.includes(args.match_mode) ? args.match_mode : "any";
  const built = buildScopeMatchExpr(query, matchMode);
  if (!built.ok) return built;

  const normalizedScope = normalizeScopeRequest(args.scope);
  if (!normalizedScope.ok) return { ...normalizedScope, stage: "scope_resolution" };
  const scopeSnapshot = await resolveScopeFromBody(normalizedScope, env);
  if (!scopeSnapshot.ok) return { ...scopeSnapshot, stage: "scope_resolution" };

  const explicitChains = new Set(normalizedScope.chains);
  const repoFiltersForChain = chain => {
    if (normalizedScope.mode === "repo") return normalizedScope.repos;
    if (normalizedScope.mode === "multi" && !explicitChains.has(chain)) return normalizedScope.repos;
    return [];
  };

  const topK = clampScopeInteger(args.top_k, DEFAULT_SCOPE_TOP_K, 1, MAX_SCOPE_TOP_K);
  const requestedPerChain = clampScopeInteger(args.per_chain_k, DEFAULT_PER_CHAIN_CANDIDATES, 1, MAX_PER_CHAIN_CANDIDATES);
  const maxTotalCandidates = clampScopeInteger(args.max_total_candidates, DEFAULT_MAX_SCOPE_CANDIDATES, 1, MAX_SCOPE_CANDIDATES);
  const allChains = scopeSnapshot.chains.map(item => item.chain);
  const maxQueriedChains = Math.min(allChains.length, maxTotalCandidates);
  const queriedChains = allChains.slice(0, maxQueriedChains);
  const skippedChains = allChains.slice(maxQueriedChains);
  const effectivePerChain = Math.max(1, Math.min(requestedPerChain, Math.floor(maxTotalCandidates / Math.max(1, queriedChains.length))));
  const headByChain = new Map(scopeSnapshot.chains.map(item => [item.chain, item.head_hash || null]));

  const candidates = [];
  const chainDiagnostics = [];
  for (let offset = 0; offset < queriedChains.length; offset += 10) {
    const batch = queriedChains.slice(offset, offset + 10);
    const batchResults = await Promise.all(batch.map(chain => queryScopeChainCandidates(env, {
      chain,
      query,
      matchExpr: built.match_expr,
      limit: effectivePerChain,
      repos: repoFiltersForChain(chain)
    })));
    for (let index = 0; index < batch.length; index += 1) {
      const chain = batch[index];
      const result = batchResults[index];
      chainDiagnostics.push({
        chain,
        search_mode: result.mode,
        repo_filter: repoFiltersForChain(chain),
        candidates: result.rows.length,
        candidate_limit_reached: result.rows.length >= effectivePerChain
      });
      for (let rowIndex = 0; rowIndex < result.rows.length; rowIndex += 1) {
        const row = result.rows[rowIndex];
        const authority = await scopeAuthorityClass(env, row, headByChain.get(chain));
        candidates.push({
          chain,
          repo: row.repo || null,
          repos: row.repo ? [row.repo] : [],
          stone_hash: row.stone_hash,
          stone: String(row.stone_hash || "").slice(0, 12),
          ref_id: row.ref_id,
          ref: row.ref_id,
          path: row.path || null,
          commit_sha: row.commit_sha || null,
          authority_class: authority.authority_class,
          ranking: {
            chain_rank: rowIndex + 1,
            textual_score: roundScopeScore(row.score),
            authority_rank: authority.authority_rank
          },
          preview: String(row.preview || "").slice(0, 160)
        });
      }
    }
  }

  candidates.sort(scopeCandidateCompare);
  const matches = candidates.slice(0, topK);

  const maxExpansions = clampScopeInteger(args.max_expansions, DEFAULT_MAX_SCOPE_EXPANSIONS, 0, MAX_SCOPE_EXPANSIONS);
  const maxExpandedBytes = clampScopeInteger(args.max_expanded_bytes, DEFAULT_MAX_EXPANDED_BYTES, 1, MAX_EXPANDED_BYTES);
  const contextLines = clampScopeInteger(args.context_lines, DEFAULT_SCOPE_CONTEXT_LINES, 0, MAX_SCOPE_CONTEXT_LINES);
  const expanded = [];
  let expansionBytes = 0;
  let expansionTruncated = false;
  if (args.expand === true && matches.length && maxExpansions > 0) {
    for (const match of matches.slice(0, maxExpansions)) {
      const remaining = maxExpandedBytes - expansionBytes;
      if (remaining <= 0) {
        expansionTruncated = true;
        break;
      }
      const item = await expandScopeCandidate(env, match, contextLines, remaining);
      if (!item.ok) return item;
      expanded.push(item);
      expansionBytes += item.bytes;
      if (item.truncated) {
        expansionTruncated = true;
        break;
      }
    }
    if (matches.length > expanded.length && expanded.length >= maxExpansions) expansionTruncated = true;
  }

  const finalHeads = await readHeadsSnapshot(env, allChains);
  for (const item of scopeSnapshot.chains) {
    const observed = finalHeads.get(item.chain) || null;
    const expected = item.head_hash || null;
    if (observed !== expected) {
      return {
        ok: false,
        error: "scope_compile_race",
        phase: "post_search",
        chain: item.chain,
        first_head_hash: expected,
        second_head_hash: observed,
        scope_id: scopeSnapshot.scope_id,
        authority_digest: scopeSnapshot.authority_digest
      };
    }
  }

  const candidateLimitReached = chainDiagnostics.some(item => item.candidate_limit_reached);
  const scopeTruncated = scopeSnapshot.truncated === true;
  const coverageComplete = !scopeTruncated && skippedChains.length === 0 && !candidateLimitReached && !expansionTruncated;
  const coverage = {
    resolved_chain_count: allChains.length,
    queried_chain_count: queriedChains.length,
    skipped_chains: skippedChains,
    requested_per_chain_k: requestedPerChain,
    effective_per_chain_k: effectivePerChain,
    max_total_candidates: maxTotalCandidates,
    candidates_considered: candidates.length,
    matched_chain_count: new Set(matches.map(item => item.chain)).size,
    matches_returned: matches.length,
    scope_truncated: scopeTruncated,
    candidate_limit_reached: candidateLimitReached,
    expansion_requested: args.expand === true,
    expansions_returned: expanded.length,
    expansion_bytes: expansionBytes,
    max_expanded_bytes: maxExpandedBytes,
    expansion_truncated: expansionTruncated,
    complete: coverageComplete,
    per_chain: chainDiagnostics
  };

  return {
    ok: true,
    schema: "cairnstone-scope-search-v1",
    query,
    match_mode: built.mode,
    scope_snapshot: scopeSnapshot,
    ranking_policy: {
      candidate_pool: "bounded_per_chain",
      textual_evidence: "fts5_bm25_with_find_v2_weights",
      fairness: "merge_by_per_chain_rank_before_next_rank",
      authority_preference: "CHAIN_HEAD_then_PATH_HEAD_then_HISTORICAL_within_equal_chain_rank",
      deterministic_tiebreak: ["chain_rank", "authority_rank", "textual_score", "chain", "stone_hash", "ref_id"]
    },
    total: matches.length,
    matches,
    ...(args.expand === true ? { expanded } : {}),
    coverage,
    read_only: {
      chain_heads_written: false,
      path_heads_written: false,
      stones_written: false,
      edges_written: false
    }
  };
}
