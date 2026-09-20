# V7.7.10i — Connector-Bound Identity + Zero-Friction Bootstrap

Status: **PRIORITY / REVIEW-CORRECTED ARCHITECTURE — CairnStone-account-root identity accepted for contract work; implementation not started.**

Priority: **P0 identity gate. Advance before new Console feature expansion, broad multi-account onboarding, or federation work.** Close only necessary in-flight safety/merge work while this contract is stabilized.

## Why this moves forward now

CairnStone must support many users on the same provider and individual users with multiple ChatGPT, Claude, Perplexity, Grok, Cursor, or future MCP accounts. Routing labels such as `perplexity:chat` and `perplexity-2:chat` are useful addresses, but they are not authentication.

The required user experience is intentionally simple:

> Add the CairnStone MCP URL, authenticate to a CairnStone account once, and immediately receive the correct identity, inboxes, tools, workspace access, and Persistent Code Mode state.

The Console-backed CairnStone account is the durable identity home. The URL is discovery/addressing. An authenticator proves control of the account relationship; the OAuth grant authorizes one MCP connection; CairnStone mints and derives the connection principal server-side.

## Core invariant

> **Authenticated CairnStone account -> authorized MCP connection -> immutable connection principal -> mailbox scope -> memberships and entitlements -> operation permissions.**

These dimensions remain separate:

```text
routing alias != connection principal
CairnStone account != authenticator
MCP connection != CairnStone account
wallet account != CairnStone account
wallet address / payment instrument != principal
resource authority != execution authority
execution authority != mutation authority
economic authority != identity authority
```

The durable account survives connector reinstall, wallet rotation, wallet loss/recovery, authenticator replacement, and provider/client changes. Those events may create or retire connections and principals without replacing the account.

## Identity model

- `tenant_id` — personal or organizational security boundary.
- `account_id` — durable CairnStone human/service identity and Console home. Owns or joins tenants, workspaces, inboxes, durable sessions, entitlements, and linked authenticators/connections.
- `authenticator_id` — one credential relationship proving control of the CairnStone account, such as passkey/WebAuthn, wallet proof, custodial-provider login, or another approved identity provider.
- `connection_id` — one OAuth-authorized MCP client/account connection. Server-minted; never derived solely from provider family, display name, routing alias, or wallet address.
- `principal_id` — opaque, immutable, server-issued actor for exactly one connection. Authorization and audit remain connection-specific even when several principals belong to the same account.
- `token_family_id` — server-owned access/refresh lineage for one authorized connection; revocable without deleting account history.
- `wallet_account_id` — optional linked wallet/custodial economic account; may also serve as an authenticator relationship, but is never the CairnStone account identity.
- wallet addresses/payment instruments — rotatable funding/settlement endpoints; never principal identity.
- actor aliases — friendly addresses such as `perplexity-2:chat`; routing only.
- memberships/entitlements — workspaces, inboxes, tools, roles, plans, grants, and Code Sessions.

Two accounts from one provider receive distinct connection principals. Two users using the same provider cannot collide. One CairnStone account may explicitly link multiple authenticators, wallets, and MCP connections, but linking never erases connection-level identity or audit history.

CairnStone does not depend on every MCP host exposing a stable installation identifier. Provider subjects, client-family identifiers, and host installation identifiers are optional evidence. CairnStone itself mints `connection_id`, `principal_id`, and `token_family_id` during authorization. A valid refresh resumes the same connection/principal; a reinstall or fresh authorization may create a new connection/principal under the same authenticated account without duplicating the account-owned home/workspace/session state.

## Standards-aligned authorization boundary

CairnStone's HTTP MCP endpoints become OAuth protected resources.

Required behavior:

