# V7.7.11j — Semantic Firewall / Stone-Addressed Social Layer

Status: **ROADMAP-ACCEPTED DIRECTION / FUTURE SLICE.** Build after the V7.7.11i Stone Inspector/object-resolution path and the required authenticated identity/access boundaries are sufficiently accepted. This slice does not authorize autonomous social publishing by itself.

## Goal

Use public social/network surfaces as a transport for compact CairnStone object addresses while CairnStone remains the semantic, authority, access-control, and provenance plane.

The core pattern is:

```text
public social post / profile / feed
  -> compact typed CairnStone object reference
  -> CairnStone resolver / inspector
  -> identity + object-specific access policy
  -> exact Stone/object payload
  -> bounded related graph / provenance / context
  -> authorized agent reasoning
```

A public platform can therefore carry the **address of meaning** without carrying the full semantic payload itself.

## Core distinction: semantic opacity is not encryption

A Stone hash is a content address, not a secret and not an encryption key.

For an observer without a CairnStone resolver, a post such as:

```text
stone:5406eefbda10c927b8f4cef3b315e962f8a11e20ad007c64b58d9c18cc7eef5d
```

is intentionally low-semantic-bandwidth: the identifier alone does not reconstruct the source content, LODs, graph neighborhood, provenance, or accepted-state classification.

For an authorized CairnStone-connected agent:

```text
object_ref
  + authenticated resolver
  + object-specific authorization
  -> exact object
  -> permitted semantic neighborhood
```

Therefore V7.7.11j MUST distinguish:

1. **semantic opacity** — ordinary humans/clients see an opaque address;
2. **public resolvability** — intentionally public Stones may resolve without private access;
3. **authenticated semantic resolution** — restricted Stones resolve only for authorized principals;
4. **cryptographic confidentiality** — where required, confidentiality comes from authenticated storage/resolution and optional encryption, never from assuming a SHA-256 hash is secret.

Do not market raw hash opacity as encryption.

## Reuse existing object identity

V7.7.11j MUST build on the existing typed object-ref grammar and V7.7.11i universal object-link/inspector work. It must not introduce a second Stone namespace.

Initial public pointer forms may include:

- `stone:<full-hash>`;
- another already-canonical typed `object_ref` where public projection is explicitly permitted;
- a stable CairnStone HTTPS inspector/deep link whose URL contains no bearer capability or secret.

A raw full Stone hash may be recognized as a compatibility form, but typed refs are preferred because they preserve object kind and avoid ambiguous parsing.

## V7.7.11j.0 — Semantic pointer contract

Define a bounded `cairnstone-social-pointer-v1` projection over an existing canonical `object_ref`.

Suggested fields:

- canonical `object_ref`;
- `kind`;
- immutable object/content identity where applicable;
- projection mode: `opaque`, `public-resolvable`, `authenticated-resolvable`;
- stable inspector/resolver URL when safe;
- optional compact human label only when policy explicitly allows it;
- source/projection platform hint;
- no raw access token, capability bearer, secret, private participant identity, or private metadata.

The pointer is a projection/transport object only. It grants zero read, discuss, execute, mutation, publication, or economic authority.

## V7.7.11j.1 — Authenticated semantic resolver boundary

Resolution policy must be enforced beneath every host adapter.

Requirements:

- public Stones may resolve through an explicitly public policy;
- restricted Stones require authenticated principal + object-specific permission/grant;
- knowledge of a Stone hash alone never grants access;
- graph-edge existence never grants target visibility;
- unauthorized resolution does not leak title, author, participants, chain membership, relationship labels, payload size, private timestamps, or other useful oracle metadata beyond the minimum safe error envelope;
- resolver behavior is consistent across MCP, HTTPS inspector, Console, and host-native surfaces;
- access revocation blocks future resolution without pretending previously read data can be erased from an external model/user.

## V7.7.11j.2 — Stone-only social feed pilot

Use X as the first distribution experiment because CairnStone already has X/Grok integration and the `x-posts` chain.

A dedicated account may intentionally publish posts containing only Stone/object references, for example:

```text
stone:5406eefbda10c927b8f4cef3b315e962f8a11e20ad007c64b58d9c18cc7eef5d
```

or a canonical CairnStone deep link.

Expected behavior:

- an ordinary viewer sees an opaque pointer;
- an ordinary model without CairnStone access can copy/classify the identifier but cannot reconstruct the stored payload from the identifier alone;
- a CairnStone-connected agent recognizes the pointer, resolves it under policy, and can recover the permitted Stone/LOD/provenance/graph context;
- the same pointer can be moved between X, chat, email, GitHub, a webpage, or another social network without changing object identity.

