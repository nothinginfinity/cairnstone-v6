// V7.7.10c — Deterministic Intent Router
//
// Pure, no-LLM classification of operator/chat text into 10b proposal/read
// plans. NEVER auto-mutates: never creates/revokes grants, never proposes
// task runs, never executes forward_with_note. Returns a proposal envelope
// only. Never moves HEADs; never mints capabilities.

import { parseObjectRef } from "./attachment-refs.js";
import {
  ACCESS_GRANT_BROKER_TOOL_IDS,
  ACCESS_GRANT_PERMISSIONS
} from "./access-grant.js";
import { TASK_RUN_BROKER_TOOL_IDS } from "./task-run.js";
import { FORWARD_NOTE_BROKER_TOOL_IDS } from "./forward-note.js";

export const INTENT_ROUTE_SCHEMA = "cairnstone-intent-route-v1";

export const INTENT_ROUTE_BROKER_TOOL_IDS = Object.freeze({
  route: "cairnstone_intent_route"
});

export const INTENT_ROUTE_READ_TOOL_IDS = Object.freeze([
  INTENT_ROUTE_BROKER_TOOL_IDS.route
]);

export const INTENT_ROUTE_MUTATION_TOOL_IDS = Object.freeze([]);

export const INTENT_IDS = Object.freeze([
  "give-access",
  "revoke-access",
  "assign",
  "forward-with-note",
  "none"
]);

