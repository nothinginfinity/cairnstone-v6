export const DECISION_SCHEMA = "cairnstone-decision-v1";
export const CANDIDATE_SCHEMA = "cairnstone-capability-candidate-v1";
export const DECISION_RECEIPT_SCHEMA = "cairnstone-decision-receipt-v1";

export const DECISION_KINDS = Object.freeze([
  "tool_route",
  "snippet_rank",
  "retain",
  "expand",
  "model_route",
  "executor_route",
  "escalate",
  "next_action"
]);

export const SCORER_SOURCES = Object.freeze([
  "deterministic",
  "heuristic",
  "workers_ai",
  "jev",
  "byok_small_model"
]);

export const POLICY_OUTCOMES = Object.freeze([
  "selected",
  "deterministic_winner",
  "ambiguous_no_winner",
  "invented_candidate_rejected",
  "candidate_set_mismatch",
  "kind_unsupported",
  "empty_candidate_set",
  "skipped_scorer"
]);

const KIND_SET = new Set(DECISION_KINDS);
const SOURCE_SET = new Set(SCORER_SOURCES);

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export async function digestCandidateSet(candidates = []) {
  const payload = stableStringify(
    (Array.isArray(candidates) ? candidates : []).map((c) => ({
      id: c.id || c.candidate_id || null,
      kind: c.kind || null,
      capability: c.capability || null,
      tool: c.tool || c.tool_name || null
    }))
  );
  const bytes = new TextEncoder().encode(payload);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export function normalizeCandidate(raw = {}) {
  const id = raw.id || raw.candidate_id;
  if (!id || typeof id !== "string") {
    throw Object.assign(new Error("candidate_id_required"), { code: "candidate_id_required" });
  }
  return {
    schema: CANDIDATE_SCHEMA,
    id,
    kind: raw.kind || null,
    capability: raw.capability || null,
    tool: raw.tool || raw.tool_name || null,
    title: raw.title || raw.name || id,
    risk_class: raw.risk_class || null,
    authorization: raw.authorization || null,
    eligible: raw.eligible !== false
  };
}

function candidateIndex(candidates) {
  const map = new Map();
  for (const raw of candidates) {
    const c = normalizeCandidate(raw);
    map.set(c.id, c);
  }
  return map;
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    execution_authority: false,
    invented_candidate_executable: false,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };
}

export async function decide({
  kind,
  task = "",
  candidates = [],
  selected_id = null,
  scorer_source = "deterministic",
  scores = null,
  confidence = null,
  candidate_set_digest = null,
  skip_scorer_if_unique = true
} = {}) {
  if (!KIND_SET.has(kind)) {
    return {
      schema: DECISION_SCHEMA,
      ok: false,
      kind: kind || null,
      policy_outcome: "kind_unsupported",
      selected: null,
      ranked: [],
      receipt: {
        schema: DECISION_RECEIPT_SCHEMA,
        scorer_source: SOURCE_SET.has(scorer_source) ? scorer_source : "deterministic",
        candidate_set_digest: null,
        policy_outcome: "kind_unsupported"
      },
      ...authorityClosedFields()
    };
  }

  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.eligible !== false) : [];
  const digest = await digestCandidateSet(list);

  if (candidate_set_digest && candidate_set_digest !== digest) {
    return {
      schema: DECISION_SCHEMA,
      ok: false,
      kind,
      policy_outcome: "candidate_set_mismatch",
      selected: null,
      ranked: [],
      receipt: {
        schema: DECISION_RECEIPT_SCHEMA,
        scorer_source: SOURCE_SET.has(scorer_source) ? scorer_source : "deterministic",
        candidate_set_digest: digest,
        requested_digest: candidate_set_digest,
        policy_outcome: "candidate_set_mismatch"
      },
      ...authorityClosedFields()
    };
  }

  if (list.length === 0) {
    return {
      schema: DECISION_SCHEMA,
      ok: false,
      kind,
      task,
      policy_outcome: "empty_candidate_set",
      selected: null,
      ranked: [],
      receipt: {
        schema: DECISION_RECEIPT_SCHEMA,
        scorer_source: "deterministic",
        candidate_set_digest: digest,
        policy_outcome: "empty_candidate_set"
      },
      ...authorityClosedFields()
    };
  }

  const byId = candidateIndex(list);
  if (selected_id && !byId.has(selected_id)) {
    return {
      schema: DECISION_SCHEMA,
      ok: false,
      kind,
      task,
      policy_outcome: "invented_candidate_rejected",
      selected: null,
      ranked: [...byId.values()],
      receipt: {
        schema: DECISION_RECEIPT_SCHEMA,
        scorer_source: SOURCE_SET.has(scorer_source) ? scorer_source : "deterministic",
        candidate_set_digest: digest,
        invented_id: selected_id,
        policy_outcome: "invented_candidate_rejected"
      },
      ...authorityClosedFields()
    };
  }

  if (list.length === 1 && skip_scorer_if_unique) {
    const winner = byId.get(list[0].id || list[0].candidate_id);
    return {
      schema: DECISION_SCHEMA,
      ok: true,
      kind,
      task,
      policy_outcome: "deterministic_winner",
      selected: winner,
      ranked: [winner],
      receipt: {
        schema: DECISION_RECEIPT_SCHEMA,
        scorer_source: "deterministic",
        candidate_set_digest: digest,
        selected_id: winner.id,
        policy_outcome: "skipped_scorer"
      },
      ...authorityClosedFields()
    };
  }

  if (selected_id) {
    const winner = byId.get(selected_id);
    const ranked = [...byId.values()].sort((a, b) => {
      if (a.id === selected_id) return -1;
      if (b.id === selected_id) return 1;
      return a.id.localeCompare(b.id);
    });
    return {
      schema: DECISION_SCHEMA,
      ok: true,
      kind,
      task,
      policy_outcome: "selected",
      selected: winner,
      ranked,
      scores: scores || undefined,
      confidence: confidence == null ? undefined : confidence,
      receipt: {
        schema: DECISION_RECEIPT_SCHEMA,
        scorer_source: SOURCE_SET.has(scorer_source) ? scorer_source : "deterministic",
        candidate_set_digest: digest,
        selected_id: winner.id,
        scores: scores || undefined,
        confidence: confidence == null ? undefined : confidence,
        policy_outcome: "selected"
      },
      ...authorityClosedFields()
    };
  }

  return {
    schema: DECISION_SCHEMA,
    ok: false,
    kind,
    task,
    policy_outcome: "ambiguous_no_winner",
    selected: null,
    ranked: [...byId.values()],
    receipt: {
      schema: DECISION_RECEIPT_SCHEMA,
      scorer_source: SOURCE_SET.has(scorer_source) ? scorer_source : "deterministic",
      candidate_set_digest: digest,
      policy_outcome: "ambiguous_no_winner"
    },
    ...authorityClosedFields()
  };
}
