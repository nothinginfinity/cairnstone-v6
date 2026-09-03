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
export const DEFAULT_SKILLS_CHAIN = "cairnstone-v6-skills";

const TASK_MAX_LENGTH = 4000;
const ACTOR_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const TOOL_CLASSES = new Set(["read", "mutation", "execution", "unknown"]);
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_SKILLS_HARD = 10;
const INSTRUCTIONS_BYTE_CAP = 20000;
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
        description: "V7.6.1 bootstrap transmission mode. Defaults to legacy_full. optimized_sparse preserves the complete accepted path-head authority through a deterministic cryptographic manifest/root while transmitting only task-relevant represented path HEAD metadata."
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
    const instructions = await loadCanonicalInstructions(env, instructionsSnapshot1.resume, DEFAULT_INSTRUCTIONS_PATH);
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
      includeCanonicalInstructionsPath: instructionsChain === chain
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

function selectSparsePathHeads(resume, task, memory, includeCanonicalInstructionsPath) {
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

async function compileAuthorityEnvelope({ resume, chain, task, memory, mode, includeCanonicalInstructionsPath }) {
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
  const represented = selectSparsePathHeads(resume, task, memory, includeCanonicalInstructionsPath);

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

  const truncated = fetched.content.length > INSTRUCTIONS_BYTE_CAP;
  const content = truncated ? fetched.content.slice(0, INSTRUCTIONS_BYTE_CAP) : fetched.content;

  return {
    ok: true,
    value: {
      path,
      stone_hash: entry.stone_hash,
      repo: entry.repo,
      commit_sha: entry.commit_sha,
      content_identity: fetched.content_identity,
      content,
      truncated
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

async function compileMemory(env, chain, task, resume, limits) {
  const query = tokenizeTask(task).join(" ");
  const chainHeadHash = resume.canonical_head.hash;
  const pathHeadSet = new Set((resume.path_heads || []).map(item => `${item.path}|${item.stone_hash}`));
  const currentStateQuery = isCurrentStateQuery(task);

  let rows = [];
  if (query) {
    const terms = tokenizeTask(task);
    const matchExpr = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
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

  const classifiedRows = rows.map((row, index) => ({
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
    if (!refRow) continue;
    const raw = await env.CAIRNSTONE_RAW.get(refRow.raw_key);
    if (!raw) continue;
    const text = await raw.text();
    const lines = text.split(/\r?\n/);
    const start = Number(refRow.line_start);
    const end = Number(refRow.line_end);
    const windowText = lines.slice(start - 1, end).join("\n");

    const bytes = utf8Bytes(windowText);
    if (usedBytes + bytes > limits.max_memory_bytes && items.length > 0) break;
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
        historical_same_path_suppressed: historicalSamePathSuppressed
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
  let packageBytes = measure(packageBody);
  let truncated = false;

  // Never omit canonical instructions -- trim memory (not authority-critical) first.
  while (packageBytes > effectiveMax && packageBody.memory.items.length > 0) {
    packageBody.memory.items.pop();
    packageBody.memory.truncated = true;
    truncated = true;
    packageBytes = measure(packageBody);
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