export const INTENT_CONFIDENCE = Object.freeze([
  "exact",
  "high",
  "low",
  "none"
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const ACTOR_IN_TEXT_RE = /\b([a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127})\b/gi;
const GRANT_ID_RE = /\b(grant:[a-z0-9][a-z0-9._:-]{0,200})\b/gi;
const MAX_TEXT = 8000;
const MAX_NOTE = 4000;
const MAX_REFS = 50;
const MAX_REF_LEN = 256;

const PERMISSION_SET = new Set(ACCESS_GRANT_PERMISSIONS);

const DISPLAY_ALIAS_MAP = Object.freeze({
  claude: "claude",
  chatgpt: "chatgpt",
  gpt: "chatgpt",
  openai: "chatgpt",
  grok: "grok",
  "grok-bot": "grok-bot",
  console: "console"
});

/**
 * Ordered deterministic rule table. Each rule declares an intent family.
 * Rule ids are stable for audit in matched_patterns[].
 */
export const INTENT_RULES = Object.freeze([
  Object.freeze({
    id: "give-access.give-access",
    intent: "give-access",
    confidence: "exact",
    pattern: /\bgive\b[\s\S]{0,80}\baccess\b/i
  }),
  Object.freeze({
    id: "give-access.grant-permission",
    intent: "give-access",
    confidence: "exact",
    pattern: /\bgrant\b[\s\S]{0,80}\b(read|discuss|execute(?:-against)?|access)\b/i
  }),
  Object.freeze({
    id: "give-access.share-with",
    intent: "give-access",
    confidence: "high",
    pattern: /\bshare\b[\s\S]{0,40}\bwith\b/i
  }),
  Object.freeze({
    id: "give-access.let-see",
    intent: "give-access",
    confidence: "high",
    pattern: /\blet\b[\s\S]{0,40}\b(see|read|view)\b/i
  }),
  Object.freeze({
    id: "revoke-access.revoke-access",
    intent: "revoke-access",
    confidence: "exact",
    pattern: /\brevoke\b[\s\S]{0,40}\baccess\b/i
  }),
  Object.freeze({
    id: "revoke-access.remove-access",
    intent: "revoke-access",
    confidence: "exact",
    pattern: /\bremove\b[\s\S]{0,40}\baccess\b/i
  }),
  Object.freeze({
    id: "revoke-access.ungrant",
    intent: "revoke-access",
    confidence: "exact",
    pattern: /\bungrant\b/i
  }),
  Object.freeze({
    id: "revoke-access.stop-sharing",
    intent: "revoke-access",
    confidence: "high",
    pattern: /\bstop\b[\s\S]{0,20}\bsharing\b/i
  }),
  Object.freeze({
    id: "assign.assign-to",
    intent: "assign",
    confidence: "exact",
    pattern: /\bassign\b[\s\S]{0,60}\bto\b/i
  }),
  Object.freeze({
    id: "assign.ask-to-work",
    intent: "assign",
    confidence: "exact",
    pattern: /\bask\b[\s\S]{0,60}\bto\s+work\b/i
  }),
  Object.freeze({
    id: "assign.have-work-on",
    intent: "assign",
    confidence: "high",
    pattern: /\bhave\b[\s\S]{0,60}\bwork\s+on\b/i
  }),
  Object.freeze({
    id: "assign.task-to",
    intent: "assign",
    confidence: "high",
    pattern: /\btask\b[\s\S]{0,40}\bto\b/i
  }),
  Object.freeze({
    id: "forward.forward-with-note",
    intent: "forward-with-note",
    confidence: "exact",
    pattern: /\bforward\b[\s\S]{0,40}\bwith\s+note\b/i
  }),
  Object.freeze({
    id: "forward.forward-to-saying",
    intent: "forward-with-note",
    confidence: "high",
    pattern: /\bforward\b[\s\S]{0,60}\b(to|saying)\b/i
  }),
  Object.freeze({
    id: "forward.send-note-about",
    intent: "forward-with-note",
    confidence: "high",
    pattern: /\bsend\b[\s\S]{0,40}\bnote\b[\s\S]{0,40}\babout\b/i
  })
]);

const CONFIDENCE_RANK = Object.freeze({
  exact: 3,
  high: 2,
  low: 1,
  none: 0
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    auto_mutated: false,
    llm_called: false,
    provider_called: false
  };
}

function normalizeText(text) {
  if (!isNonEmptyString(text)) return "";
  return String(text).trim().slice(0, MAX_TEXT);
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!isNonEmptyString(value)) continue;
    const key = String(value).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Extract and normalize object refs from free text via typed prefixes.
 * Reuses 10b parseObjectRef for canonicalization.
 */
export function extractObjectRefsFromText(text) {
  const source = normalizeText(text);
  if (!source) return [];

  const candidates = [];
  const patterns = [
    /\bstone:[0-9a-f]{64}\b/gi,
    /\bac1:[0-9a-f]{64}\b/gi,
    /\bmsg:[a-z0-9][a-z0-9._:-]{0,200}\b/gi,
    /\brepo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\b/gi,
    /\bsession:cs:[a-z0-9][a-z0-9._-]{0,127}\b/gi,
    /\bcs:[a-z0-9][a-z0-9._-]{0,127}\b/gi,
    /\bconversation:cvs:[a-z0-9][a-z0-9._-]{0,127}\b/gi,
    /\bcvs:[a-z0-9][a-z0-9._-]{0,127}\b/gi,
    /\bturn:[a-z0-9][a-z0-9._-]{0,127}\b/gi,
    /\bcmsg:[a-z0-9][a-z0-9._-]{0,127}\b/gi,
    /\b(?:response|grounded-response|gr):[a-z0-9][a-z0-9._:-]{0,200}\b/gi,
    /\bgrant:[a-z0-9][a-z0-9._:-]{0,200}\b/gi,
    /\btr:[a-z0-9][a-z0-9._:-]{0,200}\b/gi,
    /\b[0-9a-f]{64}\b/gi
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      candidates.push(match[0]);
    }
  }

  const refs = [];
  const seen = new Set();
  for (const raw of candidates) {
    const parsed = parseObjectRef(String(raw).trim().slice(0, MAX_REF_LEN));
    if (!parsed.ok) continue;
    if (seen.has(parsed.canonical_ref)) continue;
    seen.add(parsed.canonical_ref);
    refs.push(parsed.canonical_ref);
  }
  return refs;
}

function normalizeProvidedRefs(values = []) {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  const refs = [];
  const seen = new Set();
  for (const raw of list.slice(0, MAX_REFS)) {
    if (!isNonEmptyString(raw)) continue;
    const parsed = parseObjectRef(String(raw).trim().slice(0, MAX_REF_LEN));
    if (!parsed.ok) continue;
    if (seen.has(parsed.canonical_ref)) continue;
    seen.add(parsed.canonical_ref);
    refs.push(parsed.canonical_ref);
  }
  return refs;
}

function extractGrantIds(text, objectRefs = []) {
  const found = [];
  const source = normalizeText(text);
  if (source) {
    GRANT_ID_RE.lastIndex = 0;
    let match;
    while ((match = GRANT_ID_RE.exec(source)) !== null) {
      found.push(match[1]);
    }
  }
  for (const ref of objectRefs) {
    if (typeof ref === "string" && ref.toLowerCase().startsWith("grant:")) {
      found.push(ref);
    }
  }
  return uniqueStrings(found);
}

const OBJECT_REF_PREFIXES = Object.freeze(new Set([
  "stone",
  "ac1",
  "msg",
  "repo",
  "session",
  "cs",
  "conversation",
  "cvs",
  "turn",
  "cmsg",
  "response",
  "grounded-response",
  "gr",
  "grant",
  "tr"
]));

function extractFullActorIds(text) {
  const source = normalizeText(text);
  if (!source) return [];
  const found = [];
  ACTOR_IN_TEXT_RE.lastIndex = 0;
  let match;
  while ((match = ACTOR_IN_TEXT_RE.exec(source)) !== null) {
    found.push(match[1]);
  }
  // Exclude typed object-ref shapes (msg:, grant:, partial repo:owner, …).
  return uniqueStrings(found).filter((id) => {
    if (!ACTOR_ID_RE.test(id)) return false;
    const prefix = mailboxPrefix(id);
    if (OBJECT_REF_PREFIXES.has(prefix)) return false;
    const parsed = parseObjectRef(id);
    return !parsed.ok;
  });
}

function mailboxPrefix(actorId) {
  const idx = String(actorId).indexOf(":");
  return idx > 0 ? String(actorId).slice(0, idx).toLowerCase() : "";
}

/**
 * Resolve a display-name alias against known_actors only when unambiguous.
 * Returns { ok, actor_id? , error?, candidates? }.
 */
export function resolveActorAlias(token, knownActors = []) {
  if (!isNonEmptyString(token)) {
    return { ok: false, error: "alias_empty" };
  }
  const raw = String(token).trim();
  if (ACTOR_ID_RE.test(raw)) {
    return { ok: true, actor_id: raw, confidence: "exact" };
  }

  const known = uniqueStrings(knownActors).filter(id => ACTOR_ID_RE.test(id));
  const lower = raw.toLowerCase();
  const mappedPrefix = DISPLAY_ALIAS_MAP[lower] || lower;

  const exactId = known.find(id => id.toLowerCase() === lower);
  if (exactId) return { ok: true, actor_id: exactId, confidence: "exact" };

  const prefixMatches = known.filter(id => mailboxPrefix(id) === mappedPrefix);
  if (prefixMatches.length === 1) {
    return { ok: true, actor_id: prefixMatches[0], confidence: "high" };
  }
  if (prefixMatches.length > 1) {
    return {
      ok: false,
      error: "ambiguous_actor_alias",
      alias: raw,
      candidates: prefixMatches
    };
  }

  // Bare display name with no known_actors match — refuse rather than invent.
  return { ok: false, error: "unknown_actor_alias", alias: raw };
}

function extractAliasTokens(text) {
  const source = normalizeText(text);
  if (!source) return [];
  const tokens = [];
  // Capture common bare names when they appear near access/assign/forward cues.
  const aliasRe = /\b(claude|chatgpt|gpt|openai|grok-bot|grok|console)\b/gi;
  let match;
  while ((match = aliasRe.exec(source)) !== null) {
    tokens.push(match[1]);
  }
  return uniqueStrings(tokens.map(t => t.toLowerCase()));
}

function extractPermission(text) {
  const source = normalizeText(text).toLowerCase();
  if (!source) return "read";
  if (/\bexecute(?:[\s-]?against)?\b/.test(source)) return "execute-against";
  if (/\bdiscuss\b/.test(source)) return "discuss";
  if (/\bread\b/.test(source)) return "read";
  return "read";
}

function extractQuotedNote(text) {
  const source = normalizeText(text);
  if (!source) return null;
  const quoted = source.match(/["“]([^"”]{1,4000})["”]/);
  if (quoted?.[1]) return quoted[1].trim().slice(0, MAX_NOTE);
  const saying = source.match(/\bsaying\b[:\s]+(.+)$/i);
  if (saying?.[1]) return saying[1].trim().slice(0, MAX_NOTE);
  const noteAbout = source.match(/\bnote\b[:\s]+(.+)$/i);
  if (noteAbout?.[1]) return noteAbout[1].trim().slice(0, MAX_NOTE);
  return null;
}

function matchRules(text) {
  const source = normalizeText(text);
  const hits = [];
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(source)) {
      hits.push({
        id: rule.id,
        intent: rule.intent,
        confidence: rule.confidence
      });
    }
  }
  return hits;
}