1. Publish OAuth Protected Resource Metadata at the deterministic well-known location.
2. Return `401` plus a correct `WWW-Authenticate` challenge for unauthenticated protected requests.
3. Use authorization-server discovery and authorization code + PKCE S256 for public MCP clients.
4. Prefer MCP's current Client ID Metadata Document (CIMD) registration model where supported; retain Dynamic Client Registration only as a bounded compatibility path for clients that still require it.
5. Validate authorization-server issuer identity and authorization-response issuer binding so client/issuer mix-up cannot silently substitute an authorization server.
6. Require `Authorization: Bearer <access-token>` on every protected request.
7. Validate issuer, signature, expiry, audience/resource, scopes, revocation state, token family, and connection/principal binding.
8. Use short-lived access tokens and confidential, revocable, rotating refresh tokens with reuse detection.
9. Bind tokens to the canonical CairnStone resource with OAuth Resource Indicators.
10. Never accept a provider token intended for ChatGPT, Claude, Perplexity, or another service as a CairnStone credential.
11. Never place tokens, authorization codes, wallet proofs, passkey material, refresh secrets, or private keys in Stones, AC1, GitHub, model context, tool arguments, receipts, or ordinary logs.
12. Treat the current live runtime's older MCP protocol compatibility separately from the target identity/security contract; do not require every host to upgrade in lockstep before the additive canary can be evaluated.

References:

- MCP Authorization: https://modelcontextprotocol.io/specification/latest/basic/authorization
- MCP 2026-07-28 authorization update: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- RFC 9728: https://www.rfc-editor.org/rfc/rfc9728
- RFC 8707: https://www.rfc-editor.org/rfc/rfc8707

## Server-derived request context

After token validation, the gateway creates an internal context containing account, principal, tenant, connection, authenticator assurance/evidence class, provider/client family, canonical resource, scopes, roles, token-family identity, and authorization version. Protected tools receive it outside model-controlled JSON.

Token claims minimally bind `sub` (connection principal), account, tenant, connection, audience/resource, scopes, issued/expiry time, and token/replay identity. Tool arguments may narrow authority but can never expand it, select a different principal, or replace the server-derived account/tenant/connection context.

## Tool/data-plane binding

### AC1

- derive sender from the authenticated principal;
- default inbox reads to that principal's mailboxes;
- reject send-as/read-as attempts without an explicit delegated mailbox grant;
- keep caller-supplied `from` or `recipient_id` only as checked migration assertions;
- preserve immutable messages, delivery state, and thread history.

### Workspaces and invitations

- derive the invite claimant from the authenticated principal;
- bind memberships and capabilities to that principal;
- remove raw capability copy/paste from ordinary Console flows;
- retain invitations for joining another workspace/tenant, not for accessing one's own home;
- keep signed workspace capabilities as defense in depth.

### Persistent Code Mode

- create or resolve the principal's home workspace and durable Code Session;
- allow resume, lease, checkpoint, compile-context, and environment attachment only within visible membership;
- preserve checkpoints, receipts, provenance, and human authorization boundaries.

### Tool broker

- derive identity, plan, roles, scopes, and grants from server context;
- preserve existing policy tiers and human confirmation;
- allow step-up scopes without silently adding memberships or mutation authority.

## Zero-friction bootstrap

The first authenticated connection idempotently creates or resumes:

1. CairnStone account and personal tenant, unless an authenticated existing account/tenant is selected;
2. authenticator link plus connection and immutable connection principal;
3. canonical chat/work aliases;
4. personal/home workspace membership;
5. baseline tool entitlements;
6. Persistent Code Mode home/session pointer;
7. Console account/session card;
8. accepted boot-skill/package discovery;
9. an auditable bootstrap receipt.

Reauthorization and refresh must resume the same objects instead of creating duplicates.

The normal Console surface shows provider/client, user/tenant, connection state, aliases, workspaces, recent activity, and unlink/revoke controls. Internal IDs/capabilities remain visible only in advanced evidence views.

## Account linking, revocation, and recovery

Default behavior is isolation: a new authenticated connector grant creates or resumes one connection principal under one authenticated CairnStone account. Linking authenticators, wallets, connections, or accounts requires an authenticated CairnStone account action; a shared provider family, wallet address, display name, or client family is never enough.

