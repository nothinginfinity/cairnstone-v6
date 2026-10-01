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
export const OBJECT_INSPECT_APP_RESOURCE_URI = "ui://cairnstone/stone-inspector-v1.html";
export const OBJECT_INSPECT_APP_MIME_TYPE = "text/html;profile=mcp-app";

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
    if (url.protocol !== "https:") return DEFAULT_PUBLIC_BASE_URL;
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

function redactRestrictedEdgeNotes(edges, restrictedHashes) {
  const redact = edge => restrictedHashes.has(edge.from_hash) || restrictedHashes.has(edge.to_hash)
    ? { ...edge, note: null, restricted_target: true }
    : edge;
  return {
    outbound: edges.outbound.map(redact),
    inbound: edges.inbound.map(redact)
  };
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
  const restrictedRelated = related.filter(item => item.restricted === true);
  const restrictedRelatedCount = restrictedRelated.length;
  const restrictedHashes = new Set(restrictedRelated.map(item => item.hash));
  const visibleEdges = redactRestrictedEdgeNotes(edges, restrictedHashes);
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
    edges: visibleEdges,
    related,
    restricted_related_count: restrictedRelatedCount,
    graph: graphPayload(stone, related, visibleEdges),
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
  title: "Inspect CairnStone object",
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
  },
  _meta: {
    ui: {
      resourceUri: OBJECT_INSPECT_APP_RESOURCE_URI,
      visibility: ["model", "app"]
    },
    "openai/outputTemplate": OBJECT_INSPECT_APP_RESOURCE_URI
  }
});

const INSPECTOR_HTML_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortHash(value, length = 12) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function jsonInspectorUrl(result) {
  const raw = result?.object_link?.https_url;
  if (!isNonEmptyString(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    url.searchParams.set("format", "json");
    return url.toString();
  } catch {
    return null;
  }
}

function githubSourceUrl(stone = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(stone.repo || ""))) return null;
  if (!/^[0-9a-f]{40}$/i.test(String(stone.commit_sha || ""))) return null;
  if (!isNonEmptyString(stone.path)) return null;
  const [owner, repo] = stone.repo.split("/");
  const encodedPath = stone.path.split("/").map(segment => encodeURIComponent(segment)).join("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${stone.commit_sha}/${encodedPath}`;
}

function renderBadge(label, tone = "neutral") {
  return `<span class="badge badge-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function renderDefinitionRows(rows) {
  return rows.map(([label, value]) => `<div class="kv"><dt>${escapeHtml(label)}</dt><dd>${value == null || value === "" ? "—" : escapeHtml(value)}</dd></div>`).join("");
}

function renderGraphSvg(result) {
  const nodes = Array.isArray(result?.graph?.nodes) ? result.graph.nodes.slice(0, 13) : [];
  const edges = Array.isArray(result?.graph?.edges) ? result.graph.edges : [];
  if (!nodes.length) return `<div class="empty">No graph neighborhood is available for this object.</div>`;

  const width = 720;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.34;
  const focal = nodes.find(node => node.focal) || nodes[0];
  const related = nodes.filter(node => node.id !== focal.id);
  const positions = new Map([[focal.id, { x: cx, y: cy }]]);
  related.forEach((node, index) => {
    const angle = ((Math.PI * 2) * index / Math.max(related.length, 1)) - Math.PI / 2;
    positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  });

  const lineMarkup = edges.map(edge => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return "";
    return `<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}"><title>${escapeHtml(edge.type || "related")}</title></line>`;
  }).join("");

  const nodeMarkup = nodes.map(node => {
    const position = positions.get(node.id) || { x: cx, y: cy };
    const restricted = node.restricted === true;
    const nodeClass = node.focal ? "node focal" : (restricted ? "node restricted" : "node");
    const label = restricted ? "Restricted" : (node.label || shortHash(node.id));
    return `<g class="${nodeClass}"><circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${node.focal ? 34 : 26}"></circle><text x="${position.x.toFixed(1)}" y="${(position.y + 50).toFixed(1)}" text-anchor="middle">${escapeHtml(String(label).slice(0, 28))}</text><title>${escapeHtml(label)}</title></g>`;
  }).join("");

  return `<div class="graph-wrap"><svg class="graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bounded Stone relationship graph">${lineMarkup}${nodeMarkup}</svg></div>`;
}

