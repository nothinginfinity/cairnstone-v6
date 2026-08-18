import {
  buildRepoOrientationContent,
  buildArchitectureContent,
  buildLintContent,
  buildReviewContent,
  buildLanguageBreakdown,
  buildRepoFingerprint,
  detectArchitecture,
  liteLintAnalysis,
  reviewAnalysis,
  repoStoneShouldInclude,
  canonicalChain,
  buildHealthDashboard,
} from "./repo-stones-operation.js";

// ---------------------------------------------------------------------------
// createRepoStonesFromBody — main repository ingestion orchestrator.
// ---------------------------------------------------------------------------
export async function createRepoStonesFromBody(body, env, deps) {
  const required = [
    "createStoneFromGitHubBody", "createStoneFromBody", "linkStonesFromBody",
    "requireBindings", "requiredString", "safeGitHubPart", "safeGitHubRef", "clamp"
  ];
  for (const name of required) {
    if (typeof deps?.[name] !== "function") throw new Error(`Missing repo stones dependency: ${name}`);
  }

  deps.requireBindings(env);

  const owner = deps.safeGitHubPart(body.owner, "owner");
  const repo = deps.safeGitHubPart(body.repo, "repo");
  const ref = deps.safeGitHubRef(body.ref || "main");
  const author = deps.requiredString(body.author, "author");
  const chain = canonicalChain(owner, repo, body.chain);
  const maxFiles = deps.clamp(Number(body.max_files || 200), 1, 500);
  const repoFull = `${owner}/${repo}`;
  const reuseUnchanged = body.reuse_unchanged !== false;
  const linkSupersedes = body.link_supersedes !== false;
  const createArch = body.create_architecture !== false;
  const createLint = body.create_lint !== false;
  const createReview = body.create_review !== false;

  const priorIndex = await loadPriorRepoStoneIndex(env, { chain, repoFull });
  const treeResult = await fetchGitHubRepoTree({ owner, repo, ref }, env, deps);
  if (!treeResult.ok) return treeResult;

  const created = [], reused = [], updated = [], superseded = [], skipped = [], failed = [];

  // --- File filtering ---
  const accepted = [];
  for (const file of treeResult.files) {
    if (repoStoneShouldInclude(file.path, file.size, body)) {
      accepted.push(file);
    } else {
      skipped.push({ path: file.path, size: file.size, reason: "filtered" });
    }
  }

  const candidates = accepted.slice(0, maxFiles);
  for (const file of accepted.slice(maxFiles)) {
    skipped.push({ path: file.path, size: file.size, reason: "max_files_exceeded" });
  }

  // --- Stone each accepted file ---
  for (const file of candidates) {
    const prior = priorIndex.by_path.get(file.path) || null;

    // Incremental: reuse unchanged files
    if (reuseUnchanged && prior?.sha && prior.sha === file.sha) {
      reused.push({
        path: file.path, stone_hash: prior.stone_hash,
        refs: prior.refs, bytes: prior.bytes || file.size,
        sha: file.sha, reused_from: prior.stone_hash
      });
      continue;
    }

    const result = await deps.createStoneFromGitHubBody({
      owner, repo, ref, path: file.path, author, chain,
      title: `${repoFull} ${file.path}`,
      metadata: {
        kind: "repo_file", repo: repoFull, path: file.path,
        sha: file.sha, previous_sha: prior?.sha || null,
        previous_stone_hash: prior?.stone_hash || null,
        repo_stones_operation: true
      }
    }, env);

    if (!result.ok) {
      failed.push({ path: file.path, size: file.size, sha: file.sha, error: result.error || "stone_failed" });
      continue;
    }

    const item = {
      path: file.path, stone_hash: result.stone_hash, refs: result.refs,
      bytes: result.receipt?.original_bytes || file.size, sha: file.sha
    };
    created.push(item);

    // Supersedes edge for updated files
    if (prior?.stone_hash && prior.stone_hash !== result.stone_hash) {
      updated.push({ ...item, previous_stone_hash: prior.stone_hash, previous_sha: prior.sha || null });
      if (linkSupersedes) {
        const edge = await deps.linkStonesFromBody({
          from_hash: result.stone_hash, to_hash: prior.stone_hash,
          edge_type: "supersedes",
          note: `${file.path} supersedes previous SHA ${prior.sha || "unknown"}`
        }, env);
        if (edge.ok) superseded.push({ path: file.path, from_hash: result.stone_hash, to_hash: prior.stone_hash, edge_id: edge.id });
      }
    }
  }

  const current = [...created, ...reused];
  const langBreakdown = buildLanguageBreakdown(candidates);
  const arch = detectArchitecture(treeResult.files);

  // Compute compression ratio from created stones
  const totalOrigBytes = created.reduce((n, c) => n + (c.bytes || 0), 0);
  const compressionRatio = 0; // will be enriched by receipt data if needed

  const fingerprint = buildRepoFingerprint({
    owner, repo, ref,
    languages: langBreakdown.map(l => l.lang),
    frameworks: arch.frameworks,
    configs: arch.configs,
    stoneCount: current.length,
    fileCount: accepted.length,
    compressionRatio,
  });

  const summary = { owner, repo, ref, chain, created, reused, updated, skipped, failed, architecture: arch, language_breakdown: langBreakdown, fingerprint };

  // --- Orientation stone ---
  let orientation = null;
  let orientationSuperseded = null;
  if (body.create_orientation !== false) {
    orientation = await deps.createStoneFromBody({
      title: `${repoFull} repository orientation`,
      author, chain,
      content: buildRepoOrientationContent(summary),
      metadata: {
        kind: "repo_orientation", repo: repoFull, ref,
        previous_head_hash: priorIndex.previous_head_hash,
        previous_orientation_hash: priorIndex.previous_orientation?.stone_hash || null,
        repo_stones_operation: true,
        fingerprint
      },
      set_as_head: body.set_head !== false
    }, env);

    const priorOrientationHash = priorIndex.previous_orientation?.stone_hash || priorIndex.previous_head_hash || null;
    if (orientation?.ok && linkSupersedes && priorOrientationHash && priorOrientationHash !== orientation.stone_hash) {
      const edge = await deps.linkStonesFromBody({
        from_hash: orientation.stone_hash, to_hash: priorOrientationHash,
        edge_type: "supersedes",
        note: `Orientation for ${repoFull}@${ref} supersedes previous`
      }, env);
      if (edge.ok) orientationSuperseded = { from_hash: orientation.stone_hash, to_hash: priorOrientationHash, edge_id: edge.id };
    }
  }

  // --- Auto-link orientation -> file stones ---
  let linked = 0;
  if (orientation?.ok && body.auto_link !== false) {
    for (const item of current) {
      const edge = await deps.linkStonesFromBody({
        from_hash: orientation.stone_hash, to_hash: item.stone_hash,
        edge_type: "documents",
        note: `Orientation documents ${item.path}`
      }, env);
      if (edge.ok) linked += 1;
    }
  }

  // --- Architecture stone ---
  let architectureStone = null;
  if (createArch && orientation?.ok) {
    architectureStone = await deps.createStoneFromBody({
      title: `${repoFull} architecture`,
      author, chain,
      content: buildArchitectureContent(summary, arch),
      metadata: {
        kind: "repo_architecture", repo: repoFull, ref,
        repo_stones_operation: true,
        orientation_hash: orientation.stone_hash
      },
      set_as_head: false
    }, env);
    // Architecture documents orientation
    if (architectureStone?.ok && orientation?.ok) {
      await deps.linkStonesFromBody({
        from_hash: architectureStone.stone_hash, to_hash: orientation.stone_hash,
        edge_type: "documents", note: `Architecture documents repository orientation for ${repoFull}`
      }, env);
    }
    // Architecture documents each file stone
    if (architectureStone?.ok && body.auto_link !== false) {
      for (const item of current.slice(0, 50)) {
        await deps.linkStonesFromBody({
          from_hash: architectureStone.stone_hash, to_hash: item.stone_hash,
          edge_type: "documents", note: `Architecture documents ${item.path}`
        }, env);
      }
    }
  }

  // --- Lint stone (pattern-based for non-JS files; JS/TS uses existing lint tool) ---
  let lintStone = null;
  const lintResults = [];
  if (createLint && current.length > 0) {
    // We can only run lite lint on files we have content for in created (not reused)
    // For reused files we skip content-based lint
    for (const item of created.slice(0, 30)) {
      const ext = item.path.split(".").pop().toLowerCase();
      if (["py", "pyw", "go", "rs"].includes(ext)) {
        // Fetch content for lite lint
        try {
          const raw = await fetchRawFromEnv(env, item.stone_hash);
          if (raw) {
            const errors = liteLintAnalysis(item.path, raw);
            if (errors.length) lintResults.push({ path: item.path, stone_hash: item.stone_hash, errors });
          }
        } catch (_) { /* non-fatal */ }
      }
    }
    lintStone = await deps.createStoneFromBody({
      title: `${repoFull} lint report`,
      author, chain,
      content: buildLintContent(summary, lintResults),
      metadata: {
        kind: "repo_lint", repo: repoFull, ref,
        repo_stones_operation: true,
        issue_count: lintResults.reduce((n, r) => n + r.errors.length, 0)
      },
      set_as_head: false
    }, env);
    if (lintStone?.ok && orientation?.ok) {
      await deps.linkStonesFromBody({
        from_hash: lintStone.stone_hash, to_hash: orientation.stone_hash,
        edge_type: "reviews", note: `Lint report reviews ${repoFull} orientation`
      }, env);
    }
  }

  // --- Review stone ---
  let reviewStone = null;
  const reviewResults = [];
  if (createReview && current.length > 0) {
    for (const item of created.slice(0, 30)) {
      try {
        const raw = await fetchRawFromEnv(env, item.stone_hash);
        if (raw) {
          const observations = reviewAnalysis(item.path, raw);
          if (observations.length) reviewResults.push({ path: item.path, stone_hash: item.stone_hash, observations });
        }
      } catch (_) { /* non-fatal */ }
    }
    reviewStone = await deps.createStoneFromBody({
      title: `${repoFull} code review`,
      author, chain,
      content: buildReviewContent(summary, reviewResults),
      metadata: {
        kind: "repo_review", repo: repoFull, ref,
        repo_stones_operation: true,
        observation_count: reviewResults.reduce((n, r) => n + r.observations.length, 0)
      },
      set_as_head: false
    }, env);
    if (reviewStone?.ok && orientation?.ok) {
      await deps.linkStonesFromBody({
        from_hash: reviewStone.stone_hash, to_hash: orientation.stone_hash,
        edge_type: "reviews", note: `Review reviews ${repoFull} orientation`
      }, env);
    }
    // Review -> file stones
    if (reviewStone?.ok) {
      for (const r of reviewResults.slice(0, 20)) {
        await deps.linkStonesFromBody({
          from_hash: reviewStone.stone_hash, to_hash: r.stone_hash,
          edge_type: "reviews", note: `Review reviews ${r.path}`
        }, env);
      }
    }
  }

  return {
    ok: true, owner, repo, ref, chain,
    previous_head_hash: priorIndex.previous_head_hash,
    previous_orientation_hash: priorIndex.previous_orientation?.stone_hash || null,
    created_count: created.length, reused_count: reused.length,
    updated_count: updated.length, superseded_count: superseded.length,
    skipped_count: skipped.length, failed_count: failed.length,
    linked_count: linked,
    orientation_hash: orientation?.stone_hash || null,
    architecture_hash: architectureStone?.stone_hash || null,
    lint_hash: lintStone?.stone_hash || null,
    review_hash: reviewStone?.stone_hash || null,
    orientation_superseded: orientationSuperseded,
    head_hash: orientation?.stone_hash || null,
    truncated: treeResult.truncated,
    language_breakdown: langBreakdown,
    fingerprint,
    created, reused, updated, superseded, skipped, failed,
    lint_issues: lintResults,
    review_observations: reviewResults,
  };
}