function pickIntentFromHits(hits) {
  if (!hits.length) {
    return {
      intent: "none",
      confidence: "none",
      matched_patterns: [],
      diagnostics: { reason: "unmatched" }
    };
  }

  const byIntent = new Map();
  for (const hit of hits) {
    const prev = byIntent.get(hit.intent);
    const rank = CONFIDENCE_RANK[hit.confidence] || 0;
    if (!prev || rank > prev.rank) {
      byIntent.set(hit.intent, {
        intent: hit.intent,
        confidence: hit.confidence,
        rank,
        patterns: [hit.id]
      });
    } else if (prev && hit.intent === prev.intent) {
      prev.patterns.push(hit.id);
      if (rank === prev.rank && CONFIDENCE_RANK[hit.confidence] === prev.rank) {
        // keep highest label already stored
      }
    } else if (prev && rank === prev.rank) {
      prev.patterns.push(hit.id);
    }
  }

  // Collect patterns for all hits (audit), grouped by intent winner logic.
  const matched_patterns = uniqueStrings(hits.map(h => h.id));

  const winners = [...byIntent.values()].sort((a, b) => b.rank - a.rank);
  if (winners.length >= 2 && winners[0].rank === winners[1].rank) {
    return {
      intent: "none",
      confidence: "none",
      matched_patterns,
      diagnostics: {
        conflict: true,
        reason: "conflicting_mutation_intents",
        candidates: winners
          .filter(w => w.rank === winners[0].rank)
          .map(w => ({ intent: w.intent, confidence: w.confidence, patterns: w.patterns }))
      }
    };
  }

  const top = winners[0];
  return {
    intent: top.intent,
    confidence: top.confidence,
    matched_patterns,
    diagnostics: null
  };
}

