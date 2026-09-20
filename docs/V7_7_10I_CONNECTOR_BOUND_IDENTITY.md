# V7.7.10i — Connector-Bound Identity + Zero-Friction Bootstrap

Status: **PRIORITY / ARCHITECTURE-ACCEPTED — implementation not started.**

Priority: **P0 identity gate. Advance before new Console feature expansion, broad multi-account onboarding, or federation work.** Close only necessary in-flight safety/merge work while this contract is stabilized.

## Why this moves forward now

CairnStone must support many users on the same provider and individual users with multiple ChatGPT, Claude, Perplexity, Grok, Cursor, or future MCP accounts. Routing labels such as `perplexity:chat` and `perplexity-2:chat` are useful addresses, but they are not authentication.

The required user experience is intentionally simple:

> Add the CairnStone MCP URL, complete authorization once, and immediately receive the correct identity, inboxes, tools, workspace access, and Persistent Code Mode state.

The URL is discovery/addressing. The OAuth grant is the credential. CairnStone derives identity from the authenticated connection.

## Core invariant

> **Authenticated connection -> immutable principal -> mailbox scope -> memberships and entitlements -> operation permissions.**

These dimensions remain separate:

```text
routing alias != authenticated principal
provider account != CairnStone user
resource authority != execution authority
execution authority != mutation authority
economic authority != identity authority
```

## Identity model

- `tenant_id` — personal or organizational security boundary.
- `user_id` — CairnStone human or service owner.
- `connection_id` — one OAuth-authorized MCP installation/account connection.
- `principal_id` — opaque, immutable, server-issued actor used for authorization.
- actor aliases — friendly addresses such as `perplexity-2:chat`; routing only.
- memberships/entitlements — workspaces, inboxes, tools, roles, plans, grants, and Code Sessions.

Two accounts from one provider receive distinct connection principals. Two users using the same provider cannot collide. One user may explicitly link multiple connections, but linking never erases connection-level identity or audit history.

Provider subjects are optional evidence, not a universal assumption. When a host does not expose a stable provider-account subject, the authenticated CairnStone authorization grant and installation identity still create a unique connection.

## Standards-aligned authorization boundary

CairnStone's HTTP MCP endpoints become OAuth protected resources.

Required behavior:

1. Publish OAuth Protected Resource Metadata at the deterministic well-known location.
2. Return `401` plus a correct `WWW-Authenticate` challenge for unauthenticated protected requests.
3. Use authorization-server discovery and authorization code + PKCE for public MCP clients.
4. Require `Authorization: Bearer <access-token>` on every protected request.
5. Validate issuer, signature, expiry, audience/resource, scopes, revocation state, and connection/principal binding.
6. Use short-lived access tokens and confidential, revocable refresh tokens.
7. Bind tokens to the canonical CairnStone resource with OAuth Resource Indicators.
8. Never accept a provider token intended for ChatGPT, Claude, Perplexity, or another service as a CairnStone credential.
9. Never place tokens in Stones, AC1, GitHub, model context, tool arguments, or ordinary logs.

References:

- MCP Authorization: https://modelcontextprotocol.io/specification/latest/basic/authorization
- RFC 9728: https://www.rfc-editor.org/rfc/rfc9728
- RFC 8707: https://www.rfc-editor.org/rfc/rfc8707

## Server-derived request context

After token validation, the gateway creates an internal context containing principal, user, tenant, connection, provider/client family, canonical resource, scopes, roles, token identity, and authorization version. Protected tools receive it outside model-controlled JSON.

Token claims minimally bind `sub` (principal), tenant, connection, audience/resource, scopes, issued/expiry time, and replay identity. Tool arguments may narrow authority but can never expand it.

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

1. CairnStone user and personal tenant, unless an existing tenant is selected;
2. connection and immutable principal;
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

Default behavior is isolation: a new authenticated connector grant creates or resumes one connection principal. Linking requires an authenticated CairnStone account action; a shared provider family or display name is never enough.

Revoking one connection blocks it without affecting sibling connections. Recovery and alias reassignment require explicit human confirmation and immutable audit evidence.

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

## Implementation slices

### V7.7.10i.0 — Contract and threat model

- freeze `cairnstone-connection-principal-v1`;
- inventory every route/tool that accepts actor, sender, recipient, capability, workspace, or Code Session identity;
- model spoofing, confused-deputy, replay, alias collision, cross-tenant, revocation, and recovery threats;
- define the public/protected endpoint matrix and negative fixtures.

### V7.7.10i.1 — OAuth protected-resource gateway

- protected-resource/authorization-server discovery;
- authorization code + PKCE;
- token lifecycle, resource/audience validation, revocation, and consistent `401`/`403`;
- protect `/mcp`, `/mcp-b`, and private HTTP APIs;
- twin paths share one authority surface and never create separate principals.

### V7.7.10i.2 — Connection/principal registry

- D1 migrations for tenant, user, connection, principal, aliases, links, and revocation;
- server-derived request context;
- idempotent connect/reconnect;
- link/unlink/recovery policy;
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
- audience/resource binding prevents token replay;
- `/mcp` and `/mcp-b` share identity/authority;
- verified aliases preserve legacy history;
- secrets never enter Stones, AC1, GitHub, model context, receipts, or logs;
- Console and Persistent Code Mode work after first authorization;
- mutation/execution still honors existing policy and human confirmation;
- concurrency and alias-claim races fail closed.

## Dependency effect

V7.7.10i is a prerequisite for new multi-account onboarding, normal-user Console onboarding/account switching, broad Persistent Code Mode rollout, organization packaging, private/semi-public StoneLink federation, and dependable paid entitlements/economic authority.

It does not replace Console, workspace, AC1, Tool Broker, or Persistent Code Mode. It supplies the authenticated principal that lets those systems scale safely.
