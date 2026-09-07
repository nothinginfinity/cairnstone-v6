// Compact-result contract for CairnStone subagents (first bounded slice).
//
// Schema: cairnstone-subagent-result-v1
//
// Purpose: wrap an existing V7.2/V7.4 cairnstone_delegate success/failure into a
// parent-friendly envelope so outer LLMs keep answer + citations instead of the
// fuller cairnstone-delegation-result-v1 evidence dump. This slice does NOT add
// a multi-turn brokered tool loop, does NOT mutate chain/path HEAD, and grants
// zero execution/mutation authority.
//
// Parent consumption rule:
//   default keep: answer + citations (+ identities/diagnostics as needed)
//   expand only via expand_hints (opt-in cairnstone_expand / stone_v2)

import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const SUBAGENT_RESULT_SCHEMA = "cairnstone-subagent-result-v1";

/** Hard UTF-8 byte ceiling for `answer` (~4 KiB). Fail closed if exceeded. */
export const SUBAGENT_RESULT_MAX_ANSWER_BYTES = 4096;

/**
 * Soft token estimate ceiling paired with the byte cap (~1200 tokens at ~4
 * bytes/token). Diagnostics report both; enforcement is byte-based.
 */
export const SUBAGENT_RESULT_MAX_ANSWER_TOKENS_ESTIMATE = 1200;

/** Clamp generation when compact_result is requested so models aim under the cap. */
export const SUBAGENT_RESULT_MAX_OUTPUT_TOKENS = 1200;

export const SUBAGENT_RESULT_AUTHORITIES = Object.freeze([
  "CHAIN_HEAD",
  "PATH_HEAD",
  "HISTORICAL"
]);

const PACKAGE_ID_RE = /^sha256:[0-9a-f]{64}$/i;
const STONE_HASH_RE = /^[0-9a-f]{64}$/i;
const MAX_CITATIONS = 20;
const MAX_EXPAND_HINTS = 12;
const MAX_TOOL_RECEIPTS = 20;
const MAX_NOTE_CHARS = 240;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