function resolvePrincipal({ text, context, knownActors, excludeActorId = null }) {
  const diagnostics = [];
  const fullIds = extractFullActorIds(text).filter(id => id !== excludeActorId);
  if (fullIds.length === 1) {
    return { actor_id: fullIds[0], diagnostics };
  }
  if (fullIds.length > 1) {
    diagnostics.push({
      code: "ambiguous_principal_actor_ids",
      candidates: fullIds
    });
    return { actor_id: null, diagnostics };
  }

  const aliases = extractAliasTokens(text);
  const resolved = [];
  for (const alias of aliases) {
    const result = resolveActorAlias(alias, knownActors);
    if (result.ok && result.actor_id && result.actor_id !== excludeActorId) {
      resolved.push(result.actor_id);
    } else if (!result.ok && result.error === "ambiguous_actor_alias") {
      diagnostics.push({
        code: "ambiguous_actor_alias",
        alias,
        candidates: result.candidates
      });
      return { actor_id: null, diagnostics };
    } else if (!result.ok && result.error === "unknown_actor_alias") {
      diagnostics.push({ code: "unknown_actor_alias", alias });
    }
  }
  const uniqueResolved = uniqueStrings(resolved);
  if (uniqueResolved.length === 1) {
    return { actor_id: uniqueResolved[0], diagnostics };
  }
  if (uniqueResolved.length > 1) {
    diagnostics.push({
      code: "ambiguous_principal_aliases",
      candidates: uniqueResolved
    });
  }
  return { actor_id: null, diagnostics };
}

function buildNoneResult({
  matched_patterns = [],
  diagnostics = {},
  object_refs = [],
  principal_actor_id = null,
  permission = null,
  note = null,
  text = ""
} = {}) {
  return {
    ok: true,
    schema: INTENT_ROUTE_SCHEMA,
    intent: "none",
    confidence: "none",
    matched_patterns,
    requires_human_commit: false,
    auto_mutated: false,
    proposal: null,
    reads: [],
    object_refs,
    principal_actor_id,
    permission,
    note,
    input_text_preview: text ? text.slice(0, 240) : "",
    diagnostics,
    ...authorityClosedFields()
  };
}

