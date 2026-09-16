import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GROUNDED_RESPONSE_SCHEMA,
  GROUNDED_RESPONSE_ENVELOPE_SCHEMA,
  GROUNDED_RESPONSE_ENVELOPE_CATALOG,
  GROUNDED_RESPONSE_MCP_TOOL_DEFINITIONS,
  RESPONSE_LOD_CHAR_BUDGETS,
  applyEnvelopeSwap,
  buildProviderEnvelope,
  clampResponseLod,
  computeResponseId,
  createGroundedResponseFromBody,
  digestGroundedValue,
  evidenceSetIdentityPayload,
  expandGroundedResponseFromBody,
  getGroundedResponseFromBody,
  normalizeSkeleton,
  parseSkeletonModelResponse,
  renderResponseLod,
  resolveEnvelopeRoute,
  skeletonIdentityPayload
} from "../src/grounded-response.js";
import {
  DEFAULT_TOOL_BROKER_REGISTRY,
  toolRegistryFromBody
} from "../src/model-router.js";
import { listAutomaticReadToolIds } from "../src/delegate-loop.js";
import { mcpToolsForProfile } from "../src/index.js";

const ALPHA_HEAD = "a".repeat(64);
const BETA_HEAD = "b".repeat(64);
const ALPHA_PATH = "c".repeat(64);
const BETA_PATH = "d".repeat(64);

function makeFixture(overrides = {}) {
  const skeleton = {
    conclusion: "Shared scope behavior is enabled on Alpha and integrated on Beta.",
    claims: [
      { text: "Alpha enables shared scope behavior", stone_hash: ALPHA_PATH, ref_id: "ref-alpha" },
      { text: "Beta integrates shared scope behavior", stone_hash: BETA_PATH, ref_id: "ref-beta" }
    ],
    uncertainty: [],
    next_action: "Proceed with V7.7.8 progressive grounded chat LOD.",
    caveats: ["Coverage is limited to the selected Scope."],
    context: "Both chains currently expose accepted PATH_HEAD evidence for shared scope behavior.",
    analysis: "Prefer PATH_HEAD evidence over historical notes; no conflicting accepted state was supplied."
  };
  return {
    chainHeads: [
      { chain: "alpha", head_hash: ALPHA_HEAD, updated_at: "2026-09-14T00:00:00Z" },
      { chain: "beta", head_hash: BETA_HEAD, updated_at: "2026-09-14T00:00:00Z" }
    ],
    stones: [
      {
        hash: ALPHA_HEAD,
        chain_hash: "alpha",
        repo: "org/a",
        path: "project-memory/start.md",
        commit_sha: "1".repeat(40),
        title: "Alpha orientation",
        stone_json: JSON.stringify({ layers: { lod4: "Alpha is the accepted orientation for repository A." } })
      },
      {
        hash: BETA_HEAD,
        chain_hash: "beta",
        repo: "org/b",
        path: "project-memory/start.md",
        commit_sha: "2".repeat(40),
        title: "Beta orientation",
        stone_json: JSON.stringify({ layers: { lod4: "Beta is the accepted orientation for repository B." } })
      },
      { hash: ALPHA_PATH, chain_hash: "alpha", repo: "org/a", path: "src/current.js", commit_sha: "3".repeat(40) },
      { hash: BETA_PATH, chain_hash: "beta", repo: "org/b", path: "src/current.js", commit_sha: "4".repeat(40) }
    ],
    pathHeads: [
      { chain: "alpha", path: "src/current.js", head_hash: ALPHA_PATH },
      { chain: "beta", path: "src/current.js", head_hash: BETA_PATH }
    ],
    refs: [
      { ref_id: "ref-alpha", stone_hash: ALPHA_PATH, chain: "alpha", path: "src/current.js", preview: "shared scope alpha accepted behavior", score: -10, raw_key: "raw-alpha", line_start: 1, line_end: 1 },
      { ref_id: "ref-beta", stone_hash: BETA_PATH, chain: "beta", path: "src/current.js", preview: "shared scope beta accepted behavior", score: -9, raw_key: "raw-beta", line_start: 1, line_end: 1 }
    ],
    rawByKey: {
      "raw-alpha": "Alpha current accepted source says shared scope behavior is enabled.",
      "raw-beta": "Beta current accepted source says shared scope behavior is integrated."
    },
    aiResponse: JSON.stringify(skeleton),
    skeleton,
    ...overrides
  };
}

