import { parse as babelParse } from "@babel/parser";
import { createRepoStonesFromBody as createRepoStonesRuntimeFromBody } from "./repo-stones-runtime.js";

const VERSION = "0.4.1";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_LINES_PER_REF = 80;
const DEFAULT_GITHUB_REF = "main";
const MAX_FETCH_BYTES = 900000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
      if (url.pathname === "/mcp") return handleMcp(request, env, url);
      if (request.method === "GET" && url.pathname === "/") return json(landing(env, url));
      if (request.method === "GET" && url.pathname === "/health") return json(health(env));
      if (request.method === "GET" && url.pathname === "/v1/stones") return json(await listStones(env, url));
      if (request.method === "POST" && url.pathname === "/v1/stones") return json(await createStoneFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/stones/github") return json(await createStoneFromGitHubBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/stones/repository") return json(await createRepoStonesFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/fetch/github") return json(await fetchGitHubFileFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/search") return json(await searchStonesFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/query-expand") return json(await queryAndExpandFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/expand") return json(await expandRefFromBody(await request.json(), env));

      // v2 surface (CairnStone V6): compact manifests, vault-wide FTS find, one-call commit, merged stone read.
      if (request.method === "POST" && url.pathname === "/v2/commit") return json(await commitV2FromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v2/find") return json(await findV2FromBody(await request.json(), env));
      const manifestV2Match = url.pathname.match(/^\/v2\/chains\/([^/]+)\/manifest$/);
      if (request.method === "GET" && manifestV2Match) {
        const chain = decodeURIComponent(manifestV2Match[1]);
        if (!chain) return json({ ok: false, error: "missing_chain", route: "/v2/chains/:chain/manifest" }, 400);
        return json(await getChainManifestV2(env, chain, { detail: url.searchParams.get("detail") || undefined, since: url.searchParams.get("since") || undefined }));
      }
      const stoneV2Match = url.pathname.match(/^\/v2\/stones\/([^/]+)$/);
      if (request.method === "GET" && stoneV2Match) {
        return json(await stoneV2FromBody({ hash: decodeURIComponent(stoneV2Match[1]), level: url.searchParams.get("level") || undefined }, env));
      }

      const stoneMatch = url.pathname.match(/^\/v1\/stones\/([^/]+)$/);
      if (request.method === "GET" && stoneMatch) return json(await getStone(env, stoneMatch[1]));

      const lodMatch = url.pathname.match(/^\/v1\/stones\/([^/]+)\/lod\/(lod[1-5])$/);
      if (request.method === "GET" && lodMatch) return json(await getLod(env, lodMatch[1], lodMatch[2]));

      // REST compatibility shims — used by CairnGraph and other REST consumers.
      // These call the same internal functions as the MCP tools; no new logic.
      const chainManifestMatch = url.pathname.match(/^\/chains\/([^]+)\/manifest$/);
      if (request.method === "GET" && chainManifestMatch) {
        const chain = decodeURIComponent(chainManifestMatch[1]);
        if (!chain) return json({ ok: false, error: "missing_chain", route: "/chains/:chain/manifest" }, 400);
        return json(await getChainManifest(env, chain));
      }

      const restStoneMatch = url.pathname.match(/^\/stones\/([^/]+)$/);
      if (request.method === "GET" && restStoneMatch) {
        const hash = decodeURIComponent(restStoneMatch[1]);
        if (!hash) return json({ ok: false, error: "missing_hash", route: "/stones/:hash" }, 400);
        return json(await getStone(env, hash));
      }

      return json({ ok: false, error: "not_found", endpoints: routes() }, 404);
    } catch (error) {
      return json({ ok: false, error: String(error && error.message ? error.message : error) }, 500);
    }
  }
};

function landing(env, url) {
  return {
    ok: true,
    name: "cairnstone-v6",
    version: VERSION,
    protocol: "FSL-CCR Stone v6",
    mcp: `${url.origin}/mcp`,
    message: "CairnStone v6 is live. Isolated successor to cairnstone-v5. Claude and other MCP clients should connect to /mcp. REST clients can use /health, /v1/stones, /v1/stones/github, /v1/search, and /v1/expand.",
    base_url: url.origin,
    health: `${url.origin}/health`,
    d1: Boolean(env.CAIRNSTONE_DB),
    r2: Boolean(env.CAIRNSTONE_RAW),
    github_token_available: Boolean(env.GITHUB_TOKEN),
    endpoints: routes(),
    mcp_tools: mcpTools().map(tool => tool.name)
  };
}

function health(env) {
  return {
    ok: true,
    name: "cairnstone-v6",
    version: VERSION,
    protocol: "FSL-CCR Stone v6",
    mcp_protocol_version: MCP_PROTOCOL_VERSION,
    d1: Boolean(env.CAIRNSTONE_DB),
    r2: Boolean(env.CAIRNSTONE_RAW),
    github_token_available: Boolean(env.GITHUB_TOKEN),
    endpoints: routes(),
    mcp_tools: mcpTools().map(tool => tool.name)
  };
}

function routes() {
  return [
    "GET /",
    "GET /health",
    "POST /mcp",
    "GET /mcp",
    "POST /v1/stones",
    "GET /v1/stones",
    "POST /v1/stones/github",
    "POST /v1/stones/repository",
    "POST /v1/fetch/github",
    "GET /v1/stones/:hash",
    "GET /v1/stones/:hash/lod/:level",
    "POST /v1/search",
    "POST /v1/query-expand",
    "POST /v1/expand",
    "GET /chains/:chain/manifest",
    "GET /stones/:hash",
    "POST /v2/commit",
    "POST /v2/find",
    "GET /v2/chains/:chain/manifest?detail=summary|compact|full&since=ISO",
    "GET /v2/stones/:hash?level=lod1-5"
  ];
}

async function handleMcp(request, env, url) {
  if (request.method === "GET") {
    return json({
      ok: true,
      name: "cairnstone-v6-mcp",
      version: VERSION,
      protocol: "MCP JSON-RPC over HTTP",
      endpoint: `${url.origin}/mcp`,
      methods: ["initialize", "tools/list", "tools/call"],
      tools: mcpTools().map(tool => ({ name: tool.name, description: tool.description }))
    });
  }

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

  let rpc;
  try {
    rpc = await request.json();
  } catch (error) {
    return mcpRespond(request, rpcError(null, -32700, "Parse error"), sessionId, 400);
  }

  if (Array.isArray(rpc)) {
    const results = [];
    for (const item of rpc) {
      const result = await handleMcpRpc(item, env);
      if (result) results.push(result);
    }
    if (!results.length) return withSession(withCors(new Response(null, { status: 202 })), sessionId);
    return mcpRespond(request, results, sessionId);
  }

  const result = await handleMcpRpc(rpc, env);
  if (!result) return withSession(withCors(new Response(null, { status: 202 })), sessionId);
  return mcpRespond(request, result, sessionId);
}

async function handleMcpRpc(rpc, env) {
  const id = rpc && Object.prototype.hasOwnProperty.call(rpc, "id") ? rpc.id : null;
  const method = rpc && rpc.method;
  const params = isObject(rpc && rpc.params) ? rpc.params : {};

  try {
    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: (typeof params.protocolVersion === "string" && params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "cairnstone-v6", version: VERSION }
      });
    }

    if (method === "notifications/initialized") return null;
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: mcpTools() });

    if (method === "tools/call") {
      const name = requiredString(params.name, "name");
      const args = isObject(params.arguments) ? params.arguments : {};
      const output = await callMcpTool(name, args, env);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        isError: output && output.ok === false
      });
    }

    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    return rpcError(id, -32000, String(error && error.message ? error.message : error));
  }
}