function buildProposalResult({
  intent,
  confidence,
  matched_patterns,
  proposal,
  reads = [],
  object_refs = [],
  principal_actor_id = null,
  permission = null,
  note = null,
  text = "",
  diagnostics = null
}) {
  return {
    ok: true,
    schema: INTENT_ROUTE_SCHEMA,
    intent,
    confidence,
    matched_patterns,
    requires_human_commit: true,
    auto_mutated: false,
    proposal,
    reads,
    object_refs,
    principal_actor_id,
    permission,
    note,
    input_text_preview: text ? text.slice(0, 240) : "",
    diagnostics,
    ...authorityClosedFields()
  };
}

function buildGiveAccessProposal({
  objectRefs,
  principal,
  permission,
  grantor,
  missing = []
}) {
  const args = {};
  const missing_fields = [...missing];
  if (objectRefs[0]) args.object_ref = objectRefs[0];
  else missing_fields.push("object_ref");
  if (principal) args.principal_actor_id = principal;
  else missing_fields.push("principal_actor_id");
  args.permission = PERMISSION_SET.has(permission) ? permission : "read";
  if (grantor) args.grantor_actor_id = grantor;
  else missing_fields.push("grantor_actor_id");

  return {
    tool_id: ACCESS_GRANT_BROKER_TOOL_IDS.create,
    args,
    missing_fields: uniqueStrings(missing_fields)
  };
}

function buildRevokeProposal({ grantId, actorId, objectRefs, principal }) {
  const args = {};
  const missing_fields = [];
  const reads = [];

  if (grantId) {
    args.grant_id = grantId;
  } else {
    missing_fields.push("grant_id");
    const listArgs = {};
    if (actorId) listArgs.actor_id = actorId;
    else missing_fields.push("actor_id");
    if (objectRefs[0]) listArgs.object_ref = objectRefs[0];
    if (principal) listArgs.principal_actor_id = principal;
    if (listArgs.actor_id) {
      reads.push({
        tool_id: ACCESS_GRANT_BROKER_TOOL_IDS.list,
        args: listArgs,
        purpose: "resolve_grant_id_before_revoke"
      });
    }
  }
  if (actorId) args.actor_id = actorId;
  else if (!missing_fields.includes("actor_id")) missing_fields.push("actor_id");

  return {
    proposal: {
      tool_id: ACCESS_GRANT_BROKER_TOOL_IDS.revoke,
      args,
      missing_fields: uniqueStrings(missing_fields)
    },
    reads
  };
}

function buildAssignProposal({
  objectRefs,
  assignee,
  requestedBy,
  note,
  conversationId
}) {
  const args = {
    attachment_refs: objectRefs.slice(0, MAX_REFS)
  };
  const missing_fields = [];
  if (!args.attachment_refs.length) missing_fields.push("attachment_refs");
  if (assignee) args.assignee_actor_id = assignee;
  else missing_fields.push("assignee_actor_id");
  if (requestedBy) args.requested_by = requestedBy;
  else missing_fields.push("requested_by");
  if (isNonEmptyString(note)) args.note = String(note).trim().slice(0, MAX_NOTE);
  if (isNonEmptyString(conversationId)) args.conversation_id = conversationId;
  args.requested_intent = "assign";

  return {
    tool_id: TASK_RUN_BROKER_TOOL_IDS.propose,
    args,
    missing_fields: uniqueStrings(missing_fields)
  };
}

function buildForwardProposal({
  objectRefs,
  toActor,
  fromActor,
  note
}) {
  const args = {};
  const missing_fields = [];
  if (objectRefs[0]) args.object_ref = objectRefs[0];
  else missing_fields.push("object_ref");
  if (toActor) args.to = toActor;
  else missing_fields.push("to");
  if (isNonEmptyString(note)) args.note = String(note).trim().slice(0, MAX_NOTE);
  else missing_fields.push("note");
  if (fromActor) args.from = fromActor;
  else missing_fields.push("from");

  return {
    tool_id: FORWARD_NOTE_BROKER_TOOL_IDS.forward,
    args,
    missing_fields: uniqueStrings(missing_fields)
  };
}

