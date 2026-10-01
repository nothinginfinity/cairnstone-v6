# V7.7.11i — Stone Inspector + Universal Object Deep Links

Status: IMPLEMENTATION SLICE 11i.0 + 11i.1

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

The stable route is `/inspect?ref=<canonical-object-ref>`. In 11i.0/11i.1 it may return the read-only machine-readable inspector envelope; the later 11i.2 surface may render the same URL as a mobile-first visual inspector without changing object identity.

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

## Next slices

- **11i.2** — mobile-first HTTPS visual inspector (Summary / Graph / Source / Related / Messages where authorized).
- **11i.3** — native MCP/App card/modal/fullscreen projection.
- **11i.4** — authenticated object-specific related projections for messages, sessions, responses, task runs, receipts, and other typed objects.
- **11i.5** — cross-host acceptance tests and deep-link parity.
