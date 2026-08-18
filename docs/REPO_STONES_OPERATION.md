# cairnstone_create_repo_stones Operation

## Purpose

`cairnstone_create_repo_stones(owner, repo)` is the repository-level ingestion operation for CairnStone V5.

It turns a GitHub repository into a navigable CairnStone chain instead of requiring users to stone files one at a time.

## Intended public surfaces

### MCP tool

```text
cairnstone_create_repo_stones
```

### REST endpoint

```text
POST /v1/stones/repository
```

## Input schema

```json
{
  "owner": "nothinginfinity",
  "repo": "cairngraph",
  "ref": "main",
  "author": "Jared + GPT-5.5 Thinking",
  "chain": "cairngraph",
  "max_files": 200,
  "max_file_bytes": 900000,
  "include": [],
  "exclude": [],
  "create_orientation": true,
  "auto_link": true,
  "set_head": true,
  "lint": true
}
```

## Default behavior

When called with only owner and repo, the operation should:

1. Resolve the target ref, defaulting to `main`.
2. Load the GitHub tree recursively.
3. Filter unsupported or noisy files.
4. Create a CairnStone for every accepted file.
5. Create one repository orientation stone.
6. Link the orientation stone to every file stone with `documents` edges.
7. Set the orientation stone as the chain HEAD.
8. Return a manifest of created, skipped, failed, linked, and linted files.

## Default chain name

If `chain` is omitted, use the repository name.

Example:

```text
nothinginfinity/cairngraph -> chain cairngraph
```

## Default ignored paths

The implementation should skip these path fragments by default:

```text
.git/
node_modules/
dist/
build/
coverage/
.wrangler/
.next/
.vercel/
.DS_Store
package-lock.json
pnpm-lock.yaml
yarn.lock
```

## Default accepted extensions

The operation should initially accept:

```text
.md
.mdx
.txt
.json
.jsonc
.toml
.yml
.yaml
.js
.mjs
.cjs
.ts
.tsx
.jsx
.css
.html
.sql
```

## Implementation placement

The Worker source currently lives at:

```text
src/index.js
```

Add these pieces:

1. Route handler:

```js
if (request.method === "POST" && url.pathname === "/v1/stones/repository") {
  return json(await createRepoStonesFromBody(await request.json(), env));
}
```

2. Route list entry:

```text
POST /v1/stones/repository
```

3. MCP dispatch entry:

```js
if (name === "cairnstone_create_repo_stones") {
  return createRepoStonesFromBody(args, env);
}
```

4. MCP tool schema entry for `cairnstone_create_repo_stones`.

5. Helper functions:

```js
async function createRepoStonesFromBody(body, env)
async function fetchGitHubRepoTree(spec, env)
function repoStoneShouldInclude(path, size, body)
function buildRepoOrientationContent(summary)
```

## Expected output

```json
{
  "ok": true,
  "owner": "nothinginfinity",
  "repo": "cairngraph",
  "ref": "main",
  "chain": "cairngraph",
  "created_count": 12,
  "skipped_count": 3,
  "failed_count": 0,
  "linked_count": 12,
  "head_hash": "...",
  "orientation_hash": "...",
  "created": [
    {
      "path": "README.md",
      "stone_hash": "...",
      "refs": 1,
      "bytes": 1303
    }
  ],
  "skipped": [],
  "failed": []
}
```

## Notes

This operation should reuse the existing `createStoneFromGitHubBody`, `createStoneFromBody`, `linkStonesFromBody`, and `upsertHead` primitives rather than duplicating compression/storage behavior.

This file is the implementation scaffold and acceptance contract for adding the live operation to `src/index.js`.