/**
 * Core pure router. Zero side effects: no DB, no LLM, no mutation tools.
 */
export function routeIntent(input = {}) {
  const text = normalizeText(input.text);
  const actorId = isNonEmptyString(input.actor_id) ? String(input.actor_id).trim() : null;
  const context = isObject(input.context) ? input.context : {};
  const knownActors = uniqueStrings([
    ...(Array.isArray(context.known_actors) ? context.known_actors : []),
    ...(Array.isArray(input.known_actors) ? input.known_actors : [])
  ]);

  const providedRefs = normalizeProvidedRefs([
    ...(Array.isArray(input.object_refs) ? input.object_refs : []),
    ...(isNonEmptyString(context.focused_object_ref) ? [context.focused_object_ref] : [])
  ]);
  const textRefs = extractObjectRefsFromText(text);
  const object_refs = uniqueStrings([...providedRefs, ...textRefs]);

  // Structured override for tests / programmatic callers — still never mutates.
  if (isNonEmptyString(input.intent) && input.intent !== "none") {
    const override = String(input.intent).trim();
    const aliasMap = {
      "ask-to-work": "assign",
      ask_to_work: "assign",
      give_access: "give-access",
      revoke_access: "revoke-access",
      forward_with_note: "forward-with-note"
    };
    const intent = aliasMap[override] || override;
    if (!INTENT_IDS.includes(intent) || intent === "none") {
      return buildNoneResult({
        object_refs,
        diagnostics: { reason: "invalid_intent_override", intent: override },
        text
      });
    }
    return materializeIntent({
      intent,
      confidence: "exact",
      matched_patterns: [`override:${intent}`],
      text,
      actorId,
      knownActors,
      object_refs,
      context,
      diagnostics: { override: true }
    });
  }

  if (!text && !isNonEmptyString(input.intent)) {
    return buildNoneResult({
      object_refs,
      diagnostics: { reason: "empty_text" },
      text
    });
  }

  const hits = matchRules(text);
  const picked = pickIntentFromHits(hits);
  if (picked.intent === "none") {
    return buildNoneResult({
      matched_patterns: picked.matched_patterns,
      diagnostics: picked.diagnostics || { reason: "unmatched" },
      object_refs,
      text
    });
  }

  return materializeIntent({
    intent: picked.intent,
    confidence: picked.confidence,
    matched_patterns: picked.matched_patterns,
    text,
    actorId,
    knownActors,
    object_refs,
    context,
    diagnostics: picked.diagnostics
  });
}

