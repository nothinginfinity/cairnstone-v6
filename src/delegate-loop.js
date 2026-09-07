// Brokered multi-turn read loop for cairnstone_delegate (second subagent slice).
//
// When max_turns >= 2, the parent reuses cairnstone_delegate internals:
//   compile V7.0 package → optional V7.4 profile automatic reads →
//   model turn (tool-intent channel only) → V7.3 policy preview →
//   execute only allowlisted automatic reads → re-ground → next turn →
//   emit compact/legacy result.
//
// Hard invariants:
// - Model intent is never execution authority.
// - Mutation / require_authorization intents never auto-run.
// - Loop never calls set_head / set_path_head.
// - No free tool execution is handed to the model.

import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const DELEGATE_LOOP_DEFAULT_MAX_TURNS = 4;
export const DELEGATE_LOOP_MAX_MAX_TURNS = 8;
export const DELEGATE_LOOP_MAX_TOOL_CALLS = 16;
export const DELEGATE_LOOP_MAX_OUTPUT_BYTES = 20000;
export const DELEGATE_LOOP_MAX_EVIDENCE_CHARS = 6000;
export const DELEGATE_LOOP_MAX_TASK_CHARS = 3900;
export const DELEGATE_LOOP_SCHEMA = "cairnstone-delegate-loop-v1";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Slice(text, maxChars) {
  const source = String(text ?? "");
  if (source.length <= maxChars) return source;
  return source.slice(0, Math.max(0, maxChars - 1)) + "…";
}

/**
 * Parse loop controls from a delegate body.
 * - omitted / 1 → single-shot (existing V7.2/V7.4 path)
 * - 2..8 → brokered read loop
 * Loop mode defaults compact_result to true unless explicitly false.
 */
export function resolveDelegateLoopControls(body = {}) {
  const hasMaxTurns = Object.prototype.hasOwnProperty.call(body || {}, "max_turns");
  const raw = Number(body?.max_turns);
  let maxTurns = 1;
  let loopEnabled = false;
  let invalid = null;

  if (hasMaxTurns) {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > DELEGATE_LOOP_MAX_MAX_TURNS) {
      invalid = {
        ok: false,
        error: "invalid_delegation_request",
        detail: `max_turns must be an integer between 1 and ${DELEGATE_LOOP_MAX_MAX_TURNS}`
      };
    } else {
      maxTurns = raw;
      loopEnabled = raw >= 2;
    }
  }

  // Compact default: loop mode → true unless caller sets compact_result:false.
  // Single-shot preserves historical default (false) unless compact_result:true.
  let compactResult;
  if (Object.prototype.hasOwnProperty.call(body || {}, "compact_result")) {
    compactResult = body.compact_result === true;
  } else {
    compactResult = loopEnabled;
  }

  return { ok: invalid ? false : true, ...(invalid || {}), maxTurns, loopEnabled, compactResult };
}

