export const RETENTION_SCHEMA = "cairnstone-context-retention-v1";
export const REHYDRATION_SCHEMA = "cairnstone-rehydration-v1";

export const RETENTION_ACTIONS = Object.freeze({
  PIN: "PIN",
  KEEP_FULL: "KEEP_FULL",
  KEEP_REF: "KEEP_REF",
  DROP_FROM_ACTIVE_CONTEXT: "DROP_FROM_ACTIVE_CONTEXT"
});

export const CONTEXT_RETENTION_PREVIEW_TOOL_DEFINITION = Object.freeze({
  name: "cairnstone_context_retention_preview",
  description: "V7.7.10g.1: read-only retention preview over direct candidates and/or compact ledger items. Never writes storage or moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      candidates: { type: "array", items: { type: "object" } },
      items: { type: "array", items: { type: "object" } }
    },
    additionalProperties: false
  }
});

export const CONTEXT_RETENTION_REHYDRATE_TOOL_DEFINITION = Object.freeze({
  name: "cairnstone_context_retention_rehydrate",
  description: "V7.7.10g.3: read-only exact lazy rehydration router over refs and/or candidates. Returns deterministic routes only and never writes storage or moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      refs: { type: "array", items: { type: "string" } },
      candidates: { type: "array", items: { type: "object" } }
    },
    additionalProperties: false
  }
});

export const PROTECTED_CLASSES = Object.freeze([
  "chain_head",
  "path_head",
  "stone_identity",
  "git_provenance",
  "skill_manifest",
  "authorization_guard",
  "access_grant",
  "execution_receipt",
  "work_receipt",
  "code_session_checkpoint",
  "scope_snapshot",
  "grounded_response_skeleton",
  "credential_bearer",
  "secret"
]);

export const CANDIDATE_CLASSES = Object.freeze([
  "tool_call",
  "tool_result",
  "repo_read",
  "search_expand",
  "web_evidence",
  "hydrated_tool_schema",
  "intermediate_analysis",
  "diagnostic_output",
  "recoverable_ops_context",
  "user_intent",
  "current_task",
  "unresolved_blocker",
  "recent_turn"
]);

const PINNED_CONTEXT_CLASSES = new Set([
  "user_intent",
  "recent_turn"
]);

const KEEP_REF_ELIGIBLE_CLASSES = new Set([
  "repo_read",
  "search_expand",
  "web_evidence",
  "hydrated_tool_schema",
  "recoverable_ops_context"
]);

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    storage_deleted: false
  };
}

function candidateClassOf(candidate = {}) {
  return candidate.class || candidate.candidate_class || null;
}

function hasImmutableRef(candidate = {}) {
  return Boolean(
    candidate.immutable_ref
    || candidate.object_ref
    || candidate.content_ref
    || candidate.repo_ref
    || candidate.rehydration_ref
    || candidate.stone_ref
  );
}

function hasRehydrationIdentity(candidate = {}) {
  return Boolean(
    candidate.object_ref
    || candidate.content_ref
    || candidate.repo_ref
    || candidate.rehydration_ref
    || candidate.stone_ref
  );
}

function newerImmutableRefOf(candidate = {}, flags = {}) {
  return candidate.newer_immutable_ref || flags.newer_immutable_ref || null;
}

function firstNonEmptyString(values = []) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstFiniteNumber(values = []) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function asBoolean(value) {
  return value === true;
}

function ledgerClassOf(item = {}, currentTask = false, currentBlocker = false, repoRef = null) {
  return candidateClassOf(item)
    || (currentBlocker ? "unresolved_blocker" : null)
    || (currentTask ? "current_task" : null)
    || (repoRef ? "repo_read" : null)
    || null;
}

function previewTelemetry(decisions = [], extras = {}) {
  return {
    before_count: decisions.length,
    pin_count: decisions.filter((decision) => decision.action === RETENTION_ACTIONS.PIN).length,
    drop_count: decisions.filter((decision) => decision.action === RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT).length,
    ...extras
  };
}

function previewResult(decisions = [], telemetryExtras = {}) {
  return {
    ok: true,
    schema: RETENTION_SCHEMA,
    decisions,
    telemetry: previewTelemetry(decisions, telemetryExtras),
    ...authorityClosedFields()
  };
}

function isRedundantSuccessfulRead(candidate = {}, artifactClass, flags = {}) {
  const newerImmutableRef = newerImmutableRefOf(candidate, flags);
  return artifactClass === "repo_read"
    && candidate.success === true
    && (flags.redundant_successful_read === true || flags.redundant === true)
    && Boolean(newerImmutableRef);
}