function materializeIntent({
  intent,
  confidence,
  matched_patterns,
  text,
  actorId,
  knownActors,
  object_refs,
  context,
  diagnostics
}) {
  const permission = extractPermission(text);
  const note = extractQuotedNote(text);
  const grantIds = extractGrantIds(text, object_refs);
  const principalResolution = resolvePrincipal({
    text,
    context,
    knownActors,
    excludeActorId: actorId
  });
  const principal = principalResolution.actor_id;
  const extraDiagnostics = {
    ...(diagnostics || {}),
    ...(principalResolution.diagnostics.length
      ? { actor_resolution: principalResolution.diagnostics }
      : {})
  };

  if (intent === "give-access") {
    const proposal = buildGiveAccessProposal({
      objectRefs: object_refs.filter(r => !String(r).toLowerCase().startsWith("grant:")),
      principal,
      permission,
      grantor: actorId
    });
    return buildProposalResult({
      intent,
      confidence,
      matched_patterns,
      proposal,
      reads: object_refs.length
        ? [{
          tool_id: "cairnstone_attachment_ref_resolve",
          args: {
            ...(actorId ? { actor_id: actorId } : {}),
            object_refs: object_refs.slice(0, MAX_REFS)
          },
          purpose: "orient_object_refs"
        }]
        : [],
      object_refs,
      principal_actor_id: principal,
      permission: proposal.args.permission,
      note,
      text,
      diagnostics: Object.keys(extraDiagnostics).length ? extraDiagnostics : null
    });
  }

  if (intent === "revoke-access") {
    const built = buildRevokeProposal({
      grantId: grantIds[0] || null,
      actorId,
      objectRefs: object_refs.filter(r => !String(r).toLowerCase().startsWith("grant:")),
      principal
    });
    return buildProposalResult({
      intent,
      confidence,
      matched_patterns,
      proposal: built.proposal,
      reads: built.reads,
      object_refs,
      principal_actor_id: principal,
      permission: null,
      note,
      text,
      diagnostics: Object.keys(extraDiagnostics).length ? extraDiagnostics : null
    });
  }

  if (intent === "assign") {
    const workRefs = object_refs.filter(r => {
      const lower = String(r).toLowerCase();
      return !lower.startsWith("grant:") && !lower.startsWith("tr:");
    });
    const proposal = buildAssignProposal({
      objectRefs: workRefs,
      assignee: principal,
      requestedBy: actorId,
      note,
      conversationId: context.conversation_id || null
    });
    return buildProposalResult({
      intent,
      confidence,
      matched_patterns,
      proposal,
      reads: [],
      object_refs: workRefs,
      principal_actor_id: principal,
      permission: null,
      note: proposal.args.note || note,
      text,
      diagnostics: Object.keys(extraDiagnostics).length ? extraDiagnostics : null
    });
  }

  if (intent === "forward-with-note") {
    const workRefs = object_refs.filter(r => !String(r).toLowerCase().startsWith("grant:"));
    const proposal = buildForwardProposal({
      objectRefs: workRefs,
      toActor: principal,
      fromActor: actorId,
      note
    });
    return buildProposalResult({
      intent,
      confidence,
      matched_patterns,
      proposal,
      reads: [],
      object_refs: workRefs,
      principal_actor_id: principal,
      permission: null,
      note: proposal.args.note || note,
      text,
      diagnostics: Object.keys(extraDiagnostics).length ? extraDiagnostics : null
    });
  }

  return buildNoneResult({
    matched_patterns,
    diagnostics: { reason: "unhandled_intent", intent },
    object_refs,
    text
  });
}

/**
 * MCP / REST FromBody adapter. Pure over input — env is accepted for
 * signature parity with other tools but never used for writes.
 */
export function routeIntentFromBody(body = {}, env = {}) {
  void env; // intentionally unused — router is side-effect free
  if (!isObject(body)) {
    return {
      ok: false,
      error: "invalid_intent_route_body",
      detail: "object body required",
      ...authorityClosedFields()
    };
  }
  if (!isNonEmptyString(body.text) && !isNonEmptyString(body.intent)) {
    return {
      ok: false,
      error: "text_or_intent_required",
      ...authorityClosedFields()
    };
  }
  try {
    return routeIntent({
      text: body.text,
      intent: body.intent,
      actor_id: body.actor_id,
      object_refs: body.object_refs,
      known_actors: body.known_actors,
      context: body.context
    });
  } catch (error) {
    return {
      ok: false,
      error: "intent_route_failed",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }
}

export const INTENT_ROUTE_TOOL_DEFINITION = Object.freeze({
  name: INTENT_ROUTE_BROKER_TOOL_IDS.route,
  description: "V7.7.10c: deterministic no-LLM Intent Router. Classifies give-access / revoke-access / assign / forward-with-note from text+context into a proposal/read plan only. Never auto-mutates; never moves HEADs; never mints capabilities.",
  inputSchema: {
    type: "object",
    // text OR intent required at runtime (FromBody); schema stays loose for override tests
    properties: {
      text: { type: "string", maxLength: MAX_TEXT, description: "Operator/chat text to classify" },
      intent: {
        type: "string",
        enum: [...INTENT_IDS, "ask-to-work", "give_access", "revoke_access", "forward_with_note", "ask_to_work"],
        description: "Optional structured override for tests; still returns proposal only"
      },
      actor_id: { type: "string", description: "Operator / grantor / requested_by / from" },
      object_refs: {
        type: "array",
        maxItems: MAX_REFS,
        items: { type: "string" }
      },
      known_actors: {
        type: "array",
        maxItems: 50,
        items: { type: "string" }
      },
      context: {
        type: "object",
        properties: {
          focused_object_ref: { type: "string" },
          conversation_id: { type: "string" },
          known_actors: {
            type: "array",
            maxItems: 50,
            items: { type: "string" }
          }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
});

export const INTENT_ROUTE_MCP_TOOL_DEFINITIONS = Object.freeze([
  INTENT_ROUTE_TOOL_DEFINITION
]);
