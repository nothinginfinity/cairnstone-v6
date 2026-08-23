import { parse as babelParse } from "@babel/parser";
import {
  createRepoStonesFromBody as createRepoStonesRuntimeFromBody,
  fetchGitHubRepoTree
} from "./repo-stones-runtime.js";
import { importV5BundleFromBody } from "./v5-import.js";
import {
  getInboxFromBody,
  readMessageFromBody,
  sendMessageFromBody
} from "./correspondence.js";
import { askChainFromBody, ASK_TOOL_DEFINITION } from "./ask.js";
import {
  getSkillFromBody,
  listSkillsFromBody,
  resolveSkillsFromBody,
  SKILLS_TOOL_DEFINITIONS
} from "./skills.js";

const VERSION = "0.4.5";
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
      if (request.method === "POST" && url.pathname === "/v1/find-by-source") return json(await findBySourceFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/check-freshness") return json(await checkSourceFreshnessFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/get-freshness") return json(await getSourceFreshnessFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/freshness-status") return json(await getFreshnessStatusFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/reconcile-repo") return json(await reconcileRepoFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/set-path-head") return json(await setPathHeadFromBody(await request.json(), env));
      if (request.method === "POST" && url.pathname === "/v1/import-v5-bundle") return json(await importV5BundleFromBody(await request.json(), env));
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

      // V6.4: deterministic one-call chain resume/orientation. Read-only -- see resumeChainFromBody.
      const resumeV2Match = url.pathname.match(/^\/v2\/chains\/([^/]+)\/resume$/);
      if (request.method === "GET" && resumeV2Match) {
        const chain = decodeURIComponent(resumeV2Match[1]);
        if (!chain) return json({ ok: false, error: "missing_chain", route: "/v2/chains/:chain/resume" }, 400);
        return json(await resumeChainFromBody({ chain }, env));
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
    "POST /v1/find-by-source",
    "POST /v1/check-freshness",
    "POST /v1/get-freshness",
    "POST /v1/freshness-status",
    "POST /v1/reconcile-repo",
    "POST /v1/set-path-head",
    "POST /v1/import-v5-bundle",
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
    "GET /v2/stones/:hash?level=lod1-5",
    "GET /v2/chains/:chain/resume"
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
  if (name === "cairnstone_list_skills") return listSkillsFromBody(args, env);
  if (name === "cairnstone_get_skill") return getSkillFromBody(args, env);
  if (name === "cairnstone_resolve_skills") return resolveSkillsFromBody(args, env);
  if (name === "cairnstone_send_message") return sendMessageFromBody(args, env, { createStone: body => createStoneFromBody(body, env) });
  if (name === "cairnstone_get_inbox") return getInboxFromBody(args, env, { createStone: body => createStoneFromBody(body, env) });
  if (name === "cairnstone_read_message") return readMessageFromBody(args, env, { createStone: body => createStoneFromBody(body, env) });
  if (name === "cairnstone_list_stones") return listStones(env, { ...args, origin: "mcp://cairnstone" });
  if (name === "cairnstone_fetch_github_file") return fetchGitHubFileFromBody(args, env);
  if (name === "cairnstone_find_by_source") return findBySourceFromBody(args, env);
  if (name === "cairnstone_check_source_freshness") return checkSourceFreshnessFromBody(args, env);
  if (name === "cairnstone_get_source_freshness") return getSourceFreshnessFromBody(args, env);
  if (name === "cairnstone_freshness_status") return getFreshnessStatusFromBody(args, env);
  if (name === "cairnstone_reconcile_repo") return reconcileRepoFromBody(args, env);
  if (name === "cairnstone_set_path_head") return setPathHeadFromBody(args, env);
  if (name === "cairnstone_import_v5_bundle") return importV5BundleFromBody(args, env);
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
  if (name === "cairnstone_resume_chain") return resumeChainFromBody(args, env);
  if (name === "cairnstone_ask") return askChainFromBody(args, env, {
    resumeChainFromBody,
    getSourceFreshnessFromBody,
    checkSourceFreshnessFromBody,
    commitV2FromBody
  });
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
      name: "cairnstone_find_by_source",
      description: "V6.1: deterministic (repo, path[, commit_sha]) lookup. Resolves directly to the covering stone(s) via structured indexed columns -- no FTS, no fuzzy matching. Omit commit_sha to get every stone ever created for that (repo, path) across all commits, most recent first (multiple stones may legitimately reference the same commit, e.g. a file stone plus a later review). Pass commit_sha for an exact-match lookup against one specific immutable commit.",
      inputSchema: {
        type: "object",
        required: ["owner", "repo", "path"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          commit_sha: { type: "string", description: "Full 40-hex commit SHA for an exact match. Omit to list all stones for this (repo, path)." },
          limit: { type: "number", minimum: 1, maximum: 200 }
        }
      }
    },
    {
      name: "cairnstone_check_source_freshness",
      description: "V6.2.1: live-check whether a chain's accepted path_head is still in sync with the current GitHub file at (owner, repo, path, ref). Compares the accepted stone's exact content identity against the observed file content, while recording the repository commit SHA only as provenance/context. Unrelated commits elsewhere in the repo do not create false drift. A missing observed path is reported as removed. The check never advances path_heads/chain_heads.",
      inputSchema: {
        type: "object",
        required: ["chain", "path", "owner", "repo"],
        properties: {
          chain: { type: "string" },
          path: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          ref: { type: "string", description: "Branch, tag, or commit SHA to check against. Defaults to main." }
        }
      }
    },
    {
      name: "cairnstone_get_source_freshness",
      description: "V6.2: read the last-recorded freshness check for one (chain, path). No GitHub call -- cheap read of what cairnstone_check_source_freshness last found. Returns checked:false if it's never been checked.",
      inputSchema: {
        type: "object",
        required: ["chain", "path"],
        properties: { chain: { type: "string" }, path: { type: "string" } }
      }
    },
    {
      name: "cairnstone_freshness_status",
      description: "V6.2: chain-wide freshness summary from recorded checks only (no live GitHub calls -- not a repo walk, that's V6.3's cairnstone_reconcile_repo). Splits paths into drifted vs in-sync, and flags accepted path_heads that have never been checked at all.",
      inputSchema: {
        type: "object",
        required: ["chain"],
        properties: { chain: { type: "string" } }
      }
    },
    {
      name: "cairnstone_reconcile_repo",
      description: "V6.3: resolve a repository ref to one immutable commit, walk that exact Git tree once, compare every observed path against accepted per-path CairnStone state, and return structured added/changed/removed/in_sync tuples. Existing accepted stones use stored Git blob identity when available, otherwise their R2 raw content is converted to the equivalent Git blob SHA locally. Reconciliation never writes chain_heads or path_heads and never stones or accepts source automatically.",
      inputSchema: {
        type: "object",
        required: ["chain"],
        properties: {
          chain: { type: "string" },
          owner: { type: "string", description: "GitHub owner. Optional when it can be inferred from accepted stones or a chain formatted as owner/repo." },
          repo: { type: "string", description: "GitHub repository name. Optional when it can be inferred from accepted stones or a chain formatted as owner/repo." },
          ref: { type: "string", description: "Branch, tag, or commit SHA. Defaults to main; mutable refs are resolved once before the tree walk." },
          include_in_sync: { type: "boolean", description: "Include in_sync tuples in the returned tuple list. Defaults to false so drift stays compact." },
          max_paths: { type: "number", minimum: 1, maximum: 5000, description: "Maximum tuples returned after classification. Summary counts always cover the full tree. Defaults to 1000." }
        }
      }
    },
    {
      name: "cairnstone_set_path_head",
      description: "V6.2.1: explicitly accept one stone as the canonical per-path state for (chain, path). This updates path_heads only; it never changes the chain-level HEAD. The stone must already belong to the same chain and path.",
      inputSchema: {
        type: "object",
        required: ["chain", "path", "hash"],
        properties: {
          chain: { type: "string" },
          path: { type: "string" },
          hash: { type: "string", description: "Full or >=8-character CairnStone hash." }
        }
      }
    },
    {
      name: "cairnstone_send_message",
      description: "AC1: create one immutable correspondence Stone and recipient delivery state. Correspondence transports intent but grants no execution authority.",
      inputSchema: {
        type: "object",
        required: ["from", "to", "content"],
        properties: {
          from: { type: "string" },
          to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 },
          content: { type: "string" },
          message_id: { type: "string" },
          thread_id: { type: "string" },
          intent: { type: "string", enum: ["message", "handoff", "task_request", "task_result", "ack"] },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          subject: { type: "string" }
        },
        additionalProperties: false
      }
    },
    {
      name: "cairnstone_get_inbox",
      description: "AC1: list compact correspondence metadata and LOD5 for one recipient without mutating message Stones.",
      inputSchema: {
        type: "object",
        required: ["recipient_id"],
        properties: {
          recipient_id: { type: "string" },
          status: { type: "string", enum: ["queued", "delivered", "read", "acked", "archived"] },
          limit: { type: "number", minimum: 1, maximum: 200 }
        },
        additionalProperties: false
      }
    },
    {
      name: "cairnstone_read_message",
      description: "AC1: read one recipient message by message_id or stone_hash and mark only its delivery state as read.",
      inputSchema: {
        type: "object",
        required: ["recipient_id"],
        properties: {
          recipient_id: { type: "string" },
          message_id: { type: "string" },
          stone_hash: { type: "string" }
        },
        oneOf: [
          { required: ["message_id"] },
          { required: ["stone_hash"] }
        ],
        additionalProperties: false
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
          set_as_head: { type: "boolean", description: "Mark this stone as the chain-level HEAD on creation. This does NOT set the per-path head; use cairnstone_commit_v2 or cairnstone_set_path_head for per-file acceptance." }
        }
      }
    },
    {
      name: "cairnstone_create_repo_stones",
      description: "Walk a GitHub repository, create CairnStones for accepted files, populate per-path accepted heads for those files, generate an orientation stone, link it to file stones, and optionally set the orientation as chain HEAD.",
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
      description: "Mark a stone as the chain-level canonical HEAD. This is semantic/orientation state and does NOT change any per-path head. Use cairnstone_set_path_head (or cairnstone_commit_v2) to accept a specific file version.",
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
      name: "cairnstone_resume_chain",
      description: "V6.4: deterministic one-call chain resume/orientation. Returns the exact accepted canonical state for a chain in a single response -- chain-level HEAD (resolved directly from chain_heads, never inferred from timestamps), the HEAD stone's structured GitHub provenance and metadata, every accepted path_head, and every graph edge (inbound and outbound) directly connected to HEAD. Read-only: never creates stones, never moves chain_heads or path_heads, never reconciles or accepts source. Use this as the first call when resuming work on a chain instead of separately fetching the manifest, guessing HEAD from timestamps, and parsing lod5 prose.",
      inputSchema: {
        type: "object",
        required: ["chain"],
        properties: {
          chain: { type: "string" }
        }
      }
    },
    {
      name: "cairnstone_find_v2",
      description: "Vault-wide full-text search (FTS5 + bm25) over all ref keywords and previews, with optional chain or stone filter and optional inline expansion of top hits. Replaces cairnstone_search and vault-wide use of cairnstone_query_and_expand: one call to find and read. V6.5: identifier tokens with underscores (e.g. chain_heads) now index and match as single tokens; bm25 ranking weights keywords highest, then path, then preview; match_mode controls multi-word handling -- 'any' (default) matches refs containing any query term, 'all' requires every term to appear, 'phrase' requires the exact adjacent sequence. A query fully wrapped in double quotes is always treated as an exact phrase regardless of match_mode.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          chain: { type: "string", description: "Restrict to one chain" },
          stone_hash: { type: "string", description: "Restrict to one stone (full or >=8-char short hash)" },
          top_k: { type: "number", description: "Max matches, default 5" },
          match_mode: { type: "string", enum: ["any", "all", "phrase"], description: "Default 'any' (OR across terms). 'all' requires every term present. 'phrase' requires the exact adjacent sequence. A fully-quoted query is always treated as a phrase." },
          expand: { type: "boolean", description: "If true, expand the top hits' raw content inline (max 3)" },
          context_lines: { type: "number", description: "Context lines around expanded refs, default 20" }
        }
      }
    },
    ...SKILLS_TOOL_DEFINITIONS,
    ASK_TOOL_DEFINITION,
    {
      name: "cairnstone_commit_v2",
      description: "One-call write path: create a stone (inline content OR server-side GitHub fetch via owner/repo/path/ref), dedupe identical content only within the same (chain,path), set the per-path head automatically, optionally set the chain head, and create typed edges - all in one call. GitHub-backed writes fail closed unless the requested ref resolves to an immutable 40-hex commit SHA. Edges accept short (>=8 char) target hashes.",
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
      name: "cairnstone_import_v5_bundle",
      description: "V6.7: explicitly preview or import one complete CairnStone V5 chain snapshot without mutating V5. Preserves exact V5 stone hashes, raw/ref identity, receipts, typed edge IDs, path heads, and canonical chain HEAD. Dry-run is the default. Apply requires dry_run:false plus confirm_import:true. Destination collisions fail closed and there is no override mode; canonical HEAD is written last.",
      inputSchema: {
        type: "object",
        required: ["bundle"],
        properties: {
          bundle: { type: "object", description: "Portable cairnstone-v5-transfer-v1 full-chain bundle: source identity, graph-complete source_manifest, exact head, path_heads, stones as {stone,raw_content}, and typed edges." },
          dry_run: { type: "boolean", description: "Defaults true. Validate identity and destination collisions and return a write preview without changing V6." },
          confirm_import: { type: "boolean", description: "Required true when dry_run=false. Explicit opt-in guard; ignored for preview." }
        },
        additionalProperties: false
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
    clamp,
    upsertPathHead
  });
}