async function callMcpTool(name, args, env) {
  if (name === "cairnstone_health") return health(env);
  if (name === "cairnstone_list_stones") return listStones(env, { ...args, origin: "mcp://cairnstone" });
  if (name === "cairnstone_fetch_github_file") return fetchGitHubFileFromBody(args, env);
  if (name === "cairnstone_create_stone") return createStoneFromBody(args, env);
  if (name === "cairnstone_create_github_file_stone") return createStoneFromGitHubBody(args, env);
  if (name === "cairnstone_create_repo_stones") return createRepoStonesFromBody(args, env);
  if (name === "cairnstone_search") return searchStonesFromBody(args, env);
  if (name === "cairnstone_query_and_expand") return queryAndExpandFromBody(args, env);
  if (name === "cairnstone_expand") return expandRefFromBody(args, env);
  if (name === "cairnstone_get_stone") return getStone(env, requiredString(args.hash, "hash"));
  if (name === "cairnstone_get_lod") return getLod(env, requiredString(args.hash, "hash"), requiredString(args.level, "level"));
  if (name === "cairnstone_lint_stone") return lintStoneFromBody(args, env);
  if (name === "cairnstone_link_stones") return linkStonesFromBody(args, env);
  if (name === "cairnstone_set_head") return setHeadFromBody(args, env);
  if (name === "cairnstone_get_chain_manifest") return getChainManifest(env, requiredString(args.chain, "chain"));
  if (name === "cairnstone_manifest_v2") return getChainManifestV2(env, requiredString(args.chain, "chain"), args);
  if (name === "cairnstone_find_v2") return findV2FromBody(args, env);
  if (name === "cairnstone_commit_v2") return commitV2FromBody(args, env);
  if (name === "cairnstone_stone_v2") return stoneV2FromBody(args, env);
  return { ok: false, error: "unknown_tool", name };
}

function mcpTools() {
  return [
    {
      name: "cairnstone_health",
      description: "Check CairnStone v6 MCP, D1, R2, and GitHub fetch status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "cairnstone_list_stones",
      description: "List CairnStone records in the vault with lightweight metadata for dashboards and handoff links.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          chain: { type: "string", description: "Exact match filter on the stone's chain tag (e.g. a repo name used to group its file stones)." },
          limit: { type: "number", minimum: 1, maximum: 200 }
        }
      }
    },
    {
      name: "cairnstone_fetch_github_file",
      description: "Server-side fetch a GitHub file by owner, repo, path, and ref. This verifies fetch mode without pasting raw content into the tool call.",
      inputSchema: {
        type: "object",
        required: ["owner", "repo", "path"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string", description: "Branch, tag, or commit SHA. Defaults to main." },
          max_bytes: { type: "number", minimum: 1, maximum: MAX_FETCH_BYTES },
          return_content: { type: "boolean", description: "Return raw text content. Defaults to false for safety." }
        }
      }
    },
    {
      name: "cairnstone_create_stone",
      description: "Create a CairnStone from either inline content or server-side GitHub fetch input. For scale, pass owner, repo, path, and ref instead of content.",
      inputSchema: {
        type: "object",
        required: ["title", "author"],
        properties: {
          title: { type: "string" },
          author: { type: "string" },
          content: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" },
          commit: { type: "string" },
          parent: { type: "string" },
          chain: { type: "string" },
          related: { type: "array", items: { type: "string" } },
          metadata: { type: "object" },
          set_as_head: { type: "boolean", description: "Mark this stone as the chain's current HEAD on creation. Defaults to false - opt in explicitly for stones meant to be the new canonical version, not for notes/reviews/orientation stones." }
        }
      }
    },
    {
      name: "cairnstone_create_github_file_stone",
      description: "Create a CairnStone by having the Worker fetch a GitHub file server-side using owner, repo, path, and optional ref. This removes the large-content paste bottleneck.",
      inputSchema: {
        type: "object",
        required: ["owner", "repo", "path", "author"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" },
          title: { type: "string" },
          author: { type: "string" },
          parent: { type: "string" },
          chain: { type: "string" },
          related: { type: "array", items: { type: "string" } },
          metadata: { type: "object" },
          set_as_head: { type: "boolean", description: "Mark this stone as the chain's current HEAD on creation. Defaults to false - opt in explicitly when this is meant to be the new canonical version of the file." }
        }
      }
    },
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
          max_file_bytes: { type: "number", minimum: 1, maximum: MAX_FETCH_BYTES },
          include: { type: "array", items: { type: "string" } },
          exclude: { type: "array", items: { type: "string" } },
          create_orientation: { type: "boolean" },
          auto_link: { type: "boolean" },
          set_head: { type: "boolean" },
          lint: { type: "boolean" }
        }
      }
    },
    {
      name: "cairnstone_search",
      description: "Search compressed CairnStone refs before expanding raw content.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          stone_hash: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 }
        }
      }
    },
    {
      name: "cairnstone_query_and_expand",
      description: "Fused server-side search plus expansion. Tokenizes a query into terms, ranks matching refs by overlap, expands only top_k winners, and returns final expanded text without returning unused chunk previews.",
      inputSchema: {
        type: "object",
        required: ["stone_hash", "query"],
        properties: {
          stone_hash: { type: "string" },
          query: { type: "string" },
          top_k: { type: "number", minimum: 1, maximum: 10 },
          context_lines: { type: "number", minimum: 0, maximum: 200 },
          include_metadata: { type: "boolean" }
        }
      }
    },
    {
      name: "cairnstone_expand",
      description: "Expand a selected CairnStone ref into exact raw line-window content from R2.",
      inputSchema: {
        type: "object",
        properties: {
          ref_id: { type: "string" },
          stone_hash: { type: "string" },
          path: { type: "string" },
          line_start: { type: "number" },
          context_lines: { type: "number", minimum: 0, maximum: 200 }
        }
      }
    },
    {
      name: "cairnstone_get_stone",
      description: "Get a complete CairnStone record by hash.",
      inputSchema: { type: "object", required: ["hash"], properties: { hash: { type: "string" } } }
    },
    {
      name: "cairnstone_get_lod",
      description: "Get one CairnStone LOD layer by hash and level.",
      inputSchema: {
        type: "object",
        required: ["hash", "level"],
        properties: {
          hash: { type: "string" },
          level: { type: "string", enum: ["lod1", "lod2", "lod3", "lod4", "lod5"] }
        }
      }
    },
    {
      name: "cairnstone_lint_stone",
      description: "Phase 2: real AST-based syntax check against the stone's full original content (JS/TS/JSX/TSX only). Catches real parse errors (not heuristic flags) and maps each error's line number to the ref_id covering it, so you know exactly which chunk to expand.",
      inputSchema: {
        type: "object",
        required: ["stone_hash"],
        properties: {
          stone_hash: { type: "string" },
          language: { type: "string", enum: ["javascript", "typescript", "jsx", "tsx"], description: "Override auto-detection from file extension." }
        }
      }
    },
    {
      name: "cairnstone_link_stones",
      description: "Create a typed relationship edge between two stones, so the vault stays navigable as it grows past a few hundred stones. Use this whenever one stone's relationship to another matters: a re-stoned file that supersedes an older version of itself, a fix stone that patches a problem found in a review, an orientation stone that documents a set of file stones, or a review-report stone that reviews the stone it evaluated.",
      inputSchema: {
        type: "object",
        required: ["from_hash", "to_hash", "edge_type"],
        properties: {
          from_hash: { type: "string" },
          to_hash: { type: "string" },
          edge_type: { type: "string", enum: ["supersedes", "patches", "documents", "reviews", "references"] },
          note: { type: "string" }
        }
      }
    },
    {
      name: "cairnstone_set_head",
      description: "Mark a stone as the current HEAD for its chain - the canonical, up-to-date version. Use this after stoning a new revision of a file you want future chats to treat as authoritative, instead of making them guess from created_at timestamps.",
      inputSchema: {
        type: "object",
        required: ["chain", "hash"],
        properties: {
          chain: { type: "string" },
          hash: { type: "string" }
        }
      }
    },
    {
      name: "cairnstone_get_chain_manifest",
      description: "Get a navigational summary of an entire chain in one call: every stone's lod5, which one is HEAD, and every graph edge connecting them. Computed fresh from current data every time (never stale). Call this FIRST when picking up work on a chain you haven't seen recently, before listing or expanding individual stones.",
      inputSchema: {
        type: "object",
        required: ["chain"],
        properties: {
          chain: { type: "string" }
        }
      }
    },
    {
      name: "cairnstone_manifest_v2",
      description: "Token-efficient chain manifest. detail=summary returns counts + chain head + per-path heads only (~500B). detail=compact (default) returns short-hash nodes with duplicate collapsing, per-path heads, and edges as 'from>to:type' strings. detail=full returns the v1 shape. since=ISO date returns only stones created after it (delta pickup). Prefer this over cairnstone_get_chain_manifest.",
      inputSchema: {
        type: "object",
        required: ["chain"],
        properties: {
          chain: { type: "string" },
          detail: { type: "string", enum: ["summary", "compact", "full"] },
          since: { type: "string", description: "ISO date/datetime; only include stones created at or after this" }
        }
      }
    },
    {
      name: "cairnstone_find_v2",
      description: "Vault-wide full-text search (FTS5 + bm25) over all ref keywords and previews, with optional chain or stone filter and optional inline expansion of top hits. Replaces cairnstone_search and vault-wide use of cairnstone_query_and_expand: one call to find and read.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          chain: { type: "string", description: "Restrict to one chain" },
          stone_hash: { type: "string", description: "Restrict to one stone (full or >=8-char short hash)" },
          top_k: { type: "number", description: "Max matches, default 5" },
          expand: { type: "boolean", description: "If true, expand the top hits' raw content inline (max 3)" },
          context_lines: { type: "number", description: "Context lines around expanded refs, default 20" }
        }
      }
    },
    {
      name: "cairnstone_commit_v2",
      description: "One-call write path: create a stone (inline content OR server-side GitHub fetch via owner/repo/path/ref), dedupe by content within the chain (identical content returns the existing stone instead of a duplicate), set the per-path head automatically, optionally set the chain head, and create typed edges - all in one call. Edges accept short (>=8 char) target hashes. Replaces create_stone + create_github_file_stone + link_stones + set_head sequences.",
      inputSchema: {
        type: "object",
        required: ["chain", "author"],
        properties: {
          chain: { type: "string" },
          author: { type: "string" },
          title: { type: "string" },
          content: { type: "string", description: "Inline content; omit when using GitHub fetch" },
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" },
          metadata: { type: "object" },
          dedupe: { type: "boolean", description: "Default true; false forces a new stone even for identical content" },
          set_as_head: { type: "boolean", description: "Also set the chain-level head" },
          set_path_head: { type: "boolean", description: "Default true when a path is present" },
          edges: {
            type: "array",
            description: "Typed edges from the new stone, e.g. [{to:'abc123def456', type:'supersedes', note:'...'}]",
            items: {
              type: "object",
              required: ["to", "type"],
              properties: {
                to: { type: "string" },
                type: { type: "string", enum: ["supersedes", "patches", "documents", "reviews", "references"] },
                note: { type: "string" }
              }
            }
          }
        }
      }
    },
    {
      name: "cairnstone_stone_v2",
      description: "Read one stone by full or short (>=8 char) hash. Without level: compact record (border essentials + lod5 + lod4). With level=lod1..lod5: that specific LOD layer. Merges cairnstone_get_stone and cairnstone_get_lod.",
      inputSchema: {
        type: "object",
        required: ["hash"],
        properties: {
          hash: { type: "string" },
          level: { type: "string", enum: ["lod1", "lod2", "lod3", "lod4", "lod5"] }
        }
      }
    }
  ];
}