function firstNonEmptyRefFromCandidate(candidate = {}) {
  const nestedCandidate = candidate?.candidate && typeof candidate.candidate === "object"
    ? candidate.candidate
    : null;
  return firstNonEmptyString([
    candidate.rehydration_ref,
    candidate.repo_ref,
    candidate.object_ref,
    candidate.content_ref,
    candidate.stone_ref,
    candidate.receipt_ref,
    candidate.checkpoint_ref,
    candidate.receipt_id,
    candidate.checkpoint_id,
    candidate.ref,
    nestedCandidate?.rehydration_ref,
    nestedCandidate?.repo_ref,
    nestedCandidate?.object_ref,
    nestedCandidate?.content_ref,
    nestedCandidate?.stone_ref,
    nestedCandidate?.receipt_ref,
    nestedCandidate?.checkpoint_ref,
    nestedCandidate?.receipt_id,
    nestedCandidate?.checkpoint_id,
    nestedCandidate?.ref
  ]);
}

function normalizeRefOrCandidate(refOrCandidate) {
  if (typeof refOrCandidate === "string") return { ref: refOrCandidate.trim(), candidate: null };
  if (!refOrCandidate || typeof refOrCandidate !== "object") return { ref: null, candidate: null };
  return {
    ref: firstNonEmptyRefFromCandidate(refOrCandidate),
    candidate: refOrCandidate
  };
}

function rehydrationResult(result = {}) {
  return {
    schema: REHYDRATION_SCHEMA,
    ...result,
    ...authorityClosedFields()
  };
}

function isExactRepoSnapshotRef(ref) {
  return /^repo:[^/\s]+\/[^@\s]+@[0-9a-f]{40}\/.+$/i.test(ref);
}

function isRepoRef(ref) {
  return /^repo:[^/\s]+\/[^/\s]+(?:@[^/\s]+)?(?:\/.*)?$/i.test(ref);
}

export function classifyCandidate(candidate = {}) {
  const artifactClass = candidateClassOf(candidate);
  const flags = candidate.flags || {};
  const newerImmutableRef = newerImmutableRefOf(candidate, flags);
  const immutableRefPresent = hasImmutableRef(candidate);
  const rehydrationIdentityPresent = hasRehydrationIdentity(candidate);

  if (
    PROTECTED_CLASSES.includes(artifactClass)
    || flags.protected === true
    || flags.secret === true
    || flags.capability_bearer === true
  ) {
    return {
      action: RETENTION_ACTIONS.PIN,
      candidate,
      candidate_class: artifactClass,
      reason: "protected_or_sensitive",
      ...authorityClosedFields()
    };
  }

  if (artifactClass === "unresolved_blocker" || flags.current_blocker === true) {
    return {
      action: RETENTION_ACTIONS.KEEP_FULL,
      candidate,
      candidate_class: artifactClass,
      reason: "current_blocker",
      ...authorityClosedFields()
    };
  }

  if (PINNED_CONTEXT_CLASSES.has(artifactClass)) {
    return {
      action: RETENTION_ACTIONS.PIN,
      candidate,
      candidate_class: artifactClass,
      reason: "pinned_context",
      ...authorityClosedFields()
    };
  }

  if (artifactClass === "current_task") {
    return {
      action: RETENTION_ACTIONS.KEEP_FULL,
      candidate,
      candidate_class: artifactClass,
      reason: "active_task",
      ...authorityClosedFields()
    };
  }

  if (isRedundantSuccessfulRead(candidate, artifactClass, flags)) {
    if (rehydrationIdentityPresent) {
      return {
        action: RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT,
        candidate,
        candidate_class: artifactClass,
        newer_immutable_ref: newerImmutableRef,
        rehydration_ref: newerImmutableRef,
        reason: "redundant_successful_read_newer_ref",
        ...authorityClosedFields()
      };
    }

    return {
      action: RETENTION_ACTIONS.KEEP_FULL,
      candidate,
      candidate_class: artifactClass,
      reason: "missing_rehydration_identity",
      ...authorityClosedFields()
    };
  }

  if (
    flags.rehydratable === true
    && immutableRefPresent
    && rehydrationIdentityPresent
    && KEEP_REF_ELIGIBLE_CLASSES.has(artifactClass)
    && artifactClass !== "current_task"
  ) {
    return {
      action: RETENTION_ACTIONS.KEEP_REF,
      candidate,
      candidate_class: artifactClass,
      reason: "rehydratable_with_immutable_ref",
      ...authorityClosedFields()
    };
  }

  return {
    action: RETENTION_ACTIONS.KEEP_FULL,
    candidate,
    candidate_class: artifactClass,
    reason: "default_keep_full",
    ...authorityClosedFields()
  };
}

