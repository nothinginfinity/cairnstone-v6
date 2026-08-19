const V5_TRANSFER_FORMAT = "cairnstone-v5-transfer-v1";
const V5_SOURCE_VAULT = "cairnstone-v5";
const DEFAULT_LINES_PER_REF = 80;
const EDGE_TYPES = ["supersedes", "patches", "documents", "reviews", "references"];
const FULL_SHA256_RE = /^[0-9a-f]{64}$/i;
const RAW_KEY_RE = /^raw\/([0-9a-f]{64})\.txt$/i;
const MAX_IMPORT_STONES = 200;
const MAX_IMPORT_EDGES = 2000;
const MAX_IMPORT_PATH_HEADS = 1000;

export async function importV5BundleFromBody(body, env) {
  requireBindings(env);
  const dryRun = body.dry_run !== false;
  if (!dryRun && body.confirm_import !== true) {
    return fail("explicit_import_confirmation_required", {
      message: "V5 import is opt-in. Re-run with dry_run:false and confirm_import:true only after reviewing the preview."
    });
  }

  const normalized = await validateBundle(body.bundle);
  if (!normalized.ok) return normalized;

  const preflight = await inspectDestination(normalized, env);
  if (!preflight.ok) return preflight;

  const preview = buildPreview(normalized, preflight, dryRun);
  if (dryRun) return preview;

  const applied = await applyImport(normalized, preflight, env);
  if (!applied.ok) return applied;

  return {
    ...preview,
    dry_run: false,
    applied: true,
    writes: applied.writes,
    head_written_last: true,
    idempotent_replay: applied.writes.total === 0,
    destination: applied.destination
  };
}