function renderRelated(result) {
  const related = Array.isArray(result?.related) ? result.related : [];
  if (!related.length) return `<div class="empty">No related Stones were returned inside the bounded neighborhood.</div>`;
  return `<div class="card-grid">${related.map(item => {
    if (item.restricted) {
      return `<article class="related-card restricted-card"><div class="eyebrow">Restricted relation</div><strong>${escapeHtml(shortHash(item.hash))}</strong><p>Relationship is visible; private object metadata is not.</p></article>`;
    }
    const href = isNonEmptyString(item.object_ref) ? `/inspect?ref=${encodeURIComponent(item.object_ref)}` : null;
    const title = item.title || `Stone ${shortHash(item.hash)}`;
    return `<article class="related-card"><div class="eyebrow">${escapeHtml(item.chain || "Stone")}</div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(item.lod5 || "No compact summary available.")}</p>${href ? `<a class="text-link" href="${escapeHtml(href)}">Inspect related Stone →</a>` : ""}</article>`;
  }).join("")}</div>`;
}

function renderInspectorBody(result) {
  const objectRef = result?.object_ref || result?.input_ref || "Unknown object";
  if (!result?.ok) {
    return `<section class="hero"><div class="eyebrow">Inspector error</div><h1>Object unavailable</h1><p>${escapeHtml(result?.error || "Unable to inspect this object.")}</p><code>${escapeHtml(objectRef)}</code></section>`;
  }

  if (result.inspection_status === "restricted") {
    return `<section class="hero"><div class="eyebrow">Access-bound object</div><h1>Restricted Stone</h1><p>This Stone is backed by private correspondence. The universal inspector exposes identity only; use the authenticated correspondence surface to read message metadata or content.</p><code>${escapeHtml(objectRef)}</code><div class="policy-row">${renderBadge("read-only", "good")}${renderBadge("relationship ≠ visibility", "warn")}${renderBadge("zero authority", "good")}</div></section>`;
  }

  if (result.inspection_status === "link_only") {
    return `<section class="hero"><div class="eyebrow">Universal object deep link</div><h1>${escapeHtml(result.kind || "Object")}</h1><p>This typed reference is normalized and linkable, but V7.7.11i does not broadly hydrate this object kind through the public inspector.</p><code>${escapeHtml(objectRef)}</code><div class="policy-row">${renderBadge("link-only", "neutral")}${renderBadge("no private hydration", "warn")}${renderBadge("zero authority", "good")}</div></section>`;
  }

  const stone = result.stone || {};
  const accepted = result.accepted_state || {};
  const classifications = Array.isArray(accepted.classification) ? accepted.classification : [];
  const sourceHref = githubSourceUrl(stone);
  const edgeCount = Number(result?.bounds?.outbound_edges_returned || 0) + Number(result?.bounds?.inbound_edges_returned || 0);
  const relatedCount = Array.isArray(result.related) ? result.related.length : 0;
  const jsonUrl = jsonInspectorUrl(result);

  return `<header class="hero"><div class="eyebrow">Stone Inspector · V7.7.11i</div><h1>${escapeHtml(stone.title || `Stone ${shortHash(stone.hash)}`)}</h1><p class="summary">${escapeHtml(stone.lod5 || "No LOD5 summary available.")}</p><code>${escapeHtml(objectRef)}</code><div class="policy-row">${classifications.map(value => renderBadge(value, "good")).join("")}${renderBadge(`${edgeCount} edges`, "neutral")}${renderBadge(`${relatedCount} related`, "neutral")}${result.restricted_related_count ? renderBadge(`${result.restricted_related_count} restricted`, "warn") : ""}</div></header>
  <nav class="tabs" aria-label="Inspector sections"><a href="#summary">Summary</a><a href="#graph">Graph</a><a href="#source">Source</a><a href="#related">Related</a><a href="#messages">Messages</a></nav>
  <section id="summary" class="panel"><div class="section-head"><div><div class="eyebrow">Summary</div><h2>Identity & authority</h2></div>${jsonUrl ? `<a class="text-link" href="${escapeHtml(jsonUrl)}">JSON view →</a>` : ""}</div><dl class="definition-grid">${renderDefinitionRows([["Author", stone.author], ["Created", stone.created_at], ["Chain", stone.chain], ["Accepted state", classifications.join(" + ") || "Historical / unscoped"]])}</dl><div class="authority-note"><strong>Read-only projection.</strong> This view cannot move HEADs, mint capabilities, execute tools, or convert a relationship into visibility.</div></section>
  <section id="graph" class="panel"><div class="eyebrow">Graph</div><h2>Bounded relationship neighborhood</h2>${renderGraphSvg(result)}<p class="hint">Edges are exact stored Stone relationships. Restricted targets retain only ref-safe graph identity; notes are redacted.</p></section>
  <section id="source" class="panel"><div class="section-head"><div><div class="eyebrow">Source</div><h2>Immutable provenance</h2></div>${sourceHref ? `<a class="text-link" href="${escapeHtml(sourceHref)}">Open immutable source →</a>` : ""}</div><dl class="definition-grid">${renderDefinitionRows([["Repository", stone.repo], ["Path", stone.path], ["Commit", stone.commit_sha], ["Immutable Git commit", result?.provenance?.immutable_git_commit ? "yes" : "not established"]])}</dl></section>
  <section id="related" class="panel"><div class="eyebrow">Related</div><h2>Connected Stones</h2>${renderRelated(result)}</section>
  <section id="messages" class="panel"><div class="eyebrow">Messages</div><h2>Authenticated correspondence only</h2><p>Message-backed Stones and AC1 correspondence are never hydrated merely because they are connected in the graph. Authorized message inspection remains on the object-specific authenticated path.</p></section>`;
}