async function createStoneFromGitHubBody(body, env) {
  const fetched = await fetchGitHubFileFromBody({ ...body, return_content: true }, env);
  if (!fetched.ok) return fetched;
  // V6.1: resolve the requested ref (branch/tag/short-sha) to a real, immutable commit SHA
  // for structured provenance. requested_ref stays available in metadata so the original
  // ask ("main") is never lost, but border.commit is always either a real commit SHA or
  // explicitly flagged unresolved -- never a mutable branch name masquerading as a commit.
  const resolution = await resolveGitHubCommit(fetched.github.owner, fetched.github.repo, fetched.github.ref, env);
  const title = body.title || `${fetched.github.owner}/${fetched.github.repo}/${fetched.github.path}@${resolution.sha || fetched.github.ref}`;
  const stoneBody = {
    ...body,
    title,
    content: fetched.content,
    path: fetched.github.path,
    repo: `${fetched.github.owner}/${fetched.github.repo}`,
    commit: resolution.sha || fetched.github.ref,
    metadata: {
      ...(isObject(body.metadata) ? body.metadata : {}),
      source_type: "github_file",
      github: {
        ...fetched.github,
        requested_ref: fetched.github.ref,
        commit_resolved: Boolean(resolution.sha),
        commit_resolution_error: resolution.sha ? undefined : resolution.error
      },
      fetch: fetched.fetch
    }
  };
  return createStoneFromBody(stoneBody, env);
}

