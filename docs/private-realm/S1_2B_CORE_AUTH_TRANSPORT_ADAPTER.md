# S1-2b — Core-auth MCP transport adapter for the private inbox tools (DORMANT, unregistered)

Status: code, tests and docs only. `src/private-realm/private-core-auth-transport.js` is **not imported** by `src/index.js`, `src/worker.js` or `src/core-auth.js`, is attached to no endpoint, and adds no binding, migration, config switch or secret. Merging it changes no production behaviour: `/mcp`, `/mcp/core` and `/mcp/core-auth` list and serve exactly what they did before. This is source/CI acceptance only, not live-service acceptance.

## What it is

A pure, dependency-injected boundary adapter over the S1-2 tools (`createPrivateInboxTools(...)`). It owns no authorization. Identity, Home resolution, capabilities and error normalisation remain in the S1-1 bridge, the S0b store and the S1-2 tools. The adapter only decides whether the tools exist on an endpoint, reads the bearer from the transport, and frames MCP envelopes.

```js
createPrivateCoreAuthTransport({ tools, activate })
// -> { active, listTools({ endpointPath }), handlesTool(name, { endpointPath }), handleRpc(rpc, { endpointPath, headers }) }
```

## Contract

| Property | Behaviour |
|---|---|
| Absent when off | Unless `activate === true`, the adapter is inert: `listTools` is empty, `handlesTool` is false, `handleRpc` returns `null`. A private tool name is then exactly as unknown to the host as any unregistered name (the host's existing `tool_not_in_core_profile` path). It is never "callable but returns disabled". Truthy-but-not-`true` values (`1`, `"true"`, `{}`) stay inert. |
| Fail closed | `activate: true` without an injected tools object with `call`, with `enabled !== true`, or whose `definitions` differ from the S1-2 definitions throws `private_transport_bindings_required`, `private_transport_tools_not_enabled` or `private_transport_interface_mismatch`. The S1-2 tools' own bridge and store are injected into that object by the owner; the adapter never builds or sees them, so absent private store or key bindings fail at tool construction. |
| Exact endpoint | Tools exist only for `endpointPath === "/mcp/core-auth"`. `/mcp`, `/mcp/core`, `/mcp-b`, case, trailing-slash and query variants get nothing. |
| Bearer from transport only | The bearer is parsed solely from the `Authorization` header (`Bearer csat_...`, one header, bounded length). A token in the JSON-RPC body, `params`, `_meta` or tool arguments is never used; tokens in arguments are additionally rejected by the S1-2 tools. A missing or malformed bearer returns `scope_not_authorized` without invoking any tool. |
| Resource binding | The adapter passes the token to the tools; the S1-1 bridge verifies it for the exact `expectedResource` and checks realm, schema, scope and account, connection and token-family status. |
| No onboarding | There is no first-use provisioning. An unprovisioned caller gets `scope_not_authorized` and nothing is created. |
| Effect classes | Descriptors carry `_meta["cairnstone/effect"]` and annotations: `private_inbox_get`/`list` = `metadata_read` (read-only); `private_inbox_read` = `body_read` (not read-only: first read stamps `read_at`); `private_inbox_send`/`ack` = `mutation`. Each result frame echoes the effect. |
| Interface parity | Descriptor `inputSchema` and `description` are the S1-2 definitions verbatim (`additionalProperties: false`, no token or selector fields). |
| Pass-through | `handleRpc` returns `null` for every other method (`initialize`, `ping`, `tools/list`, anything unknown), every other tool name (including case, whitespace and prototype tricks), every other endpoint and every call while inactive, so the host's legacy behaviour is untouched. |
| Envelope errors | Malformed envelopes for a private tool (`jsonrpc` not `"2.0"`, object/array `id`) give `-32600`; non-object `arguments` gives `-32602`; nothing is executed. |
| Error normalisation | Tool failures are framed as `{ok:false, error:<stable code>}` with `isError: true`. Any non-`PrivateRealmError`, or a code outside `[a-z0-9_]{1,64}`, becomes `private_tool_failed`. Error detail and raw text never reach a frame. |

## Host wiring (NOT done here; this is the activation gate)

A future, separately authorized change would, inside `handleMcp` on the `auth` profile only, after the existing `enforceCoreAuthRequest` gate: (1) call `adapter.handleRpc(rpc, { endpointPath: "/mcp/core-auth", headers: request.headers })` and return its response when non-null, and (2) append `adapter.listTools(...)` to the `tools/list` result. Neither is added in this slice. Registration also needs, outside this repo's source: a real private service binding to the private storage Worker, the inbox derivation key as a secret, an explicit owner admission policy, and an activation decision. `tools/list` discovery on `/mcp/core-auth` is unauthenticated today, so listing the private tool names when active reveals only their existence.

## Tests

`test/private-realm-core-auth-transport.test.js` runs on the in-memory store and on real SQLite via the existing D1 harness, through a test-only injected host harness (a stand-in for `handleMcp`'s fall-through). Coverage: absent-when-off on every endpoint with zero tool invocations; fail-closed activation; exact-path scoping; descriptor and interface parity and effect classes; strict bearer parsing and token smuggling; full send/list/read/ack round trip with idempotent replay and conflict; capability grant and revoke; sibling and tenant isolation with a body sentinel; token audience/realm and stale or revoked account, connection and token-family states; no onboarding and no writes for unprovisioned callers; forged selectors, name tricks, unknown methods and malformed envelopes; double error normalisation; and a dormancy grep (no production import, no env, network, console, onboarding or binding in the module or `wrangler.toml`). Mutation checks (path scoping, activation strictness, enabled check, error pass-through, body-token fallback, read-only misclassification) each broke at least one test.

## Not done / still gated

No registration on any endpoint, no private storage binding or service binding, no D1/R2 migration, no S0 guard activation, no tool enablement, no deploy, no legacy identity claim or migration, no HEAD promotion. Admin-recovery admission stays default deny; the historical Home-content admin self-grant policy is unchanged and still open, as are the items listed in `S1_2_PRIVATE_INBOX_TOOLS.md`.