export function compileRetentionLedger(items = []) {
  return (Array.isArray(items) ? items : []).map((item = {}) => {
    const currentTask = asBoolean(item.current_task) || asBoolean(item.flags?.current_task);
    const currentBlocker = asBoolean(item.current_blocker) || asBoolean(item.flags?.current_blocker);
    const rehydratable = asBoolean(item.rehydratable) || asBoolean(item.flags?.rehydratable);
    const referencedByActiveTurn = asBoolean(item.referenced_by_active_turn)
      || asBoolean(item.flags?.referenced_by_active_turn);
    const repoRef = firstNonEmptyString([
      item.repo_ref,
      typeof item.object_ref === "string" && item.object_ref.startsWith("repo:") ? item.object_ref : null
    ]);
    const objectRef = firstNonEmptyString([
      item.object_ref,
      item.content_ref,
      item.rehydration_ref,
      item.stone_ref
    ]);
    const bytes = firstFiniteNumber([
      item.bytes,
      item.byte_length,
      item.size_bytes,
      item.estimated_bytes_before
    ]);
    const tokenEstimate = firstFiniteNumber([
      item.token_estimate,
      item.estimated_tokens,
      item.tokens
    ]);

    const row = {
      id: firstNonEmptyString([
        item.id,
        item.turn_id,
        item.message_id,
        item.code_session_id,
        item.conversation_id,
        item.task_run_id,
        item.checkpoint_id,
        item.receipt_id
      ]),
      class: ledgerClassOf(item, currentTask, currentBlocker, repoRef),
      current_task: currentTask,
      current_blocker: currentBlocker,
      rehydratable,
      referenced_by_active_turn: referencedByActiveTurn,
      accepted_state_authority: false,
      flags: {
        current_blocker: currentBlocker,
        rehydratable,
        referenced_by_active_turn: referencedByActiveTurn
      }
    };

    if (bytes !== null) row.bytes = bytes;
    else if (tokenEstimate !== null) row.token_estimate = tokenEstimate;
    if (objectRef) row.object_ref = objectRef;
    if (repoRef) row.repo_ref = repoRef;
    return row;
  });
}

export function previewRetention({ candidates = [] } = {}) {
  const normalizedCandidates = Array.isArray(candidates) ? candidates : [];
  const decisions = normalizedCandidates.map(classifyCandidate);
  const byteValues = normalizedCandidates
    .map(candidate => candidate.bytes)
    .filter(isNonNegativeFiniteNumber);
  return previewResult(
    decisions,
    byteValues.length ? { estimated_bytes_before: byteValues.reduce((sum, value) => sum + value, 0) } : {}
  );
}

export function previewRetentionFromLedger(items = []) {
  return previewRetention({ candidates: compileRetentionLedger(items) });
}

export function previewRetentionFromBody(body = {}) {
  if (!firstNonEmptyString([body.actor_id])) {
    return { ok: false, error: "actor_id_required", ...authorityClosedFields() };
  }
  const directCandidates = Array.isArray(body.candidates) ? body.candidates : [];
  const ledgerCandidates = Array.isArray(body.items) ? compileRetentionLedger(body.items) : [];
  return previewRetention({ candidates: [...directCandidates, ...ledgerCandidates] });
}

export function rehydrateRoute(refOrCandidate) {
  const { ref, candidate } = normalizeRefOrCandidate(refOrCandidate);

  if (typeof ref === "string" && (ref.startsWith("stone:") || /^[0-9a-f]{64}$/i.test(ref))) {
    return rehydrationResult({ ok: true, route: "stone_expand", exact: true, ref });
  }

  if (candidate?.object_ref?.startsWith?.("stone:")) {
    return rehydrationResult({ ok: true, route: "stone_expand", exact: true, ref: candidate.object_ref });
  }

  if (typeof ref === "string" && isExactRepoSnapshotRef(ref)) {
    return rehydrationResult({ ok: true, route: "repo_at_sha", exact: true, snapshot: true, ref });
  }

  if (typeof ref === "string" && isRepoRef(ref)) {
    return rehydrationResult({
      ok: false,
      exact: false,
      error: "mutable_head_ref_refused",
      reason: "would replace snapshot with current mutable state",
      ref
    });
  }

  if (
    typeof ref === "string"
    && (ref.startsWith("receipt:") || ref.startsWith("checkpoint:"))
  ) {
    return rehydrationResult({ ok: true, route: "receipt_or_checkpoint", exact: true, ref });
  }

  if (candidate && (firstNonEmptyString([candidate.receipt_id]) || firstNonEmptyString([candidate.checkpoint_id]))) {
    return rehydrationResult({
      ok: true,
      route: "receipt_or_checkpoint",
      exact: true,
      ref: firstNonEmptyString([candidate.receipt_id, candidate.checkpoint_id])
    });
  }

  return rehydrationResult({ ok: false, exact: false, error: "rehydration_unavailable", ref });
}

export function planRehydration(decisionsOrCandidates = []) {
  return (Array.isArray(decisionsOrCandidates) ? decisionsOrCandidates : []).map((entry = {}) => {
    const decision = entry?.action ? entry : classifyCandidate(entry);
    if (
      (decision.action === RETENTION_ACTIONS.KEEP_REF
        || decision.action === RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT)
      && firstNonEmptyRefFromCandidate(decision)
    ) {
      return { ...decision, rehydrate: rehydrateRoute(decision) };
    }
    return decision;
  });
}

export function rehydrateRoutesFromBody(body = {}) {
  if (!firstNonEmptyString([body.actor_id])) {
    return { ok: false, error: "actor_id_required", ...authorityClosedFields() };
  }

  const refs = Array.isArray(body.refs) ? body.refs : [];
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];

  return {
    ok: true,
    schema: REHYDRATION_SCHEMA,
    routes: [...refs, ...candidates].map(rehydrateRoute),
    ...authorityClosedFields()
  };
}