async function createRepoStonesFromBody(body, env) {
  return createRepoStonesRuntimeFromBody(body, env, {
    createStoneFromGitHubBody,
    createStoneFromBody,
    linkStonesFromBody,
    requireBindings,
    requiredString,
    safeGitHubPart,
    safeGitHubRef,
    clamp
  });
}

async function createStoneFromGitHubBody(body, env) {
  const fetched = await fetchGitHubFileFromBody({ ...body, return_content: true }, env);
  if (!fetched.ok) return fetched;
  const title = body.title || `${fetched.github.owner}/${fetched.github.repo}/${fetched.github.path}@${fetched.github.ref}`;
  const stoneBody = {
    ...body,
    title,
    content: fetched.content,
    path: fetched.github.path,
    repo: `${fetched.github.owner}/${fetched.github.repo}`,
    commit: fetched.github.ref,
    metadata: {
      ...(isObject(body.metadata) ? body.metadata : {}),
      source_type: "github_file",
      github: fetched.github,
      fetch: fetched.fetch
    }
  };
  return createStoneFromBody(stoneBody, env);
}

async function createStoneFromBody(body, env) {
  const normalized = await normalizeStoneInput(body, env);
  requireBindings(env);

  const content = normalized.content;
  const title = normalized.title;
  const author = normalized.author;
  const created = new Date().toISOString();
  const path = normalized.path || "content.txt";
  const repo = normalized.repo || null;
  const commit = normalized.commit || null;
  const parent = body.parent || null;
  const chain = body.chain || null;
  const metadata = isObject(normalized.metadata) ? normalized.metadata : {};

  const rawHash = await sha256(content);
  const rawKey = `raw/${rawHash}.txt`;
  await env.CAIRNSTONE_RAW.put(rawKey, content, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { title, author, rawHash }
  });

  const seed = stableJson({ title, author, created, rawHash, repo, commit, parent, chain });
  const stoneHash = await sha256(seed);
  const refs = await buildRefs({ stoneHash, path, rawKey, content });
  const receipt = buildReceipt({ content, refs, created });
  const layers = buildLayers({ title, author, repo, commit, content, refs, receipt, rawKey });
  const stone = {
    border: { hash: stoneHash, author, created, title, repo, commit, path, parent, chain, signature: null },
    layers,
    related: Array.isArray(body.related) ? body.related : [],
    metadata
  };

  await env.CAIRNSTONE_DB.prepare(
    "INSERT INTO stones (hash,title,author,created_at,repo,commit_sha,parent_hash,chain_hash,raw_key,stone_json) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(stoneHash, title, author, created, repo, commit, parent, chain, rawKey, JSON.stringify(stone)).run();

  for (const ref of refs) {
    await env.CAIRNSTONE_DB.prepare(
      "INSERT INTO refs (ref_id,stone_hash,path,line_start,line_end,keywords,preview,raw_key) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(ref.ref_id, stoneHash, ref.path, ref.line_start, ref.line_end, ref.keywords.join(" "), ref.preview, rawKey).run();
  }

  await ftsIndexRefs(env, stoneHash, chain, refs);

  const receiptId = await sha256(`${stoneHash}:${created}:receipt`);
  await env.CAIRNSTONE_DB.prepare(
    "INSERT INTO receipts (id,stone_hash,original_bytes,compressed_bytes,ratio,strategy,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(receiptId, stoneHash, receipt.original_bytes, receipt.compressed_bytes, receipt.ratio, receipt.strategy, created).run();

  if (chain && body.set_as_head) {
    await upsertHead(env, chain, stoneHash, created);
  }

  return { ok: true, stone_hash: stoneHash, raw_key: rawKey, refs: refs.length, receipt, source: normalized.source, stone };
}

async function normalizeStoneInput(body, env) {
  const title = body.title || null;
  const author = requiredString(body.author, "author");

  if (typeof body.content === "string" && body.content.length > 0) {
    return {
      source: { type: "inline" },
      content: body.content,
      title: title || "Inline CairnStone",
      author,
      path: body.path || "content.txt",
      repo: body.repo || null,
      commit: body.commit || null,
      metadata: isObject(body.metadata) ? body.metadata : {}
    };
  }

  const githubSpec = githubSpecFromBody(body);
  if (githubSpec) {
    const fetched = await fetchGitHubFile({ ...githubSpec, returnContent: true }, env);
    return {
      source: { type: "github_file", github: fetched.github, fetch: fetched.fetch },
      content: fetched.content,
      title: title || `${fetched.github.owner}/${fetched.github.repo}/${fetched.github.path}@${fetched.github.ref}`,
      author,
      path: fetched.github.path,
      repo: `${fetched.github.owner}/${fetched.github.repo}`,
      commit: fetched.github.ref,
      metadata: {
        ...(isObject(body.metadata) ? body.metadata : {}),
        source_type: "github_file",
        github: fetched.github,
        fetch: fetched.fetch
      }
    };
  }

  throw new Error("Missing content or GitHub source. Pass content, or pass owner+repo+path+optional ref.");
}

async function fetchGitHubFileFromBody(body, env) {
  const spec = githubSpecFromBody(body);
  if (!spec) throw new Error("Missing GitHub source. Required: owner, repo, path. Optional: ref, max_bytes, return_content.");
  return fetchGitHubFile({ ...spec, returnContent: Boolean(body.return_content) }, env);
}

function githubSpecFromBody(body) {
  if (!isObject(body)) return null;
  if (isObject(body.github)) {
    const owner = body.github.owner || body.github.org;
    const repo = body.github.repo || body.github.repository;
    const path = body.github.path || body.github.file_path;
    if (owner && repo && path) {
      return {
        owner: String(owner),
        repo: String(repo),
        path: String(path),
        ref: String(body.github.ref || body.github.branch || body.github.sha || body.ref || DEFAULT_GITHUB_REF),
        maxBytes: clamp(Number(body.github.max_bytes || body.max_bytes || MAX_FETCH_BYTES), 1, MAX_FETCH_BYTES)
      };
    }
  }

  const owner = body.owner || body.org;
  const repo = body.repo || body.repository;
  const path = body.path || body.file_path;
  if (!owner || !repo || !path) return null;
  return {
    owner: String(owner),
    repo: String(repo),
    path: String(path),
    ref: String(body.ref || body.branch || body.sha || DEFAULT_GITHUB_REF),
    maxBytes: clamp(Number(body.max_bytes || MAX_FETCH_BYTES), 1, MAX_FETCH_BYTES)
  };
}

async function fetchGitHubFile(spec, env) {
  const owner = safeGitHubPart(spec.owner, "owner");
  const repo = safeGitHubPart(spec.repo, "repo");
  const ref = safeGitHubRef(spec.ref || DEFAULT_GITHUB_REF);
  const path = safeGitHubPath(spec.path);
  const maxBytes = clamp(Number(spec.maxBytes || MAX_FETCH_BYTES), 1, MAX_FETCH_BYTES);
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    "User-Agent": "cairnstone-v6-worker",
    "Accept": "text/plain, application/octet-stream;q=0.9, */*;q=0.8"
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const response = await fetch(rawUrl, { headers });
  if (!response.ok) {
    return {
      ok: false,
      error: "github_fetch_failed",
      status: response.status,
      status_text: response.statusText,
      github: { owner, repo, path, ref },
      hint: response.status === 404 && !env.GITHUB_TOKEN ? "If this is a private repo, add GITHUB_TOKEN as a Worker secret." : undefined
    };
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > maxBytes) {
    return {
      ok: false,
      error: "github_file_too_large",
      max_bytes: maxBytes,
      content_length: contentLength,
      github: { owner, repo, path, ref }
    };
  }

  const text = await response.text();
  const bytes = utf8Bytes(text);
  if (bytes > maxBytes) {
    return {
      ok: false,
      error: "github_file_too_large_after_read",
      max_bytes: maxBytes,
      bytes,
      github: { owner, repo, path, ref }
    };
  }

  const sha = await sha256(text);
  const result = {
    ok: true,
    github: { owner, repo, path, ref, raw_url: rawUrl },
    fetch: {
      bytes,
      sha256: sha,
      content_type: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified")
    }
  };
  if (spec.returnContent) result.content = text;
  else result.preview = preview(text);
  return result;
}

function safeGitHubPart(value, name) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) throw new Error(`Invalid GitHub ${name}`);
  return text;
}

