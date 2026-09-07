// AC1 worker session pattern (third bounded subagent slice).
//
// Composes existing correspondence + cairnstone_delegate (max_turns /
// compact_result) so an outer agent can hand a bounded task to a worker over
// AC1, the worker picks up only its own inbox, runs vault-grounded work, and
// returns a compact task_result that embeds cairnstone-subagent-result-v1.
//
// Hard guarantees:
// - never calls set_head / set_path_head
// - never scans another actor's inbox
// - model mutation intents stay closed via existing delegate deny path
// - correspondence remains transport-only (createStone with set_as_head:false)

import { stableJson } from "./agent-bootstrap.js";
import {
  DELEGATE_LOOP_DEFAULT_MAX_TURNS,
  DELEGATE_LOOP_MAX_MAX_TURNS
} from "./delegate-loop.js";
import { SUBAGENT_RESULT_SCHEMA } from "./subagent-result.js";

export const TASK_REQUEST_SCHEMA = "cairnstone-task-request-v1";
export const TASK_RESULT_SCHEMA = "cairnstone-task-result-v1";
export const WORKER_SESSION_RESULT_SCHEMA = "cairnstone-worker-session-result-v1";

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_TASK_CHARS = 4000;
const MAX_SUBJECT_CHARS = 500;
const MAILBOX_CAPABILITY_SCHEMA = "cairnstone-mailbox-capability-v1";
const MAILBOX_CAPABILITY_MAX_TTL_SECONDS = 3600;
const MAILBOX_CAPABILITY_DEFAULT_TTL_SECONDS = 900;
const MAILBOX_CAPABILITY_SCOPES = Object.freeze(new Set([
  "mail.read:self",
  "mail.reply:self",
  "task.consume:self"
]));

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function actorId(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ACTOR_ID_RE.test(text)) throw new Error(`Invalid actor id for ${field}`);
  return text;
}

function optionalActorId(value, field) {
  if (value === undefined || value === null || value === "") return null;
  return actorId(value, field);
}

