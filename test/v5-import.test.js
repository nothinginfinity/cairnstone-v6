import assert from "node:assert/strict";
import { test } from "node:test";
import { importV5BundleFromBody, validateV5TransferBundle } from "../src/v5-import.js";

const CHAIN = "v5-import-fixture";
const AUTHOR = "v5-fixture";
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has", "not", "you", "your", "but", "can", "will", "all", "into", "our", "out", "use", "using", "true", "false", "null"]);

function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function extractKeywords(text, limit = 12) {
  const counts = new Map();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_]{3,}/g)) {
    const term = match[0];
    if (STOP.has(term)) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function preview(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 260);
}

async function buildRefs({ stoneHash, path, rawKey, content }) {
  const lines = content.split(/\r?\n/);
  const refs = [];
  for (let i = 0; i < lines.length; i += 80) {
    const chunkLines = lines.slice(i, i + 80);
    const text = chunkLines.join("\n");
    const chunkHash = await sha256(`${stoneHash}:${path}:${i + 1}:${text}`);
    refs.push({
      ref_id: `fsl:${chunkHash.slice(0, 16)}`,
      stone_hash: stoneHash,
      path,
      line_start: i + 1,
      line_end: i + chunkLines.length,
      keywords: extractKeywords(text),
      preview: preview(text),
      raw_key: rawKey,
      flags: []
    });
  }
  return refs;
}

async function makeStone({ title, created, path, content, parent = null }) {
  const rawHash = await sha256(content);
  const rawKey = `raw/${rawHash}.txt`;
  const repo = "nothinginfinity/v5-import-fixture";
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const seed = stableJson({ title, author: AUTHOR, created, rawHash, repo, commit, parent, chain: CHAIN });
  const stoneHash = await sha256(seed);
  const refs = await buildRefs({ stoneHash, path, rawKey, content });
  const originalBytes = utf8Bytes(content);
  const compressedBytes = utf8Bytes(JSON.stringify(refs));
  const receipt = {
    original_bytes: originalBytes,
    compressed_bytes: compressedBytes,
    ratio: Number((originalBytes / compressedBytes).toFixed(2)),
    strategy: "cairnstone-v5.server-side-github-fetch-ref-index",
    created_at: created
  };
  return {
    stone: {
      border: {
        hash: stoneHash,
        author: AUTHOR,
        created,
        title,
        repo,
        commit,
        path,
        parent,
        chain: CHAIN,
        signature: null
      },
      layers: {
        lod5: `${title} fixture`,
        lod4: `author=${AUTHOR}`,
        lod3: refs.map(ref => `${ref.ref_id} ${ref.path}:${ref.line_start}-${ref.line_end}`).join("\n"),
        lod2: { compressed_index: refs, receipt },
        lod1: { raw_key: rawKey, raw_bytes: originalBytes }
      },
      related: [],
      metadata: { source_type: "github_file" }
    },
    raw_content: content
  };
}

async function makeBundle() {
  const first = await makeStone({
    title: "V5 fixture A",
    created: "2026-01-01T00:00:00.000Z",
    path: "docs/a.txt",
    content: "alpha migration identity\nfirst fixture stone"
  });
  const second = await makeStone({
    title: "V5 fixture B",
    created: "2026-01-02T00:00:00.000Z",
    path: "docs/b.txt",
    content: "beta migration compatibility\nsecond fixture stone",
    parent: first.stone.border.hash
  });
  const edgeCreatedAt = "2026-01-02T00:00:01.000Z";
  const edgeType = "supersedes";
  const edgeId = await sha256(`${second.stone.border.hash}:${first.stone.border.hash}:${edgeType}:${edgeCreatedAt}`);
  const headUpdatedAt = "2026-01-02T00:00:02.000Z";
  return {
    format: "cairnstone-v5-transfer-v1",
    source: { vault: "cairnstone-v5", snapshot_at: "2026-01-03T00:00:00.000Z" },
    chain: CHAIN,
    head_hash: second.stone.border.hash,
    head_updated_at: headUpdatedAt,
    source_manifest: {
      stone_count: 2,
      edge_count: 1,
      path_head_count: 1,
      graph_complete: true,
      head_hash: second.stone.border.hash
    },
    stones: [first, second],
    edges: [{
      id: edgeId,
      from_hash: second.stone.border.hash,
      to_hash: first.stone.border.hash,
      edge_type: edgeType,
      note: "fixture supersedes edge",
      created_at: edgeCreatedAt
    }],
    path_heads: [{
      chain: CHAIN,
      path: "docs/b.txt",
      head_hash: second.stone.border.hash,
      updated_at: headUpdatedAt
    }]
  };
}

test("validateV5TransferBundle accepts exact hashes, refs, receipt, edge, path head, and chain head", async () => {
  const bundle = await makeBundle();
  const result = await validateV5TransferBundle(bundle);
  assert.equal(result.ok, true);
  assert.equal(result.chain, CHAIN);
  assert.equal(result.stones.length, 2);
  assert.equal(result.edges.length, 1);
  assert.equal(result.pathHeads.length, 1);
  assert.equal(result.headHash, bundle.head_hash);
});

test("validateV5TransferBundle rejects raw identity drift", async () => {
  const bundle = await makeBundle();
  bundle.stones[0].raw_content += " tampered";
  const result = await validateV5TransferBundle(bundle);
  assert.equal(result.ok, false);
  assert.equal(result.error, "raw_identity_mismatch");
});

test("validateV5TransferBundle rejects receipt compression drift", async () => {
  const bundle = await makeBundle();
  bundle.stones[0].stone.layers.lod2.receipt.compressed_bytes += 1;
  const result = await validateV5TransferBundle(bundle);
  assert.equal(result.ok, false);
  assert.equal(result.error, "receipt_compressed_bytes_mismatch");
});

test("validateV5TransferBundle rejects edge identity drift", async () => {
  const bundle = await makeBundle();
  bundle.edges[0].id = "0".repeat(64);
  const result = await validateV5TransferBundle(bundle);
  assert.equal(result.ok, false);
  assert.equal(result.error, "edge_identity_mismatch");
});

test("importV5BundleFromBody returns structured fail-closed malformed bundle errors", async () => {
  const env = { CAIRNSTONE_DB: {}, CAIRNSTONE_RAW: {} };
  const result = await importV5BundleFromBody({ bundle: { format: "cairnstone-v5-transfer-v1", source: { vault: "cairnstone-v5" } } }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_bundle");
  assert.equal(result.fail_closed, true);
});

test("importV5BundleFromBody requires explicit confirmation for apply", async () => {
  const env = { CAIRNSTONE_DB: {}, CAIRNSTONE_RAW: {} };
  const bundle = await makeBundle();
  const result = await importV5BundleFromBody({ bundle, dry_run: false }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "explicit_import_confirmation_required");
});