async function validateBundle(bundle) {
  if (!isObject(bundle)) return fail("invalid_bundle", { message: "bundle must be an object" });
  if (bundle.format !== V5_TRANSFER_FORMAT) {
    return fail("unsupported_transfer_format", { expected: V5_TRANSFER_FORMAT, actual: bundle.format || null });
  }
  if (!isObject(bundle.source) || bundle.source.vault !== V5_SOURCE_VAULT) {
    return fail("invalid_source_vault", { expected: V5_SOURCE_VAULT, actual: bundle.source?.vault || null });
  }

  const chain = requiredString(bundle.chain, "bundle.chain");
  const stones = Array.isArray(bundle.stones) ? bundle.stones : null;
  const edges = Array.isArray(bundle.edges) ? bundle.edges : null;
  const pathHeads = Array.isArray(bundle.path_heads) ? bundle.path_heads : [];
  const sourceManifest = isObject(bundle.source_manifest) ? bundle.source_manifest : null;

  if (!stones || stones.length < 1 || stones.length > MAX_IMPORT_STONES) {
    return fail("invalid_stone_count", { minimum: 1, maximum: MAX_IMPORT_STONES, actual: stones?.length ?? null });
  }
  if (!edges || edges.length > MAX_IMPORT_EDGES) {
    return fail("invalid_edge_count", { minimum: 0, maximum: MAX_IMPORT_EDGES, actual: edges?.length ?? null });
  }
  if (pathHeads.length > MAX_IMPORT_PATH_HEADS) {
    return fail("invalid_path_head_count", { maximum: MAX_IMPORT_PATH_HEADS, actual: pathHeads.length });
  }
  if (!sourceManifest || sourceManifest.graph_complete !== true) {
    return fail("source_manifest_not_graph_complete", { message: "V6.7 imports only explicit full-chain V5 snapshots whose source manifest reports graph_complete:true." });
  }
  if (Number(sourceManifest.stone_count) !== stones.length || Number(sourceManifest.edge_count) !== edges.length) {
    return fail("source_manifest_count_mismatch", {
      manifest: { stone_count: Number(sourceManifest.stone_count), edge_count: Number(sourceManifest.edge_count) },
      bundle: { stone_count: stones.length, edge_count: edges.length }
    });
  }
  if (sourceManifest.path_head_count !== undefined && Number(sourceManifest.path_head_count) !== pathHeads.length) {
    return fail("source_manifest_path_head_count_mismatch", {
      manifest: Number(sourceManifest.path_head_count), bundle: pathHeads.length
    });
  }

  const headHash = requiredHash(bundle.head_hash, "bundle.head_hash");
  const headUpdatedAt = requiredString(bundle.head_updated_at, "bundle.head_updated_at");
  const seenStoneHashes = new Set();
  const seenRefIds = new Set();
  const preparedStones = [];

  for (let index = 0; index < stones.length; index += 1) {
    const item = stones[index];
    if (!isObject(item) || !isObject(item.stone) || typeof item.raw_content !== "string") {
      return fail("invalid_stone_entry", { index, message: "Each stones[] entry must contain exact stone JSON and raw_content string." });
    }
    const stone = item.stone;
    const border = stone.border;
    const layers = stone.layers;
    if (!isObject(border) || !isObject(layers) || !isObject(layers.lod1) || !isObject(layers.lod2)) {
      return fail("invalid_stone_shape", { index });
    }

    const stoneHash = requiredHash(border.hash, `stones[${index}].stone.border.hash`);
    if (seenStoneHashes.has(stoneHash)) return fail("duplicate_stone_hash_in_bundle", { hash: stoneHash });
    seenStoneHashes.add(stoneHash);
    if (border.chain !== chain) return fail("stone_chain_mismatch", { hash: stoneHash, expected_chain: chain, stone_chain: border.chain ?? null });

    const rawKey = requiredString(layers.lod1.raw_key, `stones[${index}].stone.layers.lod1.raw_key`);
    const rawMatch = rawKey.match(RAW_KEY_RE);
    if (!rawMatch) return fail("invalid_raw_key", { hash: stoneHash, raw_key: rawKey });
    const rawHash = await sha256(item.raw_content);
    if (rawHash !== rawMatch[1].toLowerCase()) {
      return fail("raw_identity_mismatch", { hash: stoneHash, raw_key: rawKey, expected_sha256: rawMatch[1].toLowerCase(), observed_sha256: rawHash });
    }
    if (Number(layers.lod1.raw_bytes) !== utf8Bytes(item.raw_content)) {
      return fail("raw_byte_count_mismatch", { hash: stoneHash, expected: Number(layers.lod1.raw_bytes), observed: utf8Bytes(item.raw_content) });
    }

    const identitySeed = stableJson({
      title: border.title,
      author: border.author,
      created: border.created,
      rawHash,
      repo: border.repo ?? null,
      commit: border.commit ?? null,
      parent: border.parent ?? null,
      chain: border.chain ?? null
    });
    const recomputedStoneHash = await sha256(identitySeed);
    if (recomputedStoneHash !== stoneHash) {
      return fail("stone_identity_mismatch", { hash: stoneHash, recomputed_hash: recomputedStoneHash });
    }

    const refs = Array.isArray(layers.lod2.compressed_index) ? layers.lod2.compressed_index : null;
    if (!refs) return fail("missing_compressed_index", { hash: stoneHash });
    const path = requiredString(border.path || refs[0]?.path || "", `stones[${index}].stone.border.path`);
    const rebuiltRefs = await buildRefs({ stoneHash, path, rawKey, content: item.raw_content });
    if (stableJson(rebuiltRefs) !== stableJson(refs)) {
      return fail("ref_identity_mismatch", { hash: stoneHash, message: "Exact V5 compressed_index does not match refs deterministically rebuilt from raw content." });
    }
    for (const ref of refs) {
      if (seenRefIds.has(ref.ref_id)) return fail("duplicate_ref_id_in_bundle", { ref_id: ref.ref_id });
      seenRefIds.add(ref.ref_id);
    }

    const receipt = layers.lod2.receipt;
    if (!isObject(receipt)) return fail("missing_receipt", { hash: stoneHash });
    if (Number(receipt.original_bytes) !== utf8Bytes(item.raw_content)) {
      return fail("receipt_original_bytes_mismatch", { hash: stoneHash });
    }
    const receiptId = await sha256(`${stoneHash}:${border.created}:receipt`);

    preparedStones.push({
      stone,
      stoneJson: JSON.stringify(stone),
      stoneHash,
      rawContent: item.raw_content,
      rawKey,
      rawHash,
      refs,
      receipt,
      receiptId,
      path,
      row: {
        hash: stoneHash,
        title: requiredString(border.title, `stone ${stoneHash} title`),
        author: requiredString(border.author, `stone ${stoneHash} author`),
        created_at: requiredString(border.created, `stone ${stoneHash} created`),
        repo: border.repo ?? null,
        commit_sha: border.commit ?? null,
        parent_hash: border.parent ?? null,
        chain_hash: border.chain ?? null,
        raw_key: rawKey,
        path
      }
    });
  }

  if (!seenStoneHashes.has(headHash)) {
    return fail("head_not_in_imported_chain", { chain, head_hash: headHash });
  }
  if (sourceManifest.head_hash && sourceManifest.head_hash !== headHash) {
    return fail("source_manifest_head_mismatch", { manifest_head_hash: sourceManifest.head_hash, bundle_head_hash: headHash });
  }

  const seenEdgeIds = new Set();
  const preparedEdges = [];
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (!isObject(edge)) return fail("invalid_edge_entry", { index });
    const id = requiredHash(edge.id, `edges[${index}].id`);
    if (seenEdgeIds.has(id)) return fail("duplicate_edge_id_in_bundle", { id });
    seenEdgeIds.add(id);
    const fromHash = requiredHash(edge.from_hash, `edges[${index}].from_hash`);
    const toHash = requiredHash(edge.to_hash, `edges[${index}].to_hash`);
    const edgeType = requiredString(edge.edge_type, `edges[${index}].edge_type`);
    if (!EDGE_TYPES.includes(edgeType)) return fail("invalid_edge_type", { id, edge_type: edgeType, allowed: EDGE_TYPES });
    const createdAt = requiredString(edge.created_at, `edges[${index}].created_at`);
    const recomputedId = await sha256(`${fromHash}:${toHash}:${edgeType}:${createdAt}`);
    if (recomputedId !== id) return fail("edge_identity_mismatch", { id, recomputed_id: recomputedId });
    if (!seenStoneHashes.has(fromHash) && !seenStoneHashes.has(toHash)) {
      return fail("edge_not_connected_to_imported_chain", { id, from_hash: fromHash, to_hash: toHash });
    }
    preparedEdges.push({ id, from_hash: fromHash, to_hash: toHash, edge_type: edgeType, note: edge.note ?? null, created_at: createdAt });
  }

  const seenPaths = new Set();
  const preparedPathHeads = [];
  for (let index = 0; index < pathHeads.length; index += 1) {
    const entry = pathHeads[index];
    if (!isObject(entry)) return fail("invalid_path_head_entry", { index });
    const entryChain = entry.chain === undefined ? chain : requiredString(entry.chain, `path_heads[${index}].chain`);
    if (entryChain !== chain) return fail("path_head_chain_mismatch", { index, expected_chain: chain, actual_chain: entryChain });
    const path = requiredString(entry.path, `path_heads[${index}].path`);
    if (seenPaths.has(path)) return fail("duplicate_path_head_in_bundle", { path });
    seenPaths.add(path);
    const pathHeadHash = requiredHash(entry.head_hash, `path_heads[${index}].head_hash`);
    if (!seenStoneHashes.has(pathHeadHash)) return fail("path_head_not_in_imported_chain", { path, head_hash: pathHeadHash });
    const target = preparedStones.find(item => item.stoneHash === pathHeadHash);
    if (!target || target.path !== path) {
      return fail("path_head_path_mismatch", { path, head_hash: pathHeadHash, stone_path: target?.path ?? null });
    }
    preparedPathHeads.push({ chain, path, head_hash: pathHeadHash, updated_at: requiredString(entry.updated_at, `path_heads[${index}].updated_at`) });
  }

  return {
    ok: true,
    format: V5_TRANSFER_FORMAT,
    source: bundle.source,
    sourceManifest,
    chain,
    headHash,
    headUpdatedAt,
    stones: preparedStones,
    edges: preparedEdges,
    pathHeads: preparedPathHeads
  };
}

