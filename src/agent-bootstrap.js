// V7.0 -- Context Compiler / cairnstone_agent_bootstrap
//
// Implements docs/V7_0_CONTEXT_COMPILER_CONTRACT.md.
//
// Hard invariants (see contract sections 4 and 11):
//   - zero LLM calls, zero provider credentials, zero tool execution,
//     zero accepted-state mutation (no chain_head/path_head writes, no
//     correspondence status mutation, no cairnstone_skill_agent/cairnstone_ask calls).
//   - mutable Git branches are never authority; only CairnStone accepted
//     (chain_head / path_head) state is authority.
//   - fails closed with context_compile_race if any authority pointer used
//     in the package changes between the initial snapshot and final assembly.

import { computeBootstrapPackageProfile, computeMcpSchemaProfile, computeCombinedStartupProfile } from "./context-profile.js";

export const AGENT_CONTEXT_SCHEMA = "cairnstone-agent-context-v1";
export const DEFAULT_INSTRUCTIONS_PATH = "docs/AI_OPERATING_GUIDE.md";
export const DEFAULT_RUNTIME_BRIEF_PATH = "docs/AI_RUNTIME_BRIEF.json";
export const RUNTIME_BRIEF_SCHEMA = "cairnstone-canonical-instruction-runtime-brief-v1";
export const DEFAULT_SKILLS_CHAIN = "cairnstone-v6-skills";
export const REQUIRED_RUNTIME_RULE_IDS = Object.freeze([
  "AUTH-CHAIN-001",
  "AUTH-HEAD-002",
  "ORIENT-AC1-003",
  "SKILL-AUTH-004",
  "GIT-PROV-005",
  "FRESH-LIVE-006",
  "GRAPH-HEAD-007",
  "MODEL-NONAUTH-008",
  "EXEC-BOUNDARY-009",
  "SECRET-ISOLATION-010",
  "FAIL-CLOSED-011",
  "INSTR-PRECEDENCE-012",
  "TOOL-SELECT-013",
  "ACCEPT-WRITE-014",
  "VERIFY-DEPLOY-015",
  "CONCURRENCY-016"
]);

const TASK_MAX_LENGTH = 4000;
const ACTOR_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const TOOL_CLASSES = new Set(["read", "mutation", "execution", "unknown"]);
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_SKILLS_HARD = 10;
const AMBIGUITY_SCORE_MARGIN = 2;
const BOOTSTRAP_MODES = new Set(["legacy_full", "optimized_sparse"]);
const SPARSE_AUTHORITY_SCHEMA = "cairnstone-sparse-authority-v1";
const SPARSE_PATH_HEAD_CAP = 24;

const DEFAULT_LIMITS = {
  max_skills: 5,
  max_memory_hits: 6,
  max_memory_bytes: 24000,
  max_inbox_items: 10,
  max_package_bytes: 64000
};

// Server-enforced hard ceilings. Caller-requested limits are clamped to these
// even if the caller asks for more (contract section 3, "Optional limits").
const HARD_LIMITS = {
  max_skills: MAX_SKILLS_HARD,
  max_memory_hits: 15,
  max_memory_bytes: 60000,
  max_inbox_items: 50,
  max_package_bytes: 180000
};

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /bearer/i,
  /\btoken\b/i,
  /private[_-]?key/i,
  /seed[_-]?phrase/i,
  /\bpassword\b/i,
  /wallet/i,
  /credential/i
];

export const AGENT_BOOTSTRAP_TOOL_DEFINITION = {
  name: "cairnstone_agent_bootstrap",
  description:
    "V7.0: deterministic, provider-neutral context compiler. Compiles the exact accepted agent state (canonical instructions, accepted skills, bounded memory evidence, non-mutating AC1 coordination snapshot, capability/policy evidence) for actor_id+task+chain into one immutable, content-identified cairnstone-agent-context-v1 package. Zero LLM calls, zero provider credentials, zero tool execution, zero accepted-state mutation. Fails closed with context_compile_race if any authority pointer used in the package changes mid-compile. See docs/V7_0_CONTEXT_COMPILER_CONTRACT.md.",
  inputSchema: {
    type: "object",
    required: ["actor_id", "task", "chain"],
    properties: {
      actor_id: { type: "string", description: "namespace:identifier, e.g. chatgpt:cairnstone-v7" },
      task: { type: "string", maxLength: TASK_MAX_LENGTH, description: "Descriptive input only; grants no authority." },
      chain: { type: "string", description: "The accepted-state/memory chain to compile." },
      capabilities: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                available: { type: "boolean" },
                class: { type: "string", enum: ["read", "mutation", "execution", "unknown"] }
              }
            }
          },
          supports_tool_calls: { type: "boolean" },
          max_context_tokens: { type: "number" }
        },
        additionalProperties: false
      },
      loaded_skills: { type: "array", items: { type: "string" }, maxItems: 100 },
      limits: {
        type: "object",
        properties: {
          max_skills: { type: "number", minimum: 1, maximum: HARD_LIMITS.max_skills },
          max_memory_hits: { type: "number", minimum: 0, maximum: HARD_LIMITS.max_memory_hits },
          max_memory_bytes: { type: "number", minimum: 0, maximum: HARD_LIMITS.max_memory_bytes },
          max_inbox_items: { type: "number", minimum: 0, maximum: HARD_LIMITS.max_inbox_items },
          max_package_bytes: { type: "number", minimum: 1000, maximum: HARD_LIMITS.max_package_bytes }
        },
        additionalProperties: false
      },
      mode: {
        type: "string",
        enum: ["legacy_full", "optimized_sparse"],
        description: "V7.6 bootstrap transmission mode. Defaults to legacy_full. legacy_full transmits the complete accepted canonical operating guide. optimized_sparse preserves the complete accepted path-head authority cryptographically and may use the identity-bound accepted canonical runtime brief; any missing/stale/invalid brief falls back explicitly to the full accepted guide."
      },
      include_inbox: { type: "boolean", description: "Defaults to true. Non-mutating inbox listing only." },
      include_profile: {
        type: "boolean",
        description: "V7.6.0: attach a read-only context-cost diagnostics profile (byte and estimated-token accounting per package section, plus live MCP tool-schema bytes when the caller wiring supplies them) to the response. Defaults to false; adds no measurable cost to the returned package when absent. Zero additional LLM/provider calls, zero accepted-state mutation."
      }
    },
    additionalProperties: false
  }
};