function mailboxCapabilitySecret(env) {
  const dedicated = typeof env?.CAIRNSTONE_MAILBOX_CAPABILITY_SECRET === "string"
    ? env.CAIRNSTONE_MAILBOX_CAPABILITY_SECRET.trim()
    : "";
  if (dedicated) return dedicated;
  const operator = typeof env?.CAIRNSTONE_OPERATOR_TOKEN === "string"
    ? env.CAIRNSTONE_OPERATOR_TOKEN.trim()
    : "";
  return operator || null;
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const text = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = text + "=".repeat((4 - (text.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSha256Base64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function constantTimeTextEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function issueMailboxCapabilityFromBody(body = {}, env = {}) {
  const secret = mailboxCapabilitySecret(env);
  if (!secret) return { ok: false, error: "mailbox_capability_not_configured" };
  let principalActorId;
  try { principalActorId = actorId(body.principal_actor_id, "principal_actor_id"); }
  catch (error) { return { ok: false, error: "invalid_mailbox_principal", detail: String(error.message || error) }; }
  const requestedScopes = Array.isArray(body.scopes) ? body.scopes : [];
  const scopes = [...new Set(requestedScopes.map(value => String(value || "").trim()).filter(Boolean))].sort();
  if (!scopes.length || scopes.some(scope => !MAILBOX_CAPABILITY_SCOPES.has(scope))) {
    return { ok: false, error: "invalid_mailbox_capability_scopes", allowed: [...MAILBOX_CAPABILITY_SCOPES] };
  }
  const ttlSeconds = clampInt(
    body.ttl_seconds,
    30,
    MAILBOX_CAPABILITY_MAX_TTL_SECONDS,
    MAILBOX_CAPABILITY_DEFAULT_TTL_SECONDS
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    schema: MAILBOX_CAPABILITY_SCHEMA,
    principal_actor_id: principalActorId,
    scopes,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    nonce: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${issuedAt}:${Math.random()}`,
    policy: {
      self_only: true,
      transport_only: true,
      execution_authority: false,
      mutation_authority: false,
      accepted_state_authority: false
    }
  };
  const encodedPayload = encodeBase64Url(stableJson(payload));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return {
    ok: true,
    schema: MAILBOX_CAPABILITY_SCHEMA,
    mailbox_capability: `${encodedPayload}.${signature}`,
    principal_actor_id: principalActorId,
    scopes,
    issued_at: new Date(payload.iat * 1000).toISOString(),
    expires_at: new Date(payload.exp * 1000).toISOString(),
    policy: payload.policy
  };
}

export async function verifyMailboxCapability(token, expectedActorId, requiredScopes = [], env = {}) {
  const secret = mailboxCapabilitySecret(env);
  if (!secret) return { ok: false, error: "mailbox_capability_not_configured" };
  if (!isNonEmptyString(token)) return { ok: false, error: "mailbox_capability_required" };
  const parts = token.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "mailbox_capability_invalid" };
  const expectedSignature = await hmacSha256Base64Url(secret, parts[0]);
  if (!constantTimeTextEqual(parts[1], expectedSignature)) return { ok: false, error: "mailbox_capability_invalid_signature" };
  let payload;
  try { payload = JSON.parse(decodeBase64Url(parts[0])); }
  catch { return { ok: false, error: "mailbox_capability_invalid_payload" }; }
  if (!isObject(payload) || payload.schema !== MAILBOX_CAPABILITY_SCHEMA) return { ok: false, error: "mailbox_capability_wrong_schema" };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= now || payload.iat > now + 60) {
    return { ok: false, error: "mailbox_capability_expired_or_invalid_time" };
  }
  if (payload.exp - payload.iat > MAILBOX_CAPABILITY_MAX_TTL_SECONDS) return { ok: false, error: "mailbox_capability_ttl_exceeded" };
  let principalActorId;
  try { principalActorId = actorId(payload.principal_actor_id, "principal_actor_id"); }
  catch { return { ok: false, error: "mailbox_capability_invalid_principal" }; }
  if (principalActorId !== expectedActorId) {
    return { ok: false, error: "mailbox_capability_principal_mismatch", principal_actor_id: principalActorId, requested_actor_id: expectedActorId };
  }
  const scopes = Array.isArray(payload.scopes) ? [...new Set(payload.scopes.map(String))] : [];
  const missing = requiredScopes.filter(scope => !scopes.includes(scope));
  if (missing.length) return { ok: false, error: "mailbox_capability_scope_missing", missing };
  return {
    ok: true,
    schema: MAILBOX_CAPABILITY_SCHEMA,
    principal_actor_id: principalActorId,
    scopes,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    policy: payload.policy || null
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function workerFailure(error, detail = undefined) {
  const out = {
    ok: false,
    schema: WORKER_SESSION_RESULT_SCHEMA,
    error,
    policy: workerPolicy()
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

function workerPolicy() {
  return {
    own_inbox_only: true,
    accepted_state_mutation: false,
    mutation_authority: false,
    execution_authority: false,
    set_head_allowed: false,
    set_path_head_allowed: false,
    parent_should_keep: ["answer", "citations", "task_result.message_id", "task_result.stone_hash"]
  };
}

/**
 * Build a structured task_request body for cairnstone_send_message.
 * Parents should send intent="task_request" with this JSON content.
 */
export function buildTaskRequestContent({
  task,
  chain,
  profile_id = null,
  package_id = null,
  max_turns = DELEGATE_LOOP_DEFAULT_MAX_TURNS,
  compact_result = true,
  reply_to = null,
  route = null,
  limits = null,
  generation = null,
  include_inbox = undefined
} = {}) {
  if (!isNonEmptyString(task)) throw new Error("Missing required string: task");
  if (!isNonEmptyString(chain)) throw new Error("Missing required string: chain");
  const trimmedTask = task.trim();
  if (trimmedTask.length > MAX_TASK_CHARS) {
    throw new Error(`task too large: max ${MAX_TASK_CHARS} characters`);
  }
  const content = {
    schema: TASK_REQUEST_SCHEMA,
    task: trimmedTask,
    chain: chain.trim(),
    profile_id: isNonEmptyString(profile_id) ? profile_id.trim() : null,
    package_id: isNonEmptyString(package_id) ? package_id.trim() : null,
    max_turns: clampInt(max_turns, 1, DELEGATE_LOOP_MAX_MAX_TURNS, DELEGATE_LOOP_DEFAULT_MAX_TURNS),
    compact_result: compact_result !== false,
    reply_to: optionalActorId(reply_to, "reply_to"),
    policy: {
      transport_only: true,
      execution_authority: false,
      mutation_authority: false,
      accepted_state_authority: false
    }
  };
  // Security boundary: task-request correspondence carries task intent only.
  // Provider routes, credentials/failover, generation/limits, inbox hydration,
  // reply redirection, and worker profile policy are runner-local authority and
  // are deliberately NOT serialized from a requester-controlled message.
  void reply_to;
  void route;
  void limits;
  void generation;
  void include_inbox;
  return stableJson(content);
}

/**
 * Parse task_request content. Accepts structured JSON (preferred) or a plain
 * task string with chain supplied by the runner/body.
 */
export function parseTaskRequest(content, fallbacks = {}) {
  if (typeof content !== "string") {
    return { ok: false, error: "invalid_task_request_content", detail: "content_not_string" };
  }
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, error: "invalid_task_request_content", detail: "empty" };

  let parsed = null;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: "invalid_task_request_json" };
    }
  }

  if (isObject(parsed)) {
    if (parsed.schema && parsed.schema !== TASK_REQUEST_SCHEMA && parsed.schema !== "cairnstone-handoff-v1") {
      return { ok: false, error: "unsupported_task_request_schema", schema: parsed.schema };
    }
    // Handoff stones may be re-labeled as task_request by a parent; accept
    // their task/chain fields when present.
    const task = isNonEmptyString(parsed.task) ? parsed.task.trim() : null;
    const chain = isNonEmptyString(parsed.chain)
      ? parsed.chain.trim()
      : (isNonEmptyString(fallbacks.chain) ? fallbacks.chain.trim() : null);
    if (!task || !chain) {
      return { ok: false, error: "task_request_missing_task_or_chain" };
    }
    if (task.length > MAX_TASK_CHARS) {
      return { ok: false, error: "task_request_task_too_large", max_chars: MAX_TASK_CHARS };
    }
    return {
      ok: true,
      request: {
        schema: parsed.schema === "cairnstone-handoff-v1" ? "cairnstone-handoff-v1" : TASK_REQUEST_SCHEMA,
        task,
        chain,
        profile_id: fallbacks.profile_id || null,
        package_id: isNonEmptyString(parsed.package_id) ? parsed.package_id.trim() : null,
        max_turns: clampInt(
          parsed.max_turns ?? fallbacks.max_turns,
          1,
          DELEGATE_LOOP_MAX_MAX_TURNS,
          DELEGATE_LOOP_DEFAULT_MAX_TURNS
        ),
        compact_result: parsed.compact_result === undefined
          ? (fallbacks.compact_result !== false)
          : parsed.compact_result !== false,
        reply_to: null,
        route: null,
        limits: null,
        generation: null,
        include_inbox: false
      }
    };
  }

  // Plain-text fallback: entire body is the task; chain must come from runner.
  if (!isNonEmptyString(fallbacks.chain)) {
    return { ok: false, error: "task_request_missing_chain", detail: "plain_text_requires_chain" };
  }
  if (trimmed.length > MAX_TASK_CHARS) {
    return { ok: false, error: "task_request_task_too_large", max_chars: MAX_TASK_CHARS };
  }
  return {
    ok: true,
    request: {
      schema: "plain_text",
      task: trimmed,
      chain: fallbacks.chain.trim(),
      profile_id: fallbacks.profile_id || null,
      package_id: null,
      max_turns: clampInt(fallbacks.max_turns, 1, DELEGATE_LOOP_MAX_MAX_TURNS, DELEGATE_LOOP_DEFAULT_MAX_TURNS),
      compact_result: fallbacks.compact_result !== false,
      reply_to: null,
      route: null,
      limits: null,
      generation: null,
      include_inbox: undefined
    }
  };
}

/**
 * Filter inbox cards to own-recipient task_request candidates.
 * Never accepts another recipient_id.
 */
export function selectTaskRequestCandidates(inbox, workerActorId, options = {}) {
  if (!inbox?.ok) return { ok: false, error: inbox?.error || "inbox_unavailable", detail: inbox };
  const worker = actorId(workerActorId, "worker_actor_id");
  if (inbox.recipient_id && inbox.recipient_id !== worker) {
    return { ok: false, error: "foreign_inbox_denied", detail: "worker may only read its own inbox" };
  }
  const messages = Array.isArray(inbox.messages) ? inbox.messages : [];
  const intent = options.intent || "task_request";
  const filtered = messages.filter(msg => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.recipient_id && msg.recipient_id !== worker) return false;
    if (intent && msg.intent !== intent) return false;
    return true;
  });
  // FIFO: oldest first (inbox list is typically newest-first).
  const ordered = [...filtered].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return {
    ok: true,
    worker_actor_id: worker,
    total: ordered.length,
    candidates: ordered
  };
}

/**
 * Build task_result message content. Embeds the compact subagent result when
 * present; otherwise records a structured failure for the parent.
 */
export function buildTaskResultContent({
  request_message_id,
  thread_id,
  worker_actor_id,
  status,
  subagent_result = null,
  error = null,
  detail = null
} = {}) {
  if (!isNonEmptyString(request_message_id)) throw new Error("Missing request_message_id");
  if (!isNonEmptyString(worker_actor_id)) throw new Error("Missing worker_actor_id");
  const normalizedStatus = status === "ok" || status === "failed" || status === "skipped"
    ? status
    : "failed";

  const body = {
    schema: TASK_RESULT_SCHEMA,
    request_message_id: request_message_id.trim(),
    thread_id: isNonEmptyString(thread_id) ? thread_id.trim() : null,
    worker_actor_id: worker_actor_id.trim(),
    status: normalizedStatus,
    policy: {
      transport_only: true,
      execution_authority: false,
      mutation_authority: false,
      accepted_state_mutation: false,
      embeds: SUBAGENT_RESULT_SCHEMA
    }
  };

  if (isObject(subagent_result)) {
    // Prefer embedding the compact envelope; if a fuller delegation result
    // somehow arrives, still attach it under result for parent inspection.
    body.result = subagent_result;
    if (subagent_result.schema === SUBAGENT_RESULT_SCHEMA) {
      body.compact_result_schema = SUBAGENT_RESULT_SCHEMA;
      if (typeof subagent_result.answer === "string") body.answer = subagent_result.answer;
      if (Array.isArray(subagent_result.citations)) body.citations = subagent_result.citations;
    }
  }
  if (error) body.error = String(error);
  if (detail !== undefined && detail !== null) body.detail = detail;
  return stableJson(body);
}

export const RUN_TASK_REQUEST_TOOL_DEFINITION = {
  name: "cairnstone_run_task_request",
  description:
    "AC1 worker session: pick up one task_request from the worker's own inbox (optional since/thread_id/message_id), run vault-grounded work via cairnstone_delegate (prefer max_turns + compact_result), and reply with a compact task_result embedding cairnstone-subagent-result-v1. Never scans other actors' inboxes and never writes chain/path HEAD.",
  inputSchema: {
    type: "object",
    required: ["worker_actor_id", "route", "mailbox_capability"],
    properties: {
      worker_actor_id: {
        type: "string",
        description: "Canonical product actor id whose own inbox is scanned (e.g. grok-bot:cairnstone-v6). Must match the signed mailbox capability principal."
      },
      mailbox_capability: {
        type: "string",
        description: "Short-lived server-signed capability proving this caller may consume tasks from worker_actor_id's own mailbox."
      },
      route: {
        type: "object",
        required: ["provider", "model"],
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          gateway_id: { type: "string" },
          credential_mode: { type: "string", enum: ["workers_ai_billing", "unified_billing", "byok"] },
          credential_alias: { type: "string" },
          failover: { type: "object", additionalProperties: true }
        },
        additionalProperties: false,
        description: "Model route for the server-side delegate call."
      },
      message_id: { type: "string", description: "Optional exact task_request message_id to process." },
      thread_id: { type: "string", description: "Exact thread_id filter for get_inbox pickup." },
      since: { type: "string", description: "Inclusive created_at lower bound for get_inbox pickup (ISO-8601)." },
      status: {
        type: "string",
        enum: ["queued", "delivered", "read", "acked", "archived"],
        description: "Optional delivery-status filter. Defaults to delivered when message_id is omitted."
      },
      limit: { type: "number", minimum: 1, maximum: 50, description: "Inbox scan limit before intent filter. Default 20." },
      chain: { type: "string", description: "Fallback chain when the task_request body is plain text." },
      profile_id: { type: "string", description: "Optional profile override for delegate." },
      max_turns: {
        type: "number",
        minimum: 1,
        maximum: DELEGATE_LOOP_MAX_MAX_TURNS,
        description: `Delegate turn budget. Default ${DELEGATE_LOOP_DEFAULT_MAX_TURNS} (brokered read loop + compact result).`
      },
      compact_result: {
        type: "boolean",
        description: "Compatibility field. Worker sessions always force compact_result=true; requester messages cannot widen this policy."
      },
      subject: { type: "string", description: "Optional subject for the task_result reply." },
      generation: {
        type: "object",
        properties: {
          max_output_tokens: { type: "number" },
          temperature: { type: "number" }
        },
        additionalProperties: false
      },
      limits: { type: "object", additionalProperties: true },
      include_inbox: { type: "boolean" }
    },
    additionalProperties: false
  }
};

/**
 * One-tick worker session runner.
 *
 * deps:
 * - getInboxFromBody
 * - readMessageFromBody
 * - sendMessageFromBody
 * - delegateFromBody
 */
export async function runTaskRequestFromBody(body = {}, env, deps = {}) {
  try {
    if (!isObject(body)) return workerFailure("invalid_worker_request", "body_not_an_object");
    if (typeof deps.getInboxFromBody !== "function") return workerFailure("worker_dependencies_missing", "getInboxFromBody");
    if (typeof deps.readMessageFromBody !== "function") return workerFailure("worker_dependencies_missing", "readMessageFromBody");
    if (typeof deps.sendMessageFromBody !== "function") return workerFailure("worker_dependencies_missing", "sendMessageFromBody");
    if (typeof deps.delegateFromBody !== "function") return workerFailure("worker_dependencies_missing", "delegateFromBody");

    let workerActorId;
    try {
      workerActorId = actorId(body.worker_actor_id, "worker_actor_id");
    } catch (error) {
      return workerFailure("invalid_worker_actor_id", String(error.message || error));
    }

    if (!isObject(body.route) || !isNonEmptyString(body.route.provider) || !isNonEmptyString(body.route.model)) {
      return workerFailure("invalid_route", "route.provider and route.model are required");
    }

    const mailboxCapability = await verifyMailboxCapability(
      body.mailbox_capability,
      workerActorId,
      ["mail.read:self", "mail.reply:self", "task.consume:self"],
      env
    );
    if (!mailboxCapability.ok) return workerFailure(mailboxCapability.error, mailboxCapability);

    const messageId = isNonEmptyString(body.message_id) ? body.message_id.trim() : null;
    const threadId = isNonEmptyString(body.thread_id) ? body.thread_id.trim() : null;
    const since = isNonEmptyString(body.since) ? body.since.trim() : undefined;
    const limit = clampInt(body.limit, 1, 50, 20);
    const status = isNonEmptyString(body.status)
      ? body.status.trim()
      : (messageId ? undefined : "delivered");

    let selectedMeta = null;
    let read = null;

    if (messageId) {
      read = await deps.readMessageFromBody({
        recipient_id: workerActorId,
        message_id: messageId
      }, env);
      if (!read?.ok) {
        return workerFailure(read?.error || "message_not_found", read);
      }
      if (read.delivery?.recipient_id && read.delivery.recipient_id !== workerActorId) {
        return workerFailure("foreign_inbox_denied", "message delivery is not addressed to this worker");
      }
      const intent = read.metadata?.intent || null;
      if (intent && intent !== "task_request") {
        return workerFailure("not_a_task_request", { intent, message_id: messageId });
      }
      selectedMeta = {
        message_id: read.message_id,
        thread_id: read.thread_id,
        sender_id: read.metadata?.from || read.delivery?.sender_id || null,
        subject: read.metadata?.subject || null,
        intent: intent || "task_request",
        stone_hash: read.stone_hash,
        created_at: read.delivery?.created_at || null
      };
    } else {
      const inbox = await deps.getInboxFromBody({
        recipient_id: workerActorId,
        ...(threadId ? { thread_id: threadId } : {}),
        ...(since ? { since } : {}),
        ...(status ? { status } : {}),
        limit
      }, env);
      const selected = selectTaskRequestCandidates(inbox, workerActorId, { intent: "task_request" });
      if (!selected.ok) return workerFailure(selected.error, selected.detail || selected);
      if (!selected.candidates.length) {
        return {
          ok: true,
          schema: WORKER_SESSION_RESULT_SCHEMA,
          status: "idle",
          worker_actor_id: workerActorId,
          picked_up: false,
          ...(threadId ? { thread_id: threadId } : {}),
          ...(since ? { since } : {}),
          policy: workerPolicy()
        };
      }
      selectedMeta = selected.candidates[0];
      read = await deps.readMessageFromBody({
        recipient_id: workerActorId,
        message_id: selectedMeta.message_id
      }, env);
      if (!read?.ok) return workerFailure(read?.error || "message_not_found", read);
    }

    const parsed = parseTaskRequest(read.content, {
      chain: body.chain,
      profile_id: body.profile_id,
      max_turns: body.max_turns,
      compact_result: body.compact_result
    });
    if (!parsed.ok) return workerFailure(parsed.error, parsed);

    const request = parsed.request;
    if (isNonEmptyString(body.chain) && body.chain.trim() !== request.chain) {
      return workerFailure("worker_chain_pin_mismatch", { requested_chain: request.chain, allowed_chain: body.chain.trim() });
    }
    const effectiveProfileId = isNonEmptyString(body.profile_id) ? body.profile_id.trim() : null;
    const localMaxTurns = clampInt(body.max_turns, 1, DELEGATE_LOOP_MAX_MAX_TURNS, DELEGATE_LOOP_DEFAULT_MAX_TURNS);
    const requestedMaxTurns = clampInt(request.max_turns, 1, DELEGATE_LOOP_MAX_MAX_TURNS, localMaxTurns);
    const effectiveMaxTurns = Math.min(localMaxTurns, requestedMaxTurns);
    const effectiveCompact = true;
    const route = body.route;

    let replyTo;
    try {
      replyTo = selectedMeta.sender_id || read.metadata?.from || read.delivery?.sender_id;
      replyTo = actorId(replyTo, "reply_to");
    } catch (error) {
      return workerFailure("invalid_reply_to", String(error.message || error));
    }

    const delegateBody = {
      actor_id: workerActorId,
      task: request.task,
      chain: request.chain,
      route,
      max_turns: effectiveMaxTurns,
      compact_result: effectiveCompact,
      ...(effectiveProfileId ? { profile_id: effectiveProfileId } : {}),
      ...(isObject(body.generation) ? { generation: body.generation } : {}),
      ...(isObject(body.limits) ? { limits: body.limits } : {}),
      // Worker-task correspondence is data, never permission to hydrate the
      // worker's unrelated inbox into model context.
      include_inbox: false
    };

    const delegation = await deps.delegateFromBody(delegateBody, env);
    const delegateOk = delegation?.ok === true;
    const statusOut = delegateOk ? "ok" : "failed";

    const resultContent = buildTaskResultContent({
      request_message_id: selectedMeta.message_id,
      thread_id: selectedMeta.thread_id || threadId,
      worker_actor_id: workerActorId,
      status: statusOut,
      subagent_result: isObject(delegation) ? delegation : null,
      error: delegateOk ? null : (delegation?.error || "delegate_failed"),
      detail: delegateOk ? null : (delegation?.detail || null)
    });

    const subjectBase = isNonEmptyString(body.subject)
      ? body.subject.trim().slice(0, MAX_SUBJECT_CHARS)
      : (selectedMeta.subject
        ? `task_result: ${String(selectedMeta.subject).slice(0, MAX_SUBJECT_CHARS - 14)}`
        : `task_result: ${selectedMeta.message_id}`);

    const sent = await deps.sendMessageFromBody({
      from: workerActorId,
      to: [replyTo],
      content: resultContent,
      thread_id: selectedMeta.thread_id || threadId || selectedMeta.message_id,
      intent: "task_result",
      priority: "normal",
      subject: subjectBase,
      message_id: `msg:task-result:${selectedMeta.message_id}`
    }, env);

    if (!sent?.ok) {
      return {
        ok: false,
        schema: WORKER_SESSION_RESULT_SCHEMA,
        error: sent?.error || "task_result_send_failed",
        detail: sent,
        worker_actor_id: workerActorId,
        request_message_id: selectedMeta.message_id,
        delegation,
        policy: workerPolicy()
      };
    }

    const compact = isObject(delegation) && delegation.schema === SUBAGENT_RESULT_SCHEMA
      ? {
          schema: SUBAGENT_RESULT_SCHEMA,
          answer: delegation.answer,
          citations: delegation.citations,
          expand_hints: delegation.expand_hints,
          diagnostics: delegation.diagnostics,
          policy: delegation.policy
        }
      : null;

    return {
      ok: true,
      schema: WORKER_SESSION_RESULT_SCHEMA,
      status: statusOut,
      picked_up: true,
      worker_actor_id: workerActorId,
      request: {
        message_id: selectedMeta.message_id,
        thread_id: selectedMeta.thread_id || threadId || null,
        stone_hash: selectedMeta.stone_hash || read.stone_hash || null,
        sender_id: selectedMeta.sender_id || null,
        chain: request.chain,
        profile_id: effectiveProfileId || null,
        max_turns: effectiveMaxTurns,
        compact_result: effectiveCompact
      },
      task_result: {
        message_id: sent.message_id,
        thread_id: sent.thread_id,
        stone_hash: sent.stone_hash,
        recipient_id: replyTo,
        intent: "task_result",
        chain_head_written: sent.chain_head_written === true ? true : false
      },
      ...(compact
        ? { answer: compact.answer, citations: compact.citations, expand_hints: compact.expand_hints }
        : {}),
      delegation: compact || {
        ok: delegation?.ok === true,
        schema: delegation?.schema || null,
        error: delegation?.error || null,
        detail: delegation?.detail || null
      },
      policy: {
        ...workerPolicy(),
        mailbox_capability_authenticated: true,
        principal_actor_id: mailboxCapability.principal_actor_id,
        requester_controls_route: false,
        requester_controls_profile: false,
        requester_controls_reply_target: false,
        requester_controls_inbox_hydration: false,
        requester_can_only_narrow_turn_budget: true,
        compact_result_forced: true
      }
    };
  } catch (error) {
    return workerFailure("worker_session_exception", String(error && error.message ? error.message : error));
  }
}