async function inspectDestination(bundle, env) {
  const conflicts = [];
  const state = {
    missingRaw: [], missingStones: [], missingRefs: [], missingReceipts: [], missingEdges: [], missingPathHeads: [],
    ftsRebuild: [], chainHeadMissing: false, chainHeadExact: false
  };

  const chainHead = await env.CAIRNSTONE_DB.prepare("SELECT chain,head_hash,updated_at FROM chain_heads WHERE chain = ?").bind(bundle.chain).first();
  if (chainHead) {
    if (chainHead.head_hash !== bundle.headHash) {
      conflicts.push({ type: "chain_head_conflict", chain: bundle.chain, existing_head_hash: chainHead.head_hash, import_head_hash: bundle.headHash });
    } else if (chainHead.updated_at !== bundle.headUpdatedAt) {
      conflicts.push({ type: "chain_head_metadata_conflict", chain: bundle.chain, existing_updated_at: chainHead.updated_at, import_updated_at: bundle.headUpdatedAt });
    } else {
      state.chainHeadExact = true;
    }
  } else {
    state.chainHeadMissing = true;
  }

  for (const item of bundle.stones) {
    const raw = await env.CAIRNSTONE_RAW.get(item.rawKey);
    if (raw) {
      const existingRaw = await raw.text();
      if (await sha256(existingRaw) !== item.rawHash || existingRaw !== item.rawContent) {
        conflicts.push({ type: "raw_collision", raw_key: item.rawKey, stone_hash: item.stoneHash });
      }
    } else {
      state.missingRaw.push(item);
    }

    const existingStone = await env.CAIRNSTONE_DB.prepare(
      "SELECT hash,title,author,created_at,repo,commit_sha,parent_hash,chain_hash,raw_key,stone_json,path FROM stones WHERE hash = ?"
    ).bind(item.stoneHash).first();
    if (existingStone) {
      if (!sameStoneRow(existingStone, item)) conflicts.push({ type: "stone_collision", hash: item.stoneHash });
    } else {
      state.missingStones.push(item);
    }

    const existingRefs = (await env.CAIRNSTONE_DB.prepare(
      "SELECT ref_id,stone_hash,path,line_start,line_end,keywords,preview,raw_key FROM refs WHERE stone_hash = ? ORDER BY line_start ASC, ref_id ASC"
    ).bind(item.stoneHash).all()).results || [];
    if (existingRefs.length) {
      const expectedRefs = item.refs.map(refToDbRow).sort(refSort);
      const actualRefs = existingRefs.map(normalizeDbRef).sort(refSort);
      if (stableJson(actualRefs) !== stableJson(expectedRefs)) conflicts.push({ type: "stone_refs_collision", hash: item.stoneHash });
    } else {
      for (const ref of item.refs) {
        const byId = await env.CAIRNSTONE_DB.prepare(
          "SELECT ref_id,stone_hash,path,line_start,line_end,keywords,preview,raw_key FROM refs WHERE ref_id = ?"
        ).bind(ref.ref_id).first();
        if (byId) conflicts.push({ type: "ref_id_collision", ref_id: ref.ref_id, existing_stone_hash: byId.stone_hash, import_stone_hash: item.stoneHash });
        else state.missingRefs.push(ref);
      }
    }

    const receiptRows = (await env.CAIRNSTONE_DB.prepare(
      "SELECT id,stone_hash,original_bytes,compressed_bytes,ratio,strategy,created_at FROM receipts WHERE stone_hash = ?"
    ).bind(item.stoneHash).all()).results || [];
    const expectedReceipt = receiptToDbRow(item);
    if (receiptRows.length) {
      if (receiptRows.length !== 1 || stableJson(normalizeReceipt(receiptRows[0])) !== stableJson(expectedReceipt)) {
        conflicts.push({ type: "receipt_collision", stone_hash: item.stoneHash });
      }
    } else {
      const byId = await env.CAIRNSTONE_DB.prepare("SELECT stone_hash FROM receipts WHERE id = ?").bind(item.receiptId).first();
      if (byId) conflicts.push({ type: "receipt_id_collision", id: item.receiptId, existing_stone_hash: byId.stone_hash, import_stone_hash: item.stoneHash });
      else state.missingReceipts.push(item);
    }

    const ftsRows = (await env.CAIRNSTONE_DB.prepare(
      "SELECT ref_id,stone_hash,chain,path,keywords,preview FROM refs_fts WHERE stone_hash = ? ORDER BY ref_id ASC"
    ).bind(item.stoneHash).all()).results || [];
    const expectedFts = item.refs.map(ref => ({ ref_id: ref.ref_id, stone_hash: item.stoneHash, chain: bundle.chain, path: ref.path, keywords: ref.keywords.join(" "), preview: ref.preview })).sort(ftsSort);
    const actualFts = ftsRows.map(row => ({ ref_id: row.ref_id, stone_hash: row.stone_hash, chain: row.chain, path: row.path, keywords: row.keywords, preview: row.preview })).sort(ftsSort);
    if (stableJson(actualFts) !== stableJson(expectedFts)) state.ftsRebuild.push(item);
  }

  for (const edge of bundle.edges) {
    const existing = await env.CAIRNSTONE_DB.prepare("SELECT id,from_hash,to_hash,edge_type,note,created_at FROM stone_edges WHERE id = ?").bind(edge.id).first();
    if (existing) {
      if (stableJson(normalizeEdge(existing)) !== stableJson(edge)) conflicts.push({ type: "edge_collision", id: edge.id });
    } else {
      state.missingEdges.push(edge);
    }
  }

  for (const pathHead of bundle.pathHeads) {
    const existing = await env.CAIRNSTONE_DB.prepare("SELECT chain,path,head_hash,updated_at FROM path_heads WHERE chain = ? AND path = ?").bind(pathHead.chain, pathHead.path).first();
    if (existing) {
      if (stableJson(normalizePathHead(existing)) !== stableJson(pathHead)) conflicts.push({ type: "path_head_conflict", chain: pathHead.chain, path: pathHead.path, existing_head_hash: existing.head_hash, import_head_hash: pathHead.head_hash });
    } else {
      state.missingPathHeads.push(pathHead);
    }
  }

  if (conflicts.length) {
    return fail("destination_collision", {
      chain: bundle.chain,
      conflicts,
      fail_closed: true,
      message: "No V6 state was changed. Resolve or intentionally isolate the destination collision before importing."
    });
  }
  return { ok: true, state };
}

