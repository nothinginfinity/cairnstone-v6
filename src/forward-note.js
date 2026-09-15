// V7.7.10b — Forward with note helper
//
// Creates NEW AC1 correspondence that REFERENCES the original object_ref.
// Distinct from Give Access (which grants visibility without copying).
// Must not be the default share path.
// NEVER moves HEADs. Correspondence transports intent only.

import { stableJson } from "./agent-bootstrap.js";
import { parseObjectRef } from "./attachment-refs.js";
import { sendMessageFromBody } from "./correspondence.js";

export const FORWARD_NOTE_SCHEMA = "cairnstone-forward-note-v1";

export const FORWARD_NOTE_BROKER_TOOL_IDS = Object.freeze({
  forward: "cairnstone_forward_with_note"
});

export const FORWARD_NOTE_MUTATION_TOOL_IDS = Object.freeze([
  FORWARD_NOTE_BROKER_TOOL_IDS.forward
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_NOTE = 4000;
const MAX_REF_LEN = 256;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function actorId(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ACTOR_ID_RE.test(text)) throw new Error(`Invalid actor id for ${field}`);
  return text;
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    is_default_share_path: false,
    distinct_from_give_access: true,
    copies_canonical_payload: false
  };
}

/**
 * Build the forward-with-note AC1 content payload.
 * References original; does not embed/copy the original payload bytes.
 */
export function buildForwardNoteContent({
  note,
  object_ref,
  original = null,
  from,
  to
} = {}) {
  const refNorm = parseObjectRef(object_ref);
  if (!refNorm.ok) return refNorm;
  if (!isNonEmptyString(note)) {
    return { ok: false, error: "note_required" };
  }
  const noteText = String(note).trim().slice(0, MAX_NOTE);
  const originalMeta = original && typeof original === "object"
    ? {
      message_id: original.message_id || null,
      stone_hash: original.stone_hash || null,
      object_ref: original.object_ref || refNorm.canonical_ref
    }
    : {
      message_id: refNorm.kind === "msg" ? refNorm.message_id : null,
      stone_hash: (refNorm.kind === "stone" || refNorm.kind === "ac1") ? refNorm.stone_hash : null,
      object_ref: refNorm.canonical_ref
    };

  return {
    ok: true,
    content: stableJson({
      schema: FORWARD_NOTE_SCHEMA,
      note: noteText,
      original: originalMeta,
      object_ref: refNorm.canonical_ref,
      object_ref_kind: refNorm.kind,
      from,
      to,
      policy: {
        transport_only: true,
        default_share_path: false,
        distinct_from_give_access: true,
        copies_canonical_payload: false,
        accepted_state_authority: false,
        execution_authority: false,
        mutation_authority: false
      },
      accepted_state_authority: false
    }),
    object_ref: refNorm.canonical_ref,
    kind: refNorm.kind
  };
}

export async function forwardWithNoteFromBody(body = {}, env = {}, deps = {}) {
  let from;
  let recipients;
  try {
    from = actorId(body.from || body.actor_id, body.from ? "from" : "actor_id");
    const toList = Array.isArray(body.to) ? body.to : (body.to ? [body.to] : []);
    if (!toList.length) return { ok: false, error: "to_required", ...authorityClosedFields() };
    if (toList.length > 25) return { ok: false, error: "to_too_large", max: 25, ...authorityClosedFields() };
    recipients = toList.map((item, index) => actorId(item, `to[${index}]`));
  } catch (error) {
    return { ok: false, error: "invalid_forward_actors", detail: String(error.message || error), ...authorityClosedFields() };
  }

  const objectRef = body.object_ref || body.original_object_ref || body.original?.object_ref;
  if (!isNonEmptyString(objectRef)) {
    return { ok: false, error: "object_ref_required", ...authorityClosedFields() };
  }
  if (String(objectRef).trim().length > MAX_REF_LEN) {
    return { ok: false, error: "object_ref_too_long", ...authorityClosedFields() };
  }

  const built = buildForwardNoteContent({
    note: body.note,
    object_ref: objectRef,
    original: body.original || null,
    from,
    to: recipients
  });
  if (!built.ok) return { ...built, ...authorityClosedFields() };

  if (typeof deps.createStone !== "function" && typeof deps.sendMessage !== "function") {
    return {
      ok: false,
      error: "forward_transport_unavailable",
      detail: "createStone or sendMessage dependency required",
      ...authorityClosedFields()
    };
  }

  const send = deps.sendMessage
    || ((payload) => sendMessageFromBody(payload, env, { createStone: deps.createStone }));

  const sent = await send({
    from,
    to: recipients,
    content: built.content,
    message_id: body.message_id,
    thread_id: body.thread_id,
    intent: body.intent || "message",
    priority: body.priority || "normal",
    subject: body.subject || `Forward with note: ${built.object_ref}`,
    labels: Array.isArray(body.labels) && body.labels.length ? body.labels : ["informational"],
    scope: body.scope
  });

  if (!sent?.ok) {
    return { ...sent, ...authorityClosedFields() };
  }

  return {
    ok: true,
    schema: FORWARD_NOTE_SCHEMA,
    forward: {
      object_ref: built.object_ref,
      object_ref_kind: built.kind,
      note_included: true,
      distinct_from_give_access: true,
      is_default_share_path: false
    },
    message_id: sent.message_id,
    thread_id: sent.thread_id,
    stone_hash: sent.stone_hash,
    deliveries: sent.deliveries,
    idempotent_replay: Boolean(sent.idempotent_replay),
    ...authorityClosedFields()
  };
}

export const FORWARD_WITH_NOTE_TOOL_DEFINITION = Object.freeze({
  name: FORWARD_NOTE_BROKER_TOOL_IDS.forward,
  description: "V7.7.10b: Forward with note — create NEW AC1 correspondence referencing an original object_ref + operator note. Distinct from Give Access; not the default share path. Does not copy canonical payload; never moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["to", "note", "object_ref"],
    properties: {
      from: { type: "string" },
      actor_id: { type: "string", description: "alias for from" },
      to: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 }
        ]
      },
      note: { type: "string", maxLength: MAX_NOTE },
      object_ref: { type: "string" },
      original_object_ref: { type: "string" },
      original: { type: "object" },
      message_id: { type: "string" },
      thread_id: { type: "string" },
      intent: { type: "string", enum: ["message", "handoff", "task_request", "task_result", "ack"] },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      subject: { type: "string" },
      labels: { type: "array", maxItems: 20, items: { type: "string" } },
      scope: { type: "object" }
    },
    additionalProperties: false
  }
});

export const FORWARD_NOTE_MCP_TOOL_DEFINITIONS = Object.freeze([
  FORWARD_WITH_NOTE_TOOL_DEFINITION
]);
