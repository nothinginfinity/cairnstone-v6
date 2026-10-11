// S1-2 — dormant, authenticated private inbox tools (get / list / read / send / ack).
// DORMANT: not imported by src/index.js or src/worker.js, not registered in any tool list, no binding, no migration.
// DEFAULT OFF: every call fails with `private_tools_disabled` unless the owner constructs the tools with `enabled: true`.
//
// Authority model (inherited from S1-1, never widened here):
//  * Identity comes ONLY from the S1-1 bridge (`authorizeHome`), i.e. a verified Core-auth access token for the
//    exact /mcp/core-auth resource. The token is a server/transport input, never a tool argument.
//  * Callers address inboxes by (plane, kind) only. Inbox ids, Home ids, account/tenant/principal/connection ids,
//    actor strings, roles and capabilities are never accepted from a caller; ids are derived server-side.
//  * Only the caller's own Home inboxes and own connection-private inboxes are addressable. A sibling connection's
//    private inbox has no derivable address, so it is unreachable even for an admin.
//  * Capabilities are decided by the S0b store at every call (`read` / `send` / `ack`); admin role alone grants none.
//  * Failures are normalised: only a stable PrivateRealmError code crosses this boundary (no detail, no raw text).
import { PrivateRealmError, ID_PATTERNS } from "./scope.js";

const PLANES = Object.freeze(["chat", "work"]);
const KINDS = Object.freeze(["home", "connection"]);
const MAX_BODY_CHARS = 65536;
const MAX_TARGETS = 20;
const MAX_LIMIT = 200;

export const PRIVATE_INBOX_TOOL_NAMES = Object.freeze([
  "private_inbox_get", "private_inbox_list", "private_inbox_read", "private_inbox_send", "private_inbox_ack"
]);

// Fields that look like authority. Presence in tool arguments is a hard rejection, not an ignored field.
const FORBIDDEN_ARGS = Object.freeze(new Set([
  "access_token", "token", "authorization", "account_id", "tenant_id", "principal_id", "connection_id", "home_id",
  "inbox_id", "from_inbox_id", "to_inbox_ids", "actor", "from", "role", "home_role", "scope", "capability",
  "capabilities", "selector", "provider_label", "client_family", "resource"
]));

const ref = {
  type: "object", additionalProperties: false, required: ["plane", "kind"],
  properties: { plane: { enum: PLANES }, kind: { enum: KINDS } }
};

export const PRIVATE_INBOX_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "private_inbox_get",
    description: "Show your own Home and connection-private inbox addresses and what you may do with each. Takes no arguments.",
    inputSchema: Object.freeze({ type: "object", additionalProperties: false, properties: {} })
  }),
  Object.freeze({
    name: "private_inbox_list",
    description: "List message metadata (no bodies) in one of your own inboxes.",
    inputSchema: Object.freeze({
      type: "object", additionalProperties: false, required: ["inbox"],
      properties: { inbox: ref, limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT } }
    })
  }),
  Object.freeze({
    name: "private_inbox_read",
    description: "Read message bodies in one of your own inboxes. First read marks messages read.",
    inputSchema: Object.freeze({
      type: "object", additionalProperties: false, required: ["inbox"],
      properties: { inbox: ref, limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT } }
    })
  }),
  Object.freeze({
    name: "private_inbox_send",
    description: "Send a message from one of your own inboxes to your own inboxes. Idempotent by message_id.",
    inputSchema: Object.freeze({
      type: "object", additionalProperties: false, required: ["from_inbox", "to_inboxes", "message_id", "body"],
      properties: {
        from_inbox: ref,
        to_inboxes: { type: "array", minItems: 1, maxItems: MAX_TARGETS, items: ref },
        message_id: { type: "string", minLength: 8, maxLength: 120 },
        thread_id: { type: "string", minLength: 1, maxLength: 120 },
        body: { type: "string", minLength: 1, maxLength: MAX_BODY_CHARS }
      }
    })
  }),
  Object.freeze({
    name: "private_inbox_ack",
    description: "Acknowledge one delivered message in one of your own inboxes.",
    inputSchema: Object.freeze({
      type: "object", additionalProperties: false, required: ["inbox", "message_id"],
      properties: { inbox: ref, message_id: { type: "string", minLength: 8, maxLength: 120 } }
    })
  })
]);

const fail = code => new PrivateRealmError(code);
const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);

function checkKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_ARGS.has(key)) throw fail("caller_selectors_forbidden");
    if (!allowed.includes(key)) throw fail("invalid_arguments");
  }
}

function parseRef(value) {
  if (!isPlain(value)) throw fail("invalid_arguments");
  checkKeys(value, ["plane", "kind"]);
  if (!PLANES.includes(value.plane) || !KINDS.includes(value.kind)) throw fail("invalid_arguments");
  return { plane: value.plane, kind: value.kind };
}

function parseLimit(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw fail("invalid_arguments");
  return value;
}

// Only a stable code crosses the boundary. Detail (which may name inboxes/homes) and raw error text never do.
function normalise(error) {
  if (error instanceof PrivateRealmError && typeof error.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code)) {
    return new PrivateRealmError(error.code);
  }
  return new PrivateRealmError("private_tool_failed");
}

