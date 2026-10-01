# V7.7.11i — Stone Inspector + Universal Object Deep Links

Status: IMPLEMENTATION SLICES 11i.0 + 11i.1 + 11i.2 + 11i.3 + 11i.4a

## Goal

Make CairnStone identities emitted inside AI-host responses useful as links rather than opaque hashes. A typed object reference should open the richest surface the current host supports while CairnStone remains the durable object and authority layer:

`native host inspector -> MCP/App surface -> CairnStone HTTPS inspector -> ordinary HTTPS fallback`

The host UI is a projection only. Rendering never creates accepted-state, execution, mutation, or access authority.

## Reuse the existing object grammar

V7.7.11i does not create a second identity namespace. It consumes the V7.7.10b typed `object_ref` grammar and normalizer, including `stone:`, `ac1:`, `msg:`, immutable `repo:owner/repo@sha`, `session:`/`cs:`, `conversation:`/`cvs:`, `turn:`, `cmsg:`, `response:`, `grant:`, and `tr:`.

## `cairnstone-object-link-v1`

Every supported typed reference can produce a link envelope containing:

- the canonical `object_ref` and object `kind`;
- a stable HTTPS inspector URL;
- a compact safe label/title when available;
- host-native rendering hints only;
- an explicit ordinary-HTTPS fallback;
- policy evidence that UI rendering is not authority;
- no raw capability bearer or secret in the URL.

The stable route is `/inspect?ref=<canonical-object-ref>`. In 11i.2 the same URL renders the mobile-first visual inspector without changing object identity. Machine-readable clients can use `/v1/object-inspect` or append `format=json` to the stable inspector URL.

## `cairnstone_object_inspect`

Output schema: `cairnstone-object-inspector-v1`.

### Stone objects

The first implementation fully hydrates safe Stone objects with:

- full canonical hash, title, author, time, and LOD5 summary;
- chain/repository/path/immutable Git provenance;
- accepted-state classification from real `chain_heads` / `path_heads` pointers (`CHAIN_HEAD`, `PATH_HEAD`, or historical/unscoped classification); timestamp ordering is never authority;
- bounded exact inbound/outbound rows from `stone_edges`;
- bounded related Stone cards;
- a small graph payload using those exact stored edges;
- the universal object-link envelope;
- explicit read-only / zero-authority policy fields.

### Other typed refs

11i.0 returns a canonical deep-link envelope but does not broadly hydrate operational/private object kinds yet. Their object-specific access paths remain authoritative for visibility.

## Security boundary

**A relationship does not grant visibility.**

A Stone that is backed by AC1 correspondence is not generically hydrated by the universal inspector. It returns a restricted envelope and requires the object-specific authenticated correspondence path. Likewise, related correspondence-backed Stones appear only as ref-safe restricted placeholders; their title, sender, recipients, thread, body, and other private metadata are not surfaced.

If the inspector cannot determine whether a Stone is correspondence-backed, it fails closed rather than falling back to broad hydration.

## Non-authority invariants

The inspector:

- is read-only;
- never moves `chain_heads` or `path_heads`;
- never mints or widens capabilities;
- never treats mutable Git branches or timestamps as authority;
- never invents graph relationships;
- never treats host-native rendering as authority.

## 11i.2 mobile-first HTTPS inspector

The stable HTTPS route now renders a responsive, iframe-compatible inspector with Summary, Graph, Source, Related, and Messages surfaces. The graph is a bounded projection of exact stored `stone_edges`; restricted related objects remain ref-safe placeholders and their edge notes stay redacted. Source links are emitted only when repository/path provenance is paired with a real immutable 40-hex commit. The page is `private, no-store`, HTML-escapes stored metadata, applies a restrictive CSP, includes no raw secret/capability bearer, and preserves a `format=json` view for machine-readable inspection.

The Messages surface is deliberately access-bound in this slice: it explains the authenticated correspondence boundary but never hydrates private AC1/message content through the universal inspector. Full object-specific authenticated projections remain 11i.4.

## 11i.3 native MCP/App inspector

The existing read-only `cairnstone_object_inspect` tool now advertises one versioned MCP Apps resource at `ui://cairnstone/stone-inspector-v1.html`. This is intentionally attached to the existing inspector rather than creating a second render tool: non-UI clients retain the ordinary text result, while UI-capable hosts receive the same `cairnstone-object-inspector-v1` envelope as `structuredContent`.