function makeEnv(fixture) {
  const chainHeads = fixture.chainHeads || [];
  const stones = fixture.stones || [];
  const pathHeads = fixture.pathHeads || [];
  const refs = fixture.refs || [];
  const rawByKey = fixture.rawByKey || {};
  const headMutationSchedule = fixture.headMutationSchedule || null;
  const headReadCounts = new Map();
  const groundedResponses = new Map();
  const writes = { chain_heads: 0, path_heads: 0, stones: 0, edges: 0, grounded_responses: 0 };
  let aiCalls = 0;

  function stoneFor(hash) {
    return stones.find(stone => stone.hash === hash) || null;
  }

  function mutateHead(chain, hash) {
    const row = chainHeads.find(item => item.chain === chain);
    if (row) row.head_hash = hash;
  }

  const env = {
    _mutateHead: mutateHead,
    _writes: writes,
    _aiCalls: () => aiCalls,
    _groundedResponses: groundedResponses,
    CAIRNSTONE_DB: {
      prepare(sql) {
        let bound = [];
        const lower = sql.toLowerCase();
        if (lower.includes("insert into chain_heads") || lower.includes("update chain_heads")) writes.chain_heads += 1;
        if (lower.includes("insert into path_heads") || lower.includes("update path_heads")) writes.path_heads += 1;
        if (lower.includes("insert into stones")) writes.stones += 1;
        if (lower.includes("insert into stone_edges")) writes.edges += 1;
        return {
          bind(...args) { bound = args; return this; },
          async all() {
            if (sql.includes("SELECT chain, head_hash, updated_at FROM chain_heads")) {
              return { results: chainHeads.map(row => ({ ...row })) };
            }
            if (sql.includes("SELECT DISTINCT chain_hash AS chain FROM stones WHERE chain_hash IS NOT NULL")) {
              return { results: [...new Set(stones.map(s => s.chain_hash).filter(Boolean))].sort().map(chain => ({ chain })) };
            }
            if (sql.includes("SELECT DISTINCT chain_hash AS chain FROM stones WHERE repo = ?")) {
              const repo = bound[0];
              return {
                results: [...new Set(stones.filter(s => s.repo === repo).map(s => s.chain_hash).filter(Boolean))]
                  .sort()
                  .map(chain => ({ chain }))
              };
            }
            if (sql.includes("FROM refs_fts LEFT JOIN stones s")) {
              const chain = bound[1];
              const limit = Number(bound[bound.length - 1]);
              const repoFilters = bound.slice(2, -1);
              const rows = refs
                .filter(ref => {
                  if (ref.chain !== chain) return false;
                  if (!repoFilters.length) return true;
                  return repoFilters.includes(stoneFor(ref.stone_hash)?.repo || null);
                })
                .sort((a, b) => a.score - b.score || a.ref_id.localeCompare(b.ref_id))
                .slice(0, limit)
                .map(ref => {
                  const stone = stoneFor(ref.stone_hash);
                  return {
                    ref_id: ref.ref_id,
                    stone_hash: ref.stone_hash,
                    chain: ref.chain,
                    path: ref.path,
                    preview: ref.preview,
                    score: ref.score,
                    repo: stone?.repo || null,
                    commit_sha: stone?.commit_sha || null
                  };
                });
              return { results: rows };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes("SELECT head_hash FROM chain_heads WHERE chain = ?")) {
              const chain = bound[0];
              if (headMutationSchedule && headMutationSchedule.chain === chain) {
                const count = headReadCounts.get(chain) || 0;
                headReadCounts.set(chain, count + 1);
                const sequence = headMutationSchedule.sequence;
                return { head_hash: sequence[Math.min(count, sequence.length - 1)] };
              }
              const row = chainHeads.find(item => item.chain === chain);
              return row ? { head_hash: row.head_hash } : null;
            }
            if (sql.includes("SELECT hash FROM stones WHERE chain_hash = ? LIMIT 1")) {
              const chain = bound[0];
              const row = stones.find(item => item.chain_hash === chain);
              return row ? { hash: row.hash } : null;
            }
            if (sql.includes("SELECT hash,title,path,repo,commit_sha,stone_json FROM stones WHERE hash = ?")) {
              const row = stones.find(item => item.hash === bound[0]);
              return row ? {
                hash: row.hash,
                title: row.title || row.path || row.hash,
                path: row.path || null,
                repo: row.repo || null,
                commit_sha: row.commit_sha || null,
                stone_json: row.stone_json || JSON.stringify({ layers: { lod4: row.lod4 || row.title || row.hash } })
              } : null;
            }
            if (sql.includes("SELECT head_hash FROM path_heads WHERE chain = ? AND path = ?")) {
              const [chain, path] = bound;
              const row = pathHeads.find(item => item.chain === chain && item.path === path);
              return row ? { head_hash: row.head_hash } : null;
            }
            if (sql.includes("SELECT raw_key,line_start,line_end FROM refs WHERE ref_id = ?")) {
              const ref = refs.find(item => item.ref_id === bound[0]);
              return ref ? { raw_key: ref.raw_key, line_start: ref.line_start, line_end: ref.line_end } : null;
            }
            if (sql.includes("SELECT * FROM grounded_responses WHERE response_id = ?")) {
              return groundedResponses.get(bound[0]) || null;
            }
            return null;
          },
          async run() {
            if (sql.includes("INSERT INTO grounded_responses")) {
              writes.grounded_responses += 1;
              const record = {
                response_id: bound[0],
                schema: bound[1],
                question: bound[2],
                question_digest: bound[3],
                scope_request_json: bound[4],
                scope_id: bound[5],
                authority_digest: bound[6],
                evidence_set_digest: bound[7],
                answer_skeleton_digest: bound[8],
                scope_snapshot_json: bound[9],
                evidence_json: bound[10],
                skeleton_json: bound[11],
                materialized_lods_json: bound[12],
                highest_materialized_lod: bound[13],
                model: bound[14],
                provider_envelope_json: bound[15],
                actor_id: bound[16],
                thread_id: bound[17],
                code_session_id: bound[18],
                parent_response_id: bound[19],
                telemetry_json: bound[20],
                created_at: bound[21],
                updated_at: bound[22]
              };
              groundedResponses.set(record.response_id, record);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
        };
      }
    },
    CAIRNSTONE_RAW: {
      async get(key) {
        if (!Object.prototype.hasOwnProperty.call(rawByKey, key)) return null;
        return { async text() { return rawByKey[key]; } };
      }
    },
    AI: {
      async run(model, input) {
        aiCalls += 1;
        if (typeof fixture.aiRun === "function") return fixture.aiRun(model, input, aiCalls);
        return { response: fixture.aiResponse };
      }
    }
  };
  return env;
}

test("V7.7.8 helpers: response_lod clamp and pure LOD renderers stay within budgets", () => {
  assert.equal(clampResponseLod(99), 5);
  assert.equal(clampResponseLod(0), 1);
  const skeleton = normalizeSkeleton({
    conclusion: "Short answer.",
    next_action: "Ship 7.8a.",
    context: "Why: snapshot-bound.",
    claims: [{ text: "Claim A", stone_hash: ALPHA_PATH }],
    analysis: "Tradeoff noted.",
    uncertainty: ["maybe"],
    caveats: ["bounded"]
  });
  const evidence = [{ stone_hash: ALPHA_PATH, ref_id: "ref-alpha", chain: "alpha", repo: "org/a", path: "src/current.js", authority_class: "PATH_HEAD" }];
  for (const lod of [1, 2, 3, 4, 5]) {
    const rendered = renderResponseLod({
      response_lod: lod,
      question: "What next?",
      skeleton,
      evidence,
      scope_snapshot: { scope_id: "sha256:scope", authority_digest: "sha256:auth", chains: [{ chain: "alpha", head_hash: ALPHA_HEAD }] },
      identities: {
        scope_id: "sha256:scope",
        authority_digest: "sha256:auth",
        evidence_set_digest: "sha256:ev",
        answer_skeleton_digest: "sha256:sk"
      }
    });
    assert.equal(rendered.response_lod, lod);
    assert.ok(rendered.char_count <= RESPONSE_LOD_CHAR_BUDGETS[lod]);
    assert.equal(rendered.sections.deep_trace, lod >= 5);
    assert.equal(rendered.sections.evidence, lod >= 3);
    assert.match(rendered.text, /Short answer/);
    if (lod >= 5) assert.match(rendered.text, /stone_lod/);
  }
});

test("V7.7.8 helpers: deterministic response_id binds question/scope/authority/evidence/skeleton", async () => {
  const questionDigest = await digestGroundedValue("What is current?");
  const evidenceDigest = await digestGroundedValue(evidenceSetIdentityPayload([
    { stone_hash: ALPHA_PATH, ref_id: "ref-alpha", chain: "alpha", path: "src/current.js", authority_class: "PATH_HEAD" }
  ]));
  const skeletonDigest = await digestGroundedValue(skeletonIdentityPayload({
    conclusion: "Enabled.",
    claims: [],
    uncertainty: [],
    next_action: null,
    caveats: []
  }));
  const a = await computeResponseId({
    question_digest: questionDigest,
    scope_id: "sha256:scope",
    authority_digest: "sha256:auth",
    evidence_set_digest: evidenceDigest,
    answer_skeleton_digest: skeletonDigest
  });
  const b = await computeResponseId({
    question_digest: questionDigest,
    scope_id: "sha256:scope",
    authority_digest: "sha256:auth",
    evidence_set_digest: evidenceDigest,
    answer_skeleton_digest: skeletonDigest
  });
  const c = await computeResponseId({
    question_digest: questionDigest,
    scope_id: "sha256:scope",
    authority_digest: "sha256:auth-changed",
    evidence_set_digest: evidenceDigest,
    answer_skeleton_digest: skeletonDigest
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^gr:[0-9a-f]{48}$/);
});

test("V7.7.8a create: default response_lod 1 with stable identity and zero HEAD mutation", async () => {
  const fixture = makeFixture();
  const env = makeEnv(fixture);
  const result = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.schema, GROUNDED_RESPONSE_SCHEMA);
  assert.match(result.response_id, /^gr:/);
  assert.equal(result.response_lod, 1);
  assert.deepEqual(result.materialized_response_lods, [1]);
  assert.equal(result.highest_materialized_response_lod, 1);
  assert.equal(result.accepted_state_authority, false);
  assert.equal(result.chain_heads_mutated, false);
  assert.equal(result.path_heads_mutated, false);
  assert.equal(env._writes.chain_heads, 0);
  assert.equal(env._writes.path_heads, 0);
  assert.equal(env._writes.stones, 0);
  assert.equal(env._aiCalls(), 1);
  assert.ok(result.answer.length <= RESPONSE_LOD_CHAR_BUDGETS[1]);
  assert.match(result.naming.response_lod, /1→5/);
  assert.match(result.naming.stone_lod, /lod5→lod1/);
  assert.equal(result.telemetry.lazy_default, true);
});

test("V7.7.8a identity stability: same inputs reproduce the same response_id", async () => {
  const fixture = makeFixture();
  const env1 = makeEnv(fixture);
  const env2 = makeEnv(fixture);
  const request = {
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  };
  const a = await createGroundedResponseFromBody(request, env1);
  const b = await createGroundedResponseFromBody(request, env2);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.response_id, b.response_id);
  assert.equal(a.evidence_set_digest, b.evidence_set_digest);
  assert.equal(a.answer_skeleton_digest, b.answer_skeleton_digest);
  assert.equal(a.authority_digest, b.authority_digest);
});

test("V7.7.8b lazy expand: deeper LODs share response_id and do not re-run the model", async () => {
  const env = makeEnv(makeFixture());
  const created = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(created.ok, true);
  assert.equal(env._aiCalls(), 1);

  const expanded = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 3
  }, env);
  assert.equal(expanded.ok, true);
  assert.equal(expanded.response_id, created.response_id);
  assert.equal(expanded.response_lod, 3);
  assert.equal(expanded.evidence_set_digest, created.evidence_set_digest);
  assert.equal(expanded.answer_skeleton_digest, created.answer_skeleton_digest);
  assert.equal(expanded.newly_materialized, true);
  assert.ok(expanded.materialized_response_lods.includes(1));
  assert.ok(expanded.materialized_response_lods.includes(2));
  assert.ok(expanded.materialized_response_lods.includes(3));
  assert.match(expanded.answer, /Evidence/);
  assert.equal(env._aiCalls(), 1, "expand must not regenerate an independent model answer");

  const again = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 3
  }, env);
  assert.equal(again.ok, true);
  assert.equal(again.newly_materialized, false);
  assert.equal(env._aiCalls(), 1);

  const deep = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 5
  }, env);
  assert.equal(deep.ok, true);
  assert.equal(deep.response_id, created.response_id);
  assert.match(deep.answer, /Deep trace/);
  assert.match(deep.answer, /response_lod/);
  assert.ok(!/entire vault/i.test(deep.answer));
  assert.equal(env._aiCalls(), 1);
});