// ---------------------------------------------------------------------------
// Helper: fetch raw content for a stone by hash from R2.
// ---------------------------------------------------------------------------
async function fetchRawFromEnv(env, stoneHash) {
  if (!env?.CAIRNSTONE_DB || !env?.CAIRNSTONE_RAW) return null;
  const row = await env.CAIRNSTONE_DB.prepare("SELECT raw_key FROM stones WHERE hash = ?").bind(stoneHash).first();
  if (!row?.raw_key) return null;
  const obj = await env.CAIRNSTONE_RAW.get(row.raw_key);
  if (!obj) return null;
  return obj.text();
}

// ---------------------------------------------------------------------------
// loadPriorRepoStoneIndex — build incremental update index from existing chain.
// ---------------------------------------------------------------------------
async function loadPriorRepoStoneIndex(env, { chain, repoFull }) {
  const result = { previous_head_hash: null, previous_orientation: null, by_path: new Map() };
  if (!env?.CAIRNSTONE_DB || !chain || !repoFull) return result;

  const headRow = await env.CAIRNSTONE_DB.prepare("SELECT head_hash FROM chain_heads WHERE chain = ?").bind(chain).first();
  result.previous_head_hash = headRow?.head_hash || null;

  const rows = await env.CAIRNSTONE_DB.prepare(
    "SELECT hash,created_at,stone_json FROM stones WHERE chain_hash = ? ORDER BY created_at ASC"
  ).bind(chain).all();

  for (const row of rows.results || []) {
    let stone = null;
    try { stone = JSON.parse(row.stone_json || "null"); } catch { continue; }
    const metadata = stone?.metadata || {};
    if (metadata.repo !== repoFull || metadata.repo_stones_operation !== true) continue;
    if (metadata.kind === "repo_orientation") {
      result.previous_orientation = { stone_hash: row.hash, created_at: row.created_at, ref: metadata.ref || null };
      continue;
    }
    if (metadata.kind !== "repo_file" || !metadata.path) continue;
    result.by_path.set(metadata.path, {
      stone_hash: row.hash, created_at: row.created_at, path: metadata.path,
      sha: metadata.sha || null,
      refs: stone?.layers?.lod2?.compressed_index?.length || null,
      bytes: stone?.layers?.lod1?.raw_bytes || null
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// getRepoHealth — repository health dashboard.
// ---------------------------------------------------------------------------
export async function getRepoHealth(chain, env) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_bindings" };
  if (!chain) return { ok: false, error: "missing_chain" };

  const headRow = await env.CAIRNSTONE_DB.prepare("SELECT head_hash, updated_at FROM chain_heads WHERE chain = ?").bind(chain).first();
  const stoneRows = await env.CAIRNSTONE_DB.prepare(
    "SELECT hash, stone_json FROM stones WHERE chain_hash = ? ORDER BY created_at ASC"
  ).bind(chain).all();

  let fileCount = 0, stoneCount = 0, refCount = 0;
  let hasReview = false, hasLint = false, hasArchitecture = false;
  let langBreakdown = [], fingerprint = null, lastCommit = null;
  let totalOrigBytes = 0, totalCompBytes = 0;

  const hashes = stoneRows.results.map(r => r.hash);
  for (const row of stoneRows.results) {
    stoneCount++;
    let stone = {};
    try { stone = JSON.parse(row.stone_json || "{}"); } catch { continue; }
    const meta = stone.metadata || {};
    if (meta.kind === "repo_file") fileCount++;
    if (meta.kind === "repo_review") hasReview = true;
    if (meta.kind === "repo_lint") hasLint = true;
    if (meta.kind === "repo_architecture") hasArchitecture = true;
    if (meta.kind === "repo_orientation" && meta.fingerprint) {
      fingerprint = meta.fingerprint;
      langBreakdown = (fingerprint.languages || []).map(l => ({ lang: l }));
      lastCommit = fingerprint.head_commit || null;
    }
    const receipt = stone.layers?.lod2?.receipt;
    if (receipt) { totalOrigBytes += receipt.original_bytes || 0; totalCompBytes += receipt.compressed_bytes || 0; }
  }

  // Count refs
  if (hashes.length > 0) {
    for (const batch of chunkArray(hashes, 40)) {
      const placeholders = batch.map(() => "?").join(",");
      const refRows = await env.CAIRNSTONE_DB.prepare(`SELECT COUNT(*) as n FROM refs WHERE stone_hash IN (${placeholders})`).bind(...batch).first();
      refCount += Number(refRows?.n || 0);
    }
  }

  // Graph density = edges / nodes
  const edgeRow = await env.CAIRNSTONE_DB.prepare(
    `SELECT COUNT(*) as n FROM stone_edges WHERE from_hash IN (${hashes.length ? hashes.map(() => "?").join(",") : "''"})`
  ).bind(...(hashes.length ? hashes : ["''"])).first().catch(() => ({ n: 0 }));
  const edgeCount = Number(edgeRow?.n || 0);
  const graphDensity = stoneCount > 1 ? Number((edgeCount / stoneCount).toFixed(2)) : 0;
  const compressionRatio = totalCompBytes > 0 ? Number((totalOrigBytes / totalCompBytes).toFixed(2)) : 0;

  const [ownerPart, repoPart] = chain.includes("/") ? chain.split("/") : ["", chain];

  return {
    ok: true,
    ...buildHealthDashboard({
      chain,
      owner: ownerPart, repo: repoPart, ref: fingerprint?.default_branch || "main",
      langBreakdown, fileCount, stoneCount, refCount,
      compressionRatio, graphDensity,
      hasReview, hasLint, hasArchitecture,
      lastIndexedCommit: lastCommit, fingerprint
    }),
    head_hash: headRow?.head_hash || null,
    head_updated_at: headRow?.updated_at || null,
    edge_count: edgeCount,
  };
}

// ---------------------------------------------------------------------------
// fetchGitHubRepoTree — fetch recursive file tree from GitHub API.
// ---------------------------------------------------------------------------
export async function fetchGitHubRepoTree(spec, env, deps = {}) {
  const safeGitHubPart = deps.safeGitHubPart || ((value) => String(value || "").trim());
  const safeGitHubRef = deps.safeGitHubRef || ((value) => String(value || "main").trim());
  const owner = safeGitHubPart(spec.owner, "owner");
  const repo = safeGitHubPart(spec.repo, "repo");
  const ref = safeGitHubRef(spec.ref || "main");
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const headers = { "User-Agent": "cairnstone-v5-worker", "Accept": "application/vnd.github+json" };
  if (env?.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    return { ok: false, error: "github_tree_fetch_failed", status: response.status, status_text: response.statusText, github: { owner, repo, ref } };
  }

  const data = await response.json();
  return {
    ok: true, owner, repo, ref,
    truncated: Boolean(data.truncated),
    files: (data.tree || []).filter((item) => item.type === "blob").map((item) => ({ path: item.path, size: item.size || 0, sha: item.sha }))
  };
}

// ---------------------------------------------------------------------------
// getExtendedChainManifest — manifest with arch/lint/review hashes + fingerprint.
// ---------------------------------------------------------------------------
export async function getExtendedChainManifest(chain, env, queryEdgesByHashes) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_bindings" };

  const headRow = await env.CAIRNSTONE_DB.prepare("SELECT head_hash, updated_at FROM chain_heads WHERE chain = ?").bind(chain).first();
  const stoneRows = await env.CAIRNSTONE_DB.prepare(
    "SELECT hash,title,author,created_at,stone_json FROM stones WHERE chain_hash = ? ORDER BY created_at ASC"
  ).bind(chain).all();

  const hashes = stoneRows.results.map(r => r.hash);
  const edges = await queryEdgesByHashes(hashes);

  let orientationHash = null, architectureHash = null, lintHash = null, reviewHash = null;
  let fingerprint = null, fileCount = 0;
  const nodes = stoneRows.results.map(row => {
    let stone = {};
    try { stone = JSON.parse(row.stone_json || "{}"); } catch {}
    const meta = stone.metadata || {};
    if (meta.kind === "repo_orientation") { orientationHash = row.hash; fingerprint = meta.fingerprint || null; }
    if (meta.kind === "repo_architecture") architectureHash = row.hash;
    if (meta.kind === "repo_lint") lintHash = row.hash;
    if (meta.kind === "repo_review") reviewHash = row.hash;
    if (meta.kind === "repo_file") fileCount++;
    return {
      hash: row.hash, short_hash: row.hash.slice(0, 12),
      title: row.title, author: row.author, created_at: row.created_at,
      is_head: headRow ? headRow.head_hash === row.hash : false,
      kind: meta.kind || "stone",
      lod5: stone.layers?.lod5 || ""
    };
  });

  return {
    ok: true, chain,
    head_hash: headRow?.head_hash || null,
    head_updated_at: headRow?.updated_at || null,
    orientation_hash: orientationHash,
    architecture_hash: architectureHash,
    lint_hash: lintHash,
    review_hash: reviewHash,
    stone_count: nodes.length,
    file_count: fileCount,
    edge_count: edges.length,
    fingerprint,
    graph_complete: true,
    nodes, edges
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
