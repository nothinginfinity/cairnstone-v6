// S1-2b — dormant, dependency-injected MCP transport adapter for the five private inbox tools.
// DORMANT: not imported by src/index.js or src/worker.js, not attached to any endpoint, no binding, no migration.
// This is boundary glue only. It owns NO authorization: identity, Home resolution, capabilities and error
// normalisation stay in the S1-1 bridge, the S0b store and the S1-2 tools. It only (a) decides whether the tools
// exist at all on a given endpoint, (b) takes the bearer from the transport, and (c) shapes MCP envelopes.
//
// Rules this adapter enforces:
//  * ABSENT when off: unless `activate === true` AND real tools (enabled, with the exact S1-2 interface) are injected,
//    the adapter is inert. It lists nothing and handles nothing, so a private tool name is "unknown" to the host,
//    exactly like any unregistered name -- not "callable but disabled".
//  * Fail closed: asking for activation without the injected tools/enabled flag/interface throws at construction.
//  * Core-auth only: tools exist solely for the exact endpoint path /mcp/core-auth. /mcp, /mcp/core and any other
//    path (including case/trailing-slash variants) get nothing.
//  * The bearer comes ONLY from the transport Authorization header. It is never read from the JSON-RPC body,
//    `params`, `_meta` or tool arguments (the tools additionally reject token-shaped arguments).
//  * No onboarding, provisioning, Home selector or actor string is accepted or created here.
//  * Each tool is classified: metadata_read (get/list), body_read (read; stamps read_at), mutation (send/ack).
import { PrivateRealmError } from "./scope.js";
import { PRIVATE_INBOX_TOOL_DEFINITIONS, PRIVATE_INBOX_TOOL_NAMES } from "./private-inbox-tools.js";

export const PRIVATE_CORE_AUTH_ENDPOINT_PATH = "/mcp/core-auth";
const MAX_BEARER_CHARS = 2048;
const BEARER = /^Bearer[ \t]+(csat_[^\s]+)$/;

// Effect classes keep read-only listings, body reads (which stamp read state) and mutations distinguishable.
export const PRIVATE_INBOX_TOOL_EFFECTS = Object.freeze({
  private_inbox_get: "metadata_read",
  private_inbox_list: "metadata_read",
  private_inbox_read: "body_read",
  private_inbox_send: "mutation",
  private_inbox_ack: "mutation"
});

const ANNOTATIONS = Object.freeze({
  metadata_read: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  body_read: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
  mutation: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })
});

const NAME_SET = new Set(PRIVATE_INBOX_TOOL_NAMES);
const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = code => new PrivateRealmError(code);

function describe(definition) {
  const effect = PRIVATE_INBOX_TOOL_EFFECTS[definition.name];
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: ANNOTATIONS[effect],
    _meta: Object.freeze({ "cairnstone/effect": effect, "cairnstone/realm": "private-home" })
  });
}

export const PRIVATE_INBOX_MCP_DESCRIPTORS = Object.freeze(PRIVATE_INBOX_TOOL_DEFINITIONS.map(describe));

// Read the Authorization header from a Headers-like or plain object. Anything but a single well-formed
// `Bearer csat_...` credential yields null (never a partial or lenient parse).
export function bearerFromHeaders(headers) {
  let raw;
  if (headers && typeof headers.get === "function") raw = headers.get("authorization");
  else if (isPlain(headers)) {
    const keys = Object.keys(headers).filter(k => k.toLowerCase() === "authorization");
    if (keys.length === 1) raw = headers[keys[0]];
  }
  if (typeof raw !== "string" || raw.length > MAX_BEARER_CHARS) return null;
  const match = BEARER.exec(raw);
  return match ? match[1] : null;
}

const inert = Object.freeze({
  active: false,
  listTools: () => Object.freeze([]),
  handlesTool: () => false,
  handleRpc: async () => null
});

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(id, payload, isError) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError } };
}

// `tools` is the S1-2 object from createPrivateInboxTools({ bridge, store, enabled: true }). The bridge and store are
// injected into THAT object by the owner at activation time; this adapter never sees or builds them.
export function createPrivateCoreAuthTransport({ tools, activate = false } = {}) {
  if (activate !== true) return inert;
  if (!tools || typeof tools.call !== "function") throw fail("private_transport_bindings_required");
  if (tools.enabled !== true) throw fail("private_transport_tools_not_enabled");
  // Exact interface parity with the S1-2 definitions: same names, same strict schemas, same order.
  if (JSON.stringify(tools.definitions) !== JSON.stringify(PRIVATE_INBOX_TOOL_DEFINITIONS)) throw fail("private_transport_interface_mismatch");

  const onCoreAuth = endpointPath => endpointPath === PRIVATE_CORE_AUTH_ENDPOINT_PATH;

  function listTools({ endpointPath } = {}) {
    return onCoreAuth(endpointPath) ? PRIVATE_INBOX_MCP_DESCRIPTORS : Object.freeze([]);
  }

  function handlesTool(name, { endpointPath } = {}) {
    return onCoreAuth(endpointPath) && typeof name === "string" && NAME_SET.has(name);
  }

  // Returns a JSON-RPC response for a private tools/call on /mcp/core-auth, or null when the request is not ours
  // (every other method, every other endpoint, every other tool name, and every call while inactive) so the host
  // falls through to its existing behaviour unchanged.
  async function handleRpc(rpc, { endpointPath, headers } = {}) {
    if (!onCoreAuth(endpointPath)) return null;
    if (!isPlain(rpc) || rpc.method !== "tools/call") return null;
    const params = rpc.params;
    if (!isPlain(params) || typeof params.name !== "string" || !NAME_SET.has(params.name)) return null;
    const id = Object.prototype.hasOwnProperty.call(rpc, "id") ? rpc.id : null;
    if (rpc.jsonrpc !== "2.0" || !(typeof id === "string" || typeof id === "number" || id === null)) {
      return rpcError(null, -32600, "Invalid Request");
    }
    if (params.arguments !== undefined && !isPlain(params.arguments)) return rpcError(id, -32602, "Invalid params");
    const bearer = bearerFromHeaders(headers);
    if (bearer === null) return toolResult(id, { ok: false, error: "scope_not_authorized" }, true);
    try {
      const value = await tools.call(bearer, params.name, params.arguments === undefined ? {} : params.arguments);
      return toolResult(id, { ok: true, effect: PRIVATE_INBOX_TOOL_EFFECTS[params.name], result: value }, false);
    } catch (error) {
      // The S1-2 tools already normalise; this is a second fence so no raw error or detail can ever be framed.
      const code = error instanceof PrivateRealmError && /^[a-z0-9_]{1,64}$/.test(String(error.code)) ? error.code : "private_tool_failed";
      return toolResult(id, { ok: false, error: code }, true);
    }
  }

  return Object.freeze({ active: true, listTools, handlesTool, handleRpc });
}