export function renderObjectInspectorHtml(result = {}) {
  const title = result?.stone?.title || result?.object_link?.label || "CairnStone Object Inspector";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>${escapeHtml(title)} · CairnStone</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark;background:#0b0d10;color:#f5f7fa}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 50% -20%,#27364d 0,#0b0d10 38rem);color:#f5f7fa}a{color:inherit}main{width:min(1080px,100%);margin:auto;padding:24px max(18px,env(safe-area-inset-right)) 72px max(18px,env(safe-area-inset-left))}.hero,.panel{background:rgba(20,24,30,.88);border:1px solid #2d3540;border-radius:22px;padding:22px;box-shadow:0 18px 60px rgba(0,0,0,.24)}.hero{margin-top:12px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.72rem;color:#9faabc;font-weight:700}h1{font-size:clamp(1.9rem,6vw,3.8rem);line-height:1.02;margin:.35rem 0 1rem}h2{font-size:1.35rem;margin:.3rem 0 1rem}.summary{font-size:1.05rem;line-height:1.65;color:#cbd3dd;max-width:70ch}code{display:block;max-width:100%;overflow:auto;padding:12px 14px;border-radius:12px;background:#090b0e;border:1px solid #252b33;color:#c8d6e8;font-size:.82rem}.policy-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.badge{display:inline-flex;align-items:center;border:1px solid #394351;border-radius:999px;padding:6px 10px;font-size:.74rem;font-weight:700}.badge-good{border-color:#315c4c;color:#9ce5c7}.badge-warn{border-color:#705a32;color:#f4cf82}.badge-neutral{color:#c5ced9}.tabs{position:sticky;top:0;z-index:2;display:flex;gap:8px;overflow:auto;margin:16px 0;padding:10px 4px;background:rgba(11,13,16,.92);backdrop-filter:blur(12px)}.tabs a{text-decoration:none;white-space:nowrap;border:1px solid #303844;background:#151a20;border-radius:999px;padding:9px 13px;font-size:.82rem}.panel{margin-top:14px;scroll-margin-top:74px}.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.text-link{font-size:.84rem;color:#a9c9ff;text-decoration:none}.definition-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:#2c333d;border:1px solid #2c333d;border-radius:16px;overflow:hidden}.kv{background:#11151a;padding:14px;min-width:0}.kv dt{font-size:.72rem;color:#8995a5;text-transform:uppercase;letter-spacing:.08em}.kv dd{margin:6px 0 0;overflow-wrap:anywhere}.authority-note,.empty{margin-top:16px;padding:15px;border-radius:14px;background:#101820;border:1px solid #263746;color:#cbd6e3;line-height:1.55}.graph-wrap{overflow:auto;border-radius:16px;background:#0c1015;border:1px solid #26303a}.graph{display:block;width:100%;min-width:620px;max-height:480px}.graph line{stroke:#596675;stroke-width:2}.graph circle{fill:#18212b;stroke:#8ab4f8;stroke-width:2}.graph .focal circle{fill:#1c324b;stroke:#b8d2ff;stroke-width:3}.graph .restricted circle{fill:#2b2418;stroke:#dfbd75;stroke-dasharray:5 4}.graph text{fill:#cbd5e1;font-size:12px}.hint{color:#8995a5;font-size:.82rem;line-height:1.5}.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.related-card{border:1px solid #303844;border-radius:16px;background:#101419;padding:16px}.related-card strong{display:block;margin:.4rem 0}.related-card p{color:#aeb8c5;line-height:1.5}.restricted-card{border-style:dashed;border-color:#6d5b39}@media(max-width:640px){main{padding-top:12px}.hero,.panel{padding:17px;border-radius:18px}.definition-grid,.card-grid{grid-template-columns:1fr}.section-head{display:block}.section-head .text-link{display:inline-block;margin-bottom:8px}.graph{min-width:540px}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}</style></head><body><main>${renderInspectorBody(result)}</main></body></html>`;
}