function buildPreview(bundle, preflight, dryRun) {
  const s = preflight.state;
  const writes = {
    raw_objects: s.missingRaw.length,
    stones: s.missingStones.length,
    refs: s.missingRefs.length,
    receipts: s.missingReceipts.length,
    fts_stones: s.ftsRebuild.length,
    edges: s.missingEdges.length,
    path_heads: s.missingPathHeads.length,
    chain_head: s.chainHeadMissing ? 1 : 0
  };
  writes.total = Object.values(writes).reduce((sum, value) => sum + value, 0);
  return {
    ok: true,
    format: bundle.format,
    source: { ...bundle.source, authoritative: true, mutation_mode: "none" },
    chain: bundle.chain,
    dry_run: dryRun,
    applied: false,
    fail_closed: true,
    identity_preserving: true,
    source_manifest: {
      stone_count: bundle.sourceManifest.stone_count,
      edge_count: bundle.sourceManifest.edge_count,
      graph_complete: true,
      head_hash: bundle.headHash,
      path_head_count: bundle.pathHeads.length
    },
    destination_preview: {
      writes,
      existing_chain_head_exact: s.chainHeadExact,
      head_will_be_written_last: s.chainHeadMissing,
      collision_override_supported: false
    },
    instructions: dryRun ? "Preview validated. To apply this exact bundle, re-run unchanged with dry_run:false and confirm_import:true." : undefined
  };
}