export function estimateAnswerTokens(text) {
  const bytes = utf8ByteLength(text);
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

function normalizeAuthority(value) {
  if (typeof value !== "string") return "HISTORICAL";
  const upper = value.trim().toUpperCase();
  if (SUBAGENT_RESULT_AUTHORITIES.includes(upper)) return upper;
  return "HISTORICAL";
}

function compactNote(value) {
  if (!isNonEmptyString(value)) return undefined;
  const note = value.trim().slice(0, MAX_NOTE_CHARS);
  return note || undefined;
}

/**
 * Deterministic content identity for the delegated task inputs. Never treated
 * as accepted-state authority; correspondence/transport stays separate.
 */
export async function buildTaskFingerprint({ actor_id, chain, task, profile_id = null } = {}) {
  const payload = {
    actor_id: typeof actor_id === "string" ? actor_id.trim() : "",
    chain: typeof chain === "string" ? chain.trim() : "",
    task: typeof task === "string" ? task.trim() : "",
    profile_id: typeof profile_id === "string" && profile_id.trim() ? profile_id.trim() : null
  };
  return "sha256:" + await sha256Text(stableJson(payload));
}

function citationFromMemoryItem(item) {
  if (!item || !isNonEmptyString(item.stone_hash) || !STONE_HASH_RE.test(item.stone_hash)) return null;
  const citation = {
    stone_hash: item.stone_hash.toLowerCase(),
    authority: normalizeAuthority(item.authority_class || item.authority)
  };
  if (isNonEmptyString(item.path)) citation.path = item.path.trim();
  const note = compactNote(item.ref_id ? `ref=${item.ref_id}` : item.freshness);
  if (note) citation.note = note;
  return citation;
}

function citationFromPathHead(item) {
  if (!item || !isNonEmptyString(item.stone_hash) || !STONE_HASH_RE.test(item.stone_hash)) return null;
  const citation = {
    stone_hash: item.stone_hash.toLowerCase(),
    authority: "PATH_HEAD"
  };
  if (isNonEmptyString(item.path)) citation.path = item.path.trim();
  return citation;
}

function citationFromSkill(item) {
  if (!item || !isNonEmptyString(item.stone_hash) || !STONE_HASH_RE.test(item.stone_hash)) return null;
  const citation = {
    stone_hash: item.stone_hash.toLowerCase(),
    authority: "PATH_HEAD"
  };
  if (isNonEmptyString(item.skill_id)) citation.path = `skills/${item.skill_id}`;
  const note = compactNote(item.skill_version ? `skill_version=${item.skill_version}` : undefined);
  if (note) citation.note = note;
  return citation;
}

function citationFromAnswerMention(hashPrefix, evidenceHashes) {
  const matches = evidenceHashes.filter(hash => hash.startsWith(hashPrefix));
  if (matches.length !== 1) return null;
  return {
    stone_hash: matches[0],
    authority: "HISTORICAL",
    note: "mentioned_in_answer"
  };
}

/**
 * Build citations from delegate evidence. Prefer memory refs, then path heads,
 * then selected skills. Optionally resolve `[stone:<hash>]` mentions in answer.
 */
export function buildCitationsFromDelegationEvidence(evidence, answer = "") {
  const citations = [];
  const seen = new Set();
  const push = citation => {
    if (!citation || seen.has(citation.stone_hash)) return;
    seen.add(citation.stone_hash);
    citations.push(citation);
  };

  const memory = Array.isArray(evidence?.memory_refs) ? evidence.memory_refs : [];
  for (const item of memory) {
    push(citationFromMemoryItem(item));
    if (citations.length >= MAX_CITATIONS) return citations;
  }

  const pathHeads = Array.isArray(evidence?.path_heads) ? evidence.path_heads : [];
  for (const item of pathHeads) {
    push(citationFromPathHead(item));
    if (citations.length >= MAX_CITATIONS) return citations;
  }

  const chainHeadHash = isNonEmptyString(evidence?.chain_head)
    ? evidence.chain_head
    : (isObject(evidence?.chain_head) && isNonEmptyString(evidence.chain_head.stone_hash)
      ? evidence.chain_head.stone_hash
      : null);
  if (chainHeadHash && STONE_HASH_RE.test(chainHeadHash)) {
    const citation = {
      stone_hash: chainHeadHash.toLowerCase(),
      authority: "CHAIN_HEAD"
    };
    if (isObject(evidence?.chain_head) && isNonEmptyString(evidence.chain_head.path)) {
      citation.path = evidence.chain_head.path.trim();
    }
    push(citation);
    if (citations.length >= MAX_CITATIONS) return citations;
  }

  const skills = Array.isArray(evidence?.selected_skills) ? evidence.selected_skills : [];
  for (const item of skills) {
    push(citationFromSkill(item));
    if (citations.length >= MAX_CITATIONS) return citations;
  }

  const evidenceHashes = [...seen];
  const pattern = /\[stone:([0-9a-f]{12,64})(?:\s+ref:([^\]\s]+))?\]/gi;
  for (const match of String(answer || "").matchAll(pattern)) {
    const resolved = citationFromAnswerMention(match[1].toLowerCase(), evidenceHashes);
    if (resolved) push(resolved);
    if (citations.length >= MAX_CITATIONS) break;
  }

  return citations;
}