test("V7.7.8a stale authority: expand fails closed; view_original and refresh work", async () => {
  const fixture = makeFixture();
  const env = makeEnv(fixture);
  const created = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(created.ok, true);

  env._mutateHead("alpha", "f".repeat(64));

  const stale = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 4
  }, env);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "stale_response");
  assert.equal(stale.reason, "authority_changed");
  assert.equal(stale.accepted_state_authority, false);
  assert.ok(stale.actions.view_original);
  assert.ok(stale.actions.refresh);

  const original = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 4,
    view_original: true
  }, env);
  assert.equal(original.ok, true);
  assert.equal(original.response_id, created.response_id);
  assert.equal(original.authority_digest, created.authority_digest);
  assert.equal(original.authority_freshness.viewed_original_snapshot, true);

  // Refresh against current authority must mint a new response_id.
  // Restore a stonable head so synthesis can still orient, then mutate back.
  // For refresh we need the new head to resolve; put a stone for the new head.
  fixture.stones.push({
    hash: "f".repeat(64),
    chain_hash: "alpha",
    repo: "org/a",
    path: "project-memory/start.md",
    commit_sha: "5".repeat(40),
    title: "Alpha moved",
    stone_json: JSON.stringify({ layers: { lod4: "Alpha orientation moved to a new accepted HEAD." } })
  });
  const refreshed = await createGroundedResponseFromBody({
    question: created.question,
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    refresh_of: created.response_id,
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(refreshed.ok, true);
  assert.notEqual(refreshed.response_id, created.response_id);
  assert.equal(refreshed.parent_response_id, created.response_id);
  assert.notEqual(refreshed.authority_digest, created.authority_digest);
});