export function createPrivateInboxTools({ bridge, store, enabled = false } = {}) {
  if (typeof bridge?.authorizeHome !== "function") throw fail("private_inbox_bridge_required");
  for (const method of ["listInboxes", "can", "send", "listInbox", "readInbox", "ack"]) {
    if (typeof store?.[method] !== "function") throw fail("private_home_store_required");
  }
  const on = enabled === true;

  const inboxOf = (auth, r) => auth.addresses[r.plane][r.kind].inbox_id;
  const refOfInbox = (auth, inboxId) => {
    for (const plane of PLANES) for (const kind of KINDS) {
      if (auth.addresses[plane][kind].inbox_id === inboxId) return Object.freeze({ plane, kind });
    }
    return null;
  };
  const sel = auth => ({ homeId: auth.home_id });

  async function get(auth) {
    const listings = await store.listInboxes(auth.scope, sel(auth));
    const granted = new Set(listings.filter(i => i.granted).map(i => i.inbox_id));
    const inboxes = {};
    for (const plane of PLANES) {
      inboxes[plane] = {};
      for (const kind of KINDS) {
        const address = auth.addresses[plane][kind];
        const accessible = granted.has(address.inbox_id);
        const capabilities = {};
        for (const cap of ["read", "send", "ack"]) {
          capabilities[cap] = accessible && await store.can(auth.scope, address.inbox_id, cap, sel(auth));
        }
        inboxes[plane][kind] = Object.freeze({ address: address.address, scope: address.scope, capabilities: Object.freeze(capabilities) });
      }
      Object.freeze(inboxes[plane]);
    }
    return Object.freeze({ role: auth.role, inboxes: Object.freeze(inboxes) });
  }

  function shapeMessages(auth, rows) {
    return Object.freeze(rows.map(row => Object.freeze({ ...row, sender: refOfInbox(auth, row.sender_inbox_id) })));
  }

  async function dispatch(auth, name, args) {
    switch (name) {
      case "private_inbox_get": {
        checkKeys(args, []);
        return get(auth);
      }
      case "private_inbox_list":
      case "private_inbox_read": {
        checkKeys(args, ["inbox", "limit"]);
        const inboxId = inboxOf(auth, parseRef(args.inbox));
        const limit = parseLimit(args.limit);
        const opts = limit === undefined ? { inboxId } : { inboxId, limit };
        const rows = name === "private_inbox_list"
          ? await store.listInbox(auth.scope, opts, sel(auth))
          : await store.readInbox(auth.scope, opts, sel(auth));
        return Object.freeze({ messages: shapeMessages(auth, rows) });
      }
      case "private_inbox_send": {
        checkKeys(args, ["from_inbox", "to_inboxes", "message_id", "thread_id", "body"]);
        const from = parseRef(args.from_inbox);
        if (!Array.isArray(args.to_inboxes) || args.to_inboxes.length < 1 || args.to_inboxes.length > MAX_TARGETS) throw fail("invalid_arguments");
        const targets = args.to_inboxes.map(parseRef);
        if (typeof args.message_id !== "string" || !ID_PATTERNS.message.test(args.message_id)) throw fail("invalid_arguments");
        if (args.thread_id !== undefined && (typeof args.thread_id !== "string" || !ID_PATTERNS.thread.test(args.thread_id))) throw fail("invalid_arguments");
        if (typeof args.body !== "string" || args.body.length < 1 || args.body.length > MAX_BODY_CHARS) throw fail("invalid_arguments");
        const result = await store.send(auth.scope, {
          fromInboxId: inboxOf(auth, from),
          toInboxIds: targets.map(t => inboxOf(auth, t)),
          messageId: args.message_id,
          ...(args.thread_id === undefined ? {} : { threadId: args.thread_id }),
          body: args.body
        }, sel(auth));
        return Object.freeze({ ...result });
      }
      case "private_inbox_ack": {
        checkKeys(args, ["inbox", "message_id"]);
        const inboxId = inboxOf(auth, parseRef(args.inbox));
        if (typeof args.message_id !== "string" || !ID_PATTERNS.message.test(args.message_id)) throw fail("invalid_arguments");
        const result = await store.ack(auth.scope, { inboxId, messageId: args.message_id }, sel(auth));
        return Object.freeze({ ...result });
      }
      default:
        throw fail("unknown_private_tool");
    }
  }

  // `accessToken` is a transport/server input (Authorization bearer), never part of `args`.
  async function call(accessToken, name, args) {
    if (!on) throw fail("private_tools_disabled");
    if (!PRIVATE_INBOX_TOOL_NAMES.includes(name)) throw fail("unknown_private_tool");
    try {
      const auth = await bridge.authorizeHome(accessToken);
      if (args !== undefined && !isPlain(args)) throw fail("invalid_arguments");
      return await dispatch(auth, name, args === undefined ? {} : args);
    } catch (error) {
      throw normalise(error);
    }
  }

  return Object.freeze({ call, definitions: PRIVATE_INBOX_TOOL_DEFINITIONS, enabled: on });
}