export async function agentBootstrapFromBody(body, env, deps) {
  try {
    if (!env || !env.CAIRNSTONE_DB || !env.CAIRNSTONE_RAW) {
      return { ok: false, error: "cairnstone_bindings_missing" };
    }
    if (!deps || typeof deps.resumeChainFromBody !== "function" || typeof deps.getInboxFromBody !== "function" ||
        typeof deps.resolveSkillsFromBody !== "function" || typeof deps.getSkillBundleFromBody !== "function" ||
        typeof deps.listSkillsFromBody !== "function") {
      return { ok: false, error: "agent_bootstrap_dependencies_missing" };
    }

    const secretCheck = scanForForbiddenSecrets(body);
    if (!secretCheck.ok) return secretCheck;

    let actorId;
    let task;
    let chain;
    let instructionsChain;
    let bootstrapMode;
    try {
      actorId = requiredActorId(body && body.actor_id, "actor_id");
      task = requiredText(body && body.task, "task", TASK_MAX_LENGTH);
      chain = requiredText(body && body.chain, "chain", 300);
      // Internal-only V7.4 cross-project mode. `instructions_chain` is
      // intentionally absent from the public MCP input schema, so callers
      // cannot redirect canonical instructions. A validated profile may pass
      // its owning chain here while the target chain remains project-state
      // authority and memory scope.
      instructionsChain = body && typeof body.instructions_chain === "string" && body.instructions_chain.trim()
        ? requiredText(body.instructions_chain, "instructions_chain", 300)
        : chain;
      bootstrapMode = normalizeBootstrapMode(body && body.mode);
    } catch (error) {
      return { ok: false, error: mapValidationError(error) };
    }

    const capabilities = normalizeCapabilities(body && body.capabilities);
    const limits = resolveLimits(body && body.limits);
    const includeInbox = body.include_inbox !== false;
    const loadedSkillIds = new Set(normalizeStringArray(body.loaded_skills));

    // ---- Snapshot 1: authority state before compilation begins (race protection, contract section 9) ----
    const snapshot1 = await captureAuthoritySnapshot(env, chain, deps);
    if (!snapshot1.ok) return snapshot1;
    const resume = snapshot1.resume;

    // ---- Canonical instructions: accepted path HEAD only, never mutable main ----
    // Cross-project V7.4 profiles may reuse the profile owner's canonical
    // instructions while compiling authority/memory from a different allowed
    // project chain. Both chains are independently snapshotted and race-
    // checked; the instructions chain never becomes target project authority.
    const instructionsSnapshot1 = instructionsChain === chain
      ? snapshot1
      : await captureAuthoritySnapshot(env, instructionsChain, deps);
    if (!instructionsSnapshot1.ok) {
      return { ...instructionsSnapshot1, error: "canonical_instructions_chain_unavailable", instructions_chain: instructionsChain };
    }
    const instructions = await compileCanonicalInstructions({
      env,
      resume: instructionsSnapshot1.resume,
      mode: bootstrapMode,
      guidePath: DEFAULT_INSTRUCTIONS_PATH,
      briefPath: DEFAULT_RUNTIME_BRIEF_PATH
    });
    if (!instructions.ok) return { ...instructions, instructions_chain: instructionsChain };
    if (instructionsChain !== chain) instructions.value.authority_chain = instructionsChain;

    // ---- AC1 coordination snapshot: non-mutating listing only ----
    let coordination = { recipient_id: actorId, unread_count: 0, items: [] };
    if (includeInbox) {
      const inbox = await deps.getInboxFromBody({ recipient_id: actorId, limit: limits.max_inbox_items }, env);
      if (inbox && inbox.ok) {
        const items = inbox.messages.slice(0, limits.max_inbox_items).map(message => ({
          message_id: message.message_id,
          sender_id: message.sender_id,
          thread_id: message.thread_id,
          status: message.status,
          priority: message.priority,
          subject: message.subject,
          stone_hash: message.stone_hash,
          lod5: message.lod5
        }));
        coordination = {
          recipient_id: actorId,
          unread_count: inbox.messages.filter(message => message.status === "delivered" || message.status === "queued").length,
          items
        };
      }
    }

    // ---- Deterministic skill resolution + accepted provenance-bearing bundle ----
    const skillsResult = await compileSkills(env, deps, { task, loadedSkillIds, capabilities, maxSkills: limits.max_skills });
    if (!skillsResult.ok) return skillsResult;

    // ---- Bounded, deterministic memory/evidence retrieval ----
    const memory = await compileMemory(env, chain, task, resume, limits);
    if (!memory.ok) return memory;

    // ---- V7.6.1 authority transmission envelope ----
    // The snapshot/race fingerprint above and below ALWAYS covers the full
    // accepted path-head vector. optimized_sparse changes only what metadata
    // is transmitted to the reasoning model; it never changes accepted-state
    // authority or the pointers protected by the race check.
    const authority = await compileAuthorityEnvelope({
      resume,
      chain,
      task,
      memory: memory.value,
      mode: bootstrapMode,
      includeCanonicalInstructionsPath: instructionsChain === chain,
      includeRuntimeBriefPath: instructionsChain === chain && instructions.value.selection?.representation === "runtime_brief"
    });

    // ---- Capability coverage / policy evidence ----
    const capabilitiesOut = compileCapabilityEvidence(capabilities, skillsResult.value);

    const runtime = {
      cairnstone_version: deps.version || null,
      protocol: "FSL-CCR Stone v6",
      compiled_at: new Date().toISOString()
    };

    const packageBody = {
      schema: AGENT_CONTEXT_SCHEMA,
      actor: { actor_id: actorId },
      request: { task, chain },
      runtime,
      authority,
      instructions: instructions.value,
      coordination,
      skills: skillsResult.value,
      memory: memory.value,
      capabilities: capabilitiesOut,
      policy: {
        context_compiler_called_llm: false,
        execution_authority: false,
        mutation_authority: false,
        provider_credentials_in_package: false,
        accepted_state_only_for_authority: true,
        mutable_branch_is_authority: false
      },
      limits: null
    };

    // ---- Size discipline (contract section 10): trim memory before ever touching instructions ----
    const sized = enforceSizeDiscipline(packageBody, limits, instructions.value);
    packageBody.limits = sized.limits;
    if (sized.exceeded) {
      return { ok: false, error: "package_size_limit_exceeded", limits: sized.limits };
    }

    // ---- Snapshot 2: re-read minimal authority vector; fail closed on any generation mismatch ----
    const snapshot2 = await captureAuthoritySnapshot(env, chain, deps);
    if (!snapshot2.ok) return snapshot2;
    if (!sameAuthoritySnapshot(snapshot1, snapshot2)) {
      return { ok: false, error: "context_compile_race", chain, detail: "chain_or_path_heads_changed_during_compile" };
    }
    if (instructionsChain !== chain) {
      const instructionsSnapshot2 = await captureAuthoritySnapshot(env, instructionsChain, deps);
      if (!instructionsSnapshot2.ok || !sameAuthoritySnapshot(instructionsSnapshot1, instructionsSnapshot2)) {
        return {
          ok: false,
          error: "context_compile_race",
          chain,
          instructions_chain: instructionsChain,
          detail: "canonical_instructions_chain_or_path_heads_changed_during_compile"
        };
      }
    }
    const skillsManifestRecheck = await deps.listSkillsFromBody({ chain: skillsResult.value.chain }, env);
    if (!skillsManifestRecheck || skillsManifestRecheck.ok === false ||
        skillsManifestRecheck.manifest.stone_hash !== skillsResult.value.manifest_head) {
      return { ok: false, error: "context_compile_race", chain, detail: "skills_manifest_head_changed_during_compile" };
    }

    const packageId = "sha256:" + await sha256Text(stableJson(hashablePayload(packageBody)));

    // ---- V7.6.0: optional read-only context-cost profile (never affects packageId/hashablePayload above) ----
    let diagnostics;
    if (body && body.include_profile === true) {
      const bootstrapProfile = computeBootstrapPackageProfile(packageBody, {
        instructionsBytes: sized.limits.instructions_bytes,
        packageBytes: sized.limits.package_bytes
      });
      const mcpSchemaProfile = (deps && Array.isArray(deps.mcpToolDefinitions))
        ? computeMcpSchemaProfile(deps.mcpToolDefinitions)
        : null;
      diagnostics = {
        schema: "cairnstone-context-profile-v1",
        bootstrap_package: bootstrapProfile,
        mcp_schema: mcpSchemaProfile,
        combined: computeCombinedStartupProfile({
          bootstrapProfile,
          mcpSchemaProfile,
          maxContextTokens: capabilitiesOut && Number.isFinite(capabilitiesOut.max_context_tokens) ? capabilitiesOut.max_context_tokens : null
        })
      };
    }

    return {
      ok: true,
      schema: AGENT_CONTEXT_SCHEMA,
      package_id: packageId,
      ...packageBody,
      ...(diagnostics ? { diagnostics } : {})
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

// ---------------------------------------------------------------------------
// Authority snapshot / race protection
// ---------------------------------------------------------------------------

async function captureAuthoritySnapshot(env, chain, deps) {
  const resume = await deps.resumeChainFromBody({ chain }, env);
  if (!resume || resume.ok === false) {
    return { ok: false, error: (resume && resume.error) || "chain_not_found", chain, detail: resume };
  }
  return {
    ok: true,
    resume,
    fingerprint: stableJson({
      chain_head: resume.canonical_head.hash,
      path_heads: resume.path_heads.map(item => `${item.path}:${item.stone_hash}`).sort()
    })
  };
}

function sameAuthoritySnapshot(a, b) {
  return a.fingerprint === b.fingerprint;
}

function compactAcceptedPathHead(item) {
  return {
    path: item.path,
    stone_hash: item.stone_hash,
    repo: item.repo,
    commit_sha: item.commit_sha
  };
}

export function canonicalPathHeadPointers(pathHeadsOrResume) {
  const pathHeads = Array.isArray(pathHeadsOrResume)
    ? pathHeadsOrResume
    : (pathHeadsOrResume && Array.isArray(pathHeadsOrResume.path_heads) ? pathHeadsOrResume.path_heads : []);
  return pathHeads
    .map(item => ({ path: item.path, stone_hash: item.stone_hash }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.stone_hash.localeCompare(b.stone_hash));
}

export async function computeAcceptedAuthorityManifest({ chain, chain_head, path_heads }) {
  const pointers = canonicalPathHeadPointers(path_heads || []);
  const pathHeadsDigest = "sha256:" + await sha256Text(stableJson(pointers));
  const manifestIdentityPayload = {
    schema: SPARSE_AUTHORITY_SCHEMA,
    chain,
    chain_head,
    path_head_count: pointers.length,
    path_heads_digest: pathHeadsDigest
  };
  return {
    schema: SPARSE_AUTHORITY_SCHEMA,
    authority_manifest_id: "sha256:" + await sha256Text(stableJson(manifestIdentityPayload)),
    path_heads_digest: pathHeadsDigest,
    full_path_head_count: pointers.length
  };
}

function selectSparsePathHeads(resume, task, memory, includeCanonicalInstructionsPath, includeRuntimeBriefPath) {
  const full = (resume.path_heads || []).map(compactAcceptedPathHead);
  const byPath = new Map(full.map(item => [item.path, item]));
  const selected = new Set();
  const addPath = path => {
    if (typeof path !== "string" || !byPath.has(path) || selected.size >= SPARSE_PATH_HEAD_CAP) return;
    selected.add(path);
  };

  // Preserve direct authority context for the canonical chain orientation and
  // canonical instructions when those paths belong to this target chain.
  addPath(resume.canonical_head && resume.canonical_head.path);
  if (includeCanonicalInstructionsPath) addPath(DEFAULT_INSTRUCTIONS_PATH);
  if (includeRuntimeBriefPath) addPath(DEFAULT_RUNTIME_BRIEF_PATH);

  // Any accepted path-head evidence actually selected for the task must be
  // represented in the sparse envelope. Historical evidence is intentionally
  // not promoted into accepted authority merely because it was retrieved.
  for (const item of (memory && Array.isArray(memory.items) ? memory.items : [])) {
    if (item && (item.authority_class === "PATH_HEAD" || item.authority_class === "CHAIN_HEAD")) addPath(item.path);
  }

  // Deterministic lexical fallback makes obvious task/path relationships
  // representable even when bounded memory retrieval returns no row. Ranking
  // is token-overlap first and path lexical order second; there is no model
  // call and no timestamp ordering.
  const terms = tokenizeTask(task);
  const ranked = full
    .map(item => ({
      path: item.path,
      score: terms.reduce((sum, term) => sum + (String(item.path).toLowerCase().includes(term) ? 1 : 0), 0)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  for (const item of ranked) addPath(item.path);

  return full
    .filter(item => selected.has(item.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function compileAuthorityEnvelope({ resume, chain, task, memory, mode, includeCanonicalInstructionsPath, includeRuntimeBriefPath }) {
  const chainHead = {
    stone_hash: resume.canonical_head.hash,
    path: resume.canonical_head.path,
    repo: resume.canonical_head.repo,
    commit_sha: resume.canonical_head.commit_sha
  };

  // legacy_full is intentionally byte/identity compatible with the existing
  // V7.0 package shape. Explicit mode:"legacy_full" and an omitted mode yield
  // the same authority object and therefore the same package_id.
  if (mode === "legacy_full") {
    return {
      chain,
      chain_head: chainHead,
      path_heads: (resume.path_heads || []).map(compactAcceptedPathHead),
      timestamp_ordering_used: false
    };
  }

  const authorityManifest = await computeAcceptedAuthorityManifest({
    chain,
    chain_head: resume.canonical_head.hash,
    path_heads: resume.path_heads || []
  });
  const pathHeadsDigest = authorityManifest.path_heads_digest;
  const authorityManifestId = authorityManifest.authority_manifest_id;
  const represented = selectSparsePathHeads(resume, task, memory, includeCanonicalInstructionsPath, includeRuntimeBriefPath);

  return {
    chain,
    chain_head: chainHead,
    path_heads: represented,
    timestamp_ordering_used: false,
    sparse: {
      schema: SPARSE_AUTHORITY_SCHEMA,
      mode: "optimized_sparse",
      authority_manifest_id: authorityManifestId,
      path_heads_digest: pathHeadsDigest,
      full_path_head_count: authorityManifest.full_path_head_count,
      represented_path_head_count: represented.length,
      omitted_path_head_count: Math.max(0, authorityManifest.full_path_head_count - represented.length),
      selection: {
        deterministic: true,
        max_path_heads: SPARSE_PATH_HEAD_CAP,
        preserves_selected_authority_evidence: true,
        task_path_token_matching: true,
        timestamp_ordering_used: false
      },
      expansion: {
        tool: "cairnstone_resume_chain",
        arguments: { chain },
        expected_authority_manifest_id: authorityManifestId,
        expected_path_heads_digest: pathHeadsDigest
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Canonical instructions
// ---------------------------------------------------------------------------

async function compileCanonicalInstructions({ env, resume, mode, guidePath, briefPath }) {
  const guide = await loadCanonicalInstructions(env, resume, guidePath);
  if (!guide.ok) return guide;

  const fullGuide = guide.value;
  if (mode === "legacy_full") {
    return {
      ok: true,
      value: {
        ...fullGuide,
        transmitted_content_identity: fullGuide.content_identity,
        selection: {
          requested_mode: "legacy_full",
          representation: "full_guide",
          fallback: null
        }
      }
    };
  }

  const fallback = (code, detail = null) => ({
    ok: true,
    value: {
      ...fullGuide,
      transmitted_content_identity: fullGuide.content_identity,
      selection: {
        requested_mode: "optimized_sparse",
        representation: "full_guide_fallback",
        runtime_brief_path: briefPath,
        fallback: { code, ...(detail ? { detail } : {}) }
      }
    }
  });

  const briefEntry = (resume.path_heads || []).find(item => item.path === briefPath);
  if (!briefEntry) return fallback("runtime_brief_unaccepted");
  if (!FULL_SHA_RE.test(String(briefEntry.commit_sha || "")) || !briefEntry.repo || !String(briefEntry.repo).includes("/")) {
    return fallback("runtime_brief_source_not_immutable", String(briefEntry.commit_sha || "missing_commit_sha"));
  }

  const fetched = await fetchAcceptedGitHubText(env, briefEntry.repo, briefPath, briefEntry.commit_sha);
  if (!fetched.ok) return fallback("runtime_brief_fetch_failed", fetched.error || "unknown_fetch_error");

  let document;
  try {
    document = JSON.parse(fetched.content);
  } catch {
    return fallback("runtime_brief_json_invalid");
  }

  const validated = validateRuntimeBriefDocument(document, fullGuide);
  if (!validated.ok) return fallback(validated.error, validated.detail || null);

  const transmittedContentIdentity = {
    sha256: await sha256Text(validated.rendered_content),
    bytes: utf8Bytes(validated.rendered_content)
  };

  return {
    ok: true,
    value: {
      ...fullGuide,
      content: validated.rendered_content,
      transmitted_content_identity: transmittedContentIdentity,
      selection: {
        requested_mode: "optimized_sparse",
        representation: "runtime_brief",
        runtime_brief: {
          path: briefPath,
          stone_hash: briefEntry.stone_hash,
          repo: briefEntry.repo,
          commit_sha: briefEntry.commit_sha,
          schema: RUNTIME_BRIEF_SCHEMA,
          content_identity: fetched.content_identity
        },
        fallback: null
      }
    }
  };
}

function exactObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateRuntimeBriefDocument(document, expectedGuide) {
  if (!exactObjectKeys(document, ["schema", "authority", "required_rule_ids", "rules"])) {
    return { ok: false, error: "runtime_brief_shape_invalid", detail: "top_level_keys" };
  }
  if (document.schema !== RUNTIME_BRIEF_SCHEMA) {
    return { ok: false, error: "runtime_brief_schema_invalid" };
  }
  if (!exactObjectKeys(document.authority, ["guide", "full_guide_remains_canonical", "provider_neutral", "authority_expansion"]) ||
      document.authority.full_guide_remains_canonical !== true ||
      document.authority.provider_neutral !== true ||
      document.authority.authority_expansion !== false) {
    return { ok: false, error: "runtime_brief_shape_invalid", detail: "authority_contract" };
  }
  if (!exactObjectKeys(document.authority.guide, ["path", "stone_hash", "repo", "commit_sha", "content_identity"]) ||
      !exactObjectKeys(document.authority.guide.content_identity, ["sha256", "git_blob_sha", "bytes"])) {
    return { ok: false, error: "runtime_brief_shape_invalid", detail: "guide_identity_shape" };
  }

  const expectedGuideIdentity = {
    path: expectedGuide.path,
    stone_hash: expectedGuide.stone_hash,
    repo: expectedGuide.repo,
    commit_sha: expectedGuide.commit_sha,
    content_identity: expectedGuide.content_identity
  };
  if (stableJson(document.authority.guide) !== stableJson(expectedGuideIdentity)) {
    return { ok: false, error: "runtime_brief_guide_identity_mismatch" };
  }

  if (!Array.isArray(document.required_rule_ids) ||
      stableJson(document.required_rule_ids) !== stableJson(REQUIRED_RUNTIME_RULE_IDS)) {
    return { ok: false, error: "runtime_brief_required_rule_coverage_invalid", detail: "required_rule_ids" };
  }
  if (!Array.isArray(document.rules) || document.rules.length !== REQUIRED_RUNTIME_RULE_IDS.length) {
    return { ok: false, error: "runtime_brief_required_rule_coverage_invalid", detail: "rules_length" };
  }

  const rendered = [];
  for (let index = 0; index < REQUIRED_RUNTIME_RULE_IDS.length; index += 1) {
    const rule = document.rules[index];
    const expectedId = REQUIRED_RUNTIME_RULE_IDS[index];
    if (!exactObjectKeys(rule, ["id", "text"]) || rule.id !== expectedId || typeof rule.text !== "string" || !rule.text.trim()) {
      return { ok: false, error: "runtime_brief_required_rule_coverage_invalid", detail: `rule:${expectedId}` };
    }
    rendered.push(`${rule.id}: ${rule.text.trim()}`);
  }

  return { ok: true, rendered_content: rendered.join("\n") };
}

async function loadCanonicalInstructions(env, resume, path) {
  const entry = (resume.path_heads || []).find(item => item.path === path);
  if (!entry) {
    return { ok: false, error: "canonical_instructions_unavailable", path };
  }
  if (!FULL_SHA_RE.test(String(entry.commit_sha || "")) || !entry.repo || !String(entry.repo).includes("/")) {
    return { ok: false, error: "accepted_instruction_source_not_immutable", path, commit_sha: entry.commit_sha || null };
  }
  const fetched = await fetchAcceptedGitHubText(env, entry.repo, path, entry.commit_sha);
  if (!fetched.ok) return { ...fetched, path };

  return {
    ok: true,
    value: {
      path,
      stone_hash: entry.stone_hash,
      repo: entry.repo,
      commit_sha: entry.commit_sha,
      content_identity: fetched.content_identity,
      content: fetched.content,
      truncated: false
    }
  };
}

async function fetchAcceptedGitHubText(env, repo, path, commitSha) {
  if (!env.GITHUB_TOKEN) return { ok: false, error: "github_token_missing" };
  const [owner, repoName] = String(repo).split("/", 2);
  const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "cairnstone-v6-agent-bootstrap"
    }
  });
  if (!response.ok) return { ok: false, error: "accepted_instruction_github_fetch_failed", status: response.status };
  const data = await response.json();
  if (!data || data.encoding !== "base64" || typeof data.content !== "string") {
    return { ok: false, error: "accepted_instruction_github_response_invalid" };
  }
  const content = decodeBase64Utf8(data.content.replace(/\s+/g, ""));
  const bytes = utf8Bytes(content);
  return {
    ok: true,
    content,
    content_identity: {
      sha256: await sha256Text(content),
      git_blob_sha: FULL_SHA_RE.test(String(data.sha || "")) ? String(data.sha).toLowerCase() : null,
      bytes
    }
  };
}

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Skills: deterministic resolution + accepted provenance-bearing bundle
// ---------------------------------------------------------------------------

async function compileSkills(env, deps, { task, loadedSkillIds, capabilities, maxSkills }) {
  const chain = DEFAULT_SKILLS_CHAIN;
  const availableTools = (capabilities.tools || [])
    .filter(tool => tool.available !== false)
    .map(tool => tool.id);

  const manifestSnapshot = await deps.listSkillsFromBody({ chain }, env);
  if (!manifestSnapshot || manifestSnapshot.ok === false) {
    return { ok: false, error: "skills_manifest_unavailable", detail: manifestSnapshot };
  }
  const manifestHead = manifestSnapshot.manifest.stone_hash;
  const boot = (manifestSnapshot.boot || []).filter(id => !loadedSkillIds.has(id));

  const resolved = await deps.resolveSkillsFromBody({
    task,
    chain,
    available_tools: availableTools,
    loaded_skills: [...loadedSkillIds],
    max_skills: maxSkills
  }, env);
  if (!resolved || resolved.ok === false) {
    return { ok: false, error: "skills_resolution_failed", detail: resolved };
  }

  const recommendations = resolved.recommendations || [];
  const ambiguous = recommendations.length >= 2 &&
    (recommendations[0].score - recommendations[1].score) <= AMBIGUITY_SCORE_MARGIN;

  const selectedIds = [...new Set([...boot, ...recommendations.map(item => item.skill_id)])];

  let acceptedBundle = { bundle_identity: { algorithm: "sha256", sha256: null }, skills: [] };
  if (selectedIds.length) {
    const bundle = await deps.getSkillBundleFromBody({ skill_ids: selectedIds, chain }, env);
    if (!bundle || bundle.ok === false) {
      return { ok: false, error: "accepted_skill_bundle_invalid", detail: bundle };
    }
    if (bundle.manifest_head !== manifestHead) {
      return { ok: false, error: "context_compile_race", detail: "skills_manifest_head_changed_during_bundle_fetch" };
    }
    acceptedBundle = {
      bundle_identity: bundle.bundle_identity,
      skills: bundle.skills.map(skill => ({
        skill_id: skill.skill_id,
        skill_version: skill.skill_version,
        title: skill.title,
        description: skill.description,
        path: skill.path,
        tags: skill.tags,
        requires_tools: skill.requires_tools,
        stone_hash: skill.stone_hash,
        commit_sha: skill.commit_sha,
        content_identity: skill.content_identity,
        authority: skill.authority,
        content: skill.content
      }))
    };
  }

  return {
    ok: true,
    manifest_head_changed: false,
    value: {
      chain,
      manifest_head: manifestHead,
      resolution_mode: "deterministic",
      boot,
      recommendations: recommendations.map(item => ({
        skill_id: item.skill_id,
        title: item.title,
        path: item.path,
        version: item.version,
        score: item.score,
        reasons: item.reasons,
        missing_tools: item.missing_tools
      })),
      ambiguous,
      ...(ambiguous ? { advisory_model_may_help_later: true } : {}),
      accepted_bundle: acceptedBundle
    }
  };
}

// ---------------------------------------------------------------------------
// Bounded deterministic memory / evidence retrieval (no LLM synthesis)
// ---------------------------------------------------------------------------

const FTS_BM25_WEIGHTS = "0, 0, 0, 2.0, 4.0, 1.0";
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
  "have", "has", "not", "you", "your", "but", "can", "will", "all", "into",
  "our", "out", "use", "using", "true", "false", "null"
]);

const CURRENT_STATE_CUES = [
  /\bcurrent(?:ly)?\b/i,
  /\blatest\b/i,
  /\bnewest\b/i,
  /\bnow\b/i,
  /\bnext\b/i,
  /\bstatus\b/i,
  /\broadmap\b/i,
  /\bupcoming\b/i,
  /\bremaining\b/i,
  /\bactive\b/i
];

const HISTORICAL_STATE_CUES = [
  /\bhistor(?:y|ical|ically)\b/i,
  /\bprevious(?:ly)?\b/i,
  /\bprior\b/i,
  /\bold(?:er)?\b/i,
  /\bearlier\b/i,
  /\bbefore\b/i,
  /\bformerly\b/i,
  /\bchange(?:d|s)?\b/i,
  /\bcompare(?:d|s)?\b/i,
  /\bcomparison\b/i,
  /\bevolution\b/i,
  /\bsupersed(?:e|ed|es|ing)\b/i
];

function isCurrentStateQuery(task) {
  const text = String(task || "");
  if (HISTORICAL_STATE_CUES.some(pattern => pattern.test(text))) return false;
  return CURRENT_STATE_CUES.some(pattern => pattern.test(text));
}

function authorityRank(authorityClass) {
  if (authorityClass === "CHAIN_HEAD") return 0;
  if (authorityClass === "PATH_HEAD") return 1;
  return 2;
}

function tokenizeTask(text) {
  const terms = [];
  const seen = new Set();
  for (const match of String(text).toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) {
    const term = match[0];
    if (STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

const STRUCTURAL_PATH_HEAD_LIMIT = 1;
const PATH_MATCH_IGNORED_TERMS = new Set([
  ...STOP_WORDS,
  "what", "current", "currently", "latest", "newest", "now", "next",
  "status", "upcoming", "remaining", "active"
]);

function scoreAuthorityContextPathReference(path, authorityContextText) {
  const normalizedPath = String(path || "").toLowerCase();
  const context = String(authorityContextText || "").toLowerCase();
  if (!normalizedPath || !context) return 0;

  let best = 0;
  let from = 0;
  while (from < context.length) {
    const index = context.indexOf(normalizedPath, from);
    if (index < 0) break;
    const before = context.slice(Math.max(0, index - 180), index);
    const after = context.slice(index + normalizedPath.length, Math.min(context.length, index + normalizedPath.length + 180));
    const window = `${before} ${normalizedPath} ${after}`;
    let score = 1;
    // Current orientation stones commonly identify accepted file authority as
    // "<path> path HEAD". Reward that structural marker much more strongly
    // than a bare mention elsewhere in the same HEAD.
    if (/^\s*path\s+head\b/.test(after)) score += 6;
    if (/accepted\s+authority|accepted\s+path|current\s+accepted/.test(window)) score += 3;
    if (/\bcurrent\b|\bnext\b|\bcomplete\b|\blive-verified\b/.test(window)) score += 1;
    // A current chain HEAD can also mention stale or out-of-scope files while
    // explaining drift. Those references must not tie a real authority entry.
    if (/\bhistorical\b|\bunrelated\b|\bdrift\b|\bstale\b|\bsuperseded\b/.test(window)) score -= 4;
    best = Math.max(best, score);
    from = index + normalizedPath.length;
  }
  return best;
}

function selectTaskRelevantPathHeads(resume, task, maxCount = STRUCTURAL_PATH_HEAD_LIMIT, authorityContextText = "") {
  if (maxCount <= 0) return [];
  const terms = tokenizeTask(task).filter(term => !PATH_MATCH_IGNORED_TERMS.has(term));
  if (!terms.length) return [];
  const chainHeadHash = resume && resume.canonical_head ? resume.canonical_head.hash : null;
  return (resume.path_heads || [])
    .filter(item => item && typeof item.path === "string" && item.stone_hash && item.stone_hash !== chainHeadHash)
    .map(item => {
      // Match normalized path tokens, not arbitrary substrings. This prevents
      // short task words such as "in" from matching the letters inside
      // unrelated path tokens such as "operating" and outranking ROADMAP.
      const normalizedPath = String(item.path).toLowerCase();
      const pathTerms = new Set(normalizedPath.match(/[a-z0-9]{2,}/g) || []);
      const score = terms.reduce((sum, term) => sum + (pathTerms.has(term) ? 1 : 0), 0);
      // The current canonical chain HEAD is the strongest deterministic
      // orientation signal when multiple accepted paths tie on task/path
      // tokens. Distinguish accepted "path HEAD" references from incidental
      // historical/drift mentions in that same orientation stone. Never use
      // timestamps to decide currentness. Lexical path order is only the
      // final stable fallback when current orientation is silent.
      const authorityReferenceScore = scoreAuthorityContextPathReference(item.path, authorityContextText);
      return { item, score, authorityReferenceScore };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) =>
      b.authorityReferenceScore - a.authorityReferenceScore ||
      b.score - a.score ||
      a.item.path.localeCompare(b.item.path)
    )
    .slice(0, maxCount)
    .map(entry => entry.item);
}

async function readMemoryRefRawText(env, refId) {
  if (!refId) return null;
  const refRow = await env.CAIRNSTONE_DB.prepare("SELECT * FROM refs WHERE ref_id = ?").bind(refId).first();
  if (!refRow) return null;
  const raw = await env.CAIRNSTONE_RAW.get(refRow.raw_key);
  if (!raw) return null;
  // Every ref for a stone points at the same immutable raw object. The
  // authority-context tie-breaker must inspect the complete canonical HEAD,
  // not only whichever ~80-line ref happened to match the task terms. A
  // multi-ref orientation can name accepted PATH_HEAD authority in one ref
  // while "next/roadmap" terms match a later ref.
  return raw.text();
}

async function findStructuralAuthorityRow(env, { chain, stoneHash, path, matchExpr }) {
  if (!stoneHash) return null;
  if (matchExpr) {
    try {
      const sql = `SELECT ref_id, stone_hash, chain, path, preview, bm25(refs_fts, ${FTS_BM25_WEIGHTS}) AS score
                   FROM refs_fts WHERE refs_fts MATCH ? AND chain = ? AND stone_hash = ?
                   ORDER BY bm25(refs_fts, ${FTS_BM25_WEIGHTS}) ASC, ref_id ASC LIMIT 1`;
      const matched = await env.CAIRNSTONE_DB.prepare(sql).bind(matchExpr, chain, stoneHash).first();
      if (matched) return { ...matched, path: matched.path || path || null, structural_authority_seed: true };
    } catch {
      // Fall through to a direct structural ref lookup. BM25 is supplemental,
      // never the authority-existence gate.
    }
  }

  const fallbackSql = `SELECT r.ref_id, r.stone_hash, s.chain_hash AS chain, r.path, r.preview, 0 AS score
                       FROM refs r JOIN stones s ON s.hash = r.stone_hash
                       WHERE r.stone_hash = ? AND s.chain_hash = ?
                       ORDER BY r.line_start ASC, r.ref_id ASC LIMIT 1`;
  const fallback = await env.CAIRNSTONE_DB.prepare(fallbackSql).bind(stoneHash, chain).first();
  return fallback ? { ...fallback, path: fallback.path || path || null, structural_authority_seed: true } : null;
}

async function compileMemory(env, chain, task, resume, limits) {
  const terms = tokenizeTask(task);
  const query = terms.join(" ");
  const matchExpr = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  const chainHeadHash = resume.canonical_head.hash;
  const pathHeadSet = new Set((resume.path_heads || []).map(item => `${item.path}|${item.stone_hash}`));
  const currentStateQuery = isCurrentStateQuery(task);

  let rows = [];
  if (query) {
    try {
      const sql = `SELECT ref_id, stone_hash, chain, path, preview, bm25(refs_fts, ${FTS_BM25_WEIGHTS}) AS score
                   FROM refs_fts WHERE refs_fts MATCH ? AND chain = ?
                   ORDER BY bm25(refs_fts, ${FTS_BM25_WEIGHTS}) ASC, stone_hash ASC, ref_id ASC LIMIT ?`;
      rows = (await env.CAIRNSTONE_DB.prepare(sql).bind(matchExpr, chain, Math.max(limits.max_memory_hits * 3, 10)).all()).results || [];
    } catch {
      const like = `%${terms.join("%")}%`;
      const sql = `SELECT r.ref_id, r.stone_hash, s.chain_hash AS chain, r.path, r.preview, 0 AS score
                   FROM refs r JOIN stones s ON s.hash = r.stone_hash
                   WHERE s.chain_hash = ? AND (LOWER(COALESCE(r.keywords,'')) LIKE ? OR LOWER(COALESCE(r.preview,'')) LIKE ?)
                   ORDER BY r.stone_hash ASC, r.ref_id ASC LIMIT ?`;
      rows = (await env.CAIRNSTONE_DB.prepare(sql).bind(chain, like, like, Math.max(limits.max_memory_hits * 3, 10)).all()).results || [];
    }
  }

  // V7.6.5: BM25 may rank supplemental evidence, but it may not decide
  // whether current accepted authority exists in model-visible memory. When
  // memory is enabled, seed the accepted chain HEAD and one deterministic,
  // task-relevant accepted path HEAD directly from their immutable stone refs
  // before merging the bounded BM25 candidate window. Current-state queries
  // fail closed if either required structural seed cannot be read.
  const structuralEnabled = Boolean(query && limits.max_memory_hits > 0 && limits.max_memory_bytes > 0);
  const structuralRows = [];
  if (structuralEnabled) {
    const chainHeadRow = await findStructuralAuthorityRow(env, {
      chain,
      stoneHash: chainHeadHash,
      path: resume.canonical_head.path,
      matchExpr
    });
    let chainHeadContextText = "";
    if (chainHeadRow) {
      structuralRows.push(chainHeadRow);
      chainHeadContextText = await readMemoryRefRawText(env, chainHeadRow.ref_id) || "";
      if (currentStateQuery && !chainHeadContextText) {
        return { ok: false, error: "authority_memory_unavailable", detail: "chain_head_ref_raw_missing", chain, stone_hash: chainHeadHash };
      }
    } else if (currentStateQuery) {
      return { ok: false, error: "authority_memory_unavailable", detail: "chain_head_ref_missing", chain, stone_hash: chainHeadHash };
    }

    const pathSlots = Math.max(0, limits.max_memory_hits - structuralRows.length);
    const relevantPathHeads = selectTaskRelevantPathHeads(
      resume,
      task,
      Math.min(STRUCTURAL_PATH_HEAD_LIMIT, pathSlots),
      chainHeadContextText
    );
    for (const pathHead of relevantPathHeads) {
      const pathHeadRow = await findStructuralAuthorityRow(env, {
        chain,
        stoneHash: pathHead.stone_hash,
        path: pathHead.path,
        matchExpr
      });
      if (pathHeadRow) structuralRows.push(pathHeadRow);
      else if (currentStateQuery) {
        return {
          ok: false,
          error: "authority_memory_unavailable",
          detail: "task_path_head_ref_missing",
          chain,
          path: pathHead.path,
          stone_hash: pathHead.stone_hash
        };
      }
    }
  }

  const mergedRows = [];
  const mergedSeen = new Set();
  for (const row of [...structuralRows, ...rows]) {
    const key = `${row.stone_hash}|${row.ref_id}`;
    if (mergedSeen.has(key)) continue;
    mergedSeen.add(key);
    mergedRows.push(row);
  }

  const classifiedRows = mergedRows.map((row, index) => ({
    ...row,
    authority_class: row.stone_hash === chainHeadHash
      ? "CHAIN_HEAD"
      : pathHeadSet.has(`${row.path}|${row.stone_hash}`)
        ? "PATH_HEAD"
        : "HISTORICAL",
    retrieval_order: index
  }));
  classifiedRows.sort((a, b) =>
    authorityRank(a.authority_class) - authorityRank(b.authority_class) ||
    Number(Boolean(b.structural_authority_seed)) - Number(Boolean(a.structural_authority_seed)) ||
    a.retrieval_order - b.retrieval_order
  );

  const authoritativeMatchedPaths = new Set(
    classifiedRows
      .filter(row => row.authority_class !== "HISTORICAL" && row.path)
      .map(row => row.path)
  );
  let historicalSamePathSuppressed = 0;
  const rankedRows = currentStateQuery
    ? classifiedRows.filter(row => {
        if (row.authority_class === "HISTORICAL" && authoritativeMatchedPaths.has(row.path)) {
          historicalSamePathSuppressed += 1;
          return false;
        }
        return true;
      })
    : classifiedRows;

  const items = [];
  let usedBytes = 0;
  const seen = new Set();
  for (const row of rankedRows) {
    if (items.length >= limits.max_memory_hits) break;
    const key = `${row.stone_hash}|${row.ref_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const refRow = await env.CAIRNSTONE_DB.prepare("SELECT * FROM refs WHERE ref_id = ?").bind(row.ref_id).first();
    if (!refRow) {
      if (currentStateQuery && row.structural_authority_seed) {
        return { ok: false, error: "authority_memory_unavailable", detail: "structural_ref_metadata_missing", ref_id: row.ref_id };
      }
      continue;
    }
    const raw = await env.CAIRNSTONE_RAW.get(refRow.raw_key);
    if (!raw) {
      if (currentStateQuery && row.structural_authority_seed) {
        return { ok: false, error: "authority_memory_unavailable", detail: "structural_ref_raw_missing", ref_id: row.ref_id };
      }
      continue;
    }
    const text = await raw.text();
    const lines = text.split(/\r?\n/);
    const start = Number(refRow.line_start);
    const end = Number(refRow.line_end);
    const windowText = lines.slice(start - 1, end).join("\n");

    const bytes = utf8Bytes(windowText);
    if (usedBytes + bytes > limits.max_memory_bytes && items.length > 0) {
      if (currentStateQuery && row.structural_authority_seed) {
        return {
          ok: false,
          error: "authority_memory_limit_exceeded",
          detail: "structural_authority_floor_exceeds_memory_budget",
          effective_max_memory_bytes: limits.max_memory_bytes
        };
      }
      break;
    }
    usedBytes += bytes;

    items.push({
      authority_class: row.authority_class,
      stone_hash: row.stone_hash,
      path: row.path,
      ref_id: row.ref_id,
      line_start: start,
      line_end: end,
      content: windowText,
      freshness: "NOT_CHECKED"
    });
  }

  return {
    ok: true,
    value: {
      query,
      retrieval_policy: {
        authority_first: true,
        ordering: ["CHAIN_HEAD", "PATH_HEAD", "HISTORICAL"],
        current_state_query: currentStateQuery,
        same_path_historical_suppression: currentStateQuery,
        historical_same_path_suppressed: historicalSamePathSuppressed,
        structural_authority_guarantee: {
          enabled: structuralEnabled,
          chain_head_seeded: structuralRows.some(row => row.stone_hash === chainHeadHash),
          task_path_heads_seeded: structuralRows
            .filter(row => row.stone_hash !== chainHeadHash && pathHeadSet.has(`${row.path}|${row.stone_hash}`))
            .map(row => row.path),
          bm25_supplemental_only: structuralEnabled
        }
      },
      items,
      truncated: rankedRows.length > items.length
    }
  };
}

// ---------------------------------------------------------------------------
// Capabilities / policy evidence
// ---------------------------------------------------------------------------

function compileCapabilityEvidence(capabilities, skillsValue) {
  const availableTools = (capabilities.tools || [])
    .filter(tool => tool.available !== false)
    .map(tool => tool.id);
  const availableSet = new Set(availableTools);
  const missing = new Set();
  for (const skill of (skillsValue.accepted_bundle.skills || [])) {
    for (const tool of (skill.requires_tools || [])) {
      if (!availableSet.has(tool)) missing.add(tool);
    }
  }
  return {
    available_tools: availableTools,
    missing_required_tools: [...missing].sort(),
    supports_tool_calls: capabilities.supports_tool_calls !== false
  };
}

// ---------------------------------------------------------------------------
// Size discipline (contract section 10)
// ---------------------------------------------------------------------------

function enforceSizeDiscipline(packageBody, limits, instructionsValue) {
  const effectiveMax = clampNumber(limits.max_package_bytes, DEFAULT_LIMITS.max_package_bytes, 1000, HARD_LIMITS.max_package_bytes);

  const measure = body => utf8Bytes(JSON.stringify(body));
  const items = packageBody.memory.items;

  // V7.6.5: priority-aware size discipline. compileMemory already
  // authority-orders items CHAIN_HEAD -> PATH_HEAD -> HISTORICAL. The
  // protected authority floor below is the first CHAIN_HEAD item and the
  // first PATH_HEAD item actually present -- the guaranteed current-state
  // evidence "authority-first retrieval" promises regardless of corpus size
  // or keyword ranking (V7.0/V7.4.1). Never omit canonical instructions.
  // Trim order: surplus/HISTORICAL memory items first, then optional
  // specialized skill bodies (never the core.orient boot skill), and only
  // then -- as a last resort -- the protected floor itself. If even the
  // structural package plus the protected floor cannot fit, this fails
  // closed via the exceeded flag rather than silently shipping a package
  // with degraded/missing current-authority evidence.
  let protectedChainHead = null;
  let protectedPathHead = null;
  for (const item of items) {
    if (!protectedChainHead && item.authority_class === "CHAIN_HEAD") protectedChainHead = item;
    if (!protectedPathHead && item.authority_class === "PATH_HEAD") protectedPathHead = item;
  }
  const isProtected = item => item === protectedChainHead || item === protectedPathHead;

  let packageBytes = measure(packageBody);
  let truncated = false;

  // Step 1: trim non-protected memory items (surplus PATH_HEAD + all
  // HISTORICAL) from lowest priority first, skipping protected floor entries.
  while (packageBytes > effectiveMax) {
    let removeAt = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (!isProtected(items[i])) { removeAt = i; break; }
    }
    if (removeAt === -1) break;
    items.splice(removeAt, 1);
    packageBody.memory.truncated = true;
    truncated = true;
    packageBytes = measure(packageBody);
  }

  // Step 2: if still over budget, trim optional specialized skill bodies
  // (never the boot skill core.orient, never canonical instructions),
  // before ever touching the protected authority floor.
  const skillsList = packageBody.skills && packageBody.skills.accepted_bundle && Array.isArray(packageBody.skills.accepted_bundle.skills)
    ? packageBody.skills.accepted_bundle.skills
    : null;
  if (skillsList) {
    while (packageBytes > effectiveMax) {
      let removeAt = -1;
      for (let i = skillsList.length - 1; i >= 0; i--) {
        if (skillsList[i].skill_id !== "core.orient") { removeAt = i; break; }
      }
      if (removeAt === -1) break;
      skillsList.splice(removeAt, 1);
      packageBody.skills.truncated = true;
      truncated = true;
      packageBytes = measure(packageBody);
    }
  }

  const skillsBytes = utf8Bytes(JSON.stringify(packageBody.skills.accepted_bundle));
  const memoryBytes = utf8Bytes(JSON.stringify(packageBody.memory.items));
  const instructionsBytes = utf8Bytes(instructionsValue.content);

  const limitsOut = {
    effective_max_package_bytes: effectiveMax,
    package_bytes: packageBytes,
    skills_bytes: skillsBytes,
    memory_bytes: memoryBytes,
    instructions_bytes: instructionsBytes,
    truncated
  };

  // Step 3: fail closed. If the protected authority floor plus the
  // structural package (instructions, authority envelope, coordination,
  // capabilities) still exceeds budget even after every non-authoritative
  // reduction above, report exceeded rather than popping CHAIN_HEAD/PATH_HEAD
  // evidence out of the package.
  return { exceeded: packageBytes > effectiveMax, limits: limitsOut };
}

// ---------------------------------------------------------------------------
// Package identity (contract section 6): stable, ephemeral-field-excluding hash
// ---------------------------------------------------------------------------

export function hashablePayload(packageBody) {
  const payload = {
    schema: packageBody.schema,
    actor_id: packageBody.actor.actor_id,
    task: packageBody.request.task,
    chain: packageBody.request.chain,
    chain_head: packageBody.authority.chain_head,
    path_heads: [...packageBody.authority.path_heads].sort((a, b) => a.path.localeCompare(b.path)),
    instructions_identity: {
      path: packageBody.instructions.path,
      stone_hash: packageBody.instructions.stone_hash,
      commit_sha: packageBody.instructions.commit_sha,
      content_identity: packageBody.instructions.content_identity,
      transmitted_content_identity: packageBody.instructions.transmitted_content_identity,
      selection: packageBody.instructions.selection,
      truncated: packageBody.instructions.truncated,
      ...(packageBody.instructions.authority_chain ? { authority_chain: packageBody.instructions.authority_chain } : {})
    },
    inbox_snapshot: packageBody.coordination.items
      .map(item => ({ message_id: item.message_id, stone_hash: item.stone_hash, status: item.status }))
      .sort((a, b) => a.message_id.localeCompare(b.message_id)),
    skills_manifest_head: packageBody.skills.manifest_head,
    selected_skills: packageBody.skills.accepted_bundle.skills
      .map(skill => ({
        skill_id: skill.skill_id,
        skill_version: skill.skill_version,
        stone_hash: skill.stone_hash,
        commit_sha: skill.commit_sha,
        content_identity: skill.content_identity
      }))
      .sort((a, b) => a.skill_id.localeCompare(b.skill_id)),
    memory_retrieval_policy: packageBody.memory.retrieval_policy || null,
    memory_evidence: packageBody.memory.items
      .map(item => ({
        authority_class: item.authority_class,
        stone_hash: item.stone_hash,
        ref_id: item.ref_id,
        path: item.path
      })),
    capability_metadata: {
      available_tools: [...packageBody.capabilities.available_tools].sort(),
      missing_required_tools: [...packageBody.capabilities.missing_required_tools].sort()
    },
    effective_limits: packageBody.limits,
    policy: packageBody.policy
  };

  // V7.6.1 sparse packages bind package identity to the COMPLETE accepted
  // authority set through the cryptographic manifest/root, even though only
  // represented path-head metadata is transmitted. Legacy packages omit this
  // field entirely to preserve their established package_id semantics.
  if (packageBody.authority && packageBody.authority.sparse) {
    payload.authority_sparse = packageBody.authority.sparse;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function scanForForbiddenSecrets(body) {
  const stack = [body];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "string" && value.length >= 8 && SECRET_KEY_PATTERNS.some(pattern => pattern.test(key))) {
        return { ok: false, error: "forbidden_credential_in_request", field: key };
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return { ok: true };
}

function requiredActorId(value, name) {
  const text = requiredText(value, name, 240);
  if (!ACTOR_ID_RE.test(text)) throw new Error(`invalid_actor_id`);
  return text;
}

function requiredText(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_${name}`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`invalid_${name}`);
  return text;
}

function mapValidationError(error) {
  const message = String(error && error.message ? error.message : error);
  if (message.includes("invalid_actor_id")) return "invalid_actor_id";
  if (message.includes("invalid_task")) return "invalid_task";
  if (message.includes("invalid_chain")) return "chain_not_found";
  if (message.includes("invalid_bootstrap_mode")) return "invalid_bootstrap_mode";
  return message;
}

function normalizeBootstrapMode(value) {
  if (value === undefined || value === null || value === "") return "legacy_full";
  if (typeof value !== "string" || !BOOTSTRAP_MODES.has(value.trim())) throw new Error("invalid_bootstrap_mode");
  return value.trim();
}

function normalizeCapabilities(value) {
  if (!value || typeof value !== "object") return { tools: [], supports_tool_calls: true };
  const tools = Array.isArray(value.tools)
    ? value.tools
        .filter(tool => tool && typeof tool === "object" && typeof tool.id === "string")
        .map(tool => ({
          id: tool.id,
          available: tool.available !== false,
          class: TOOL_CLASSES.has(tool.class) ? tool.class : "unknown"
        }))
    : [];
  return {
    tools,
    supports_tool_calls: value.supports_tool_calls !== false,
    max_context_tokens: Number.isFinite(Number(value.max_context_tokens)) ? Number(value.max_context_tokens) : null
  };
}

function resolveLimits(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    max_skills: clampNumber(source.max_skills, DEFAULT_LIMITS.max_skills, 1, HARD_LIMITS.max_skills),
    max_memory_hits: clampNumber(source.max_memory_hits, DEFAULT_LIMITS.max_memory_hits, 0, HARD_LIMITS.max_memory_hits),
    max_memory_bytes: clampNumber(source.max_memory_bytes, DEFAULT_LIMITS.max_memory_bytes, 0, HARD_LIMITS.max_memory_bytes),
    max_inbox_items: clampNumber(source.max_inbox_items, DEFAULT_LIMITS.max_inbox_items, 0, HARD_LIMITS.max_inbox_items),
    max_package_bytes: clampNumber(source.max_package_bytes, DEFAULT_LIMITS.max_package_bytes, 1000, HARD_LIMITS.max_package_bytes)
  };
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value)).length;
}

export async function sha256Text(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