test("V7.7.8a get: reports authority freshness without eager deeper materialization", async () => {
  const env = makeEnv(makeFixture());
  const created = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  const got = await getGroundedResponseFromBody({ response_id: created.response_id }, env);
  assert.equal(got.ok, true);
  assert.equal(got.response_id, created.response_id);
  assert.equal(got.authority_freshness.status, "current");
  assert.deepEqual(got.materialized_response_lods, [1]);
  assert.equal(got.accepted_state_authority, false);
});

test("V7.7.8 skeleton parser accepts JSON and prose fallback", () => {
  const json = parseSkeletonModelResponse({
    response: JSON.stringify({ conclusion: "A.", next_action: "B.", claims: [], uncertainty: [], caveats: [], context: "", analysis: "" })
  });
  assert.equal(json.ok, true);
  assert.equal(json.skeleton.conclusion, "A.");

  const prose = parseSkeletonModelResponse({
    response: "Only prose conclusion without JSON."
  });
  assert.equal(prose.ok, true);
  assert.equal(prose.skeleton_parse, "prose_fallback");
  assert.match(prose.skeleton.conclusion, /Only prose/);
});

test("V7.7.8 broker: grounded-response tools remain automatic reads; registry 94 after V7.7.10d", async () => {
  const registry = await toolRegistryFromBody({}, {});
  assert.equal(registry.ok, true);
  // V7.7.8a/b added create/get/expand; V7.7.10b adds 10 access-grant/attachment/task-run/forward tools (76 -> 86; V7.7.10c +1 intent router -> 87; V7.7.10d +7 executor/task-run tools -> 94).
  assert.equal(registry.total, 94);

  for (const toolId of [
    "cairnstone_grounded_response",
    "cairnstone_grounded_response_get",
    "cairnstone_grounded_response_expand"
  ]) {
    const tool = registry.tools.find(item => item.tool_id === toolId);
    assert.ok(tool, `${toolId} must be broker-classified`);
    assert.equal(tool.risk_class, "read");
    assert.equal(tool.authorization, "automatic");
    assert.equal(tool.available, true);
  }

  const automatic = listAutomaticReadToolIds(DEFAULT_TOOL_BROKER_REGISTRY);
  assert.ok(automatic.includes("cairnstone_grounded_response"));
  assert.ok(automatic.includes("cairnstone_grounded_response_get"));
  assert.ok(automatic.includes("cairnstone_grounded_response_expand"));

  const mcpNames = mcpToolsForProfile(false).map(tool => tool.name);
  for (const def of GROUNDED_RESPONSE_MCP_TOOL_DEFINITIONS) {
    assert.ok(mcpNames.includes(def.name));
  }
});