Revoking one connection or token family blocks it without affecting sibling connections. Removing or rotating a wallet/authenticator does not delete the CairnStone account. Recovery, authenticator replacement, account linking, wallet reassignment, and alias reassignment require explicit human confirmation, step-up authentication appropriate to the risk, and immutable audit evidence.

## Legacy aliases

Existing addresses remain routable during migration:

```text
perplexity:chat + perplexity:cairnstone-v6 -> principal A
perplexity-2:chat + perplexity-2:cairnstone-v6 -> principal B
```

Bind aliases only after authenticated ownership proof. Reject conflicting claims, retain historical messages, and never rewrite old message bodies. Pre-migration actor strings do not prove current ownership.

## Public versus protected surfaces

Health, OAuth/MCP discovery, public documentation, intentionally public capability summaries, and later StoneLink public metadata may remain public and rate-limited.

Private tools, inboxes, workspaces, Code Sessions, grants, and user data require an authenticated principal. Endpoint knowledge alone yields public metadata or `401`, never private access.

## Chosen first implementation path — CairnStone-account-root authenticated Core canary

The first implementation is intentionally additive and reversible:

1. Add a new protected MCP resource at `/mcp/core-auth`; do not change `/mcp`, `/mcp/core`, or `/mcp-b` during the canary.
2. Make the CairnStone account/Console the durable identity home. Authentication proves control of that account; it does not make the authenticator itself the identity.
3. Reuse the proven OAuth/PKCE/token lifecycle from `nothinginfinity/x402-sub-agent-mcp` as an upstream authentication kernel, adapted into a CairnStone resource binding and current MCP authorization profile.
4. Use wallet-backed sign-on as the first canary authenticator path because the x402 lifecycle already exists, but model the wallet account as a linked authenticator/economic relationship. A zero-balance wallet account may be provisioned automatically; funding, payment, and spend are never required to authenticate.
5. Mint CairnStone-owned `connection_id`, immutable per-connection `principal_id`, and `token_family_id`. Do not require a stable installation ID from the MCP host.
6. Issue a CairnStone Core resource-bound token whose `sub` is the connection principal and whose server-side binding resolves the owning `account_id`, tenant, connection, token family, and scopes.
7. Carry the authenticated context through `cairnstone_tool_execute`, `cairnstone_load_tools`, and every dynamically hydrated tool. Indirect execution must not lose, replace, or widen identity.
8. Isolate newly authenticated records from the legacy compatibility realm. Prefer a separate authenticated D1 security realm for the canary; if one D1 is retained, use separate auth tables/namespaces plus mandatory server-side realm + tenant + principal predicates.
9. Use the second Perplexity account as the first live same-provider/multi-account canary.
10. Advance enforcement through `off -> shadow -> canary -> required`, with an immediate rollback to the unchanged legacy routes.

### Identity, authentication, connection, and economic separation

| Layer | Purpose | Stability / authority |
|---|---|---|
| `account_id` | Durable CairnStone identity / Console home | Survives connector reinstall, wallet rotation, and authenticator changes; owns durable memberships and state |
| `authenticator_id` | Proof of control of the CairnStone account | Replaceable/revocable; passkey, wallet proof, custodial login, or future approved method |
| `connection_id` + `principal_id` | One authorized MCP connection and its exact authorization/audit actor | Server-minted; immutable principal per connection; siblings may belong to one account |
| `wallet_account_id` | Optional wallet/custodial economic relationship and first-canary authenticator | Linked to account; may be zero-balance; not identity root |
| wallet addresses / payment instruments | Funding and settlement endpoints | Rotatable/recoverable; never principal identity |

Authentication proves control of the CairnStone account through an approved authenticator. It does not grant payment, execution, mutation, workspace membership, mailbox delegation, or economic authority by itself. Economic authority remains a separate explicit grant.

### What can be reused from x402

The x402 service already demonstrates authorization code + PKCE, protected-resource challenges and discovery, hashed access/refresh tokens, rotation and revocation, resource/audience binding, audit evidence, wallet-ownership authorization sessions, and trusted client-family detection. These should be extracted or adapted as a shared auth kernel rather than rewritten without cause.

