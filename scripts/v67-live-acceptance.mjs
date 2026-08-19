import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const V5 = process.env.V5_BASE || "https://cairnstone-v5.jaredtechfit.workers.dev";
const V6 = process.env.V6_BASE || "https://cairnstone-v6.jaredtechfit.workers.dev";
const SOURCE_CHAIN = process.env.V5_IMPORT_CHAIN || "afo-devflow";
const PROTECTED_V6_CHAIN = "cairnstone-v6";
const EXPECTED_V5_TOOLS = 19;
const EXPECTED_V6_TOOLS = 27;
const FORMAT = "cairnstone-v5-transfer-v1";

const evidence = {
  acceptance: "V6.7 V5 vault import compatibility",
  source_chain: SOURCE_CHAIN,
  protected_v6_chain: PROTECTED_V6_CHAIN,
  started_at: new Date().toISOString(),
  checks: []
};

function record(name, detail = {}) {
  evidence.checks.push({ name, ok: true, ...detail });
  console.log(`PASS ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

function stableComparable(value) {
  if (Array.isArray(value)) return value.map(stableComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableComparable(value[key])]));
  }
  return value;
}

async function requestJson(url, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`${options.method || "GET"} ${url} returned non-JSON ${response.status}: ${text.slice(0, 500)}`); }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} failed ${response.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  return { response, data };
}

async function getJson(base, path) {
  return (await requestJson(`${base}${path}`)).data;
}

async function postJson(base, path, body) {
  return (await requestJson(`${base}${path}`, { method: "POST", body })).data;
}

function manifestShape(manifest) {
  return {
    chain: manifest.chain,
    head_hash: manifest.head_hash ?? null,
    head_updated_at: manifest.head_updated_at ?? null,
    stone_count: Number(manifest.stone_count ?? (manifest.nodes || []).length),
    edge_count: Number(manifest.edge_count ?? (manifest.edges || []).length),
    graph_complete: manifest.graph_complete === true,
    node_hashes: (manifest.nodes || []).map(n => n.hash).sort(),
    edge_ids: (manifest.edges || []).map(e => e.id).sort()
  };
}

function parseMcpPayload(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split(/\r?\n/).find(line => line.startsWith("data: "));
  if (!dataLine) throw new Error(`Unrecognized MCP response: ${trimmed.slice(0, 500)}`);
  return JSON.parse(dataLine.slice(6));
}

async function mcpPost(payload, sessionId = null) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${V6}/mcp`, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${payload.method} failed ${response.status}: ${text.slice(0, 1000)}`);
  return { payload: parseMcpPayload(text), sessionId: response.headers.get("mcp-session-id") || sessionId };
}

async function fetchSourceStoneWithRaw(hash) {
  const stoneResponse = await getJson(V5, `/v1/stones/${encodeURIComponent(hash)}`);
  assert.equal(stoneResponse.ok, true, `V5 stone ${hash} must exist`);
  const stone = stoneResponse.stone;
  assert.equal(stone?.border?.hash, hash);
  assert.equal(stone?.border?.chain, SOURCE_CHAIN);
  const refs = [...(stone?.layers?.lod2?.compressed_index || [])].sort((a, b) => a.line_start - b.line_start);
  assert.ok(refs.length > 0, `V5 stone ${hash} must have refs`);
  const chunks = [];
  const expanded = [];
  for (const ref of refs) {
    const result = await postJson(V5, "/v1/expand", { ref_id: ref.ref_id, context_lines: 0 });
    assert.equal(result.ok, true, `V5 ref ${ref.ref_id} must expand`);
    assert.equal(result.ref_id, ref.ref_id);
    assert.equal(result.stone_hash, hash);
    assert.equal(result.line_start, ref.line_start);
    assert.equal(result.line_end, ref.line_end);
    chunks.push(result.text);
    expanded.push({ ref_id: ref.ref_id, text: result.text });
  }
  const rawContent = chunks.join("\n");
  const rawKey = stone?.layers?.lod1?.raw_key;
  assert.match(rawKey || "", /^raw\/[0-9a-f]{64}\.txt$/i);
  const expectedRawHash = rawKey.slice(4, -4).toLowerCase();
  assert.equal(sha256(rawContent), expectedRawHash, `raw hash mismatch for ${hash}`);
  assert.equal(utf8Bytes(rawContent), Number(stone.layers.lod1.raw_bytes), `raw byte mismatch for ${hash}`);
  return { stone, raw_content: rawContent, expanded };
}

async function main() {
  const [v5HealthBefore, v6Health, v5ManifestBefore, v5Summary, protectedBefore] = await Promise.all([
    getJson(V5, "/health"),
    getJson(V6, "/health"),
    getJson(V5, `/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest`),
    getJson(V5, `/v2/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest?detail=summary`),
    getJson(V6, `/chains/${encodeURIComponent(PROTECTED_V6_CHAIN)}/manifest`)
  ]);

  assert.equal(v5HealthBefore.ok, true);
  assert.equal(v5HealthBefore.mcp_tools.length, EXPECTED_V5_TOOLS);
  assert.equal(new Set(v5HealthBefore.mcp_tools).size, EXPECTED_V5_TOOLS);
  record("V5 healthy before import", { version: v5HealthBefore.version, tools: v5HealthBefore.mcp_tools.length });

  assert.equal(v6Health.ok, true);
  assert.equal(v6Health.version, "0.4.4");
  assert.equal(v6Health.mcp_tools.length, EXPECTED_V6_TOOLS);
  assert.equal(new Set(v6Health.mcp_tools).size, EXPECTED_V6_TOOLS);
  assert.ok(v6Health.mcp_tools.includes("cairnstone_import_v5_bundle"));
  record("V6.7 live health catalog", { version: v6Health.version, tools: v6Health.mcp_tools.length });

  assert.equal(v5ManifestBefore.ok, true);
  assert.equal(v5ManifestBefore.graph_complete, true);
  assert.ok(v5ManifestBefore.head_hash);
  assert.ok(v5ManifestBefore.stone_count > 1);
  assert.ok(v5ManifestBefore.edge_count > 0);
  assert.equal(v5Summary.ok, true);
  assert.ok(Array.isArray(v5Summary.path_heads));
  assert.equal(v5Summary.path_heads.length, 0, "live fixture must have an explicitly observed empty V5 path_heads set");
  record("V5 fixture is graph-complete with explicit empty path_heads", {
    stones: v5ManifestBefore.stone_count,
    edges: v5ManifestBefore.edge_count,
    head: v5ManifestBefore.head_hash,
    path_heads: v5Summary.path_heads.length
  });

  const existingDestination = await getJson(V6, `/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest`);
  const existingCount = Number(existingDestination.stone_count ?? (existingDestination.nodes || []).length);
  assert.equal(existingCount, 0, `V6 destination chain ${SOURCE_CHAIN} must be absent before fresh acceptance`);
  assert.equal(existingDestination.head_hash ?? null, null);
  record("destination chain absent before import");

  const importedStones = [];
  const sourceExpansions = new Map();
  for (const node of v5ManifestBefore.nodes) {
    const item = await fetchSourceStoneWithRaw(node.hash);
    importedStones.push({ stone: item.stone, raw_content: item.raw_content });
    sourceExpansions.set(node.hash, item.expanded);
  }
  assert.equal(importedStones.length, v5ManifestBefore.stone_count);
  record("V5 raw/ref identity reconstructed exactly", {
    stones: importedStones.length,
    refs: importedStones.reduce((sum, item) => sum + item.stone.layers.lod2.compressed_index.length, 0)
  });

  const bundle = {
    format: FORMAT,
    source: {
      vault: "cairnstone-v5",
      version: v5HealthBefore.version,
      base_url: V5,
      captured_at: new Date().toISOString()
    },
    chain: SOURCE_CHAIN,
    source_manifest: {
      chain: SOURCE_CHAIN,
      head_hash: v5ManifestBefore.head_hash,
      head_updated_at: v5ManifestBefore.head_updated_at,
      stone_count: v5ManifestBefore.stone_count,
      edge_count: v5ManifestBefore.edge_count,
      graph_complete: v5ManifestBefore.graph_complete,
      path_head_count: v5Summary.path_heads.length
    },
    head_hash: v5ManifestBefore.head_hash,
    head_updated_at: v5ManifestBefore.head_updated_at,
    path_heads: [],
    stones: importedStones,
    edges: v5ManifestBefore.edges
  };

  const preview = await postJson(V6, "/v1/import-v5-bundle", { bundle, dry_run: true });
  assert.equal(preview.ok, true, `dry-run failed: ${JSON.stringify(preview)}`);
  assert.notEqual(preview.applied, true);
  record("dry-run preview accepted", { result: preview.result || preview.mode || "preview" });

  const applied = await postJson(V6, "/v1/import-v5-bundle", { bundle, dry_run: false, confirm_import: true });
  assert.equal(applied.ok, true, `apply failed: ${JSON.stringify(applied)}`);
  assert.notEqual(applied.dry_run, true);
  record("explicit import applied", { head: bundle.head_hash });

  const [v6ImportedManifest, v6ImportedSummary] = await Promise.all([
    getJson(V6, `/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest`),
    getJson(V6, `/v2/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest?detail=summary`)
  ]);
  assert.equal(v6ImportedManifest.ok, true);
  assert.deepEqual(manifestShape(v6ImportedManifest), manifestShape(v5ManifestBefore));
  assert.equal(v6ImportedSummary.ok, true);
  assert.equal(v6ImportedSummary.stones, v5ManifestBefore.stone_count);
  assert.equal(v6ImportedSummary.head, v5ManifestBefore.head_hash.slice(0, 12));
  assert.deepEqual(v6ImportedSummary.path_heads, []);
  record("graph, HEAD, and path_heads preserved", {
    stones: v6ImportedManifest.stone_count,
    edges: v6ImportedManifest.edge_count,
    head: v6ImportedManifest.head_hash,
    path_heads: v6ImportedSummary.path_heads.length
  });

  for (const item of importedStones) {
    const hash = item.stone.border.hash;
    const destinationStone = await getJson(V6, `/v1/stones/${encodeURIComponent(hash)}`);
    assert.equal(destinationStone.ok, true);
    assert.deepEqual(stableComparable(destinationStone.stone), stableComparable(item.stone), `stone JSON drift for ${hash}`);
    for (const sourceRef of sourceExpansions.get(hash)) {
      const destinationRef = await postJson(V6, "/v1/expand", { ref_id: sourceRef.ref_id, context_lines: 0 });
      assert.equal(destinationRef.ok, true);
      assert.equal(destinationRef.text, sourceRef.text, `expanded raw text drift for ${sourceRef.ref_id}`);
    }
  }
  record("all imported stone JSON and ref expansions are byte-identical");

  const find = await postJson(V6, "/v2/find", {
    query: "semantic custody",
    chain: SOURCE_CHAIN,
    match_mode: "all",
    top_k: 10,
    expand: false
  });
  assert.equal(find.ok, true, `V6 find failed: ${JSON.stringify(find)}`);
  const findText = JSON.stringify(find);
  assert.ok(findText.includes(SOURCE_CHAIN) || findText.includes(v5ManifestBefore.head_hash.slice(0, 12)), "V6 find did not surface imported chain content");
  record("imported refs are searchable via V6 FTS");

  const replayBefore = manifestShape(await getJson(V6, `/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest`));
  const replay = await postJson(V6, "/v1/import-v5-bundle", { bundle, dry_run: false, confirm_import: true });
  assert.equal(replay.ok, true, `idempotent replay failed: ${JSON.stringify(replay)}`);
  const replayAfter = manifestShape(await getJson(V6, `/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest`));
  assert.deepEqual(replayAfter, replayBefore);
  const replaySignal = replay.idempotent_replay === true || replay.replayed === true || replay.writes?.total === 0 || replay.destination?.writes?.total === 0;
  assert.equal(replaySignal, true, `importer did not report zero-write/idempotent replay: ${JSON.stringify(replay)}`);
  record("exact replay is idempotent");

  const conflictingBundle = structuredClone(bundle);
  const alternateHead = importedStones.map(item => item.stone.border.hash).find(hash => hash !== bundle.head_hash);
  assert.ok(alternateHead);
  conflictingBundle.head_hash = alternateHead;
  conflictingBundle.source_manifest.head_hash = alternateHead;
  const collision = await postJson(V6, "/v1/import-v5-bundle", { bundle: conflictingBundle, dry_run: false, confirm_import: true });
  assert.equal(collision.ok, false, `collision must fail closed: ${JSON.stringify(collision)}`);
  assert.match(String(collision.error || collision.code || collision.message || JSON.stringify(collision)), /conflict|collision/i);
  const collisionAfter = manifestShape(await getJson(V6, `/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest`));
  assert.deepEqual(collisionAfter, replayBefore);
  record("conflicting canonical HEAD fails closed with no mutation", { error: collision.error || collision.code || "conflict" });

  const init = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cairnstone-v67-acceptance", version: "1.0.0" } }
  });
  assert.equal(init.payload?.result?.protocolVersion, "2025-03-26");
  const toolsList = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId);
  const tools = toolsList.payload?.result?.tools || [];
  assert.equal(tools.length, EXPECTED_V6_TOOLS);
  assert.equal(new Set(tools.map(tool => tool.name)).size, EXPECTED_V6_TOOLS);
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...v6Health.mcp_tools].sort());
  assert.ok(tools.some(tool => tool.name === "cairnstone_import_v5_bundle"));
  record("raw MCP initialize and tools/list match /health", { tools: tools.length });

  const dispatcherProbe = await mcpPost({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "cairnstone_import_v5_bundle", arguments: { bundle: {}, dry_run: true } }
  }, toolsList.sessionId);
  const dispatcherText = JSON.stringify(dispatcherProbe.payload);
  assert.match(dispatcherText, /invalid_bundle|bundle/i);
  record("MCP dispatcher routes cairnstone_import_v5_bundle");

  const [v5HealthAfter, v5ManifestAfter, protectedAfter] = await Promise.all([
    getJson(V5, "/health"),
    getJson(V5, `/chains/${encodeURIComponent(SOURCE_CHAIN)}/manifest`),
    getJson(V6, `/chains/${encodeURIComponent(PROTECTED_V6_CHAIN)}/manifest`)
  ]);
  assert.equal(v5HealthAfter.ok, true);
  assert.equal(v5HealthAfter.mcp_tools.length, EXPECTED_V5_TOOLS);
  assert.deepEqual(manifestShape(v5ManifestAfter), manifestShape(v5ManifestBefore));
  assert.equal(v5ManifestAfter.head_updated_at, v5ManifestBefore.head_updated_at);
  assert.equal(protectedAfter.head_hash, protectedBefore.head_hash, "existing V6 cairnstone-v6 HEAD must never move during V5 import");
  assert.equal(protectedAfter.stone_count, protectedBefore.stone_count);
  assert.equal(protectedAfter.edge_count, protectedBefore.edge_count);
  record("V5 authoritative graph/HEAD unchanged and V6 project HEAD protected", {
    v5_tools: v5HealthAfter.mcp_tools.length,
    protected_head: protectedAfter.head_hash
  });

  evidence.completed_at = new Date().toISOString();
  evidence.ok = true;
  evidence.source_before = manifestShape(v5ManifestBefore);
  evidence.destination_after = manifestShape(v6ImportedManifest);
  evidence.protected_v6_head_before = protectedBefore.head_hash;
  evidence.protected_v6_head_after = protectedAfter.head_hash;
  evidence.v5_health = { version: v5HealthAfter.version, tools: v5HealthAfter.mcp_tools.length };
  evidence.v6_health = { version: v6Health.version, tools: v6Health.mcp_tools.length };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/v67-live-acceptance.json", JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(`V6.7_ACCEPTANCE_OK ${JSON.stringify({ source_chain: SOURCE_CHAIN, stones: v5ManifestBefore.stone_count, edges: v5ManifestBefore.edge_count, head: v5ManifestBefore.head_hash, protected_v6_head: protectedAfter.head_hash })}`);
}

main().catch(async error => {
  evidence.ok = false;
  evidence.failed_at = new Date().toISOString();
  evidence.error = String(error?.stack || error);
  try {
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/v67-live-acceptance.json", JSON.stringify(evidence, null, 2) + "\n", "utf8");
  } catch {}
  console.error(error);
  process.exitCode = 1;
});