The hand-rolled MCP transport now advertises resource capability and supports `resources/list` and `resources/read`. The inspector resource is served as `text/html;profile=mcp-app`, initializes through the MCP Apps `ui/*` bridge, accepts `ui/notifications/tool-result`, and advertises inline/fullscreen presentation. The tool uses the standard `ui.resourceUri` metadata plus the OpenAI `openai/outputTemplate` compatibility alias.

The native app remains a thin projection over CairnStone state: it performs no direct mutation, contains no capability bearer, renders stored values with DOM text primitives rather than HTML injection, and preserves the HTTPS inspector as fallback. Graph relationships still do not grant visibility and message-backed content remains behind authenticated object-specific surfaces.

## 11i.4a authenticated correspondence projection

First slice of authenticated object-specific projections. It covers exactly one family: correspondence-backed Stones (`stone:`, `ac1:`, `msg:` refs). Every other object kind remains link-only.

**Identity.** The viewer is established only by a verified signed mailbox capability (`verifyMailboxCapability`, scope `mail.read:self`) presented together with `principal_actor_id`. An asserted principal id, a URL parameter, or a graph edge never authorizes anything. A presented-but-unusable capability fails closed with `inspector_viewer_authentication_failed` and a stable reason code, even for an otherwise public Stone; the verifier's other fields (such as a mismatching principal) are never echoed.

**Surfaces.** Only `POST /v1/object-inspect` opts in (`{ viewerAuth: true }`), reading the capability from the JSON body. It answers 401 on authentication failure and always sends `cache-control: private, no-store`. `GET /inspect` never reads a capability from the URL, so no bearer can appear in a deep link. The MCP tool path does not opt in: a presented capability is rejected with `viewer_authentication_not_available_on_this_surface` rather than honored or silently ignored, which keeps the tool's registered `read` / `automatic` classification truthful.

**Authorization.** The object-specific rule is a `correspondence_deliveries` row whose `recipient_id` equals the verified principal. It is recipient-only, matching the existing inbox/read path; a sender who is not also a recipient is not authorized. Any lookup error denies.

**No oracle.** An authenticated caller who is not authorized receives exactly the envelope an anonymous caller receives (only the `viewer` / `policy.authenticated_projection` fields differ). An unauthorized `ac1:` or `msg:` ref stays link-only. A `msg:` ref resolves only through the principal's own deliveries; if it matches more than one Stone it fails closed to link-only with `ambiguous_message_ref`.

**Projection.** An authorized recipient receives the ordinary hydrated Stone inspection plus a minimal `correspondence` block: message id, sender, the principal's own delivery status/timestamps, and thread id. It never includes the body, other recipients (`other_recipients_disclosed: false`), or any capability. Related correspondence Stones are upgraded from placeholders to full cards only when the principal is also a recipient of that related Stone; edge notes stay redacted for every target that remains restricted.

**Read-only guarantee.** The inspector issues only `SELECT`s. It never advances delivery or read state (`cairnstone_read_message` still owns that), never moves `chain_heads` / `path_heads`, and never mints or widens a capability. Policy fields `delivery_state_mutated: false` and `message_body_returned: false` make this explicit in every response.

### Open decisions carried forward

1. **MCP exposure of authenticated mode.** Either reclassify `cairnstone_object_inspect` from `automatic` to `scoped_grant` (which would stop delegate loops from using it for safe Stones) or add a separate `scoped_grant` tool for the authenticated projection. A separate tool is recommended; neither is implemented.
2. **Sender visibility.** Recipient-only is the conservative default. Allowing a sender to inspect their own sent messages would be a new visibility surface and needs an explicit decision.
3. **Scope vocabulary for other kinds.** Grants, Task Runs, Conversation/Code Sessions, and Grounded Responses each have a per-kind visibility rule in their own modules, but the existing signed scopes (`mail.read:self`, `mail.reply:self`, `task.consume:self`) are mailbox-shaped. Reusing `mail.read:self` for non-mail objects would stretch it, so a new scope name is a separate, explicit authorization change.

## Next slices
- **11i.4b+** — remaining authenticated projections (sessions, responses, task runs, receipts, grants), gated on open decision 3.
- **11i.5** — cross-host acceptance tests and deep-link parity.