test("V7.7.8d helpers: envelope catalog resolves generation vs reattribution routes", () => {
  assert.ok(GROUNDED_RESPONSE_ENVELOPE_CATALOG.some(item => item.generation));
  assert.ok(GROUNDED_RESPONSE_ENVELOPE_CATALOG.some(item => !item.generation));

  const gen = resolveEnvelopeRoute({}, { generationRequired: true });
  assert.equal(gen.ok, true);
  assert.equal(gen.provider, "workers_ai");
  assert.equal(gen.generation, true);

  const reattr = resolveEnvelopeRoute({
    provider: "openai",
    model: "gpt-4o-mini"
  }, { generationRequired: false });
  assert.equal(reattr.ok, true);
  assert.equal(reattr.provider, "openai");

  const blocked = resolveEnvelopeRoute({
    provider: "openai",
    model: "gpt-4o-mini"
  }, { generationRequired: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "model_not_generation_capable");

  const envelope = buildProviderEnvelope({
    provider: "workers_ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  });
  assert.equal(envelope.schema, GROUNDED_RESPONSE_ENVELOPE_SCHEMA);
  assert.equal(envelope.identity_affecting, false);
  const swapped = applyEnvelopeSwap(envelope, {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    transport: "anthropic-messages",
    at: "2026-09-14T12:00:00Z",
    response_lod: 3
  });
  assert.equal(swapped.swapped, true);
  assert.equal(swapped.envelope.provider, "anthropic");
  assert.equal(swapped.envelope.history.length, 1);
  assert.equal(swapped.envelope.identity_affecting, false);
});

test("V7.7.8d envelope swap on expand: identity/authority/evidence/claims preserved", async () => {
  const env = makeEnv(makeFixture());
  const created = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(created.ok, true);
  assert.equal(created.provider_envelope.schema, GROUNDED_RESPONSE_ENVELOPE_SCHEMA);
  assert.equal(created.provider_envelope.provider, "workers_ai");
  assert.equal(created.provider_envelope.visible, true);
  assert.equal(created.provider_envelope.identity_affecting, false);
  assert.equal(created.refresh_lineage.is_refresh, false);
  assert.equal(env._aiCalls(), 1);

  const expanded = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 3,
    provider: "openai",
    model: "gpt-4o-mini"
  }, env);
  assert.equal(expanded.ok, true);
  assert.equal(expanded.response_id, created.response_id);
  assert.equal(expanded.authority_digest, created.authority_digest);
  assert.equal(expanded.evidence_set_digest, created.evidence_set_digest);
  assert.equal(expanded.answer_skeleton_digest, created.answer_skeleton_digest);
  assert.equal(expanded.envelope_swapped, true);
  assert.equal(expanded.provider_envelope.provider, "openai");
  assert.equal(expanded.provider_envelope.model, "gpt-4o-mini");
  assert.equal(expanded.provider_envelope.visible, true);
  assert.ok(expanded.provider_envelope.history.length >= 1);
  assert.equal(expanded.provider_envelope.history[0].provider, "workers_ai");
  assert.equal(env._aiCalls(), 1, "envelope swap must not re-run the model");
  assert.equal(env._writes.chain_heads, 0);
  assert.equal(env._writes.path_heads, 0);
});

test("V7.7.8d stale acceptance: reason codes, view_original, refresh lineage", async () => {
  const fixture = makeFixture();
  const env = makeEnv(fixture);
  const created = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    actor_id: "tester",
    thread_id: "thread-8d",
    code_session_id: "cs-optional-bind",
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(created.ok, true);
  assert.equal(created.code_session_id, "cs-optional-bind");

  env._mutateHead("alpha", "f".repeat(64));

  const gotStale = await getGroundedResponseFromBody({ response_id: created.response_id }, env);
  assert.equal(gotStale.ok, true);
  assert.equal(gotStale.authority_freshness.status, "authority_changed");
  assert.equal(gotStale.authority_freshness.stale, true);
  assert.equal(gotStale.authority_freshness.stale_reason_code, "authority_changed");
  assert.equal(gotStale.authority_freshness.snapshot_view, "stale");
  assert.deepEqual(gotStale.authority_freshness.actions, ["view_original", "refresh"]);
  assert.equal(gotStale.provider_envelope.visible, true);

  const stale = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 4
  }, env);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "stale_response");
  assert.equal(stale.reason, "authority_changed");
  assert.equal(stale.stale_reason_code, "authority_changed");
  assert.equal(stale.snapshot_view, "stale");
  assert.equal(stale.evidence_set_digest, created.evidence_set_digest);
  assert.ok(stale.provider_envelope);
  assert.ok(stale.actions.view_original.params.view_original);
  assert.equal(stale.actions.refresh.params.refresh_of, created.response_id);

  const original = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 4,
    view_original: true
  }, env);
  assert.equal(original.ok, true);
  assert.equal(original.response_id, created.response_id);
  assert.equal(original.authority_freshness.snapshot_view, "original");
  assert.equal(original.authority_freshness.viewed_original_snapshot, true);
  assert.equal(original.authority_digest, created.authority_digest);
  assert.equal(original.answer_skeleton_digest, created.answer_skeleton_digest);

  fixture.stones.push({
    hash: "f".repeat(64),
    chain_hash: "alpha",
    repo: "org/a",
    path: "project-memory/start.md",
    commit_sha: "5".repeat(40),
    title: "Alpha moved",
    stone_json: JSON.stringify({ layers: { lod4: "Alpha orientation moved to a new accepted HEAD." } })
  });
  const refreshed = await createGroundedResponseFromBody({
    question: created.question,
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    refresh_of: created.response_id,
    code_session_id: created.code_session_id,
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(refreshed.ok, true);
  assert.notEqual(refreshed.response_id, created.response_id);
  assert.equal(refreshed.parent_response_id, created.response_id);
  assert.equal(refreshed.refresh_of, created.response_id);
  assert.equal(refreshed.refresh_lineage.is_refresh, true);
  assert.equal(refreshed.refresh_lineage.refresh_of, created.response_id);
  assert.notEqual(refreshed.authority_digest, created.authority_digest);
  assert.equal(refreshed.code_session_id, "cs-optional-bind");
  assert.equal(refreshed.accepted_state_authority, false);

  // Original remains inspectable after refresh.
  const stillOriginal = await expandGroundedResponseFromBody({
    response_id: created.response_id,
    response_lod: 5,
    view_original: true
  }, env);
  assert.equal(stillOriginal.ok, true);
  assert.equal(stillOriginal.response_id, created.response_id);
  assert.equal(stillOriginal.authority_digest, created.authority_digest);
});