function safeGitHubRef(value) {
  const text = String(value || DEFAULT_GITHUB_REF).trim();
  if (!/^[A-Za-z0-9_./-]+$/.test(text) || text.includes("..")) throw new Error("Invalid GitHub ref");
  return text;
}

function safeGitHubPath(value) {
  const text = String(value || "").trim().replace(/^\/+/, "");
  if (!text || text.includes("..") || text.includes("\\")) throw new Error("Invalid GitHub path");
  return text;
}

async function listStones(env, urlOrParams = {}) {
  requireBindings(env);
  const q = String(urlOrParams.searchParams?.get?.("q") || urlOrParams.q || "").toLowerCase();
  const chainFilter = String(urlOrParams.searchParams?.get?.("chain") || urlOrParams.chain || "");
  const limit = clamp(Number(urlOrParams.searchParams?.get?.("limit") || urlOrParams.limit || 100), 1, 200);
  const origin = urlOrParams.origin || "";
  const filtering = Boolean(q || chainFilter);
  const fetchLimit = filtering ? 2000 : limit;
  const rows = await env.CAIRNSTONE_DB.prepare(
    "SELECT s.hash,s.title,s.author,s.created_at,s.repo,s.commit_sha,s.chain_hash,s.raw_key,s.stone_json,r.original_bytes,r.compressed_bytes,r.ratio,r.strategy,(SELECT COUNT(*) FROM refs WHERE stone_hash=s.hash) refs_count FROM stones s LEFT JOIN receipts r ON r.stone_hash=s.hash ORDER BY s.created_at DESC LIMIT ?"
  ).bind(fetchLimit).all();
  let stones = rows.results.map(row => stoneListCard(row, origin));
  if (chainFilter) stones = stones.filter(stone => stone.chain === chainFilter);
  if (q) stones = stones.filter(stone => JSON.stringify(stone).toLowerCase().includes(q));
  const headRows = await env.CAIRNSTONE_DB.prepare("SELECT chain, head_hash FROM chain_heads").all();
  const headsMap = new Map(headRows.results.map(r => [r.chain, r.head_hash]));
  for (const stone of stones) stone.is_head = headsMap.get(stone.chain) === stone.hash;
  const totals = stones.reduce((acc, stone) => {
    acc.original_bytes += stone.original_bytes || 0;
    acc.compressed_bytes += stone.compressed_bytes || 0;
    acc.refs += stone.refs_count || 0;
    return acc;
  }, { original_bytes: 0, compressed_bytes: 0, refs: 0 });
  totals.ratio = totals.compressed_bytes ? Number((totals.original_bytes / totals.compressed_bytes).toFixed(2)) : 0;
  const total = stones.length;
  stones = stones.slice(0, limit);
  return { ok: true, total, totals, stones };
}

function stoneListCard(row, origin) {
  let stone = {};
  try { stone = JSON.parse(row.stone_json || "{}"); } catch {}
  const layers = stone.layers || {};
  const metadata = stone.metadata || {};
  const border = stone.border || {};
  const hash = row.hash || border.hash;
  return {
    hash,
    short_hash: String(hash || "").slice(0, 12),
    title: row.title || border.title || "Untitled CairnStone",
    author: row.author || border.author || "",
    created_at: row.created_at || border.created || "",
    repo: row.repo || border.repo || metadata.repo_url || "",
    path: metadata.github?.path || border.path || "",
    chain: row.chain_hash || border.chain || "",
    commit: row.commit_sha || border.commit || "",
    refs_count: Number(row.refs_count || 0),
    original_bytes: Number(row.original_bytes || layers.lod1?.raw_bytes || 0),
    compressed_bytes: Number(row.compressed_bytes || 0),
    ratio: Number(row.ratio || 0),
    lod5: layers.lod5 || "",
    lod4: layers.lod4 || "",
    source_type: metadata.source_type || "stone",
    share_url: origin && hash ? `${origin.replace(/\/$/, "")}/v1/stones/${hash}` : undefined
  };
}

async function getStone(env, hash) {
  requireBindings(env);
  const row = await env.CAIRNSTONE_DB.prepare("SELECT stone_json FROM stones WHERE hash = ?").bind(hash).first();
  if (!row) return { ok: false, error: "stone_not_found", hash };
  return { ok: true, stone: JSON.parse(row.stone_json) };
}

async function getLod(env, hash, level) {
  const result = await getStone(env, hash);
  if (!result.ok) return result;
  const value = result.stone.layers[level];
  if (value === undefined) return { ok: false, error: "lod_not_found", hash, level };
  return { ok: true, hash, level, value };
}

const EDGE_TYPES = ["supersedes", "patches", "documents", "reviews", "references"];