export function objectInspectorHtmlResponse(result = {}) {
  const status = result?.ok ? 200 : (result?.error === "stone_not_found" ? 404 : 400);
  return new Response(renderObjectInspectorHtml(result), { status, headers: INSPECTOR_HTML_HEADERS });
}

export function renderObjectInspectorAppHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>CairnStone Stone Inspector</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--bg:var(--color-background-primary,#101318);--card:var(--color-background-secondary,#171c22);--line:var(--color-border-default,#303844);--text:var(--color-text-primary,#f3f6fa);--muted:var(--color-text-secondary,#9da9b8);--accent:var(--color-text-link,#9dc2ff)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}main{padding:14px;max-width:980px;margin:auto}.hero,.panel{border:1px solid var(--line);background:var(--card);border-radius:18px;padding:16px}.hero h1{font-size:clamp(1.45rem,5vw,2.5rem);margin:.35rem 0}.eyebrow{font-size:.7rem;text-transform:uppercase;letter-spacing:.11em;color:var(--muted);font-weight:700}.summary,.muted{color:var(--muted);line-height:1.55}.ref{display:block;overflow:auto;padding:10px;border-radius:10px;border:1px solid var(--line);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.badges,.tabs{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.badge,.tabs button{border:1px solid var(--line);border-radius:999px;padding:6px 9px;background:transparent;color:var(--text);font-size:.75rem}.tabs{position:sticky;top:0;padding:9px 0;background:var(--bg);z-index:1}.tabs button[aria-selected="true"]{border-color:var(--accent);color:var(--accent)}.panel{margin-top:10px}.panel[hidden]{display:none}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kv,.node,.related{border:1px solid var(--line);border-radius:12px;padding:11px;min-width:0}.kv small{display:block;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}.kv div,.related strong{overflow-wrap:anywhere}.graph{display:flex;flex-wrap:wrap;gap:8px}.node.focal{border-color:var(--accent)}.node.restricted{border-style:dashed}.related-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.empty{color:var(--muted);padding:12px 0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.actions a{color:var(--accent);font-size:.82rem;text-decoration:none}.status{padding:26px;text-align:center;color:var(--muted)}@media(max-width:620px){main{padding:10px}.hero,.panel{border-radius:15px}.grid,.related-list{grid-template-columns:1fr}}</style></head><body><main id="app"><div id="loading" class="status">Loading CairnStone inspector…</div><div id="view" hidden><header class="hero"><div id="eyebrow" class="eyebrow"></div><h1 id="title"></h1><p id="summary" class="summary"></p><code id="object-ref" class="ref"></code><div id="badges" class="badges"></div><div class="actions"><a id="https-link" target="_blank" rel="noopener noreferrer" hidden>Open HTTPS inspector ↗</a></div></header><nav class="tabs" aria-label="Inspector sections"></nav><section id="summary-panel" class="panel"></section><section id="graph-panel" class="panel" hidden></section><section id="source-panel" class="panel" hidden></section><section id="related-panel" class="panel" hidden></section><section id="messages-panel" class="panel" hidden></section></div></main><script>
(() => {
  const pending = new Map(); let requestId = 1; let latest = null;
  const $ = id => document.getElementById(id);
  const text = (el, value) => { el.textContent = value == null || value === "" ? "—" : String(value); };
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); };
  const safeHttps = value => { try { const url = new URL(String(value || "")); return url.protocol === "https:" ? url.toString() : null; } catch { return null; } };
  function badge(value){ const el=document.createElement("span"); el.className="badge"; text(el,value); return el; }
  function heading(panel, eyebrow, title){ const e=document.createElement("div"); e.className="eyebrow"; text(e,eyebrow); const h=document.createElement("h2"); text(h,title); panel.append(e,h); }
  function kv(label,value){ const box=document.createElement("div"); box.className="kv"; const small=document.createElement("small"); text(small,label); const val=document.createElement("div"); text(val,value); box.append(small,val); return box; }
  function render(result){ latest=result || {}; $("loading").hidden=true; $("view").hidden=false; const hydrated=latest.inspection_status==="hydrated"; const restricted=latest.inspection_status==="restricted"; const stone=latest.stone || {}; text($("eyebrow"), restricted ? "Access-bound object" : hydrated ? "Stone Inspector · V7.7.11i" : "Universal object deep link"); text($("title"), restricted ? "Restricted Stone" : (stone.title || latest.kind || "CairnStone object")); text($("summary"), restricted ? "Private correspondence metadata remains behind its authenticated object-specific surface." : (stone.lod5 || (hydrated ? "No compact summary available." : "This object is linkable but is not broadly hydrated by the universal inspector."))); text($("object-ref"), latest.object_ref || latest.input_ref || "Unknown object"); clear($("badges")); const classes=Array.isArray(latest.accepted_state?.classification)?latest.accepted_state.classification:[]; classes.forEach(v=>$("badges").append(badge(v))); $("badges").append(badge("read-only"),badge("zero authority")); if(latest.restricted_related_count) $("badges").append(badge(latest.restricted_related_count+" restricted")); const href=safeHttps(latest.object_link?.https_url); const link=$("https-link"); if(href){link.href=href;link.hidden=false}else{link.hidden=true;link.removeAttribute("href")}
    const panels={Summary:$("summary-panel"),Graph:$("graph-panel"),Source:$("source-panel"),Related:$("related-panel"),Messages:$("messages-panel")}; const nav=document.querySelector(".tabs"); clear(nav); Object.entries(panels).forEach(([name,panel],i)=>{ const b=document.createElement("button"); b.type="button"; b.textContent=name; b.setAttribute("aria-selected",i===0?"true":"false"); b.onclick=()=>{Object.entries(panels).forEach(([n,p])=>{p.hidden=n!==name}); [...nav.children].forEach(x=>x.setAttribute("aria-selected",x===b?"true":"false"));}; nav.append(b); clear(panel); });
    const summaryPanel=panels.Summary; heading(summaryPanel,"Summary","Identity & authority"); const grid=document.createElement("div"); grid.className="grid"; grid.append(kv("Author",stone.author),kv("Created",stone.created_at),kv("Chain",stone.chain),kv("Accepted state",classes.join(" + ") || (hydrated?"Historical / unscoped":"Access-bound"))); summaryPanel.append(grid); const policy=document.createElement("p"); policy.className="muted"; text(policy,"This native surface is a projection only. Rendering never moves HEADs, executes tools, mints capabilities, or turns graph relationships into visibility."); summaryPanel.append(policy);
    const graphPanel=panels.Graph; heading(graphPanel,"Graph","Bounded relationship neighborhood"); const graph=document.createElement("div"); graph.className="graph"; const nodes=Array.isArray(latest.graph?.nodes)?latest.graph.nodes:[]; nodes.forEach(node=>{const n=document.createElement("div"); n.className="node"+(node.focal?" focal":"")+(node.restricted?" restricted":""); text(n,node.restricted?"Restricted":(node.label || String(node.id||"").slice(0,12))); graph.append(n);}); graphPanel.append(nodes.length?graph:Object.assign(document.createElement("div"),{className:"empty",textContent:"No graph neighborhood is available for this object."})); const edgeNote=document.createElement("p"); edgeNote.className="muted"; text(edgeNote,(Array.isArray(latest.graph?.edges)?latest.graph.edges.length:0)+" exact stored edge(s). Restricted relation notes stay redacted."); graphPanel.append(edgeNote);
    const sourcePanel=panels.Source; heading(sourcePanel,"Source","Immutable provenance"); const sourceGrid=document.createElement("div"); sourceGrid.className="grid"; sourceGrid.append(kv("Repository",stone.repo),kv("Path",stone.path),kv("Commit",stone.commit_sha),kv("Immutable Git commit",latest.provenance?.immutable_git_commit?"yes":"not established")); sourcePanel.append(sourceGrid);
    const relatedPanel=panels.Related; heading(relatedPanel,"Related","Connected Stones"); const list=document.createElement("div"); list.className="related-list"; const related=Array.isArray(latest.related)?latest.related:[]; related.forEach(item=>{const card=document.createElement("div"); card.className="related"; const strong=document.createElement("strong"); text(strong,item.restricted?"Restricted relation":(item.title || String(item.hash||"").slice(0,12))); const p=document.createElement("p"); p.className="muted"; text(p,item.restricted?"Relationship visible; private metadata hidden.":(item.lod5 || item.object_ref || "Related Stone")); card.append(strong,p); list.append(card);}); relatedPanel.append(related.length?list:Object.assign(document.createElement("div"),{className:"empty",textContent:"No related Stones were returned inside the bounded neighborhood."}));
    const messagesPanel=panels.Messages; heading(messagesPanel,"Messages","Authenticated correspondence only"); const mp=document.createElement("p"); mp.className="muted"; text(mp,"Message-backed Stones and AC1 correspondence are never hydrated merely because they are connected in the graph. Authorized message inspection remains on the object-specific authenticated path."); messagesPanel.append(mp);
  }
  function send(message){ window.parent.postMessage(message,"*"); }
  function request(method,params){ const id=requestId++; send({jsonrpc:"2.0",id,method,params}); return new Promise((resolve,reject)=>pending.set(id,{resolve,reject})); }
  window.addEventListener("message",event=>{ if(event.source!==window.parent) return; const message=event.data; if(!message || message.jsonrpc!=="2.0") return; if(message.id!==undefined && pending.has(message.id)){ const p=pending.get(message.id); pending.delete(message.id); message.error?p.reject(message.error):p.resolve(message.result); return; } if(message.method==="ui/notifications/tool-result" && message.params?.structuredContent) render(message.params.structuredContent); },{passive:true});
  const compatibility=typeof window.openai==="object" ? window.openai.toolOutput : null; if(compatibility) render(compatibility);
  request("ui/initialize",{protocolVersion:"2025-11-21",appInfo:{name:"cairnstone-stone-inspector",title:"CairnStone Stone Inspector",version:"1.0.0"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]}}).then(()=>send({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}})).catch(()=>{ if(!latest) text($("loading"),"Inspector host bridge unavailable. Use the HTTPS inspector fallback."); });
})();
</script></body></html>`;
}

export function objectInspectorAppResource() {
  return {
    uri: OBJECT_INSPECT_APP_RESOURCE_URI,
    name: "CairnStone Stone Inspector",
    description: "Read-only native MCP Apps projection for V7.7.11i typed object inspection.",
    mimeType: OBJECT_INSPECT_APP_MIME_TYPE
  };
}

export function objectInspectorAppResourceRead() {
  return {
    contents: [{
      uri: OBJECT_INSPECT_APP_RESOURCE_URI,
      mimeType: OBJECT_INSPECT_APP_MIME_TYPE,
      text: renderObjectInspectorAppHtml(),
      _meta: {
        ui: { prefersBorder: true },
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] }
      }
    }]
  };
}

export const OBJECT_INSPECT_MCP_TOOL_DEFINITIONS = Object.freeze([
  OBJECT_INSPECT_TOOL_DEFINITION
]);
