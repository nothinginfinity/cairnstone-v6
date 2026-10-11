# S1-1 — authenticated Identity-to-Home bridge (dormant candidate)

**DRAFT ONLY**, stacked on PR #74; no route, imported production entrypoint, private binding, migration, provisioned Home, merge, deployment, guard activation, legacy claim, or accepted-state promotion.

## Authority contract

`createCoreAuthIdentityHomeBridge({env, store, resource, admitOnboarding, inboxDerivationKey})` wires the existing `validateAccessToken` Core-auth verifier with its exact /mcp/core-auth audience, not a decoded/unsigned token, request actor, or a foreign-provider credential. The dependency-injected `createIdentityHomeBridge` is for unit tests and trusted server composition only, never for client-side invocation. It requires the existing `cairnstone-core-auth-context-v1` shape, realm=core-auth, active account/connection/family, `mcp:core` scope, token-family ID and valid account/tenant/principal/connection IDs. Context is returned only by the validator, not a request argument. The validator is called again before writes; no globally atomic Core-auth/private-D1 transaction is claimed.

`authContext.client_family` is the Core-auth source field; `provider_label` is merely sanitized metadata, never a Home identifier. The underlying S0b store remains sole authority for Home association, account/tenant/principal conflicts, connection revocation, roles, inbox grants, and last-admin protection.

A second independent, server-injected `admitAdminRecovery(context)` hook defaults to deny. When it explicitly authorizes recovery, the bridge may request `home_role: admin` from S0b, which permits a new connection to become admin only if the Home has **no** active admin. This never grants the new admin access to connection-private content or old Home inbox grants; SQL enforces the role decision under concurrent attachments. The owner controls both bootstrap and recovery admission independently.

The bridge has two server-only methods:

- `onboard(accessToken)` requires a **server-injected**, explicitly affirmative `admitOnboarding(context)` callback, default-deny. It calls `ensureDefaultHome` and uses the returned Home ID. Not a public route or automatic first-use path.
- `inspect(accessToken)` is strictly non-provisioning and returns the connection's **visible** inbox metadata; it never mints identities, reads bodies, or resolves a Home from a caller-supplied selector.

There are deliberately **no** caller-supplied account/tenant/principal/connection/Home/inbox/actor/options parameters. An extra request argument is rejected, including `{}`. Do not expose a `validateToken` function or the derivation key to untrusted callers.

## Addresses and capabilities

Home inboxes and connection-private inboxes are kept separate for both `chat` and `work` planes. Stable IDs use a versioned HMAC-SHA256 keyed derivation over `(scope, Home ID, connection ID if private, plane)` and are mapped as `inbox:ibx_<opaque>`. The key must be a protected server-only secret retained for future sessions and export/import; changing it without a migration plan changes all deterministic IDs.

A newly created Home has an initial admin as defined by S0b store. Initial Home-owned inboxes are created only by an admitted admin; the store creates an explicit grant for private inbox owners. The bridge issues a full Home inbox grant **only for a newly created inbox**, and only to the creating admin; an existing revoked grant is never silently resurrected. A new attached provider gets its own private inboxes, **zero implicit Home grants**, and no sibling-private access even when promoted admin. Admin role is control-plane metadata, not mailbox-body permission; `listInboxes` and `can` are rechecked to display capabilities.

Creation is idempotent under simultaneous requests through S0b's guarded SQL and unique indexes. Partial failure after a Home or inbox create may require an approved retry/manual grant; it must not auto-restore a revoked grant. Private Home-owned history persists after provider revocation; no data is copied into public/legacy AC1. Provider changes do not change Home ownership.

## Evidence and acceptance gates

`test/private-realm-identity-home-bridge.test.js` exercises fail-closed token contexts, resource/audience enforcement, ownership portability, same-provider distinct accounts, tenant/connection replay, selector spoofing, Home/private inbox isolation, explicit grants, last-admin safety, revocation, repeat admission and SQLite-backed D1 races using the existing migration harness. `npm run check` includes syntax checking of the dormant bridge and the full `node --test` suite. GitHub Actions test gate (inherited from PR #74) is TEST ONLY.

**Not proven by local SQLite/CI:** production Core-auth gateway/binding caller integrity, real private Cloudflare D1 batch/trigger/RETURNING/changes semantics, global response-boundary revocation, cross-isolate signed-envelope nonce replay, atomic audit with mutation, orphan private-R2 cleanup, backup/portability export-import and rotation of the inbox HMAC key. These are separate owner review and live acceptance gates.

**Operator decisions still open:** automatic vs explicit first-connection bootstrap; legacy claim proof and L0–L3 transition/sunset. This draft chooses *explicit default-deny* rather than making that policy decision implicitly.

Never enable S1-1 on a public Worker or share the private binding with legacy tool/REST/Stone/FTS/R2 code paths. No production storage or migration should be touched as part of draft review.
