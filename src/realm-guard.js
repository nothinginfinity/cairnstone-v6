// S0a — Private-realm actor guard for the unauthenticated legacy AC1 surface.
//
// Roadmap: project-memory/roadmap/2026-10-10-personal-mcp-home-connection-specific-endpoints.md
// (Stone 3fcdb3598e58246f299102bb71e14b598268e60ef9d3a7d4496d19e740328d5c), Gate S0.
//
// Problem: legacy /mcp, /mcp/core, /mcp-b and the REST routes accept caller-supplied
// actor strings for AC1 mailbox tools with no authentication. Anything that lets such a
// caller name a core-auth (private realm) address would let it read or send as that
// address, so the private realm must be unreachable by name from the legacy surface.
//
// Design constraints honoured here:
// - Pure and synchronous. Legacy surfaces must never read auth_* tables
//   (see legacyMustNotQueryAuth in core-auth.js), so protection is by reserved
//   address namespace, not by registry lookup.
// - Additive and default OFF. Historical legacy actors (chatgpt:chat, claude:cairnstone-v6,
//   grok:*, ...) are untouched, so no existing trusted agent is silently severed.
// - Authenticated core-auth calls are not handled here; assertCallerIdentity() and
//   injectServerDerivedCaller() already bind them to the server-derived principal.
// - Grants no execution, mutation, accepted-state or scope authority.

export const REALM_GUARD_MODES = Object.freeze(["off", "shadow", "enforce"]);
export const DEFAULT_REALM_GUARD_MODE = "off";

// Address namespaces reserved for the core-auth private realm. A legacy caller may not
// name an address in any of these, as sender, mailbox owner, or recipient.
export const PRIVATE_REALM_NAMESPACES = Object.freeze(["prin", "conn", "home", "acct", "ten", "inbox"]);

// Opaque identifier prefixes minted by core-auth (see ID_PATTERNS in core-auth.js) plus the
// planned private-realm Home (home_) and inbox (ibx_) ids. `agent:` is deliberately NOT reserved:
// existing fixtures use agent:claude:jared; reserving it needs its own audit and approval.
const PRIVATE_REALM_ID_PREFIXES = Object.freeze(["prin_", "conn_", "acct_", "ten_", "authn_", "tfam_", "walacct_", "home_", "ibx_"]);

// AC1 tools that take a mailbox actor on the unauthenticated surface.
export const AC1_MAILBOX_TOOLS = Object.freeze([
  "cairnstone_send_message",
  "cairnstone_dispatch_handoff",
  "cairnstone_forward_with_note",
  "cairnstone_get_inbox",
  "cairnstone_list_threads",
  "cairnstone_get_thread",
  "cairnstone_read_message",
  "cairnstone_note_self",
  "cairnstone_get_notes",
  "cairnstone_mailbox_policy_preview",
  "cairnstone_run_task_request"
]);

const SINGLE_ACTOR_FIELDS = Object.freeze(["from", "recipient_id", "actor_id", "worker_actor_id"]);
const LIST_ACTOR_FIELDS = Object.freeze(["to"]);

const AC1_MAILBOX_TOOL_SET = new Set(AC1_MAILBOX_TOOLS);

export function resolveRealmGuardMode(env) {
  const raw = typeof env?.AC1_REALM_GUARD === "string" ? env.AC1_REALM_GUARD.trim().toLowerCase() : "";
  return REALM_GUARD_MODES.includes(raw) ? raw : DEFAULT_REALM_GUARD_MODE;
}

/**
 * True when the string names an address in the reserved private realm.
 * Normalises case and whitespace so trivial variants cannot bypass the check.
 */
export function isPrivateRealmActor(value) {
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  if (!text) return false;
  const colon = text.indexOf(":");
  const namespace = colon === -1 ? "" : text.slice(0, colon);
  const identifier = colon === -1 ? text : text.slice(colon + 1);
  if (namespace && PRIVATE_REALM_NAMESPACES.includes(namespace)) return true;
  return PRIVATE_REALM_ID_PREFIXES.some(prefix => text.startsWith(prefix) || identifier.startsWith(prefix));
}

/**
 * Inspect one tool call's arguments. Returns the actor fields that name the private realm.
 * Never echoes the offending value.
 */
export function findPrivateRealmActorFields(toolName, args) {
  if (!AC1_MAILBOX_TOOL_SET.has(toolName)) return { applicable: false, fields: [] };
  const fields = [];
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const field of SINGLE_ACTOR_FIELDS) {
      if (isPrivateRealmActor(args[field])) fields.push(field);
    }
    for (const field of LIST_ACTOR_FIELDS) {
      const value = args[field];
      const items = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
      if (items.some(isPrivateRealmActor)) fields.push(field);
    }
  }
  return { applicable: true, fields };
}

/**
 * Gate for a tool call. Returns null to allow, or a fail-closed error object to return.
 * Only acts on calls with no authenticated context; core-auth calls are bound elsewhere.
 */
export function applyRealmGuard(toolName, args, env, { authContext = null, warn = defaultWarn } = {}) {
  if (authContext) return null;
  const mode = resolveRealmGuardMode(env);
  if (mode === "off") return null;
  const found = findPrivateRealmActorFields(toolName, args);
  if (!found.applicable || !found.fields.length) return null;
  if (mode === "shadow") {
    warn({
      event: "ac1_realm_guard_would_deny",
      tool: toolName,
      fields: found.fields,
      mode
    });
    return null;
  }
  return {
    ok: false,
    status: 403,
    error: "private_realm_actor_forbidden",
    field: found.fields[0],
    fields: found.fields,
    hint: "This address belongs to the authenticated private realm and cannot be named on the legacy surface. Connect through an authenticated endpoint.",
    transport_only: true,
    accepted_state_authority: false
  };
}

function defaultWarn(entry) {
  try { console.warn(JSON.stringify(entry)); } catch { /* logging must never break a request */ }
}
