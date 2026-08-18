# Repo Stones Implementation Handoff

## Goal

Add a live CairnStone V5 operation named:

```text
cairnstone_create_repo_stones
```

This operation should ingest an entire GitHub repository into a CairnStone chain.

## Current progress

Committed scaffolding:

- `docs/REPO_STONES_OPERATION.md`
- `docs/REPO_STONES_PATCH_CHECKLIST.md`
- `examples/create-repo-stones.json`
- `src/repo-stones-operation.js`

## Current limitation

The live Worker entrypoint `src/index.js` has not yet been patched. The operation is specified and helper logic exists, but it is not exposed through REST or MCP until `src/index.js` is wired.

## Recommended next code patch

Patch `src/index.js` directly, preferably by importing helper functions from `src/repo-stones-operation.js` if the build/deploy pipeline supports module imports.

If the Worker build currently expects a single-file entrypoint, inline the helper functions instead of importing.

## Core implementation sketch

```js
async function createRepoStonesFromBody(body, env) {
  requireBindings(env);
  const owner = safeGitHubPart(body.owner, "owner");
  const repo = safeGitHubPart(body.repo, "repo");
  const ref = safeGitHubRef(body.ref || DEFAULT_GITHUB_REF);
  const author = requiredString(body.author, "author");
  const chain = body.chain || repo;
  const maxFiles = clamp(Number(body.max_files || 200), 1, 500);

  const treeResult = await fetchGitHubRepoTree({ owner, repo, ref }, env);
  if (!treeResult.ok) return treeResult;

  const created = [];
  const skipped = [];
  const failed = [];

  const candidates = treeResult.files.filter((file) => repoStoneShouldInclude(file.path, file.size, body)).slice(0, maxFiles);

  for (const file of candidates) {
    const result = await createStoneFromGitHubBody({
      owner,
      repo,
      ref,
      path: file.path,
      author,
      chain,
      title: `${repo} ${file.path}`,
      metadata: {
        kind: "repo_file",
        repo: `${owner}/${repo}`,
        path: file.path,
        repo_stones_operation: true
      }
    }, env);

    if (result.ok) {
      created.push({ path: file.path, stone_hash: result.stone_hash, refs: result.refs, bytes: result.receipt?.original_bytes || file.size });
    } else {
      failed.push({ path: file.path, error: result.error || "stone_failed" });
    }
  }

  const summary = { owner, repo, ref, chain, created, skipped, failed };

  let orientation = null;
  if (body.create_orientation !== false) {
    orientation = await createStoneFromBody({
      title: `${repo} repository orientation`,
      author,
      chain,
      content: buildRepoOrientationContent(summary),
      metadata: {
        kind: "repo_orientation",
        repo: `${owner}/${repo}`,
        ref,
        repo_stones_operation: true
      },
      set_as_head: body.set_head !== false
    }, env);
  }

  let linked = 0;
  if (orientation?.ok && body.auto_link !== false) {
    for (const item of created) {
      const edge = await linkStonesFromBody({
        from_hash: orientation.stone_hash,
        to_hash: item.stone_hash,
        edge_type: "documents",
        note: `Repository orientation documents ${item.path}`
      }, env);
      if (edge.ok) linked += 1;
    }
  }

  return {
    ok: true,
    owner,
    repo,
    ref,
    chain,
    created_count: created.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    linked_count: linked,
    orientation_hash: orientation?.stone_hash || null,
    head_hash: orientation?.stone_hash || null,
    created,
    skipped,
    failed
  };
}
```

## Tree fetch helper sketch

```js
async function fetchGitHubRepoTree(spec, env) {
  const owner = safeGitHubPart(spec.owner, "owner");
  const repo = safeGitHubPart(spec.repo, "repo");
  const ref = safeGitHubRef(spec.ref || DEFAULT_GITHUB_REF);
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const headers = {
    "User-Agent": "cairnstone-v5-worker",
    "Accept": "application/vnd.github+json"
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    return { ok: false, error: "github_tree_fetch_failed", status: response.status, status_text: response.statusText, github: { owner, repo, ref } };
  }
  const data = await response.json();
  return {
    ok: true,
    owner,
    repo,
    ref,
    truncated: Boolean(data.truncated),
    files: (data.tree || []).filter((item) => item.type === "blob").map((item) => ({ path: item.path, size: item.size || 0, sha: item.sha }))
  };
}
```

## Acceptance test

After deployment, call:

```json
{
  "owner": "nothinginfinity",
  "repo": "cairngraph",
  "author": "Jared + GPT-5.5 Thinking"
}
```

Expected:

- files are stoned under chain `cairngraph`
- orientation stone is created
- orientation stone is chain HEAD
- graph edges connect orientation to file stones
- `cairnstone_get_chain_manifest` shows the new repo map
