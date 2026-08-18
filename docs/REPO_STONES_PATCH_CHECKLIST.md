# Repo-Wide Stoning Patch Checklist

This checklist tracks the remaining live Worker wiring for `cairnstone_create_repo_stones`.

## Source files touched so far

- `docs/REPO_STONES_OPERATION.md`
- `src/repo-stones-operation.js`
- `examples/create-repo-stones.json`
- `docs/REPO_STONES_PATCH_CHECKLIST.md`

## Required `src/index.js` changes

### 1. Add REST route

Inside the main fetch route table, add:

```js
if (request.method === "POST" && url.pathname === "/v1/stones/repository") {
  return json(await createRepoStonesFromBody(await request.json(), env));
}
```

### 2. Add route list entry

Inside `routes()`, add:

```text
POST /v1/stones/repository
```

### 3. Add MCP dispatch branch

Inside `callMcpTool(name, args, env)`, add:

```js
if (name === "cairnstone_create_repo_stones") {
  return createRepoStonesFromBody(args, env);
}
```

### 4. Add MCP schema

Inside `mcpTools()`, add a new schema object:

```js
{
  name: "cairnstone_create_repo_stones",
  description: "Walk a GitHub repository, create CairnStones for accepted files, generate an orientation stone, link it to file stones, and set it as chain HEAD.",
  inputSchema: {
    type: "object",
    required: ["owner", "repo", "author"],
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      ref: { type: "string" },
      author: { type: "string" },
      chain: { type: "string" },
      max_files: { type: "number", minimum: 1, maximum: 500 },
      max_file_bytes: { type: "number", minimum: 1, maximum: 900000 },
      include: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      create_orientation: { type: "boolean" },
      auto_link: { type: "boolean" },
      set_head: { type: "boolean" },
      lint: { type: "boolean" }
    }
  }
}
```

### 5. Add implementation functions

Add these functions after `createStoneFromGitHubBody` or near the GitHub helpers:

```js
async function createRepoStonesFromBody(body, env)
async function fetchGitHubRepoTree(spec, env)
function repoStoneShouldInclude(path, size, options)
function buildRepoOrientationContent(summary)
```

## Expected behavior

A call to:

```json
{
  "owner": "nothinginfinity",
  "repo": "cairngraph",
  "author": "Jared + GPT-5.5 Thinking"
}
```

should:

1. resolve `ref` to `main` when omitted,
2. create file stones under chain `cairngraph`,
3. create a repository orientation stone,
4. link orientation to each file stone with `documents`,
5. set the orientation stone as HEAD,
6. return counts for created, skipped, failed, and linked files.

## Verification plan

After patching and deploying:

1. Run `GET /health` and confirm `cairnstone_create_repo_stones` appears in `mcp_tools`.
2. Run `POST /v1/stones/repository` using `examples/create-repo-stones.json`.
3. Run `cairnstone_get_chain_manifest(chain="cairngraph")`.
4. Confirm the orientation stone is HEAD.
5. Confirm `documents` edges exist from orientation to file stones.
6. Expand a file stone and verify raw source lines are present.

## Known current state

The helper module and docs are committed. The Worker entrypoint is not wired until `src/index.js` is patched and deployed.