The current x402 identity assumptions are **not** reusable as-is:

- its OAuth subject lookup is single-user-oriented;
- a trusted family key such as `fam:perplexity` distinguishes providers but cannot distinguish two accounts within one provider;
- wallet selection, budgets, and payment capture are broader than the credential needed to enter CairnStone;
- its client-registration behavior predates the current MCP preference for Client ID Metadata Documents;
- the service is a policy/bookkeeping layer and does not hold wallet private keys.

CairnStone therefore needs its own account/authenticator/connection/principal/token-family registry. Provider/client/install identifiers and wallet relationships are evidence/links, not the authorization root.

### Compatibility firewall / non-lockout invariant

The canary must preserve today's working system while preventing legacy access from becoming a cross-tenant bypass:

- existing `/mcp`, `/mcp/core`, and `/mcp-b` behavior remains unchanged during the canary;
- `/mcp-b` remains the full-catalog twin and is never repurposed as an auth endpoint;
- legacy routes remain confined to the existing single-tenant compatibility realm;
- legacy callers cannot enumerate, select, impersonate, or read newly created authenticated accounts/principals or their private state;
- authenticated data access always starts from server-derived account/tenant/connection context; caller-supplied IDs can only narrow a permitted operation;
- new users default to authenticated Core after the canary is accepted;
- migrate one connector at a time; retire legacy access only after parity, rollback, and multi-account isolation are proven;
- authentication failure on the canary cannot disable the unchanged legacy routes.

A second `/mcp/core-auth-b` route is unnecessary unless a real client-cache incompatibility proves that a twin is required.

### Review gate before implementation

Independent architecture/security review must explicitly approve:

- the account/authenticator/connection-principal/wallet-instrument separation;
- issuer, authorization-response issuer binding, audience/resource, subject, account/connection/token-family binding, scopes, expiry, refresh rotation/reuse detection, revocation, and replay semantics;
- same-provider multi-account uniqueness, reconnect/reinstall behavior, account recovery, authenticator replacement, wallet rotation, and explicit linking behavior;
- the absence of any dependency on a universal stable MCP-host installation identifier;
- propagation of server-derived principal context through brokered and hydrated tools;
- the compatibility firewall and rollback path;
- zero-balance authentication without implicit spend authority;
- secret isolation from Stones, AC1, GitHub, tool JSON, model context, and ordinary logs.

No auth enforcement, route replacement, or deployment is authorized by this document alone.

## Implementation slices

### V7.7.10i.0 — CairnStone account-root OAuth Core canary contract + threat model

- freeze `cairnstone-account-v1`, `cairnstone-authenticator-v1`, and `cairnstone-connection-principal-v1`, including explicit `account_id -> connection_id -> principal_id -> token_family_id` semantics;
- freeze wallet-account/payment-instrument separation and define wallet-backed authentication as the first canary authenticator rather than the identity root;
- inventory every route/tool that accepts actor, sender, recipient, account, tenant, capability, workspace, Code Session, or economic identity;
- extract/adapt the reusable x402 OAuth kernel, remove the single-subject/provider-family collision assumptions, and adapt registration/issuer checks to the current MCP authorization profile (CIMD preferred; DCR compatibility only);
- define `/mcp/core-auth`, authenticated-vs-legacy storage realms, enforcement modes, rollback, and negative fixtures;
- model spoofing, confused-deputy, same-resource bearer replay, cross-resource token substitution, issuer mix-up, alias collision, cross-tenant, revocation, recovery, authenticator replacement, wallet rotation, and same-provider multi-account threats;
- complete independent architecture/security review before runtime implementation or deployment.

### V7.7.10i.1 — Additive authenticated Core canary

- protected-resource/authorization-server discovery and authorization code + PKCE;
- CairnStone-account sign-on using wallet-backed authentication as the first canary authenticator, with automatic zero-balance wallet-account provisioning when needed; no funding or spend requirement;
- token lifecycle, issuer/authorization-response issuer validation, resource/audience validation, token-family binding, refresh rotation/reuse detection, revocation, and consistent `401`/`403`;
- add `/mcp/core-auth` while leaving `/mcp`, `/mcp/core`, and `/mcp-b` unchanged;
- propagate the server-derived principal through `cairnstone_tool_execute`, `cairnstone_load_tools`, and hydrated tools;
- enforce `off -> shadow -> canary -> required` only on the new authenticated surface.