async function upsertHead(env, chain, hash, updatedAt) {
  await env.CAIRNSTONE_DB.prepare(
    "INSERT INTO chain_heads (chain,head_hash,updated_at) VALUES (?,?,?) ON CONFLICT(chain) DO UPDATE SET head_hash=excluded.head_hash, updated_at=excluded.updated_at"
  ).bind(chain, hash, updatedAt).run();
}

async function linkStonesFromBody(body, env) {
  requireBindings(env);
  const fromHash = requiredString(body.from_hash, "from_hash");
  const toHash = requiredString(body.to_hash, "to_hash");
  const edgeType = requiredString(body.edge_type, "edge_type");
  if (!EDGE_TYPES.includes(edgeType)) return { ok: false, error: "invalid_edge_type", allowed: EDGE_TYPES };
  const fromRow = await env.CAIRNSTONE_DB.prepare("SELECT hash FROM stones WHERE hash = ?").bind(fromHash).first();
  if (!fromRow) return { ok: false, error: "from_stone_not_found", hash: fromHash };
  const toRow = await env.CAIRNSTONE_DB.prepare("SELECT hash FROM stones WHERE hash = ?").bind(toHash).first();
  if (!toRow) return { ok: false, error: "to_stone_not_found", hash: toHash };
  const created = new Date().toISOString();
  const id = await sha256(`${fromHash}:${toHash}:${edgeType}:${created}`);
  await env.CAIRNSTONE_DB.prepare(
    "INSERT INTO stone_edges (id,from_hash,to_hash,edge_type,note,created_at) VALUES (?,?,?,?,?,?)"
  ).bind(id, fromHash, toHash, edgeType, body.note || null, created).run();
  return { ok: true, id, from_hash: fromHash, to_hash: toHash, edge_type: edgeType, note: body.note || null, created_at: created };
}

async function setHeadFromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");
  const hash = requiredString(body.hash, "hash");
  const row = await env.CAIRNSTONE_DB.prepare("SELECT chain_hash FROM stones WHERE hash = ?").bind(hash).first();
  if (!row) return { ok: false, error: "stone_not_found", hash };
  if (row.chain_hash !== chain) return { ok: false, error: "chain_mismatch", stone_chain: row.chain_hash, requested_chain: chain };
  const updated = new Date().toISOString();
  await upsertHead(env, chain, hash, updated);
  return { ok: true, chain, head_hash: hash, updated_at: updated };
}

async function getChainManifest(env, chain) {
  requireBindings(env);
  const headRow = await env.CAIRNSTONE_DB.prepare("SELECT head_hash, updated_at FROM chain_heads WHERE chain = ?").bind(chain).first();
  const stoneRows = await env.CAIRNSTONE_DB.prepare(
    "SELECT hash,title,author,created_at,stone_json FROM stones WHERE chain_hash = ? ORDER BY created_at ASC"
  ).bind(chain).all();
  const hashes = stoneRows.results.map(r => r.hash);
  const edges = await queryEdgesByHashes(env, hashes);
  const nodes = stoneRows.results.map(row => {
    let stone = {};
    try { stone = JSON.parse(row.stone_json || "{}"); } catch {}
    const layers = stone.layers || {};
    return {
      hash: row.hash,
      short_hash: row.hash.slice(0, 12),
      title: row.title,
      author: row.author,
      created_at: row.created_at,
      is_head: headRow ? headRow.head_hash === row.hash : false,
      lod5: layers.lod5 || ""
    };
  });
  return {
    ok: true,
    chain,
    head_hash: headRow ? headRow.head_hash : null,
    head_updated_at: headRow ? headRow.updated_at : null,
    stone_count: nodes.length,
    edge_count: edges.length,
    graph_complete: true,
    nodes,
    edges
  };
}

async function queryEdgesByHashes(env, hashes) {
  if (!hashes.length) return [];
  const edges = [];
  const seen = new Set();
  for (const batch of chunkArray(hashes, 40)) {
    const placeholders = batch.map(() => "?").join(",");
    const edgeRows = await env.CAIRNSTONE_DB.prepare(
      `SELECT id,from_hash,to_hash,edge_type,note,created_at FROM stone_edges WHERE from_hash IN (${placeholders}) OR to_hash IN (${placeholders})`
    ).bind(...batch, ...batch).all();
    for (const edge of edgeRows.results || []) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      edges.push(edge);
    }
  }
  return edges;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function pluginsForLanguage(language) {
  if (language === "typescript") return ["typescript", "topLevelAwait"];
  if (language === "tsx") return ["typescript", "jsx", "topLevelAwait"];
  if (language === "jsx") return ["jsx", "topLevelAwait"];
  if (language === "javascript") return ["jsx", "topLevelAwait"];
  return null;
}

function pluginsForPath(path) {
  const ext = String(path || "").split(".").pop().toLowerCase();
  if (ext === "tsx") return pluginsForLanguage("tsx");
  if (ext === "ts") return pluginsForLanguage("typescript");
  if (ext === "jsx") return pluginsForLanguage("jsx");
  if (["js", "mjs", "cjs"].includes(ext)) return pluginsForLanguage("javascript");
  return null;
}

async function lintStoneFromBody(body, env) {
  requireBindings(env);
  const hash = requiredString(body.stone_hash, "stone_hash");
  const result = await getStone(env, hash);
  if (!result.ok) return result;
  const stone = result.stone;
  const path = stone.metadata?.github?.path || stone.border?.path || "content.txt";

  const plugins = body.language ? pluginsForLanguage(body.language) : pluginsForPath(path);
  if (!plugins) {
    return { ok: true, stone_hash: hash, path, supported: false, note: "Unsupported language for Phase 2 syntax linting (javascript/typescript/jsx/tsx only)." };
  }

  const rawKey = stone.layers?.lod1?.raw_key;
  if (!rawKey) return { ok: false, error: "raw_not_available" };
  const raw = await env.CAIRNSTONE_RAW.get(rawKey);
  if (!raw) return { ok: false, error: "raw_not_found", raw_key: rawKey };
  const content = await raw.text();

  let valid = true;
  let errors = [];
  try {
    const ast = babelParse(content, { sourceType: "unambiguous", errorRecovery: true, plugins });
    if (ast.errors && ast.errors.length) {
      valid = false;
      errors = ast.errors.map(e => ({ message: e.message, line: e.loc ? e.loc.line : null, column: e.loc ? e.loc.column : null, code: e.code || null, reason_code: e.reasonCode || null }));
    }
  } catch (e) {
    valid = false;
    errors = [{ message: e.message, line: e.loc ? e.loc.line : null, column: e.loc ? e.loc.column : null, code: e.code || null, reason_code: e.reasonCode || null }];
  }

  if (!valid) {
    for (const err of errors) {
      if (!err.line) continue;
      const row = await env.CAIRNSTONE_DB.prepare(
        "SELECT ref_id FROM refs WHERE stone_hash = ? AND line_start <= ? AND line_end >= ? LIMIT 1"
      ).bind(hash, err.line, err.line).first();
      err.ref_id = row ? row.ref_id : null;
    }
  }

  return { ok: true, stone_hash: hash, path, supported: true, valid, error_count: errors.length, errors };
}

async function searchStonesFromBody(body, env) {
  requireBindings(env);
  const query = requiredString(body.query, "query").toLowerCase();
  const limit = clamp(Number(body.limit || 20), 1, 100);
  const stoneHash = body.stone_hash || null;
  const safe = query.replaceAll("%", "").replaceAll("_", "");
  const like = `%${safe}%`;
  const sql = stoneHash
    ? "SELECT ref_id,stone_hash,path,line_start,line_end,keywords,preview FROM refs WHERE stone_hash = ? AND (LOWER(keywords) LIKE ? OR LOWER(preview) LIKE ?) LIMIT ?"
    : "SELECT ref_id,stone_hash,path,line_start,line_end,keywords,preview FROM refs WHERE LOWER(keywords) LIKE ? OR LOWER(preview) LIKE ? LIMIT ?";
  const stmt = env.CAIRNSTONE_DB.prepare(sql);
  const rows = stoneHash ? await stmt.bind(stoneHash, like, like, limit).all() : await stmt.bind(like, like, limit).all();
  await logEvent(env, { stone_hash: stoneHash, query, event_type: "search" });
  return {
    ok: true,
    query,
    total: rows.results.length,
    matches: rows.results.map(row => ({
      ref_id: row.ref_id,
      stone_hash: row.stone_hash,
      path: row.path,
      line_start: row.line_start,
      line_end: row.line_end,
      keywords: String(row.keywords || "").split(/\s+/).filter(Boolean),
      preview: row.preview
    }))
  };
}