test("V7.7.8d multi-scope examples: single_chain, multi-chain, optional Code Session", async () => {
  const fixture = makeFixture({
    skeleton: {
      conclusion: "Roadmap next step is Progressive Grounded Chat LOD.",
      claims: [
        { text: "Alpha roadmap points at V7.7.8", stone_hash: ALPHA_PATH, ref_id: "ref-alpha" }
      ],
      uncertainty: [],
      next_action: "Accept V7.7.8d cross-provider stale acceptance.",
      caveats: [],
      context: "Single-chain and multi-chain Scope share one trust model.",
      analysis: "Code Session binding is optional for ordinary Q&A."
    },
    aiResponse: null
  });
  fixture.aiResponse = JSON.stringify(fixture.skeleton);

  const singleEnv = makeEnv(fixture);
  const single = await createGroundedResponseFromBody({
    question: "What is the next roadmap slice?",
    scope: { mode: "single_chain", chains: ["alpha"] },
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, singleEnv);
  assert.equal(single.ok, true);
  assert.equal(single.scope_snapshot.mode, "single_chain");
  assert.equal(single.scope_snapshot.chains.length, 1);
  assert.equal(single.code_session_id, null);
  assert.equal(single.accepted_state_authority, false);

  const multiEnv = makeEnv(fixture);
  const multi = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current across repos?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    code_session_id: "cs-roadmap-smoke",
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, multiEnv);
  assert.equal(multi.ok, true);
  assert.equal(multi.scope_snapshot.mode, "multi");
  assert.equal(multi.scope_snapshot.chains.length, 2);
  assert.equal(multi.code_session_id, "cs-roadmap-smoke");
  assert.notEqual(multi.response_id, single.response_id);
  assert.equal(multi.provider_envelope.visible, true);

  const deep = await expandGroundedResponseFromBody({
    response_id: multi.response_id,
    response_lod: 5
  }, multiEnv);
  assert.equal(deep.ok, true);
  assert.equal(deep.response_id, multi.response_id);
  assert.match(deep.answer, /Deep trace/);
  assert.equal(multiEnv._aiCalls(), 1);
  assert.equal(multiEnv._writes.chain_heads, 0);
});

test("V7.7.8d create rejects non-generation envelope models without changing allowlist semantics", async () => {
  const env = makeEnv(makeFixture());
  const result = await createGroundedResponseFromBody({
    question: "What shared scope behavior is current?",
    scope: { mode: "multi", chains: ["alpha", "beta"] },
    provider: "openai",
    model: "gpt-4o-mini",
    top_k: 2,
    per_chain_k: 1,
    max_expansions: 2,
    context_lines: 0
  }, env);
  assert.equal(result.ok, false);
  assert.equal(result.error, "model_not_generation_capable");
  assert.equal(result.accepted_state_authority, false);
  assert.equal(env._aiCalls(), 0);
});