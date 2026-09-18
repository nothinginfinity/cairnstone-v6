export const RETENTION_SCHEMA = "cairnstone-context-retention-v1";

export const RETENTION_ACTIONS = Object.freeze({
  PIN: "PIN",
  KEEP_FULL: "KEEP_FULL",
  KEEP_REF: "KEEP_REF",
  DROP_FROM_ACTIVE_CONTEXT: "DROP_FROM_ACTIVE_CONTEXT"
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

function isRedundantSuccessfulRead(candidate = {}, artifactClass, flags = {}) {
  const newerImmutableRef = candidate.newer_immutable_ref || flags.newer_immutable_ref;
  return artifactClass === "repo_read"
    && candidate.success === true
    && (flags.redundant_successful_read === true || flags.redundant === true)
    && Boolean(newerImmutableRef);
}

export function classifyCandidate(candidate = {}) {
  const artifactClass = candidateClassOf(candidate);
  const flags = candidate.flags || {};
  const immutableRefPresent = hasImmutableRef(candidate);

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
    if (immutableRefPresent) {
      return {
        action: RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT,
        candidate,
        candidate_class: artifactClass,
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

export function previewRetention({ candidates = [] } = {}) {
  const decisions = (Array.isArray(candidates) ? candidates : []).map(classifyCandidate);
  return {
    ok: true,
    schema: RETENTION_SCHEMA,
    decisions,
    telemetry: {
      before_count: decisions.length,
      pin_count: decisions.filter((decision) => decision.action === RETENTION_ACTIONS.PIN).length,
      drop_count: decisions.filter((decision) => decision.action === RETENTION_ACTIONS.DROP_FROM_ACTIVE_CONTEXT).length
    },
    ...authorityClosedFields()
  };
}