export function listAutomaticReadToolIds(registry = []) {
  return (Array.isArray(registry) ? registry : [])
    .filter(entry => entry && entry.risk_class === "read" && entry.authorization === "automatic" && entry.available === true)
    .map(entry => entry.tool_id)
    .filter(id => typeof id === "string" && id.trim())
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve the mid-loop automatic-read allowlist.
 * Always intersected with broker automatic-read tools. With a profile, also
 * intersected with profile.tool_allowlist (profile may only narrow).
 */
export function resolveLoopAllowlist({ registry, profile = null } = {}) {
  const automatic = listAutomaticReadToolIds(registry);
  if (!profile) return automatic;
  const profileAllow = new Set(
    Array.isArray(profile.tool_allowlist)
      ? profile.tool_allowlist.filter(id => typeof id === "string" && id.trim())
      : []
  );
  return automatic.filter(id => profileAllow.has(id));
}

export function compactLoopReadEvidence(toolId, executed) {
  const result = executed?.result;
  const preview = executed?.result_preview;
  let bounded = null;
  if (result !== undefined && result !== null) {
    const serialized = stableJson(result);
    bounded = serialized.length > 1500
      ? { truncated: true, preview: serialized.slice(0, 1500) }
      : result;
  } else if (typeof preview === "string") {
    bounded = { truncated: true, preview: preview.slice(0, 1500) };
  }
  return {
    tool_id: toolId,
    ok: executed?.executed === true && executed?.ok !== false,
    decision: executed?.decision || null,
    execution_id: executed?.execution_id || null,
    result_hash: executed?.result_hash || null,
    receipt_stone_hash: executed?.receipt?.stone_hash || null,
    receipt_chain: executed?.receipt?.chain || null,
    bounded_result: bounded
  };
}

export function buildLoopGroundedTask(baseTask, loopEvidence, { turn, maxTurns } = {}) {
  const envelope = {
    schema: DELEGATE_LOOP_SCHEMA,
    turn: turn || null,
    max_turns: maxTurns || null,
    precedence: ["LOOP_AUTOMATIC_READ", "LIVE_OPERATIONAL_READ", "CHAIN_HEAD", "PATH_HEAD", "HISTORICAL"],
    loop_reads: loopEvidence,
    policy: {
      tool_intents_only: true,
      execution_authority: false,
      mutation_authority: false,
      accepted_state_mutation: false
    }
  };
  const grounded = [
    `USER TASK: ${baseTask}`,
    `SERVER-SIDE V7 BROKERED READ-LOOP EVIDENCE: ${stableJson(envelope)}`,
    "LOOP RULES: You may propose structured tool intents only for allowlisted automatic-read tools. Never claim mutation or execution authority. Prefer loop read evidence for operational-current claims. When finished, return a final answer with zero tool intents."
  ].join("\n\n");
  if (grounded.length <= DELEGATE_LOOP_MAX_TASK_CHARS) {
    return { ok: true, task: grounded, envelope };
  }
  // Fail soft by truncating evidence array rather than failing the whole loop.
  const trimmedEvidence = Array.isArray(loopEvidence) ? loopEvidence.slice(-2) : [];
  const trimmedEnvelope = { ...envelope, loop_reads: trimmedEvidence, truncated: true };
  const trimmed = [
    `USER TASK: ${utf8Slice(baseTask, 1200)}`,
    `SERVER-SIDE V7 BROKERED READ-LOOP EVIDENCE: ${utf8Slice(stableJson(trimmedEnvelope), DELEGATE_LOOP_MAX_EVIDENCE_CHARS)}`,
    "LOOP RULES: You may propose structured tool intents only for allowlisted automatic-read tools. Never claim mutation or execution authority. Prefer loop read evidence for operational-current claims. When finished, return a final answer with zero tool intents."
  ].join("\n\n");
  return {
    ok: true,
    task: utf8Slice(trimmed, DELEGATE_LOOP_MAX_TASK_CHARS),
    envelope: trimmedEnvelope,
    truncated: true
  };
}

function normalizeIntent(intent, fallbackId) {
  if (!intent || typeof intent !== "object") return null;
  const toolId = typeof intent.tool_id === "string" ? intent.tool_id.trim() : "";
  if (!toolId) return null;
  const args = intent.arguments === undefined ? {} : intent.arguments;
  if (!isPlainObject(args)) return null;
  return {
    intent_id: typeof intent.intent_id === "string" && intent.intent_id.trim()
      ? intent.intent_id.trim()
      : fallbackId,
    tool_id: toolId,
    arguments: args,
    executed: false
  };
}

/**
 * Run the brokered multi-turn read loop. Returns a cairnstone-delegation-result-v1
 * shaped object (success or failure) with loop diagnostics. Caller wraps compact.
 */
export async function runBrokeredReadLoop({
  env,
  deps,
  actorId,
  effectiveActorId,
  task,
  baseTaskForBootstrap,
  chain,
  route,
  generation,
  limits,
  includeInbox,
  profile = null,
  profileMeta = null,
  grounding = null,
  instructionsChain = null,
  initialToolsExecuted = 0,
  maxTurns = DELEGATE_LOOP_DEFAULT_MAX_TURNS,
  helpers = {}
} = {}) {
  const compactDelegationEvidence = helpers.compactDelegationEvidence;
  const compactDelegationRoute = helpers.compactDelegationRoute;
  const compactDelegationUsage = helpers.compactDelegationUsage;
  const compactDelegationObservability = helpers.compactDelegationObservability;
  const compactDelegationDiagnostics = helpers.compactDelegationDiagnostics;
  const delegationReadOnlyPolicy = helpers.delegationReadOnlyPolicy;
  const registry = Array.isArray(deps.registry) ? deps.registry : (helpers.defaultRegistry || []);

  if (typeof deps.agentBootstrapFromBody !== "function" || typeof deps.modelRouteFromBody !== "function") {
    return {
      ok: false,
      error: "delegation_dependencies_missing",
      policy: delegationReadOnlyPolicy ? delegationReadOnlyPolicy(initialToolsExecuted) : {
        delegation_mode: "brokered_read_loop",
        tools_exposed_to_model: 0,
        tools_executed: initialToolsExecuted,
        execution_authority: false,
        mutation_authority: false,
        accepted_state_mutation: false
      }
    };
  }
  if (typeof deps.executeReadToolIntent !== "function") {
    return {
      ok: false,
      error: "delegate_loop_execute_unavailable",
      detail: "brokered read loop requires executeReadToolIntent",
      policy: {
        delegation_mode: "brokered_read_loop",
        tools_exposed_to_model: 0,
        tools_executed: initialToolsExecuted,
        execution_authority: false,
        mutation_authority: false,
        accepted_state_mutation: false
      }
    };
  }
  const previewFn = typeof deps.toolPolicyPreview === "function"
    ? deps.toolPolicyPreview
    : null;

  const allowlist = resolveLoopAllowlist({ registry, profile });
  if (!allowlist.length) {
    return {
      ok: false,
      error: "delegate_loop_allowlist_empty",
      detail: "no automatic-read tools available for brokered loop",
      actor_id: effectiveActorId,
      ...(profileMeta ? { caller_actor_id: actorId, profile: profileMeta, grounding } : {}),
      chain,
      policy: {
        delegation_mode: "brokered_read_loop",
        tools_exposed_to_model: 0,
        tools_executed: initialToolsExecuted,
        execution_authority: false,
        mutation_authority: false,
        accepted_state_mutation: false
      }
    };
  }

  let toolsExecuted = initialToolsExecuted;
  const loopEvidence = [];
  const readReceipts = Array.isArray(grounding?.read_receipts) ? [...grounding.read_receipts] : [];
  const turnTrace = [];
  let lastBootstrap = null;
  let lastRouted = null;
  let lastText = "";
  let stopReason = "max_turns";
  let stopDetail = null;
  let externalModelCalls = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const grounded = buildLoopGroundedTask(baseTaskForBootstrap, loopEvidence, { turn, maxTurns });
    const bootstrap = await deps.agentBootstrapFromBody({
      actor_id: effectiveActorId,
      task: grounded.task,
      chain,
      ...(instructionsChain ? { instructions_chain: instructionsChain } : {}),
      capabilities: {
        tools: allowlist.map(id => ({ id, available: true, class: "read" })),
        supports_tool_calls: true
      },
      limits,
      include_inbox: includeInbox !== false && turn === 1
    }, env);

    if (!bootstrap || bootstrap.ok !== true) {
      stopReason = "bootstrap_failed";
      stopDetail = bootstrap && bootstrap.error ? bootstrap.error : "unknown";
      return {
        ok: false,
        schema: helpers.delegationResultSchema || "cairnstone-delegation-result-v1",
        error: "delegation_bootstrap_failed",
        detail: stopDetail,
        actor_id: effectiveActorId,
        ...(profileMeta ? { caller_actor_id: actorId, profile: profileMeta, grounding } : {}),
        chain,
        policy: loopPolicy(allowlist.length, toolsExecuted),
        diagnostics: loopDiagnostics({
          pkg: bootstrap,
          routed: null,
          toolsExecuted,
          turns: turn,
          stopReason,
          allowlist,
          turnTrace,
          externalModelCalls
        })
      };
    }
    lastBootstrap = bootstrap;

    const routed = await deps.modelRouteFromBody({
      context_package: bootstrap,
      route,
      request: {
        tools: allowlist,
        generation
      }
    }, env);

    if (!routed || routed.ok !== true) {
      stopReason = "route_failed";
      stopDetail = routed && routed.error ? routed.error : "delegation_route_failed";
      return {
        ok: false,
        schema: helpers.delegationResultSchema || "cairnstone-delegation-result-v1",
        error: stopDetail,
        detail: routed && routed.detail ? routed.detail : undefined,
        diagnostic: routed && routed.diagnostic ? routed.diagnostic : undefined,
        actor_id: effectiveActorId,
        ...(profileMeta ? { caller_actor_id: actorId, profile: profileMeta, grounding } : {}),
        chain,
        package_id: bootstrap.package_id,
        request_ir_id: routed && routed.request_ir_id ? routed.request_ir_id : null,
        route: compactDelegationRoute ? compactDelegationRoute(routed && routed.route ? routed.route : route) : (routed && routed.route) || route,
        observability: compactDelegationObservability ? compactDelegationObservability(routed) : null,
        policy: loopPolicy(allowlist.length, toolsExecuted),
        evidence: compactDelegationEvidence ? compactDelegationEvidence(bootstrap) : undefined,
        diagnostics: loopDiagnostics({
          pkg: bootstrap,
          routed,
          toolsExecuted,
          turns: turn,
          stopReason,
          allowlist,
          turnTrace,
          externalModelCalls
        })
      };
    }

    lastRouted = routed;
    externalModelCalls += Number.isFinite(Number(routed?.v7_1_4?.external_model_calls))
      ? Number(routed.v7_1_4.external_model_calls)
      : (Number.isFinite(Number(routed?.v7_1_3?.external_model_calls))
        ? Number(routed.v7_1_3.external_model_calls)
        : (Number.isFinite(Number(routed?.v7_1_2?.external_model_calls))
          ? Number(routed.v7_1_2.external_model_calls)
          : (Number.isFinite(Number(routed?.v7_1_1?.external_model_calls))
            ? Number(routed.v7_1_1.external_model_calls)
            : 1)));
    lastText = typeof routed.output?.text === "string" ? routed.output.text : "";
    const rawIntents = Array.isArray(routed.output?.tool_intents) ? routed.output.tool_intents : [];
    const turnRecord = {
      turn,
      package_id: bootstrap.package_id,
      request_ir_id: routed.request_ir_id || null,
      tool_intents_proposed: rawIntents.length,
      tools_executed_this_turn: 0,
      finish_reason: routed.output?.finish_reason || null
    };

    if (!rawIntents.length) {
      stopReason = "final_answer";
      turnTrace.push(turnRecord);
      break;
    }

    if (toolsExecuted >= DELEGATE_LOOP_MAX_TOOL_CALLS) {
      stopReason = "budget";
      stopDetail = "max_tool_calls_exceeded";
      turnTrace.push({ ...turnRecord, stop: stopReason });
      break;
    }

    let blocked = null;
    const executedThisTurn = [];

    for (let index = 0; index < rawIntents.length; index += 1) {
      const intentId = "sha256:" + await sha256Text(stableJson({
        package_id: bootstrap.package_id,
        request_ir_id: routed.request_ir_id || null,
        turn,
        ordinal: index,
        tool_id: rawIntents[index]?.tool_id || null,
        arguments: rawIntents[index]?.arguments || {}
      }));
      const intent = normalizeIntent(rawIntents[index], intentId);
      if (!intent) {
        blocked = {
          stopReason: "deny",
          decision: "deny",
          reason: "invalid_tool_intent",
          tool_id: rawIntents[index]?.tool_id || null
        };
        break;
      }

      // Policy preview first so mutation intents surface require_authorization
      // (not a silent allowlist miss). Prefer explicit preview when available.
      let decision = null;
      let reason = null;
      let authorizationRequired = false;
      if (previewFn) {
        const preview = await previewFn({
          context_package: bootstrap,
          tool_intent: intent
        }, env);
        if (!preview || preview.ok !== true) {
          blocked = {
            stopReason: "deny",
            decision: "deny",
            reason: preview?.error || "tool_policy_preview_failed",
            tool_id: intent.tool_id
          };
          break;
        }
        decision = preview.decision;
        reason = preview.reason;
        authorizationRequired = preview.authorization_required === true;
      }

      if (decision === "require_authorization") {
        blocked = {
          stopReason: "require_authorization",
          decision: "require_authorization",
          reason: reason || "authorization_required",
          tool_id: intent.tool_id,
          authorization_required: true
        };
        break;
      }

      if (decision === "deny") {
        blocked = {
          stopReason: "deny",
          decision: "deny",
          reason: reason || "policy_denied",
          tool_id: intent.tool_id,
          authorization_required: false
        };
        break;
      }

      const allowlisted = allowlist.includes(intent.tool_id);
      if (!allowlisted) {
        blocked = {
          stopReason: "deny",
          decision: "deny",
          reason: "not_in_loop_allowlist",
          tool_id: intent.tool_id,
          authorization_required: false
        };
        break;
      }

      // Without a preview helper, the execute gate re-derives the identical verdict.
      if (previewFn && decision !== "allow") {
        blocked = {
          stopReason: "deny",
          decision: decision || "deny",
          reason: reason || "policy_denied",
          tool_id: intent.tool_id,
          authorization_required: authorizationRequired
        };
        break;
      }

      if (toolsExecuted >= DELEGATE_LOOP_MAX_TOOL_CALLS) {
        blocked = {
          stopReason: "budget",
          decision: "deny",
          reason: "max_tool_calls_exceeded",
          tool_id: intent.tool_id
        };
        break;
      }

      const executed = await deps.executeReadToolIntent({
        context_package: bootstrap,
        tool_intent: intent,
        request_ir_id: routed.request_ir_id || null,
        execution_allowlist: allowlist,
        turn_id: `delegate-loop:${turn}`,
        budgets: {
          max_output_bytes: DELEGATE_LOOP_MAX_OUTPUT_BYTES,
          max_tool_calls_per_turn: Math.min(8, DELEGATE_LOOP_MAX_TOOL_CALLS),
          turn_tool_calls_so_far: executedThisTurn.length
        }
      }, env);

      if (!executed || executed.ok !== true) {
        blocked = {
          stopReason: "deny",
          decision: executed?.decision || "deny",
          reason: executed?.error || "tool_execution_failed",
          tool_id: intent.tool_id
        };
        break;
      }

      if (executed.executed !== true) {
        // execute path denied (mutation / require_authorization / not allowlisted)
        blocked = {
          stopReason: executed.decision === "require_authorization" ? "require_authorization" : "deny",
          decision: executed.decision || "deny",
          reason: executed.execution_denied_reason || executed.reason || "execution_denied",
          tool_id: intent.tool_id,
          authorization_required: executed.authorization_required === true
        };
        break;
      }

      toolsExecuted += 1;
      turnRecord.tools_executed_this_turn += 1;
      const evidence = compactLoopReadEvidence(intent.tool_id, executed);
      loopEvidence.push(evidence);
      executedThisTurn.push(evidence);
      if (executed.receipt?.stone_hash) {
        readReceipts.push({
          tool_id: intent.tool_id,
          stone_hash: executed.receipt.stone_hash,
          chain: executed.receipt.chain || null
        });
      }
    }

    turnTrace.push(turnRecord);

    if (blocked) {
      stopReason = blocked.stopReason;
      stopDetail = blocked;
      // Surface deny/require_authorization status; do not continue turns.
      return {
        ok: false,
        schema: helpers.delegationResultSchema || "cairnstone-delegation-result-v1",
        error: blocked.stopReason === "require_authorization"
          ? "delegate_loop_require_authorization"
          : (blocked.stopReason === "budget" ? "delegate_loop_budget_exceeded" : "delegate_loop_denied"),
        detail: {
          decision: blocked.decision,
          reason: blocked.reason,
          tool_id: blocked.tool_id,
          authorization_required: blocked.authorization_required === true,
          turn
        },
        actor_id: effectiveActorId,
        ...(profileMeta ? { caller_actor_id: actorId, profile: profileMeta, grounding: mergeGrounding(grounding, readReceipts, toolsExecuted) } : {}),
        chain,
        package_id: bootstrap.package_id,
        request_ir_id: routed.request_ir_id || null,
        route: compactDelegationRoute ? compactDelegationRoute(routed.route) : routed.route,
        observability: compactDelegationObservability ? compactDelegationObservability(routed) : null,
        output: { text: lastText, finish_reason: routed.output?.finish_reason || null },
        usage: compactDelegationUsage ? compactDelegationUsage(routed.usage) : routed.usage,
        policy: loopPolicy(allowlist.length, toolsExecuted),
        evidence: compactDelegationEvidence ? compactDelegationEvidence(bootstrap) : undefined,
        loop: {
          schema: DELEGATE_LOOP_SCHEMA,
          max_turns: maxTurns,
          turns: turn,
          stop_reason: stopReason,
          allowlist,
          read_receipts: readReceipts,
          evidence: loopEvidence,
          turn_trace: turnTrace
        },
        diagnostics: loopDiagnostics({
          pkg: bootstrap,
          routed,
          toolsExecuted,
          turns: turn,
          stopReason,
          allowlist,
          turnTrace,
          externalModelCalls,
          stopDetail
        })
      };
    }

    // Executed intents this turn → re-ground and continue (unless last turn).
    if (turn === maxTurns) {
      stopReason = "max_turns";
      // Prefer last model text if present; otherwise report max_turns stop.
      break;
    }
  }

  const turnsCompleted = turnTrace.length || maxTurns;
  const success = {
    ok: true,
    schema: helpers.delegationResultSchema || "cairnstone-delegation-result-v1",
    actor_id: effectiveActorId,
    ...(profileMeta ? {
      caller_actor_id: actorId,
      profile: profileMeta,
      grounding: mergeGrounding(grounding, readReceipts, toolsExecuted)
    } : {}),
    chain,
    package_id: lastBootstrap?.package_id || null,
    request_ir_id: lastRouted?.request_ir_id || null,
    output: {
      text: lastText,
      finish_reason: lastRouted?.output?.finish_reason || (stopReason === "max_turns" ? "max_turns" : "stop")
    },
    route: compactDelegationRoute
      ? compactDelegationRoute(lastRouted?.route || route)
      : (lastRouted?.route || route),
    usage: compactDelegationUsage ? compactDelegationUsage(lastRouted?.usage) : (lastRouted?.usage || null),
    observability: compactDelegationObservability ? compactDelegationObservability(lastRouted) : null,
    evidence: lastBootstrap && compactDelegationEvidence ? compactDelegationEvidence(lastBootstrap) : undefined,
    policy: loopPolicy(allowlist.length, toolsExecuted),
    loop: {
      schema: DELEGATE_LOOP_SCHEMA,
      max_turns: maxTurns,
      turns: turnsCompleted,
      stop_reason: stopReason,
      allowlist,
      read_receipts: readReceipts,
      evidence: loopEvidence,
      turn_trace: turnTrace
    },
    diagnostics: loopDiagnostics({
      pkg: lastBootstrap,
      routed: lastRouted,
      toolsExecuted,
      turns: turnsCompleted,
      stopReason,
      allowlist,
      turnTrace,
      externalModelCalls,
      stopDetail
    })
  };

  // max_turns with no final answer and empty text still returns ok:true with stop_reason,
  // matching "stop on max_turns" — parent can inspect diagnostics.stop_reason.
  if (stopReason === "max_turns" && !lastText && !loopEvidence.length) {
    return {
      ...success,
      ok: false,
      error: "delegate_loop_max_turns",
      detail: { max_turns: maxTurns, turns: turnsCompleted }
    };
  }

  return success;
}