// V6.1: resolve a branch/tag/short-ref to a real 40-hex commit SHA via the GitHub REST API.
// If the ref is already a full 40-hex SHA, it's returned as-is with no API call (it's already
// a real commit identifier). On failure, returns { sha: null, error } rather than throwing --
// callers explicitly flag unresolved provenance instead of silently treating a branch name as
// a commit, or hard-failing stone creation over a transient GitHub API hiccup.
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
async function resolveGitHubCommit(owner, repo, ref, env) {
  if (FULL_SHA_RE.test(String(ref || ""))) return { sha: String(ref).toLowerCase(), already_resolved: true };
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  const headers = {
    "User-Agent": "cairnstone-v6-worker",
    "Accept": "application/vnd.github+json"
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      return { sha: null, error: `github_commit_lookup_failed:${response.status}` };
    }
    const data = await response.json();
    if (data && typeof data.sha === "string" && FULL_SHA_RE.test(data.sha)) {
      return { sha: data.sha };
    }
    return { sha: null, error: "github_commit_lookup_malformed_response" };
  } catch (error) {
    return { sha: null, error: `github_commit_lookup_exception:${String(error && error.message ? error.message : error)}` };
  }
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
    "INSERT INTO stones (hash,title,author,created_at,repo,commit_sha,parent_hash,chain_hash,raw_key,stone_json,path) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(stoneHash, title, author, created, repo, commit, parent, chain, rawKey, JSON.stringify(stone), path).run();

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