async function queryAndExpandFromBody(body, env) {
  requireBindings(env);
  const stoneHash = requiredString(body.stone_hash, "stone_hash");
  const query = requiredString(body.query, "query");
  const terms = tokenizeQuery(query);
  if (!terms.length) return { ok: false, error: "empty_query_terms" };

  const topK = clamp(Number(body.top_k || 1), 1, 10);
  const context = clamp(optionalNumber(body.context_lines, 0), 0, 200);
  const rows = await env.CAIRNSTONE_DB.prepare(
    "SELECT * FROM refs WHERE stone_hash = ?"
  ).bind(stoneHash).all();

  const ranked = rows.results
    .map(row => ({ row, score: scoreRowForTerms(row, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.row.line_start) - Number(b.row.line_start))
    .slice(0, topK);

  await logEvent(env, { stone_hash: stoneHash, query, event_type: "query_expand" });

  if (!ranked.length) {
    return { ok: false, error: "no_matching_ref", query, terms, text: "" };
  }

  const expanded = [];
  for (const item of ranked) {
    expanded.push(await expandRefRow(item.row, env, context, item.score));
  }

  const text = expanded.map(item => item.text).join("\n\n---\n\n");
  if (!body.include_metadata) return { ok: true, query, text };
  return {
    ok: true,
    query,
    top_k: topK,
    context_lines: context,
    terms,
    selected: expanded.map(item => ({
      ref_id: item.ref_id,
      stone_hash: item.stone_hash,
      path: item.path,
      line_start: item.line_start,
      line_end: item.line_end,
      score: item.score
    })),
    text
  };
}

function tokenizeQuery(query) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has", "not", "you", "your", "but", "can", "will", "all", "into", "our", "out", "use", "using", "true", "false", "null"]);
  const terms = [];
  const seen = new Set();
  for (const match of String(query).toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) {
    const term = match[0];
    if (stop.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function scoreRowForTerms(row, terms) {
  const haystack = `${row.keywords || ""} ${row.preview || ""} ${row.path || ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

async function expandRefRow(row, env, context, score) {
  const raw = await env.CAIRNSTONE_RAW.get(row.raw_key);
  if (!raw) throw new Error(`raw_not_found: ${row.raw_key}`);
  const text = await raw.text();
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Number(row.line_start) - context);
  const end = Math.min(lines.length, Number(row.line_end) + context);
  const window = lines.slice(start - 1, end).map((line, i) => ({ n: start + i, text: line }));
  return {
    ref_id: row.ref_id,
    stone_hash: row.stone_hash,
    path: row.path,
    line_start: start,
    line_end: end,
    score,
    text: window.map(line => line.text).join("\n"),
    lines: window
  };
}

async function expandRefFromBody(body, env) {
  requireBindings(env);
  const refId = body.ref_id || null;
  let row;
  if (refId) {
    row = await env.CAIRNSTONE_DB.prepare("SELECT * FROM refs WHERE ref_id = ?").bind(refId).first();
  } else {
    const stoneHash = requiredString(body.stone_hash, "stone_hash");
    const path = body.path || "content.txt";
    const lineStart = Number(body.line_start || 1);
    row = await env.CAIRNSTONE_DB.prepare(
      "SELECT * FROM refs WHERE stone_hash = ? AND path = ? AND line_start <= ? AND line_end >= ? LIMIT 1"
    ).bind(stoneHash, path, lineStart, lineStart).first();
  }
  if (!row) return { ok: false, error: "ref_not_found" };
  const context = clamp(optionalNumber(body.context_lines, 0), 0, 200);
  const raw = await env.CAIRNSTONE_RAW.get(row.raw_key);
  if (!raw) return { ok: false, error: "raw_not_found", raw_key: row.raw_key };
  const text = await raw.text();
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Number(row.line_start) - context);
  const end = Math.min(lines.length, Number(row.line_end) + context);
  const window = lines.slice(start - 1, end).map((line, i) => ({ n: start + i, text: line }));
  await logEvent(env, { stone_hash: row.stone_hash, ref_id: row.ref_id, event_type: "expand" });
  return { ok: true, ref_id: row.ref_id, stone_hash: row.stone_hash, path: row.path, line_start: start, line_end: end, text: window.map(line => line.text).join("\n"), lines: window };
}

const FLAG_PATTERNS = [
  { type: "empty_catch", re: /catch\s*\([^)]*\)\s*\{\s*\}/g },
  { type: "var_usage", re: /\bvar\s+[a-zA-Z_$]/g },
  { type: "console_debug", re: /\bconsole\.(log|debug|warn)\s*\(/g },
  { type: "debugger_statement", re: /\bdebugger\b/g },
  { type: "todo_comment", re: /\b(TODO|FIXME|XXX|HACK)\b/g },
  { type: "hardcoded_secret", re: /(api[_-]?key|secret|password|pass|token)\w*\s*[:=]\s*["'][^"']{4,}["']/gi }
];

function detectFlags(text) {
  const flags = [];
  for (const { type, re } of FLAG_PATTERNS) {
    const matches = [...text.matchAll(re)];
    if (matches.length) flags.push({ type, count: matches.length });
  }
  const lines = text.split(/\r?\n/);
  const longLines = lines.filter(l => l.length > 300).length;
  if (longLines) flags.push({ type: "long_line", count: longLines });
  return flags;
}

async function buildRefs({ stoneHash, path, rawKey, content }) {
  const lines = content.split(/\r?\n/);
  const refs = [];
  const byNormalized = new Map();
  for (let i = 0; i < lines.length; i += DEFAULT_LINES_PER_REF) {
    const chunkLines = lines.slice(i, i + DEFAULT_LINES_PER_REF);
    const text = chunkLines.join("\n");
    const chunkHash = await sha256(`${stoneHash}:${path}:${i + 1}:${text}`);
    const refId = `fsl:${chunkHash.slice(0, 16)}`;
    const ref = { ref_id: refId, stone_hash: stoneHash, path, line_start: i + 1, line_end: i + chunkLines.length, keywords: extractKeywords(text, 12), preview: preview(text), raw_key: rawKey, flags: detectFlags(text) };
    refs.push(ref);
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length > 40) {
      if (!byNormalized.has(normalized)) byNormalized.set(normalized, []);
      byNormalized.get(normalized).push(refId);
    }
  }
  // mark duplicate chunks: any two refs whose normalized text matches exactly
  for (const ids of byNormalized.values()) {
    if (ids.length <= 1) continue;
    for (const ref of refs) {
      if (!ids.includes(ref.ref_id)) continue;
      ref.flags.push({ type: "duplicate_chunk", count: ids.length - 1, with: ids.filter(id => id !== ref.ref_id) });
    }
  }
  return refs;
}

function aggregateFlags(refs) {
  const counts = {};
  let total = 0;
  for (const ref of refs) {
    for (const flag of ref.flags || []) {
      counts[flag.type] = (counts[flag.type] || 0) + (flag.count || 1);
      total += flag.count || 1;
    }
  }
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(",");
  return { total, summary, counts };
}

function buildReceipt({ content, refs, created }) {
  const originalBytes = utf8Bytes(content);
  const compressedBytes = utf8Bytes(JSON.stringify(refs));
  return { original_bytes: originalBytes, compressed_bytes: compressedBytes, ratio: compressedBytes > 0 ? Number((originalBytes / compressedBytes).toFixed(2)) : 0, strategy: "cairnstone-v6.server-side-github-fetch-ref-index", created_at: created };
}

function buildLayers({ title, author, repo, commit, content, refs, receipt, rawKey }) {
  const lineCount = content.split(/\r?\n/).length;
  const topKeywords = extractKeywords(content, 16);
  const flagInfo = aggregateFlags(refs);
  const lod5 = `${title}: ${lineCount} lines, ${refs.length} refs, ${receipt.ratio}x ratio${flagInfo.total ? `, ${flagInfo.total} flags` : ""}`;
  const lod4 = [lod5, `author=${author}`, repo ? `repo=${repo}` : null, commit ? `commit=${commit}` : null, `top=${topKeywords.slice(0, 8).join(",")}`, flagInfo.total ? `flags=${flagInfo.summary}` : null].filter(Boolean).join(" | ");
  const lod3 = refs.slice(0, 24).map(ref => {
    const flagStr = ref.flags && ref.flags.length ? ` \u26a0${ref.flags.map(f => f.type).join(",")}` : "";
    return `${ref.ref_id} ${ref.path}:${ref.line_start}-${ref.line_end} ${ref.keywords.slice(0, 5).join(",")}${flagStr}`;
  }).join("\n");
  return { lod5, lod4, lod3, lod2: { compressed_index: refs, receipt }, lod1: { raw_key: rawKey, raw_bytes: receipt.original_bytes } };
}

function extractKeywords(text, limit) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has", "not", "you", "your", "but", "can", "will", "all", "into", "our", "out", "use", "using", "true", "false", "null"]);
  const counts = new Map();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_]{3,}/g)) {
    const term = match[0];
    if (stop.has(term)) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([term]) => term);
}

function preview(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 260);
}

async function logEvent(env, event) {
  if (!env.CAIRNSTONE_DB) return;
  const id = await sha256(`${Date.now()}:${Math.random()}:${JSON.stringify(event)}`);
  await env.CAIRNSTONE_DB.prepare(
    "INSERT INTO retrieval_events (id,stone_hash,ref_id,query,event_type,created_at) VALUES (?,?,?,?,?,?)"
  ).bind(id, event.stone_hash || null, event.ref_id || null, event.query || null, event.event_type, new Date().toISOString()).run();
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}

function requireBindings(env) {
  if (!env.CAIRNSTONE_DB) throw new Error("Missing D1 binding CAIRNSTONE_DB");
  if (!env.CAIRNSTONE_RAW) throw new Error("Missing R2 binding CAIRNSTONE_RAW");
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required string: ${name}`);
  return value;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function optionalNumber(value, fallback) {
  return value === undefined || value === null || value === "" ? fallback : Number(value);
}

function json(data, status = 200) {
  return withCors(Response.json(data, { status }));
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,Mcp-Session-Id");
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withSession(response, sessionId) {
  if (!sessionId) return response;
  const headers = new Headers(response.headers);
  headers.set("Mcp-Session-Id", sessionId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function mcpRespond(request, payload, sessionId, status = 200) {
  const accept = request.headers.get("accept") || "";
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization,Mcp-Session-Id");
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
  headers.set("cache-control", "no-store");
  if (sessionId) headers.set("Mcp-Session-Id", sessionId);
  if (accept.includes("text/event-stream")) {
    headers.set("content-type", "text/event-stream");
    return new Response("event: message\ndata: " + JSON.stringify(payload) + "\n\n", { status, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), { status, headers });
}

// ============================================================
// v2 surface (CairnStone V6): short hashes, per-path heads,
// FTS5 find, compact manifests, one-call commit.
// Additive only - v1 tools and routes are unchanged.
// ============================================================

async function resolveStoneHash(env, input) {
  const value = requiredString(input, "hash");
  if (value.length === 64) {
    const row = await env.CAIRNSTONE_DB.prepare("SELECT hash FROM stones WHERE hash = ?").bind(value).first();
    return row ? { ok: true, hash: row.hash } : { ok: false, error: "stone_not_found", hash: value };
  }
  if (value.length < 8) return { ok: false, error: "hash_prefix_too_short", hash: value, min_length: 8 };
  const safe = value.replaceAll("%", "").replaceAll("_", "");
  const rows = await env.CAIRNSTONE_DB.prepare("SELECT hash FROM stones WHERE hash LIKE ? LIMIT 3").bind(`${safe}%`).all();
  const results = rows.results || [];
  if (results.length === 0) return { ok: false, error: "stone_not_found", hash: value };
  if (results.length > 1) return { ok: false, error: "ambiguous_hash_prefix", hash: value, matches: results.map(r => r.hash.slice(0, 16)) };
  return { ok: true, hash: results[0].hash };
}

async function upsertPathHead(env, chain, path, hash, updated) {
  await env.CAIRNSTONE_DB.prepare(
    "INSERT INTO path_heads (chain,path,head_hash,updated_at) VALUES (?,?,?,?) ON CONFLICT(chain,path) DO UPDATE SET head_hash=excluded.head_hash, updated_at=excluded.updated_at"
  ).bind(chain, path, hash, updated).run();
}

async function ftsIndexRefs(env, stoneHash, chain, refs) {
  try {
    for (const ref of refs) {
      const keywords = Array.isArray(ref.keywords) ? ref.keywords.join(" ") : String(ref.keywords || "");
      await env.CAIRNSTONE_DB.prepare(
        "INSERT INTO refs_fts (ref_id,stone_hash,chain,path,keywords,preview) VALUES (?,?,?,?,?,?)"
      ).bind(ref.ref_id, stoneHash, chain || "", ref.path || "", keywords, ref.preview || "").run();
    }
    return true;
  } catch {
    return false;
  }
}

async function getChainManifestV2(env, chain, options = {}) {
  requireBindings(env);
  const detail = ["summary", "compact", "full"].includes(options.detail) ? options.detail : "compact";
  if (detail === "full") return getChainManifest(env, chain);
  const since = typeof options.since === "string" && options.since ? options.since : null;

  const headRow = await env.CAIRNSTONE_DB.prepare("SELECT head_hash, updated_at FROM chain_heads WHERE chain = ?").bind(chain).first();
  let pathHeads = [];
  try {
    const ph = await env.CAIRNSTONE_DB.prepare("SELECT path, head_hash, updated_at FROM path_heads WHERE chain = ? ORDER BY path ASC").bind(chain).all();
    pathHeads = (ph.results || []).map(r => ({ path: r.path, head: String(r.head_hash).slice(0, 12), updated: String(r.updated_at).slice(0, 10) }));
  } catch {}

  const stoneRows = await env.CAIRNSTONE_DB.prepare(
    "SELECT hash,title,created_at,stone_json FROM stones WHERE chain_hash = ? ORDER BY created_at ASC"
  ).bind(chain).all();
  const all = stoneRows.results || [];
  const rowsInScope = since ? all.filter(r => String(r.created_at) >= since) : all;

  if (detail === "summary") {
    const out = {
      ok: true,
      chain,
      stones: all.length,
      head: headRow ? headRow.head_hash.slice(0, 12) : null,
      path_heads: pathHeads
    };
    if (since) out.new_since = rowsInScope.length;
    return out;
  }

  const headHash = headRow ? headRow.head_hash : null;
  const groups = new Map();
  for (const row of rowsInScope) {
    let lod5 = "";
    try { lod5 = (JSON.parse(row.stone_json || "{}").layers || {}).lod5 || ""; } catch {}
    const key = `${row.title}|${lod5}`;
    const isHead = headHash === row.hash;
    const existing = groups.get(key);
    if (existing) {
      existing.n += 1;
      if (isHead) { existing.id = row.hash.slice(0, 12); existing.date = String(row.created_at).slice(0, 10); existing.head = true; }
      else if (!existing.head) { existing.id = row.hash.slice(0, 12); existing.date = String(row.created_at).slice(0, 10); }
    } else {
      groups.set(key, { id: row.hash.slice(0, 12), title: row.title, lod5, date: String(row.created_at).slice(0, 10), n: 1, head: isHead });
    }
  }
  const nodes = [...groups.values()].map(group => {
    const node = { id: group.id, t: group.title, lod5: group.lod5, date: group.date };
    if (group.n > 1) node.dups = group.n;
    if (group.head) node.head = true;
    return node;
  });

  const hashes = rowsInScope.map(r => r.hash);
  const edges = await queryEdgesByHashes(env, hashes);
  const edgeStrings = [...new Set(edges.map(e => `${e.from_hash.slice(0, 12)}>${e.to_hash.slice(0, 12)}:${e.edge_type}`))];

  const out = {
    ok: true,
    chain,
    detail,
    stones: all.length,
    nodes_shown: nodes.length,
    edges_shown: edgeStrings.length,
    head: headHash ? headHash.slice(0, 12) : null,
    path_heads: pathHeads,
    nodes,
    edges: edgeStrings
  };
  if (since) out.since = since;
  return out;
}

async function findV2FromBody(body, env) {
  requireBindings(env);
  const query = requiredString(body.query, "query");
  const chain = typeof body.chain === "string" && body.chain ? body.chain : null;
  const topK = clamp(Number(body.top_k || 5), 1, 25);
  const doExpand = body.expand === true;
  const context = clamp(optionalNumber(body.context_lines, 20), 0, 200);

  let stoneFilter = null;
  if (typeof body.stone_hash === "string" && body.stone_hash) {
    const resolved = await resolveStoneHash(env, body.stone_hash);
    if (!resolved.ok) return resolved;
    stoneFilter = resolved.hash;
  }

  const terms = tokenizeQuery(query);
  if (!terms.length) return { ok: false, error: "empty_query_terms" };
  const matchExpr = terms.map(term => `"${String(term).replaceAll('"', "")}"`).join(" OR ");

  let results = [];
  let mode = "fts";
  try {
    let sql = "SELECT ref_id, stone_hash, chain, path, preview, bm25(refs_fts) AS score FROM refs_fts WHERE refs_fts MATCH ?";
    const binds = [matchExpr];
    if (chain) { sql += " AND chain = ?"; binds.push(chain); }
    if (stoneFilter) { sql += " AND stone_hash = ?"; binds.push(stoneFilter); }
    sql += " ORDER BY bm25(refs_fts) LIMIT ?";
    binds.push(topK);
    results = (await env.CAIRNSTONE_DB.prepare(sql).bind(...binds).all()).results || [];
  } catch {
    mode = "like_fallback";
    const like = `%${query.toLowerCase().replaceAll("%", "").replaceAll("_", "")}%`;
    let sql = "SELECT r.ref_id, r.stone_hash, s.chain_hash AS chain, r.path, r.preview, 0 AS score FROM refs r LEFT JOIN stones s ON s.hash = r.stone_hash WHERE (LOWER(r.keywords) LIKE ? OR LOWER(r.preview) LIKE ?)";
    const binds = [like, like];
    if (chain) { sql += " AND s.chain_hash = ?"; binds.push(chain); }
    if (stoneFilter) { sql += " AND r.stone_hash = ?"; binds.push(stoneFilter); }
    sql += " LIMIT ?";
    binds.push(topK);
    results = (await env.CAIRNSTONE_DB.prepare(sql).bind(...binds).all()).results || [];
  }

  await logEvent(env, { stone_hash: stoneFilter, query, event_type: "find_v2" });

  const matches = results.map(row => ({
    ref: row.ref_id,
    stone: String(row.stone_hash).slice(0, 12),
    chain: row.chain || undefined,
    path: row.path,
    score: typeof row.score === "number" ? Math.round(row.score * 100) / 100 : undefined,
    preview: String(row.preview || "").slice(0, 160)
  }));

  const out = { ok: true, query, mode, total: matches.length, matches };

  if (doExpand && results.length) {
    const expanded = [];
    for (const row of results.slice(0, Math.min(3, topK))) {
      const refRow = await env.CAIRNSTONE_DB.prepare("SELECT * FROM refs WHERE ref_id = ?").bind(row.ref_id).first();
      if (!refRow) continue;
      const item = await expandRefRow(refRow, env, context, null);
      expanded.push({ ref: row.ref_id, stone: String(row.stone_hash).slice(0, 12), path: refRow.path, text: item.text });
    }
    out.expanded = expanded;
  }

  return out;
}

async function commitV2FromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");
  const author = requiredString(body.author, "author");
  const dedupe = body.dedupe !== false;

  let stoneBody;
  let content;
  if (typeof body.content === "string" && body.content.length > 0) {
    content = body.content;
    stoneBody = { ...body, chain, author };
  } else {
    const fetched = await fetchGitHubFileFromBody({ ...body, return_content: true }, env);
    if (!fetched.ok) return fetched;
    content = fetched.content;
    stoneBody = {
      ...body,
      chain,
      author,
      title: body.title || `${fetched.github.owner}/${fetched.github.repo}/${fetched.github.path}@${fetched.github.ref}`,
      content,
      path: fetched.github.path,
      repo: `${fetched.github.owner}/${fetched.github.repo}`,
      commit: fetched.github.ref,
      metadata: {
        ...(isObject(body.metadata) ? body.metadata : {}),
        source_type: "github_file",
        github: fetched.github,
        fetch: fetched.fetch
      }
    };
  }
  delete stoneBody.set_as_head;
  delete stoneBody.edges;

  const rawHash = await sha256(content);
  const rawKey = `raw/${rawHash}.txt`;

  let stoneHash = null;
  let deduped = false;
  let refsCount = null;
  if (dedupe) {
    const existing = await env.CAIRNSTONE_DB.prepare(
      "SELECT hash FROM stones WHERE chain_hash = ? AND raw_key = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(chain, rawKey).first();
    if (existing) {
      stoneHash = existing.hash;
      deduped = true;
    }
  }

  if (!stoneHash) {
    const created = await createStoneFromBody(stoneBody, env);
    if (!created.ok) return created;
    stoneHash = created.stone_hash;
    refsCount = created.refs;
  }

  const now = new Date().toISOString();
  const path = stoneBody.path || null;
  const actions = [];
  if (deduped) actions.push("deduped_to_existing_stone");

  if (path && body.set_path_head !== false) {
    await upsertPathHead(env, chain, path, stoneHash, now);
    actions.push(`path_head:${path}`);
  }
  if (body.set_as_head === true) {
    await upsertHead(env, chain, stoneHash, now);
    actions.push("chain_head");
  }

  const edgeResults = [];
  for (const edge of Array.isArray(body.edges) ? body.edges : []) {
    if (!edge || typeof edge.to !== "string" || typeof edge.type !== "string") {
      edgeResults.push({ to: edge && edge.to, ok: false, error: "invalid_edge_spec" });
      continue;
    }
    const target = await resolveStoneHash(env, edge.to);
    if (!target.ok) {
      edgeResults.push({ to: edge.to, ok: false, error: target.error });
      continue;
    }
    if (target.hash === stoneHash) {
      edgeResults.push({ to: edge.to, ok: false, error: "self_edge_skipped" });
      continue;
    }
    const linked = await linkStonesFromBody({ from_hash: stoneHash, to_hash: target.hash, edge_type: edge.type, note: edge.note || null }, env);
    if (linked.ok === false) edgeResults.push({ to: target.hash.slice(0, 12), type: edge.type, ok: false, error: linked.error });
    else edgeResults.push({ to: target.hash.slice(0, 12), type: edge.type, ok: true });
  }

  const out = { ok: true, stone: stoneHash.slice(0, 12), stone_hash: stoneHash, deduped, actions };
  if (refsCount !== null) out.refs = refsCount;
  if (edgeResults.length) out.edges = edgeResults;
  return out;
}

async function stoneV2FromBody(body, env) {
  requireBindings(env);
  const resolved = await resolveStoneHash(env, body.hash);
  if (!resolved.ok) return resolved;
  const level = typeof body.level === "string" && body.level ? body.level : null;
  if (level) {
    if (!/^lod[1-5]$/.test(level)) return { ok: false, error: "invalid_level", allowed: ["lod1", "lod2", "lod3", "lod4", "lod5"] };
    return getLod(env, resolved.hash, level);
  }
  const result = await getStone(env, resolved.hash);
  if (!result.ok) return result;
  const stone = result.stone;
  const border = stone.border || {};
  const layers = stone.layers || {};
  const out = {
    ok: true,
    stone: resolved.hash.slice(0, 12),
    stone_hash: resolved.hash,
    title: border.title,
    author: border.author,
    created: String(border.created || "").slice(0, 10),
    lod5: layers.lod5 || ""
  };
  if (border.repo) out.repo = border.repo;
  if (border.path) out.path = border.path;
  if (border.chain) out.chain = border.chain;
  if (layers.lod4) out.lod4 = layers.lod4;
  return out;
}