function mergeGrounding(grounding, readReceipts, toolsExecuted) {
  if (!grounding) {
    return {
      schema: DELEGATE_LOOP_SCHEMA,
      read_receipts: readReceipts,
      live_reads_executed: toolsExecuted,
      degraded: false
    };
  }
  return {
    ...grounding,
    read_receipts: readReceipts,
    live_reads_executed: toolsExecuted
  };
}

function loopPolicy(toolsExposed, toolsExecuted) {
  return {
    delegation_mode: "brokered_read_loop",
    tools_exposed_to_model: toolsExposed,
    tools_executed: toolsExecuted,
    execution_authority: false,
    mutation_authority: false,
    accepted_state_mutation: false,
    tool_intents_only: true,
    model_intent_is_execution_authority: false
  };
}

function loopDiagnostics({
  pkg,
  routed,
  toolsExecuted,
  turns,
  stopReason,
  allowlist,
  turnTrace,
  externalModelCalls,
  stopDetail
}) {
  return {
    context_package_returned: false,
    server_carried_context_package: true,
    package_bytes: Number.isFinite(Number(pkg?.limits?.package_bytes)) ? Number(pkg.limits.package_bytes) : null,
    package_truncated: pkg?.limits?.truncated === true,
    memory_truncated: pkg?.memory?.truncated === true,
    coordination_items: Array.isArray(pkg?.coordination?.items) ? pkg.coordination.items.length : 0,
    external_model_calls: externalModelCalls,
    tools_executed: toolsExecuted,
    turns,
    stop_reason: stopReason,
    allowlist_size: Array.isArray(allowlist) ? allowlist.length : 0,
    turn_trace: turnTrace,
    ...(stopDetail ? { stop_detail: stopDetail } : {}),
    loop: true
  };
}