This creates an **agent-readable social layer** on top of existing public distribution networks without making those networks CairnStone authority.

## V7.7.11j.3 — Social projection receipt + governed publishing

Reuse V7.7.10k X Action Connectors / Governed Social Operator for actual posting. V7.7.11j defines what semantic pointer is projected; V7.7.10k governs whether/how an external action is executed.

Define a `cairnstone-social-projection-receipt-v1` or equivalent receipt binding:

- canonical `object_ref`;
- platform + account/actor identity;
- external post/item ID and URL where available;
- exact projected text/digest;
- projection mode and access-policy class;
- idempotency/replay identity;
- created/observed timestamps;
- publication authorization/confirmation receipt when required.

External deletion/editing changes the projection, not the underlying Stone. Stone accepted state is never derived from social-platform state.

## V7.7.11j.4 — Provider-neutral social addressing

Do not hard-code the architecture to X.

After the X pilot, prove the same canonical pointer/resolver semantics across at least one additional public transport such as Bluesky, Mastodon, GitHub, a website/feed, or another MCP-accessible channel.

The social platform supplies distribution and discovery. CairnStone supplies object identity, access, semantic resolution, graph context, provenance, and continuity.

## Security / privacy invariants

- **Hash != capability.** Possession of a Stone hash never grants restricted access.
- **Pointer != authority.** Posting, quoting, forwarding, embedding, or indexing a pointer grants zero new authority.
- **No bearer in public URLs/posts.** Capabilities/tokens/secrets never appear in social pointers.
- **No metadata oracle.** Unauthorized resolution is deliberately bounded and non-enumerative.
- **No graph leakage.** Related-object existence/labels do not reveal restricted target metadata.
- **No social-source promotion.** A social post never becomes accepted CairnStone state merely because it references a Stone.
- **No host lock-in.** X/Grok, ChatGPT, Claude, Console, or another host can resolve the same object identity under the same policy.
- **Deletion independence.** Removing an external social projection does not delete the CairnStone object; deleting/revoking CairnStone access does not rewrite historical external posts.
- **Rights remain explicit.** Permission to read a Stone does not imply permission to publicly project/publish it.
- **Enumeration resistance.** Public resolver/search surfaces remain bounded, rate-limited, and policy-aware; hash space opacity is defense-in-depth, not the access-control mechanism.

## Relationship to existing roadmap

- **V7.7.10i** supplies account/connection identity and authenticated authorization roots.
- **V7.7.10b** supplies typed object refs and Access Grants.
- **V7.7.10k** supplies governed X/social actions and confirmation/idempotency policy.
- **V7.7.11h** supplies host-native plugin/app distribution surfaces.
- **V7.7.11i** supplies universal deep links, Stone Inspector, exact object resolution, and authenticated related-object projection.
- **V7.8 StoneLink** can later generalize discovery/resolution across independently owned CairnStone nodes; V7.7.11j should remain useful before federation exists.

## Acceptance

V7.7.11j is accepted only when live tests prove at minimum:

- a public X post containing only a canonical Stone pointer resolves to the exact intended Stone for an authorized CairnStone-connected agent;
- the identifier alone does not contain enough information to reconstruct the original Stone body/LOD/graph without a resolver or another independent copy of the content;
- a restricted Stone remains unreadable when the same hash is supplied by an unauthenticated or unauthorized actor;
- unauthorized resolution does not expose restricted title/body/participants/graph metadata;
- an authorized principal receives the exact allowed object plus bounded permitted relationships;
- no capability bearer or secret is present in the external post, URL, receipt, or host-visible pointer;
- publishing/reposting the pointer changes no CairnStone chain/path HEAD or access grant;
- revocation blocks subsequent restricted resolution while preserving immutable audit/projection receipts;
- the same pointer resolves consistently from at least two independent hosts/transports;
- at least one Stone-only social account/feed can be consumed meaningfully by CairnStone-connected agents while remaining intentionally opaque to ordinary viewers;
- documentation explicitly states that semantic opacity is not cryptographic encryption.

## Product thesis

The durable design principle is:

> **Public networks can carry symbols; CairnStone resolves their governed meaning.**

Or, equivalently:

```text
public symbol -> private/policy-bound semantic resolution
```

This creates a provider-neutral, Stone-addressed social layer where the visible message may be tiny while the authorized semantic payload includes the exact object, provenance, accepted-state classification, and permitted graph context.
