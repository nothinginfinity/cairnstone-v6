// V7.7.11i — Stone Inspector + Universal Object Deep Links
//
// First slice: universal object-link envelopes for the existing V7.7.10b
// typed object_ref grammar, plus full read-only inspection for safe Stone
// objects. Non-Stone refs are intentionally link-only in this slice. Stones
// backed by private AC1 correspondence fail closed to a restricted envelope;
// relationship edges never grant visibility into a related object.

import { parseObjectRef } from "./attachment-refs.js";

export const OBJECT_LINK_SCHEMA = "cairnstone-object-link-v1";
export const OBJECT_INSPECTOR_SCHEMA = "cairnstone-object-inspector-v1";
export const OBJECT_INSPECT_TOOL_ID = "cairnstone_object_inspect";

const DEFAULT_PUBLIC_BASE_URL = "https://cairnstone-v6.jaredtechfit.workers.dev";
const DEFAULT_EDGE_LIMIT = 12;
const MAX_EDGE_LIMIT = 25;
const DEFAULT_RELATED_LIMIT = 12;
const MAX_RELATED_LIMIT = 25;

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function authorityPolicy() {
  return {
    read_only: true,
    accepted_state_authority: false,
    execution_authority: false,
    mutation_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    relationship_grants_visibility: false,
    host_rendering_is_authority: false
  };
}

function publicBaseUrl(env = {}) {
  const raw = isNonEmptyString(env.CAIRNSTONE_PUBLIC_BASE_URL)
    ? env.CAIRNSTONE_PUBLIC_BASE_URL.trim()
    : DEFAULT_PUBLIC_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_PUBLIC_BASE_URL;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return DEFAULT_PUBLIC_BASE_URL;
  }
}

function displayLabel(parsed) {
  if (parsed.kind === "stone" || parsed.kind === "ac1") return `Stone ${parsed.stone_hash.slice(0, 12)}`;
  if (parsed.kind === "repo") return `${parsed.owner}/${parsed.repo}@${parsed.commit_sha.slice(0, 12)}`;
  return parsed.canonical_ref || parsed.object_ref;
}

export function buildObjectLink(parsed, env = {}, display = {}) {
  const base = publicBaseUrl(env);
  const objectRef = parsed.canonical_ref || parsed.object_ref;
  const title = isNonEmptyString(display.title) ? display.title.trim() : null;
  const label = isNonEmptyString(display.label) ? display.label.trim() : (title || displayLabel(parsed));
  return {
    schema: OBJECT_LINK_SCHEMA,
    object_ref: objectRef,
    kind: parsed.kind,
    https_url: `${base}/inspect?ref=${encodeURIComponent(objectRef)}`,
    label,
    title,
    rendering_hint: parsed.kind === "stone" || parsed.kind === "ac1" ? "stone_inspector" : "object_link",
    fallback: {
      kind: "ordinary_https",
      url: base
    },
    presentation_order: ["native_host_inspector", "mcp_app_surface", "https_inspector", "ordinary_https"],
    secret_bearer_in_url: false,
    authority: {
      host_rendering_is_authority: false,
      accepted_state_authority: false
    }
  };
}