### V7.7.10i.2 — Account/authenticator/connection registry + compatibility firewall

- prefer a separate authenticated D1 security realm for the canary; if one D1 is used, create separate `auth_*` tables/namespaces and mandatory realm predicates;
- schema for tenant, account, authenticator, connection, principal, token family, wallet-account link, aliases, memberships, links, revocation, and audit events;
- server-derived request context and query helpers that always constrain authenticated access by realm + tenant + account/principal;
- idempotent refresh/reconnect plus explicit new-connection behavior for reinstall/fresh authorization under an existing account;
- link/unlink/recovery, step-up authentication, authenticator replacement, and wallet-rotation policy;
- confine legacy routes to the existing compatibility realm and deny access to new authenticated-account/principal private state;
- audit receipts without secrets.

### V7.7.10i.3 — AC1/workspace binding

- server-derived AC1 sender and inbox ownership;
- verified legacy alias migration;
- authenticated invite claim;
- principal-bound memberships/capabilities;
- cross-principal negative tests.

### V7.7.10i.4 — Bootstrap + Persistent Code Mode

- one authorization creates/resumes mailbox, home workspace, entitlements, and Code Session;
- no manual actor/capability entry in the ordinary flow;
- reconnect preserves identity;
- revoke blocks future protected calls immediately.

### V7.7.10i.5 — Console account controls

- account/connection card;
- tenant selection;
- link/unlink/revoke;
- principal-derived workspace and inbox visibility;
- advanced evidence view;
- remove the normal-flow verification maze.

### V7.7.10i.6 — Multi-user/multi-account acceptance

Prove the acceptance matrix live across ChatGPT, Claude, and two accounts from one provider where client support permits.

## Acceptance gate

V7.7.10i is complete only when live tests prove:

- URL possession without authorization cannot access protected state;
- account A cannot read/send as B;
- A cannot claim B's invite, membership, capability, Code Session, checkpoint, or receipt;
- same-provider users never collide;
- one user can connect multiple accounts with distinct principals;
- explicit linking unifies the user view without erasing connection identity;
- revoking A leaves B working;
- reconnect/refresh preserves identity without duplicate bootstrap state;
- audience/resource binding prevents cross-resource token replay/substitution; stolen bearer replay against the same CairnStone resource is addressed separately by short access-token lifetime, TLS, refresh rotation/reuse detection, revocation, and later sender-constrained tokens where host support permits;
- `/mcp/core-auth` preserves principal identity through direct Core calls, broker execution, and dynamically hydrated tools;
- legacy `/mcp`, `/mcp/core`, and `/mcp-b` remain operational during canary rollback but cannot access new authenticated-principal private state;
- a CairnStone account can authenticate through the wallet-backed first-canary authenticator with a zero-balance wallet account and without payment or spend authority;
- rotating/removing a wallet or reinstalling a connector does not replace the durable CairnStone account; a fresh authorization may create a new connection principal while resuming account-owned state;
- no host-supplied stable installation identifier is required for account continuity;
- two Perplexity accounts create distinct connection principals even when client family is identical;
- verified aliases preserve legacy history;
- secrets never enter Stones, AC1, GitHub, model context, receipts, or logs;
- Console and Persistent Code Mode work after first authorization;
- mutation/execution still honors existing policy and human confirmation;
- concurrency and alias-claim races fail closed.

## Dependency effect

V7.7.10i is a prerequisite for new multi-account onboarding, normal-user Console onboarding/account switching, broad Persistent Code Mode rollout, organization packaging, private/semi-public StoneLink federation, and dependable paid entitlements/economic authority.

It does not replace Console, workspace, AC1, Tool Broker, or Persistent Code Mode. It supplies the authenticated principal that lets those systems scale safely.