// V6.1: deterministic (repo, path[, commit_sha]) lookup against structured indexed columns.
// Deliberately does NOT use refs_fts or cairnstone_search -- exact structured match only.
async function findBySourceFromBody(body, env) {
  requireBindings(env);
  const owner = requiredString(body.owner, "owner");
  const repoName = requiredString(body.repo, "repo");
  const path = requiredString(body.path, "path");
  const commitSha = body.commit_sha ? String(body.commit_sha) : null;
  const limit = clamp(Number(body.limit || 50), 1, 200);
  const repo = `${owner}/${repoName}`;

  const query = commitSha
    ? "SELECT hash,title,author,created_at,repo,commit_sha,chain_hash,path FROM stones WHERE repo = ? AND path = ? AND commit_sha = ? ORDER BY created_at DESC LIMIT ?"
    : "SELECT hash,title,author,created_at,repo,commit_sha,chain_hash,path FROM stones WHERE repo = ? AND path = ? ORDER BY created_at DESC LIMIT ?";
  const bindArgs = commitSha ? [repo, path, commitSha, limit] : [repo, path, limit];

  const result = await env.CAIRNSTONE_DB.prepare(query).bind(...bindArgs).all();
  const rows = (result && result.results) || [];
  return {
    ok: true,
    repo,
    path,
    commit_sha: commitSha,
    total: rows.length,
    stones: rows.map(row => ({
      hash: row.hash,
      title: row.title,
      author: row.author,
      created_at: row.created_at,
      commit_sha: row.commit_sha,
      chain: row.chain_hash
    }))
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
  const gitBlobSha = await gitBlobSha1(text);
  const result = {
    ok: true,
    github: { owner, repo, path, ref, raw_url: rawUrl },
    fetch: {
      bytes,
      sha256: sha,
      git_blob_sha: gitBlobSha,
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

async function gitBlobSha1(value) {
  const encoder = new TextEncoder();
  const content = encoder.encode(value);
  const header = encoder.encode(`blob ${content.length}\0`);
  const payload = new Uint8Array(header.length + content.length);
  payload.set(header, 0);
  payload.set(content, header.length);
  const hash = await crypto.subtle.digest("SHA-1", payload);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
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

async function setPathHeadFromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");
  const path = requiredString(body.path, "path");
  const resolved = await resolveStoneHash(env, body.hash);
  if (!resolved.ok) return resolved;
  const row = await env.CAIRNSTONE_DB.prepare(
    "SELECT chain_hash,path FROM stones WHERE hash = ?"
  ).bind(resolved.hash).first();
  if (!row) return { ok: false, error: "stone_not_found", hash: resolved.hash };
  if (row.chain_hash !== chain) return { ok: false, error: "stone_chain_mismatch", chain, stone_chain: row.chain_hash, hash: resolved.hash };
  if (row.path !== path) return { ok: false, error: "stone_path_mismatch", path, stone_path: row.path, hash: resolved.hash };
  const updatedAt = new Date().toISOString();
  await upsertPathHead(env, chain, path, resolved.hash, updatedAt);
  return { ok: true, chain, path, head_hash: resolved.hash, updated_at: updatedAt };
}

// V6.2: accepted-state (path_heads, semantic/curated) vs observed-source (live GitHub) freshness.
// This NEVER writes to path_heads/chain_heads -- reconciliation is read-only with respect to
// HEAD by design. It only records what was observed and whether it differs from what's accepted.
async function upsertSourceFreshness(env, row) {
  await env.CAIRNSTONE_DB.prepare(
    `INSERT INTO source_freshness
       (chain,path,owner,repo,checked_ref,observed_commit_sha,observed_at,accepted_stone_hash,accepted_commit_sha,accepted_content_sha256,observed_content_sha256,drift,drift_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(chain,path) DO UPDATE SET
       owner=excluded.owner, repo=excluded.repo, checked_ref=excluded.checked_ref,
       observed_commit_sha=excluded.observed_commit_sha, observed_at=excluded.observed_at,
       accepted_stone_hash=excluded.accepted_stone_hash, accepted_commit_sha=excluded.accepted_commit_sha,
       accepted_content_sha256=excluded.accepted_content_sha256, observed_content_sha256=excluded.observed_content_sha256,
       drift=excluded.drift, drift_reason=excluded.drift_reason`
  ).bind(
    row.chain, row.path, row.owner, row.repo, row.checked_ref, row.observed_commit_sha,
    row.observed_at, row.accepted_stone_hash, row.accepted_commit_sha,
    row.accepted_content_sha256, row.observed_content_sha256,
    row.drift ? 1 : 0, row.drift_reason
  ).run();
}

// Live check: resolves current GitHub state for (owner,repo,path,ref), compares against the
// chain's accepted path_head, records the result, and returns the comparison. Does NOT touch
// path_heads/chain_heads -- drift is surfaced, never auto-resolved.
async function checkSourceFreshnessFromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");
  const path = requiredString(body.path, "path");
  const owner = requiredString(body.owner, "owner");
  const repoName = requiredString(body.repo, "repo");
  const ref = String(body.ref || DEFAULT_GITHUB_REF);
  const repo = `${owner}/${repoName}`;
  const observedAt = new Date().toISOString();

  // Repository commit is provenance/context only. Path drift is decided by exact file content.
  const resolution = await resolveGitHubCommit(owner, repoName, ref, env);
  const observedFile = await fetchGitHubFile({ owner, repo: repoName, path, ref, maxBytes: MAX_FETCH_BYTES, returnContent: false }, env);

  const pathHeadRow = await env.CAIRNSTONE_DB.prepare(
    "SELECT head_hash FROM path_heads WHERE chain = ? AND path = ?"
  ).bind(chain, path).first();
  const acceptedStoneHash = pathHeadRow ? pathHeadRow.head_hash : null;

  let acceptedCommitSha = null;
  let acceptedContentSha256 = null;
  if (acceptedStoneHash) {
    const stoneRow = await env.CAIRNSTONE_DB.prepare(
      "SELECT commit_sha,raw_key FROM stones WHERE hash = ?"
    ).bind(acceptedStoneHash).first();
    acceptedCommitSha = stoneRow ? stoneRow.commit_sha : null;
    if (stoneRow && typeof stoneRow.raw_key === "string" && /^raw\/[0-9a-f]{64}\.txt$/i.test(stoneRow.raw_key)) {
      acceptedContentSha256 = stoneRow.raw_key.slice(4, -4).toLowerCase();
    }
  }

  const observedContentSha256 = observedFile && observedFile.ok ? observedFile.fetch?.sha256 || null : null;
  const observedMissing = observedFile && observedFile.ok === false && observedFile.status === 404;

  let drift = false;
  let driftReason = null;
  if (!acceptedStoneHash) {
    drift = true;
    driftReason = observedMissing ? "no_accepted_stone_and_missing_source" : "no_accepted_stone";
  } else if (observedMissing) {
    drift = true;
    driftReason = "removed";
  } else if (!observedFile || observedFile.ok === false) {
    drift = true;
    driftReason = `observation_failed:${observedFile?.error || resolution.error || "unknown"}`;
  } else if (!acceptedContentSha256) {
    drift = true;
    driftReason = "accepted_content_identity_missing";
  } else if (acceptedContentSha256 !== observedContentSha256) {
    drift = true;
    driftReason = "content_mismatch";
  }

  await upsertSourceFreshness(env, {
    chain, path, owner, repo: repoName, checked_ref: ref,
    observed_commit_sha: resolution.sha, observed_at: observedAt,
    accepted_stone_hash: acceptedStoneHash, accepted_commit_sha: acceptedCommitSha,
    accepted_content_sha256: acceptedContentSha256,
    observed_content_sha256: observedContentSha256,
    drift, drift_reason: driftReason
  });

  return {
    ok: true,
    chain, path, repo, checked_ref: ref,
    accepted: { stone_hash: acceptedStoneHash, commit_sha: acceptedCommitSha, content_sha256: acceptedContentSha256 },
    observed: {
      commit_sha: resolution.sha,
      content_sha256: observedContentSha256,
      exists: !observedMissing,
      resolved: Boolean(resolution.sha),
      error: observedFile && observedFile.ok === false && !observedMissing ? observedFile.error : (resolution.sha ? undefined : resolution.error)
    },
    drift, drift_reason: driftReason,
    observed_at: observedAt
  };
}

// Cheap read of the last-recorded freshness check for one (chain,path). No GitHub call.
async function getSourceFreshnessFromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");
  const path = requiredString(body.path, "path");
  const row = await env.CAIRNSTONE_DB.prepare(
    "SELECT * FROM source_freshness WHERE chain = ? AND path = ?"
  ).bind(chain, path).first();
  if (!row) return { ok: true, chain, path, checked: false, message: "No freshness check recorded yet for this (chain, path). Call cairnstone_check_source_freshness to check now." };
  return {
    ok: true, chain, path, checked: true,
    repo: `${row.owner}/${row.repo}`, checked_ref: row.checked_ref,
    accepted: { stone_hash: row.accepted_stone_hash, commit_sha: row.accepted_commit_sha, content_sha256: row.accepted_content_sha256 },
    observed: { commit_sha: row.observed_commit_sha, content_sha256: row.observed_content_sha256 },
    drift: Boolean(row.drift), drift_reason: row.drift_reason,
    observed_at: row.observed_at
  };
}

// Chain-wide freshness summary. Cheap read only (no GitHub calls) -- shows every path with a
// recorded freshness check, split into drifted vs in-sync, plus which accepted path_heads have
// never been checked at all. This is deliberately NOT a live repo walk (that's V6.3's
// cairnstone_reconcile_repo) -- it only reports on what's already been recorded.
async function getFreshnessStatusFromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");

  const freshnessRows = (await env.CAIRNSTONE_DB.prepare(
    "SELECT * FROM source_freshness WHERE chain = ? ORDER BY path ASC"
  ).bind(chain).all()).results || [];

  const pathHeadRows = (await env.CAIRNSTONE_DB.prepare(
    "SELECT path FROM path_heads WHERE chain = ? ORDER BY path ASC"
  ).bind(chain).all()).results || [];

  const checkedPaths = new Set(freshnessRows.map(r => r.path));
  const neverChecked = pathHeadRows.map(r => r.path).filter(p => !checkedPaths.has(p));

  const drifted = freshnessRows.filter(r => r.drift).map(r => ({ path: r.path, drift_reason: r.drift_reason, observed_at: r.observed_at }));
  const inSync = freshnessRows.filter(r => !r.drift).map(r => ({ path: r.path, observed_at: r.observed_at }));

  return {
    ok: true,
    chain,
    summary: { total_checked: freshnessRows.length, drifted: drifted.length, in_sync: inSync.length, never_checked: neverChecked.length },
    drifted,
    in_sync: inSync,
    never_checked: neverChecked
  };
}

// V6.3: live repository reconciliation. One immutable Git tree snapshot is compared with the
// deliberately accepted per-path state. No stone, path head, or chain head is created or moved.
async function reconcileRepoFromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");
  const requestedRef = safeGitHubRef(body.ref || DEFAULT_GITHUB_REF);
  const includeInSync = body.include_in_sync === true;
  const maxPaths = clamp(Number(body.max_paths || 1000), 1, 5000);

  let owner = typeof body.owner === "string" && body.owner.trim() ? safeGitHubPart(body.owner, "owner") : null;
  let repoName = typeof body.repo === "string" && body.repo.trim() ? safeGitHubPart(body.repo, "repo") : null;
  if (Boolean(owner) !== Boolean(repoName)) {
    return { ok: false, error: "repo_identity_incomplete", chain, message: "Provide both owner and repo, or neither so CairnStone can infer them." };
  }

  const acceptedRows = (await env.CAIRNSTONE_DB.prepare(
    `SELECT ph.path,ph.head_hash,s.commit_sha,s.raw_key,s.repo,s.stone_json
     FROM path_heads ph LEFT JOIN stones s ON s.hash = ph.head_hash
     WHERE ph.chain = ? ORDER BY ph.path ASC`
  ).bind(chain).all()).results || [];

  if (!owner && !repoName) {
    const repoCandidates = [...new Set(acceptedRows.map(r => String(r.repo || "").trim()).filter(Boolean))];
    const candidate = repoCandidates.length === 1 ? repoCandidates[0] : (/^[^/]+\/[^/]+$/.test(chain) ? chain : null);
    if (!candidate) {
      return { ok: false, error: "repo_identity_required", chain, repo_candidates: repoCandidates, message: "Could not infer one owner/repo identity from accepted path heads. Provide owner and repo explicitly." };
    }
    const parts = candidate.split("/");
    owner = safeGitHubPart(parts[0], "owner");
    repoName = safeGitHubPart(parts[1], "repo");
  }

  const resolution = await resolveGitHubCommit(owner, repoName, requestedRef, env);
  if (!resolution.sha) {
    return { ok: false, error: "github_commit_resolution_failed", chain, repo: `${owner}/${repoName}`, requested_ref: requestedRef, detail: resolution.error || "unknown" };
  }

  const tree = await fetchGitHubRepoTree(
    { owner, repo: repoName, ref: resolution.sha },
    env,
    { safeGitHubPart, safeGitHubRef }
  );
  if (!tree.ok) return { ...tree, chain, requested_ref: requestedRef, observed_commit_sha: resolution.sha };
  if (tree.truncated) {
    return { ok: false, error: "github_tree_truncated", chain, repo: `${owner}/${repoName}`, requested_ref: requestedRef, observed_commit_sha: resolution.sha, message: "Refusing to classify removals from a truncated Git tree." };
  }

  const observedByPath = new Map((tree.files || []).map(file => [file.path, file]));
  const acceptedByPath = new Map();
  for (const row of acceptedRows) {
    let metadata = {};
    try { metadata = (JSON.parse(row.stone_json || "{}").metadata || {}); } catch {}
    let acceptedBlobSha = null;
    let acceptedBlobSource = null;
    if (typeof metadata.fetch?.git_blob_sha === "string" && FULL_SHA_RE.test(metadata.fetch.git_blob_sha)) {
      acceptedBlobSha = metadata.fetch.git_blob_sha.toLowerCase();
      acceptedBlobSource = "metadata.fetch.git_blob_sha";
    } else if (metadata.kind === "repo_file" && typeof metadata.sha === "string" && FULL_SHA_RE.test(metadata.sha)) {
      acceptedBlobSha = metadata.sha.toLowerCase();
      acceptedBlobSource = "metadata.repo_file.sha";
    } else if (row.raw_key) {
      const raw = await env.CAIRNSTONE_RAW.get(row.raw_key);
      if (raw) {
        acceptedBlobSha = await gitBlobSha1(await raw.text());
        acceptedBlobSource = "r2_raw_recomputed";
      }
    }
    acceptedByPath.set(row.path, {
      path: row.path,
      head_hash: row.head_hash,
      commit_sha: row.commit_sha || null,
      blob_sha: acceptedBlobSha,
      blob_source: acceptedBlobSource
    });
  }

  const paths = [...new Set([...observedByPath.keys(), ...acceptedByPath.keys()])].sort();
  const tuples = [];
  const counts = { added: 0, changed: 0, removed: 0, in_sync: 0, unknown: 0 };
  for (const path of paths) {
    const observed = observedByPath.get(path) || null;
    const accepted = acceptedByPath.get(path) || null;
    let driftType;
    let reason = null;
    if (!accepted && observed) driftType = "added";
    else if (accepted && !observed) driftType = "removed";
    else if (!accepted?.blob_sha) {
      driftType = "unknown";
      reason = "accepted_blob_identity_unavailable";
    } else if (accepted.blob_sha === observed.sha) driftType = "in_sync";
    else driftType = "changed";
    counts[driftType] += 1;
    tuples.push({
      path,
      current_stone_hash: accepted?.head_hash || null,
      observed_commit_sha: resolution.sha,
      drift_type: driftType,
      accepted_commit_sha: accepted?.commit_sha || null,
      accepted_blob_sha: accepted?.blob_sha || null,
      observed_blob_sha: observed?.sha || null,
      accepted_blob_source: accepted?.blob_source || null,
      reason
    });
  }

  const visible = includeInSync ? tuples : tuples.filter(item => item.drift_type !== "in_sync");
  const returned = visible.slice(0, maxPaths);
  return {
    ok: true,
    chain,
    repo: `${owner}/${repoName}`,
    requested_ref: requestedRef,
    observed_commit_sha: resolution.sha,
    snapshot: { immutable: true, tree_truncated: false, observed_files: observedByPath.size, accepted_paths: acceptedByPath.size },
    summary: { ...counts, total_paths: paths.length, drifted: counts.added + counts.changed + counts.removed + counts.unknown },
    include_in_sync: includeInSync,
    tuples: returned,
    tuples_total: visible.length,
    tuples_returned: returned.length,
    tuples_truncated: visible.length > returned.length,
    read_only: { chain_heads_written: false, path_heads_written: false, stones_written: false }
  };
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

// V6.4: deterministic chain resume/orientation. One call returns the exact accepted
// canonical state for `chain` -- HEAD resolved directly from chain_heads (never from
// created_at ordering), the HEAD stone's structured provenance/metadata read from stored
// columns and JSON (never parsed out of lod5/lod4 prose), every accepted path_head, and
// every graph edge touching HEAD in either direction. Strictly read-only: no INSERT/UPDATE
// of any kind. Fails closed with explicit error codes rather than degrading into a vague
// orientation on a corrupt or incomplete canonical state.
async function resumeChainFromBody(body, env) {
  requireBindings(env);
  const chain = requiredString(body.chain, "chain");

  const headRow = await env.CAIRNSTONE_DB.prepare(
    "SELECT head_hash, updated_at FROM chain_heads WHERE chain = ?"
  ).bind(chain).first();

  if (!headRow) {
    const anyStone = await env.CAIRNSTONE_DB.prepare(
      "SELECT hash FROM stones WHERE chain_hash = ? LIMIT 1"
    ).bind(chain).first();
    if (!anyStone) return { ok: false, error: "chain_not_found", chain };
    return { ok: false, error: "chain_head_missing", chain, detail: "chain has stones but no chain_heads row -- no HEAD has ever been set" };
  }

  const headStoneRow = await env.CAIRNSTONE_DB.prepare(
    "SELECT hash,title,author,created_at,repo,path,commit_sha,chain_hash,stone_json FROM stones WHERE hash = ?"
  ).bind(headRow.head_hash).first();
  if (!headStoneRow) {
    return { ok: false, error: "head_stone_missing", chain, head_hash: headRow.head_hash, detail: "dangling HEAD: chain_heads points at a hash with no matching row in stones" };
  }
  if (headStoneRow.chain_hash !== chain) {
    return { ok: false, error: "head_chain_mismatch", chain, stone_chain: headStoneRow.chain_hash, head_hash: headRow.head_hash };
  }

  let stoneJson;
  try {
    stoneJson = JSON.parse(headStoneRow.stone_json || "{}");
  } catch {
    return { ok: false, error: "head_stone_json_corrupt", chain, head_hash: headRow.head_hash };
  }
  const metadata = isObject(stoneJson.metadata) ? stoneJson.metadata : {};

  const pathHeadsResult = await env.CAIRNSTONE_DB.prepare(
    `SELECT ph.path AS path, ph.head_hash AS stone_hash, ph.updated_at AS updated_at,
            s.repo AS repo, s.commit_sha AS commit_sha
     FROM path_heads ph
     LEFT JOIN stones s ON s.hash = ph.head_hash
     WHERE ph.chain = ?
     ORDER BY ph.path ASC`
  ).bind(chain).all();
  const path_heads = (pathHeadsResult.results || []).map(row => ({
    path: row.path,
    stone_hash: row.stone_hash,
    repo: row.repo || null,
    commit_sha: row.commit_sha || null,
    updated_at: row.updated_at
  }));

  const edgeSortKey = edge => `${edge.edge_type}|${edge.from_hash}|${edge.to_hash}`;
  const sortEdges = rows => (rows || [])
    .map(edge => ({ from_hash: edge.from_hash, to_hash: edge.to_hash, edge_type: edge.edge_type, note: edge.note || null }))
    .sort((a, b) => {
      const ka = edgeSortKey(a);
      const kb = edgeSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const [outboundRows, inboundRows] = await Promise.all([
    env.CAIRNSTONE_DB.prepare(
      "SELECT from_hash, to_hash, edge_type, note FROM stone_edges WHERE from_hash = ?"
    ).bind(headStoneRow.hash).all(),
    env.CAIRNSTONE_DB.prepare(
      "SELECT from_hash, to_hash, edge_type, note FROM stone_edges WHERE to_hash = ?"
    ).bind(headStoneRow.hash).all()
  ]);
  const outbound = sortEdges(outboundRows.results);
  const inbound = sortEdges(inboundRows.results);

  const canonical_head = {
    hash: headStoneRow.hash,
    title: headStoneRow.title,
    author: headStoneRow.author,
    created_at: headStoneRow.created_at,
    path: headStoneRow.path || null,
    repo: headStoneRow.repo || null,
    commit_sha: headStoneRow.commit_sha || null,
    metadata
  };

  const provenance = {
    repo: headStoneRow.repo || null,
    path: headStoneRow.path || null,
    commit_sha: headStoneRow.commit_sha || null,
    source_type: metadata.source_type || (isObject(metadata.github) ? "github_file" : null)
  };

  return {
    ok: true,
    chain,
    canonical_head,
    provenance,
    path_heads,
    edges: { outbound, inbound },
    graph_complete: true,
    resume: {
      canonical_source: "chain_head",
      timestamp_ordering_used: false
    }
  };
}

// V6.5: builds the FTS5 MATCH expression for a query + match_mode.
// - A query fully wrapped in double quotes is always an exact phrase, regardless of match_mode.
// - match_mode "phrase" treats the whole (unquoted) query as one exact adjacent-token phrase.
// - match_mode "all" requires every tokenized term to appear (FTS5 AND).
// - match_mode "any" (default) matches refs containing any tokenized term (FTS5 OR) -- unchanged
//   default behavior from the pre-V6.5 implementation, preserved for backward compatibility.
function buildMatchExpr(query, matchMode) {
  const trimmed = String(query || "").trim();
  const isFullyQuoted = trimmed.length > 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  if (isFullyQuoted || matchMode === "phrase") {
    const phraseText = (isFullyQuoted ? trimmed.slice(1, -1) : trimmed).trim();
    if (!phraseText) return { ok: false, error: "empty_query_terms" };
    return { ok: true, matchExpr: `"${phraseText.replaceAll('"', '""')}"`, mode: "phrase" };
  }
  const terms = tokenizeQuery(trimmed);
  if (!terms.length) return { ok: false, error: "empty_query_terms" };
  const quotedTerms = terms.map(term => `"${String(term).replaceAll('"', '""')}"`);
  if (matchMode === "all") return { ok: true, matchExpr: quotedTerms.join(" AND "), mode: "all" };
  return { ok: true, matchExpr: quotedTerms.join(" OR "), mode: "any" };
}

// V6.5: bm25 column weights, in refs_fts column declaration order (ref_id, stone_hash,
// chain, path, keywords, preview). The first three are required 0-weight placeholders for
// the UNINDEXED columns -- bm25's weight arguments map 1:1 to ALL table columns, not just
// indexed ones, and supplying too few silently defaults the remaining columns to weight 1.0
// (verified live against D1 before shipping). keywords (curated top-12 terms per ref)
// outweighs raw preview text; path gets a modest boost since filename/directory is often
// meaningful on its own.
const FTS_BM25_WEIGHTS = "0, 0, 0, 2.0, 4.0, 1.0";

async function findV2FromBody(body, env) {
  requireBindings(env);
  const query = requiredString(body.query, "query");
  const chain = typeof body.chain === "string" && body.chain ? body.chain : null;
  const topK = clamp(Number(body.top_k || 5), 1, 25);
  const doExpand = body.expand === true;
  const context = clamp(optionalNumber(body.context_lines, 20), 0, 200);
  const matchMode = ["any", "all", "phrase"].includes(body.match_mode) ? body.match_mode : "any";

  let stoneFilter = null;
  if (typeof body.stone_hash === "string" && body.stone_hash) {
    const resolved = await resolveStoneHash(env, body.stone_hash);
    if (!resolved.ok) return resolved;
    stoneFilter = resolved.hash;
  }

  const built = buildMatchExpr(query, matchMode);
  if (!built.ok) return built;
  const matchExpr = built.matchExpr;

  let results = [];
  let mode = "fts";
  try {
    let sql = `SELECT ref_id, stone_hash, chain, path, preview, bm25(refs_fts, ${FTS_BM25_WEIGHTS}) AS score FROM refs_fts WHERE refs_fts MATCH ?`;
    const binds = [matchExpr];
    if (chain) { sql += " AND chain = ?"; binds.push(chain); }
    if (stoneFilter) { sql += " AND stone_hash = ?"; binds.push(stoneFilter); }
    sql += ` ORDER BY bm25(refs_fts, ${FTS_BM25_WEIGHTS}) LIMIT ?`;
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

  const out = { ok: true, query, mode, match_mode: built.mode, total: matches.length, matches };

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
    const resolution = await resolveGitHubCommit(fetched.github.owner, fetched.github.repo, fetched.github.ref, env);
    if (!resolution.sha) {
      return {
        ok: false,
        error: "github_commit_resolution_failed",
        owner: fetched.github.owner,
        repo: fetched.github.repo,
        path: fetched.github.path,
        requested_ref: fetched.github.ref,
        detail: resolution.error || "unknown"
      };
    }
    content = fetched.content;
    stoneBody = {
      ...body,
      chain,
      author,
      title: body.title || `${fetched.github.owner}/${fetched.github.repo}/${fetched.github.path}@${resolution.sha}`,
      content,
      path: fetched.github.path,
      repo: `${fetched.github.owner}/${fetched.github.repo}`,
      commit: resolution.sha,
      metadata: {
        ...(isObject(body.metadata) ? body.metadata : {}),
        source_type: "github_file",
        github: {
          ...fetched.github,
          requested_ref: fetched.github.ref,
          commit_resolved: Boolean(resolution.sha),
          commit_resolution_error: resolution.sha ? undefined : resolution.error
        },
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
      "SELECT hash FROM stones WHERE chain_hash = ? AND path = ? AND raw_key = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(chain, stoneBody.path || "content.txt", rawKey).first();
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