function parseStoneJson(row) {
  if (!isNonEmptyString(row?.stone_json)) return {};
  try {
    const parsed = JSON.parse(row.stone_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function compactStoneRow(row) {
  const stone = parseStoneJson(row);
  return {
    object_ref: `stone:${row.hash}`,
    hash: row.hash,
    title: row.title || stone.title || null,
    author: row.author || stone.author || null,
    created_at: row.created_at || stone.created_at || null,
    lod5: stone.layers?.lod5 || null,
    chain: row.chain_hash || stone.chain || null,
    repo: row.repo || stone.repo || null,
    path: row.path || stone.path || null,
    commit_sha: row.commit_sha || stone.commit || null
  };
}

async function correspondenceRestriction(db, hash) {
  try {
    const row = await db.prepare(
      "SELECT stone_hash FROM correspondence_deliveries WHERE stone_hash = ? LIMIT 1"
    ).bind(hash).first();
    return row
      ? { restricted: true, reason: "correspondence_object_requires_authenticated_path" }
      : { restricted: false, reason: null };
  } catch {
    // Visibility classification itself is security-sensitive. If it cannot be
    // established, do not fall back to broad Stone hydration.
    return { restricted: true, reason: "correspondence_access_check_failed" };
  }
}

async function acceptedStateForStone(db, row) {
  const chain = row.chain_hash || null;
  const path = row.path || null;
  let chainHead = false;
  let pathHead = false;

  if (chain) {
    const current = await db.prepare(
      "SELECT head_hash FROM chain_heads WHERE chain = ?"
    ).bind(chain).first();
    chainHead = current?.head_hash === row.hash;
  }

  if (chain && path) {
    const current = await db.prepare(
      "SELECT head_hash FROM path_heads WHERE chain = ? AND path = ?"
    ).bind(chain, path).first();
    pathHead = current?.head_hash === row.hash;
  }

  const classification = [];
  if (chainHead) classification.push("CHAIN_HEAD");
  if (pathHead) classification.push("PATH_HEAD");
  if (!classification.length) classification.push(chain ? "HISTORICAL" : "DERIVED_OR_UNSCOPED");

  return {
    classification,
    chain_head: chainHead,
    path_head: pathHead,
    accepted: chainHead || pathHead,
    source: "chain_heads/path_heads",
    timestamp_ordering_used: false
  };
}

function normalizeEdge(row, direction) {
  return {
    from_hash: row.from_hash,
    to_hash: row.to_hash,
    edge_type: row.edge_type,
    note: row.note || null,
    direction
  };
}

async function edgeNeighborhood(db, hash, limit) {
  const [outboundRows, inboundRows] = await Promise.all([
    db.prepare(
      "SELECT from_hash, to_hash, edge_type, note FROM stone_edges WHERE from_hash = ? ORDER BY edge_type, from_hash, to_hash LIMIT ?"
    ).bind(hash, limit).all(),
    db.prepare(
      "SELECT from_hash, to_hash, edge_type, note FROM stone_edges WHERE to_hash = ? ORDER BY edge_type, from_hash, to_hash LIMIT ?"
    ).bind(hash, limit).all()
  ]);
  return {
    outbound: (outboundRows.results || []).map(row => normalizeEdge(row, "outbound")),
    inbound: (inboundRows.results || []).map(row => normalizeEdge(row, "inbound"))
  };
}

function relatedHashes(hash, edges, limit) {
  const ordered = [];
  const seen = new Set([hash]);
  for (const edge of [...edges.outbound, ...edges.inbound]) {
    const candidate = edge.from_hash === hash ? edge.to_hash : edge.from_hash;
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

async function relatedCard(db, hash) {
  const visibility = await correspondenceRestriction(db, hash);
  if (visibility.restricted) {
    return {
      object_ref: `stone:${hash}`,
      hash,
      restricted: true,
      restriction_reason: visibility.reason
    };
  }
  const row = await db.prepare(
    "SELECT hash, title, author, created_at, repo, commit_sha, chain_hash, path, stone_json FROM stones WHERE hash = ?"
  ).bind(hash).first();
  if (!row) {
    return { object_ref: `stone:${hash}`, hash, found: false, restricted: false };
  }
  return { ...compactStoneRow(row), found: true, restricted: false };
}

function graphPayload(focal, related, edges) {
  const nodes = [
    {
      id: focal.hash,
      object_ref: focal.object_ref,
      kind: "stone",
      focal: true,
      restricted: false,
      title: focal.title,
      label: focal.title || `Stone ${focal.hash.slice(0, 12)}`
    },
    ...related.map(item => ({
      id: item.hash,
      object_ref: item.object_ref,
      kind: "stone",
      focal: false,
      restricted: item.restricted === true,
      title: item.restricted ? null : (item.title || null),
      label: item.restricted ? "Restricted related object" : (item.title || `Stone ${item.hash.slice(0, 12)}`)
    }))
  ];
  const graphEdges = [...edges.outbound, ...edges.inbound].map(edge => ({
    from: edge.from_hash,
    to: edge.to_hash,
    type: edge.edge_type,
    note: edge.note
  }));
  return { nodes, edges: graphEdges };
}

function bindingError(env) {
  return !env?.CAIRNSTONE_DB
    ? { ok: false, error: "missing_d1_binding", detail: "CAIRNSTONE_DB required", policy: authorityPolicy() }
    : null;
}

export async function objectInspectFromBody(body = {}, env = {}) {
  const missingBinding = bindingError(env);
  if (missingBinding) return missingBinding;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_object_inspect_request", policy: authorityPolicy() };
  }
  const raw = body.object_ref;
  const parsed = parseObjectRef(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      schema: OBJECT_INSPECTOR_SCHEMA,
      error: parsed.error,
      detail: parsed.detail || null,
      input_ref: isNonEmptyString(raw) ? raw.trim().slice(0, 256) : null,
      object_link: null,
      policy: authorityPolicy()
    };
  }

  const edgeLimit = clampInteger(body.edge_limit, 1, MAX_EDGE_LIMIT, DEFAULT_EDGE_LIMIT);
  const relatedLimit = clampInteger(body.related_limit, 1, MAX_RELATED_LIMIT, DEFAULT_RELATED_LIMIT);

  // V7.7.11i.0: every supported typed ref receives a canonical deep-link
  // envelope. Only safe Stone objects are hydrated in i.1.
  if (parsed.kind !== "stone") {
    return {
      ok: true,
      schema: OBJECT_INSPECTOR_SCHEMA,
      object_ref: parsed.canonical_ref || parsed.object_ref,
      kind: parsed.kind,
      inspection_status: "link_only",
      object_link: buildObjectLink(parsed, env),
      hydration: {
        attempted: false,
        reason: "object_kind_not_hydrated_in_v7_7_11i_1"
      },
      policy: authorityPolicy()
    };
  }

  const hash = parsed.stone_hash;
  const visibility = await correspondenceRestriction(env.CAIRNSTONE_DB, hash);
  if (visibility.restricted) {
    return {
      ok: true,
      schema: OBJECT_INSPECTOR_SCHEMA,
      object_ref: parsed.canonical_ref,
      kind: "stone",
      inspection_status: "restricted",
      restricted: true,
      restriction_reason: visibility.reason,
      object_link: buildObjectLink(parsed, env),
      stone: null,
      accepted_state: null,
      edges: null,
      related: [],
      graph: null,
      policy: authorityPolicy()
    };
  }

  const row = await env.CAIRNSTONE_DB.prepare(
    "SELECT hash, title, author, created_at, repo, commit_sha, chain_hash, path, stone_json FROM stones WHERE hash = ?"
  ).bind(hash).first();
  if (!row) {
    return {
      ok: false,
      schema: OBJECT_INSPECTOR_SCHEMA,
      error: "stone_not_found",
      object_ref: parsed.canonical_ref,
      kind: "stone",
      object_link: buildObjectLink(parsed, env),
      policy: authorityPolicy()
    };
  }

  const stone = compactStoneRow(row);
  const [acceptedState, edges] = await Promise.all([
    acceptedStateForStone(env.CAIRNSTONE_DB, row),
    edgeNeighborhood(env.CAIRNSTONE_DB, hash, edgeLimit)
  ]);
  const relationHashes = relatedHashes(hash, edges, relatedLimit);
  const related = [];
  for (const relatedHash of relationHashes) {
    related.push(await relatedCard(env.CAIRNSTONE_DB, relatedHash));
  }
  const restrictedRelatedCount = related.filter(item => item.restricted === true).length;
  const objectLink = buildObjectLink(parsed, env, { title: stone.title });

  return {
    ok: true,
    schema: OBJECT_INSPECTOR_SCHEMA,
    object_ref: parsed.canonical_ref,
    kind: "stone",
    inspection_status: "hydrated",
    restricted: false,
    object_link: objectLink,
    stone,
    provenance: {
      chain: stone.chain,
      repo: stone.repo,
      path: stone.path,
      commit_sha: stone.commit_sha,
      immutable_git_commit: Boolean(stone.commit_sha && /^[0-9a-f]{40}$/i.test(stone.commit_sha))
    },
    accepted_state: acceptedState,
    edges,
    related,
    restricted_related_count: restrictedRelatedCount,
    graph: graphPayload(stone, related, edges),
    bounds: {
      edge_limit: edgeLimit,
      related_limit: relatedLimit,
      outbound_edges_returned: edges.outbound.length,
      inbound_edges_returned: edges.inbound.length,
      related_returned: related.length
    },
    policy: authorityPolicy()
  };
}

export const OBJECT_INSPECT_TOOL_DEFINITION = Object.freeze({
  name: OBJECT_INSPECT_TOOL_ID,
  description: "V7.7.11i: read-only universal object inspector. Returns cairnstone-object-link-v1 for the existing typed object_ref grammar and fully hydrates only safe Stone objects with accepted-state classification, provenance, exact stored edges, bounded related cards, and graph payload. Correspondence-backed Stones fail closed to a restricted envelope; relationships never grant visibility; never moves HEADs or grants capability.",
  inputSchema: {
    type: "object",
    required: ["object_ref"],
    properties: {
      object_ref: { type: "string", description: "Existing V7.7.10b typed object_ref, e.g. stone:<64hex>, msg:…, repo:owner/repo@40hex, session:cs:…" },
      edge_limit: { type: "integer", minimum: 1, maximum: MAX_EDGE_LIMIT },
      related_limit: { type: "integer", minimum: 1, maximum: MAX_RELATED_LIMIT }
    },
    additionalProperties: false
  }
});

export const OBJECT_INSPECT_MCP_TOOL_DEFINITIONS = Object.freeze([
  OBJECT_INSPECT_TOOL_DEFINITION
]);