async function applyImport(bundle, preflight, env) {
  const s = preflight.state;
  const writes = { raw_objects: 0, stones: 0, refs: 0, receipts: 0, fts_stones: 0, edges: 0, path_heads: 0, chain_head: 0, total: 0 };

  try {
    for (const item of s.missingRaw) {
      await env.CAIRNSTONE_RAW.put(item.rawKey, item.rawContent, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: { title: item.row.title, author: item.row.author, rawHash: item.rawHash, importedFrom: V5_SOURCE_VAULT }
      });
      writes.raw_objects += 1;
    }

    const statements = [];
    for (const item of s.missingStones) {
      statements.push(env.CAIRNSTONE_DB.prepare(
        "INSERT INTO stones (hash,title,author,created_at,repo,commit_sha,parent_hash,chain_hash,raw_key,stone_json,path) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(item.row.hash, item.row.title, item.row.author, item.row.created_at, item.row.repo, item.row.commit_sha, item.row.parent_hash, item.row.chain_hash, item.row.raw_key, item.stoneJson, item.row.path));
    }
    for (const ref of s.missingRefs) {
      statements.push(env.CAIRNSTONE_DB.prepare(
        "INSERT INTO refs (ref_id,stone_hash,path,line_start,line_end,keywords,preview,raw_key) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(ref.ref_id, ref.stone_hash, ref.path, ref.line_start, ref.line_end, ref.keywords.join(" "), ref.preview, ref.raw_key));
    }
    for (const item of s.missingReceipts) {
      const r = item.receipt;
      statements.push(env.CAIRNSTONE_DB.prepare(
        "INSERT INTO receipts (id,stone_hash,original_bytes,compressed_bytes,ratio,strategy,created_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(item.receiptId, item.stoneHash, r.original_bytes, r.compressed_bytes, r.ratio, r.strategy, r.created_at));
    }
    for (const edge of s.missingEdges) {
      statements.push(env.CAIRNSTONE_DB.prepare(
        "INSERT INTO stone_edges (id,from_hash,to_hash,edge_type,note,created_at) VALUES (?,?,?,?,?,?)"
      ).bind(edge.id, edge.from_hash, edge.to_hash, edge.edge_type, edge.note, edge.created_at));
    }
    for (const pathHead of s.missingPathHeads) {
      statements.push(env.CAIRNSTONE_DB.prepare(
        "INSERT INTO path_heads (chain,path,head_hash,updated_at) VALUES (?,?,?,?)"
      ).bind(pathHead.chain, pathHead.path, pathHead.head_hash, pathHead.updated_at));
    }
    if (statements.length) await env.CAIRNSTONE_DB.batch(statements);
    writes.stones = s.missingStones.length;
    writes.refs = s.missingRefs.length;
    writes.receipts = s.missingReceipts.length;
    writes.edges = s.missingEdges.length;
    writes.path_heads = s.missingPathHeads.length;

    for (const item of s.ftsRebuild) {
      const ftsStatements = [env.CAIRNSTONE_DB.prepare("DELETE FROM refs_fts WHERE stone_hash = ?").bind(item.stoneHash)];
      for (const ref of item.refs) {
        ftsStatements.push(env.CAIRNSTONE_DB.prepare(
          "INSERT INTO refs_fts (ref_id,stone_hash,chain,path,keywords,preview) VALUES (?,?,?,?,?,?)"
        ).bind(ref.ref_id, item.stoneHash, bundle.chain, ref.path, ref.keywords.join(" "), ref.preview));
      }
      await env.CAIRNSTONE_DB.batch(ftsStatements);
      writes.fts_stones += 1;
    }

    // Canonical chain HEAD is intentionally the final write. Any earlier failure leaves the imported
    // rows non-canonical and safely replayable; an existing conflicting HEAD was rejected in preflight.
    if (s.chainHeadMissing) {
      await env.CAIRNSTONE_DB.prepare("INSERT INTO chain_heads (chain,head_hash,updated_at) VALUES (?,?,?)")
        .bind(bundle.chain, bundle.headHash, bundle.headUpdatedAt).run();
      writes.chain_head = 1;
    }
    writes.total = writes.raw_objects + writes.stones + writes.refs + writes.receipts + writes.fts_stones + writes.edges + writes.path_heads + writes.chain_head;

    const destination = await verifyDestination(bundle, env);
    if (!destination.ok) return destination;
    return { ok: true, writes, destination };
  } catch (error) {
    return fail("import_apply_failed", {
      message: String(error?.message || error),
      head_write_attempted: writes.chain_head > 0,
      safe_to_replay_after_review: writes.chain_head === 0
    });
  }
}

async function verifyDestination(bundle, env) {
  const head = await env.CAIRNSTONE_DB.prepare("SELECT head_hash,updated_at FROM chain_heads WHERE chain = ?").bind(bundle.chain).first();
  const stoneCount = await count(env, "SELECT COUNT(*) AS n FROM stones WHERE chain_hash = ?", bundle.chain);
  const edgeRows = await queryEdgesForHashes(env, bundle.stones.map(item => item.stoneHash));
  const pathHeadCount = await count(env, "SELECT COUNT(*) AS n FROM path_heads WHERE chain = ?", bundle.chain);
  if (!head || head.head_hash !== bundle.headHash || head.updated_at !== bundle.headUpdatedAt) {
    return fail("post_import_head_verification_failed", { chain: bundle.chain, expected: bundle.headHash, actual: head?.head_hash || null });
  }
  if (stoneCount !== bundle.stones.length) return fail("post_import_stone_count_mismatch", { expected: bundle.stones.length, actual: stoneCount });
  if (edgeRows.length !== bundle.edges.length) return fail("post_import_edge_count_mismatch", { expected: bundle.edges.length, actual: edgeRows.length });
  if (pathHeadCount !== bundle.pathHeads.length) return fail("post_import_path_head_count_mismatch", { expected: bundle.pathHeads.length, actual: pathHeadCount });
  return { ok: true, chain: bundle.chain, head_hash: head.head_hash, stone_count: stoneCount, edge_count: edgeRows.length, path_head_count: pathHeadCount, graph_complete: true };
}

async function queryEdgesForHashes(env, hashes) {
  if (!hashes.length) return [];
  const placeholders = hashes.map(() => "?").join(",");
  const sql = `SELECT id,from_hash,to_hash,edge_type,note,created_at FROM stone_edges WHERE from_hash IN (${placeholders}) OR to_hash IN (${placeholders}) ORDER BY created_at ASC,id ASC`;
  const result = await env.CAIRNSTONE_DB.prepare(sql).bind(...hashes, ...hashes).all();
  return result.results || [];
}

async function count(env, sql, value) {
  const row = await env.CAIRNSTONE_DB.prepare(sql).bind(value).first();
  return Number(row?.n || 0);
}

function sameStoneRow(existing, item) {
  const expected = item.row;
  const scalarEqual = existing.hash === expected.hash && existing.title === expected.title && existing.author === expected.author &&
    existing.created_at === expected.created_at && nullish(existing.repo) === nullish(expected.repo) &&
    nullish(existing.commit_sha) === nullish(expected.commit_sha) && nullish(existing.parent_hash) === nullish(expected.parent_hash) &&
    nullish(existing.chain_hash) === nullish(expected.chain_hash) && existing.raw_key === expected.raw_key && nullish(existing.path) === nullish(expected.path);
  if (!scalarEqual) return false;
  try { return stableJson(JSON.parse(existing.stone_json)) === stableJson(item.stone); } catch { return false; }
}

function refToDbRow(ref) {
  return { ref_id: ref.ref_id, stone_hash: ref.stone_hash, path: ref.path, line_start: Number(ref.line_start), line_end: Number(ref.line_end), keywords: ref.keywords.join(" "), preview: ref.preview, raw_key: ref.raw_key };
}
function normalizeDbRef(ref) { return { ref_id: ref.ref_id, stone_hash: ref.stone_hash, path: ref.path, line_start: Number(ref.line_start), line_end: Number(ref.line_end), keywords: ref.keywords, preview: ref.preview, raw_key: ref.raw_key }; }
function refSort(a, b) { return a.line_start - b.line_start || String(a.ref_id).localeCompare(String(b.ref_id)); }
function ftsSort(a, b) { return String(a.ref_id).localeCompare(String(b.ref_id)); }
function receiptToDbRow(item) { const r = item.receipt; return { id: item.receiptId, stone_hash: item.stoneHash, original_bytes: Number(r.original_bytes), compressed_bytes: Number(r.compressed_bytes), ratio: Number(r.ratio), strategy: r.strategy, created_at: r.created_at }; }
function normalizeReceipt(r) { return { id: r.id, stone_hash: r.stone_hash, original_bytes: Number(r.original_bytes), compressed_bytes: Number(r.compressed_bytes), ratio: Number(r.ratio), strategy: r.strategy, created_at: r.created_at }; }
function normalizeEdge(e) { return { id: e.id, from_hash: e.from_hash, to_hash: e.to_hash, edge_type: e.edge_type, note: e.note ?? null, created_at: e.created_at }; }
function normalizePathHead(p) { return { chain: p.chain, path: p.path, head_hash: p.head_hash, updated_at: p.updated_at }; }
function nullish(value) { return value === undefined || value === null ? null : value; }

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
  const longLines = text.split(/\r?\n/).filter(line => line.length > 300).length;
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
    const ref = { ref_id: `fsl:${chunkHash.slice(0, 16)}`, stone_hash: stoneHash, path, line_start: i + 1, line_end: i + chunkLines.length, keywords: extractKeywords(text, 12), preview: preview(text), raw_key: rawKey, flags: detectFlags(text) };
    refs.push(ref);
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length > 40) {
      if (!byNormalized.has(normalized)) byNormalized.set(normalized, []);
      byNormalized.get(normalized).push(ref.ref_id);
    }
  }
  for (const ids of byNormalized.values()) {
    if (ids.length <= 1) continue;
    for (const ref of refs) {
      if (ids.includes(ref.ref_id)) ref.flags.push({ type: "duplicate_chunk", count: ids.length - 1, with: ids.filter(id => id !== ref.ref_id) });
    }
  }
  return refs;
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
function preview(text) { return text.replace(/\s+/g, " ").trim().slice(0, 260); }
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
function utf8Bytes(value) { return new TextEncoder().encode(value).length; }
function isObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required string: ${name}`);
  return value;
}
function requiredHash(value, name) {
  const text = requiredString(value, name).toLowerCase();
  if (!FULL_SHA256_RE.test(text)) throw new Error(`Invalid SHA-256 hash: ${name}`);
  return text;
}
function requireBindings(env) {
  if (!env?.CAIRNSTONE_DB) throw new Error("Missing D1 binding CAIRNSTONE_DB");
  if (!env?.CAIRNSTONE_RAW) throw new Error("Missing R2 binding CAIRNSTONE_RAW");
}
function fail(error, extra = {}) { return { ok: false, error, ...extra }; }

export const v5ImportContract = Object.freeze({
  format: V5_TRANSFER_FORMAT,
  source_vault: V5_SOURCE_VAULT,
  default_dry_run: true,
  explicit_apply_confirmation: true,
  collision_override_supported: false,
  head_written_last: true,
  maximum_stones: MAX_IMPORT_STONES
});