export function buildExpandHintsFromDelegationEvidence(evidence) {
  const hints = [];
  const seen = new Set();
  const memory = Array.isArray(evidence?.memory_refs) ? evidence.memory_refs : [];
  for (const item of memory) {
    if (!item || !isNonEmptyString(item.stone_hash) || !STONE_HASH_RE.test(item.stone_hash)) continue;
    const key = `${item.stone_hash}:${item.ref_id || ""}:${item.line_start || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = { stone_hash: item.stone_hash.toLowerCase() };
    if (isNonEmptyString(item.ref_id)) hint.ref_id = item.ref_id.trim();
    if (Number.isInteger(item.line_start)) hint.line_start = item.line_start;
    if (Number.isInteger(item.line_end) && Number.isInteger(item.line_start)) {
      hint.context_lines = Math.max(0, item.line_end - item.line_start);
    }
    hints.push(hint);
    if (hints.length >= MAX_EXPAND_HINTS) break;
  }
  return hints;
}

export function buildToolReceiptsFromDelegation(delegation) {
  const receipts = [];
  const fromGrounding = Array.isArray(delegation?.grounding?.read_receipts)
    ? delegation.grounding.read_receipts
    : [];
  for (const item of fromGrounding) {
    if (!item || !isNonEmptyString(item.tool_id)) continue;
    const receipt = {
      tool_id: item.tool_id.trim(),
      read_only: true
    };
    if (isNonEmptyString(item.stone_hash) && STONE_HASH_RE.test(item.stone_hash)) {
      receipt.receipt_stone_hash = item.stone_hash.toLowerCase();
    }
    if (isNonEmptyString(item.chain)) receipt.chain = item.chain.trim();
    receipts.push(receipt);
    if (receipts.length >= MAX_TOOL_RECEIPTS) break;
  }
  return receipts;
}

function readOnlyPolicy(toolsExecuted = 0) {
  return {
    delegation_mode: "read_only",
    tools_exposed_to_model: 0,
    tools_executed: toolsExecuted,
    execution_authority: false,
    mutation_authority: false,
    accepted_state_mutation: false,
    parent_should_keep: ["answer", "citations"],
    expand_via: "expand_hints"
  };
}

function baseIdentities({ actor_id, chain, package_id, profile_id, task_fingerprint, request_ir_id, route }) {
  return {
    schema: SUBAGENT_RESULT_SCHEMA,
    actor_id,
    chain,
    package_id: package_id || null,
    profile_id: profile_id || null,
    task_fingerprint,
    ...(request_ir_id ? { request_ir_id } : {}),
    ...(route ? { route } : {})
  };
}

/**
 * Validate a candidate cairnstone-subagent-result-v1 object (shape only).
 * Fail-closed on oversized answers even if ok:true.
 */
export function validateSubagentResult(result) {
  const errors = [];
  if (!isObject(result)) return { ok: false, errors: ["result must be an object"] };
  if (result.schema !== SUBAGENT_RESULT_SCHEMA) {
    errors.push(`schema must equal '${SUBAGENT_RESULT_SCHEMA}'`);
  }
  if (typeof result.ok !== "boolean") errors.push("ok must be a boolean");
  if (!isNonEmptyString(result.actor_id)) errors.push("actor_id must be a non-empty string");
  if (!isNonEmptyString(result.chain)) errors.push("chain must be a non-empty string");
  if (!isNonEmptyString(result.task_fingerprint) || !PACKAGE_ID_RE.test(result.task_fingerprint)) {
    errors.push("task_fingerprint must be sha256:<64-hex>");
  }
  if (result.package_id != null && (!isNonEmptyString(result.package_id) || !PACKAGE_ID_RE.test(result.package_id))) {
    errors.push("package_id when present must be sha256:<64-hex>");
  }
  if (result.profile_id != null && result.profile_id !== null && !isNonEmptyString(result.profile_id)) {
    errors.push("profile_id when present must be a string or null");
  }

  if (result.ok === true) {
    if (typeof result.answer !== "string") errors.push("answer must be a string when ok:true");
    else {
      const bytes = utf8ByteLength(result.answer);
      if (bytes > SUBAGENT_RESULT_MAX_ANSWER_BYTES) {
        errors.push(`answer exceeds max ${SUBAGENT_RESULT_MAX_ANSWER_BYTES} UTF-8 bytes (got ${bytes})`);
      }
    }
    if (!Array.isArray(result.citations)) errors.push("citations must be an array when ok:true");
    else {
      for (let i = 0; i < result.citations.length; i += 1) {
        const c = result.citations[i];
        if (!isObject(c)) {
          errors.push(`citations[${i}] must be an object`);
          continue;
        }
        if (!isNonEmptyString(c.stone_hash) || !STONE_HASH_RE.test(c.stone_hash)) {
          errors.push(`citations[${i}].stone_hash must be 64-hex`);
        }
        if (!SUBAGENT_RESULT_AUTHORITIES.includes(c.authority)) {
          errors.push(`citations[${i}].authority must be one of ${SUBAGENT_RESULT_AUTHORITIES.join("|")}`);
        }
      }
    }
  }

  if (result.expand_hints !== undefined) {
    if (!Array.isArray(result.expand_hints)) errors.push("expand_hints must be an array when present");
  }
  if (result.tool_receipts !== undefined) {
    if (!Array.isArray(result.tool_receipts)) errors.push("tool_receipts must be an array when present");
  }
  if (!isObject(result.diagnostics)) errors.push("diagnostics must be an object");
  if (!isObject(result.policy)) errors.push("policy must be an object");
  else {
    if (result.policy.execution_authority !== false) errors.push("policy.execution_authority must be false");
    if (result.policy.mutation_authority !== false) errors.push("policy.mutation_authority must be false");
    if (result.policy.accepted_state_mutation !== false) {
      errors.push("policy.accepted_state_mutation must be false");
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Wrap a cairnstone-delegation-result-v1 (or failure) into cairnstone-subagent-result-v1.
 * Oversized answers fail closed — never truncated into a successful ok:true result.
 */
export async function buildSubagentResultFromDelegation({
  delegation,
  task,
  actor_id,
  chain,
  profile_id = null
} = {}) {
  const effectiveActorId = isNonEmptyString(delegation?.actor_id)
    ? delegation.actor_id
    : (typeof actor_id === "string" ? actor_id.trim() : "");
  const effectiveChain = isNonEmptyString(delegation?.chain)
    ? delegation.chain
    : (typeof chain === "string" ? chain.trim() : "");
  const effectiveProfileId = isNonEmptyString(profile_id)
    ? profile_id.trim()
    : (delegation?.profile?.profile_id || null);
  const taskFingerprint = await buildTaskFingerprint({
    actor_id: effectiveActorId,
    chain: effectiveChain,
    task,
    profile_id: effectiveProfileId
  });

  const toolsExecuted = Number.isFinite(Number(delegation?.policy?.tools_executed))
    ? Number(delegation.policy.tools_executed)
    : (Number.isFinite(Number(delegation?.diagnostics?.tools_executed))
      ? Number(delegation.diagnostics.tools_executed)
      : 0);

  const identities = baseIdentities({
    actor_id: effectiveActorId,
    chain: effectiveChain,
    package_id: delegation?.package_id || null,
    profile_id: effectiveProfileId,
    task_fingerprint: taskFingerprint,
    request_ir_id: delegation?.request_ir_id || null,
    route: delegation?.route || null
  });

  if (!delegation || typeof delegation !== "object") {
    return {
      ok: false,
      ...identities,
      error: "invalid_delegation_result",
      answer: "",
      citations: [],
      expand_hints: [],
      tool_receipts: [],
      diagnostics: {
        answer_bytes: 0,
        answer_tokens_estimate: 0,
        max_answer_bytes: SUBAGENT_RESULT_MAX_ANSWER_BYTES,
        max_answer_tokens_estimate: SUBAGENT_RESULT_MAX_ANSWER_TOKENS_ESTIMATE,
        answer_truncated: false,
        turns: 0,
        input_tokens: null,
        output_tokens: null
      },
      policy: readOnlyPolicy(0)
    };
  }

  if (delegation.ok !== true) {
    return {
      ok: false,
      ...identities,
      error: delegation.error || "delegation_failed",
      ...(delegation.detail !== undefined ? { detail: delegation.detail } : {}),
      answer: "",
      citations: [],
      expand_hints: [],
      tool_receipts: buildToolReceiptsFromDelegation(delegation),
      diagnostics: {
        answer_bytes: 0,
        answer_tokens_estimate: 0,
        max_answer_bytes: SUBAGENT_RESULT_MAX_ANSWER_BYTES,
        max_answer_tokens_estimate: SUBAGENT_RESULT_MAX_ANSWER_TOKENS_ESTIMATE,
        answer_truncated: false,
        turns: 0,
        input_tokens: delegation.usage?.input_tokens ?? null,
        output_tokens: delegation.usage?.output_tokens ?? null,
        ...(isObject(delegation.diagnostics) ? { delegation: delegation.diagnostics } : {})
      },
      policy: {
        ...readOnlyPolicy(toolsExecuted),
        ...(isObject(delegation.policy)
          ? {
              tools_executed: toolsExecuted,
              execution_authority: false,
              mutation_authority: false,
              accepted_state_mutation: false
            }
          : {})
      }
    };
  }

  const answer = typeof delegation.output?.text === "string" ? delegation.output.text : "";
  const answerBytes = utf8ByteLength(answer);
  const answerTokensEstimate = estimateAnswerTokens(answer);
  const citations = buildCitationsFromDelegationEvidence(delegation.evidence, answer);
  const expandHints = buildExpandHintsFromDelegationEvidence(delegation.evidence);
  const toolReceipts = buildToolReceiptsFromDelegation(delegation);

  const diagnostics = {
    answer_bytes: answerBytes,
    answer_tokens_estimate: answerTokensEstimate,
    max_answer_bytes: SUBAGENT_RESULT_MAX_ANSWER_BYTES,
    max_answer_tokens_estimate: SUBAGENT_RESULT_MAX_ANSWER_TOKENS_ESTIMATE,
    answer_truncated: false,
    turns: 1,
    input_tokens: delegation.usage?.input_tokens ?? null,
    output_tokens: delegation.usage?.output_tokens ?? null,
    finish_reason: delegation.output?.finish_reason || null,
    citations_count: citations.length,
    expand_hints_count: expandHints.length,
    tool_receipts_count: toolReceipts.length,
    ...(isObject(delegation.diagnostics) ? {
      package_bytes: delegation.diagnostics.package_bytes ?? null,
      package_truncated: delegation.diagnostics.package_truncated === true,
      memory_truncated: delegation.diagnostics.memory_truncated === true,
      external_model_calls: delegation.diagnostics.external_model_calls ?? null,
      tools_executed: delegation.diagnostics.tools_executed ?? toolsExecuted,
      context_package_returned: false,
      server_carried_context_package: true
    } : {
      context_package_returned: false,
      server_carried_context_package: true,
      tools_executed: toolsExecuted
    })
  };

  if (answerBytes > SUBAGENT_RESULT_MAX_ANSWER_BYTES) {
    return {
      ok: false,
      ...identities,
      error: "subagent_answer_exceeds_cap",
      detail: {
        answer_bytes: answerBytes,
        max_answer_bytes: SUBAGENT_RESULT_MAX_ANSWER_BYTES,
        answer_tokens_estimate: answerTokensEstimate,
        max_answer_tokens_estimate: SUBAGENT_RESULT_MAX_ANSWER_TOKENS_ESTIMATE
      },
      answer: "",
      citations,
      expand_hints: expandHints,
      tool_receipts: toolReceipts,
      diagnostics: { ...diagnostics, answer_truncated: true, fail_closed: true },
      policy: readOnlyPolicy(toolsExecuted)
    };
  }

  return {
    ok: true,
    ...identities,
    answer,
    citations,
    expand_hints: expandHints,
    tool_receipts: toolReceipts,
    diagnostics,
    policy: readOnlyPolicy(toolsExecuted)
  };
}
