# V7.7.10l — Standalone CairnStone Messages Mini MCP

Status: **PLANNED / STANDALONE-FIRST PRODUCT CANDIDATE / DOCS ONLY.** No repository creation, Worker deployment, account migration, production database, paid provider enrollment, accepted path-HEAD movement, or public launch is authorized by this document.

Parent roadmap: `docs/ROADMAP_V7.md`.
Related follow-on: `docs/V7_7_11I_CROSS_HOST_COMMUNICATIONS.md`.
Working product name: **CairnStone Messages**.
Candidate implementation repository after review: `nothinginfinity/cairnstone-messages`.
Candidate deployment boundary after review: an independent Messages Worker / remote MCP resource server plus a small standalone Messages web/PWA surface.
Core principle: **Messages must be useful without CairnStone Core, while CairnStone Core can become a first-class client of the same service.**

## Why make Messages standalone-first

The complete CairnStone platform solves durable project memory, tools, multi-agent work, authorization and cross-provider continuity. That is powerful but asks a new user to understand a large product surface.

A Messages connector has a much smaller first-use contract:

> Connect CairnStone Messages to the AI app you already use, sign in, and exchange permission-scoped messages with people who use their own supported AI app or the standalone Messages web/PWA.

That creates a plausible high-frequency entry product: communication can recur throughout a day or project, invitations can introduce a second user naturally, and each successful cross-host reply demonstrates portability without asking the user to learn Stones, Tool Belts, Persistent Code Mode or the full Console. **This is a product hypothesis, not a guaranteed retention claim.** Measure invitation acceptance, successful cross-host replies, returning connected users and thread activity before treating “stickiness” as proven.

The standalone connector should also serve as a narrow real-world proving ground for the V7.7.10i account/connection-principal model. It must not fork identity or weaken the Core security model merely to launch faster.

## Product boundary

CairnStone Messages is a focused communications resource server, not a thin alias of the full CairnStone `/mcp` catalog.

A user may have:
- a **Messages-only CairnStone account entitlement** and never create a project;
- the standalone Messages MCP connected to one or more supported AI hosts;
- the standalone Messages web/PWA for inbox/account access when host UI support is absent;
- later, the same CairnStone account connected to Core, where authorized project communication views can consume the same Messages service.

Messages owns human communications state. Core owns project authority, Stones, Scope, tools, Code Sessions and other platform state. Neither silently copies the other’s private data.

The initial Messages release does **not** require V7.7.10k Response Profiles or V7.7.11g/11h interactive UI. Those enrich the experience later. It **does require** an accepted 10i-compatible human account / tenant / connection-principal contract and resource-scoped authorization. The full 10j Tool Belt system is not a launch prerequisite for a fixed tiny Messages tool catalog, but when Core calls Messages, the Core user’s accepted belt/grants remain an additional ceiling rather than being bypassed.

## Standalone architecture

```text
ChatGPT / Claude / other MCP host
            │
            │ remote MCP + OAuth
            ▼
  CairnStone Messages Worker
  ┌───────────────────────────┐
  │ tiny fixed MCP tool set   │
  │ auth / tenant checks      │
  │ contact/thread ACL        │
  │ message + receipt logic   │
  │ optional MCP App UI       │
  └────────────┬──────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
 Messages D1       Messages R2
 metadata/content  bounded attachments
       │
       │ optional internal service contract
       ▼
 CairnStone Core Worker / full Console
       │
       └── project linking only with explicit grants
```

Implementation should use a separate Worker and release lifecycle so Messages can be deployed, tested, rate-limited and rolled back independently from Core. A Cloudflare Service Binding / RPC bridge is a good candidate for same-account Worker-to-Worker integration, but downstream Messages authorization must still validate the end-user/service context explicitly; transport adjacency is not user authorization.

Do not create a duplicate authentication universe. The preferred design is one CairnStone account root / authorization service issuing audience/resource-restricted access appropriate to each resource server. A Core token must not automatically be replayable at Messages and vice versa unless an explicit accepted resource/scope design permits it.

## Human-message storage boundary

Reuse the proven **ideas** from AC1—stable message IDs, idempotency, threads, per-recipient delivery state, immutable audit/evidence identities where appropriate—but do not make private human message bodies accepted project-memory Stones by default.

Working operational model:
- `accounts / members / connections` — server-derived identity links;
- `contact_edges / invites / blocks` — bounded discovery and consent state;
- `threads / thread_members` — exact participant ACL;
- `messages` — human message body + sender + thread revision;
- `deliveries / receipts` — delivered/read/failed state;
- `attachments` — metadata + permission-scoped object ref; bytes can live in R2 if/when enabled;
- `notification_preferences` — opt-in delivery rules;
- `core_links` — explicit association to a CairnStone tenant/project/object, never inferred from message text.

Before implementation, freeze retention/deletion/export, encryption-at-rest/in-transit expectations, account/admin visibility, abuse/report/block behavior, attachment scanning, backups and legal/privacy handling. Do not advertise end-to-end encryption unless a separately reviewed key lifecycle actually implements it.

## Mini MCP surface

Keep the public connector intentionally small. Working v0 vocabulary:

1. `messages_me` — read current authenticated account/member/connection identity and feature compatibility.
2. `messages_contacts` — list/search only contacts or directory entries the authenticated user is permitted to discover; no global user enumeration.
3. `messages_threads` — bounded thread summaries, unread state and cursor.
4. `messages_thread_get` — read one authorized thread and message window.
5. `messages_send` — explicit recipient/thread + body send; authenticated mutation, idempotency key, rate/abuse checks, exact server receipt before UI success.
6. `messages_mark_read` — recipient-owned receipt mutation.

Possible v1 additions after privacy acceptance: `messages_invite`, attachment tools, block/report, notification settings and project-thread linking.

Do **not** expose Core search, Stones, GitHub, code execution, model routing, wallets or arbitrary tool hydration through the standalone Messages connector. Tool-list minimalism is part of the product and security boundary.

Sending must require a clear user-directed action. The model may draft freely, but it must not infer permission to send from merely discussing a message. Hosts with confirmation affordances may add confirmation; the Messages server still validates account, recipient/thread membership, idempotency and current policy.

## MCP App and no-App behavior

The service must work as ordinary MCP tools first. Interactive UI is progressive enhancement.

Where a host supports MCP Apps, provide a small trusted Inbox / Thread / Composer UI resource tied to the same tools:
- Inbox: unread + recent authorized threads;
- Thread: message window, sender identity, delivery state;
- Composer: exact recipient/thread and explicit Send;
- Account: current identity, connected host and “Open Messages” fallback.

Where UI embedding is unavailable, the model can call the same tools and render normal text/structured output. Every user also has the standalone Messages web/PWA as the independent fallback. No host-specific UI may become the only path to retrieve or send a message.

The initial public connector should avoid live-schema churn: keep the small tool catalog deterministic and backwards-compatible so connector caching is less disruptive.

## Standalone web/PWA

Messages-only users need an independent account/inbox surface; requiring the full CairnStone Console would defeat the simple entry product.

The Messages web/PWA should initially provide:
- sign-in/account connection state;
- Inbox and thread reader;
- compose/reply;
- contacts/invites/block;
- install/connect instructions for supported AI hosts;
- privacy/retention/export/delete controls as they become available;
- “Connect CairnStone Core” or “Open Core” only when the account is entitled/linked.

The full CairnStone Console remains the richer operator surface for Core users and may embed the same Messages views through the service contract. The Messages PWA is not a second message database.

## Invitation / growth loop

A cross-host product must handle the case where the intended recipient has not installed the connector.

Safe first flow:
1. sender chooses an already-authorized contact, or creates an invitation through a separately permitted invite flow;
2. invitation resolves to an opaque single-use/expiring claim, never a reusable mailbox bearer;
3. recipient opens the standalone Messages site, creates/signs into a CairnStone account and accepts;
4. recipient optionally installs the Messages MCP in their preferred supported host;
5. after acceptance, the shared thread becomes visible according to its participant ACL.

Do not send unsolicited bulk invitations, expose a global directory, or use email/phone discovery without explicit policy and consent.

## Core integration contract

CairnStone Core should **consume**, not duplicate, the Messages service.

After standalone acceptance:
- Core / full Console may show authorized human Messages alongside AC1 agent/work correspondence while keeping their semantic classes visibly separate;
- project/workspace threads can be linked through explicit `core_link`/object grants;
- an authorized message may be intentionally referenced from a project conversation, but private message content is never silently promoted to Stone/RAG authority;
- agent participation in a human thread requires explicit thread/project policy;
- Core account revocation, tenant switch, Tool Belt/grant changes and Messages membership changes must re-resolve before protected reads/actions;
- unlinking Core does not silently delete the user’s independent Messages account/history; deletion follows the Messages retention/account policy.

Use an internal service interface (candidate: Worker Service Binding/RPC) for Core→Messages calls where useful. Carry an explicit, verifiable service caller and end-user resource context; do not assume the downstream Worker inherits upstream authorization implicitly.

## Roadmap

### V7.7.10l.0 — Product/security contract
- freeze product name/namespace only as a working identifier;
- freeze resource-server identity, account/tenant/principal mapping, token audience/resource and scopes;
- freeze human-message privacy/retention/deletion/export/block/report model;
- freeze AC1 concepts to reuse versus human-message behavior that must stay separate;
- threat model guessed user/thread IDs, stolen invite, cross-tenant read, token replay, prompt-driven unintended send, abusive signup/invite and attachment risks;
- choose repository/deployment/storage names after review.

**Gate:** no private-message implementation until account isolation and resource-specific token checks have a tested design.

### V7.7.10l.1 — Independent repo + Worker skeleton
Candidate new repo: `nothinginfinity/cairnstone-messages`.
- independent Cloudflare Worker and CI;
- `/health`, remote `/mcp`, protected-resource + auth discovery;
- six-tool deterministic mini catalog with stubs/read-only identity first;
- separate Messages D1 binding; no Core D1 sharing;
- optional internal service-binding interface contract, initially read-only;
- structured audit/trace IDs and abuse/rate-limit hooks.

**Gate:** two separately authenticated accounts must remain isolated before send is enabled.

### V7.7.10l.2 — Human message store + text MVP
- account-scoped contacts/invites;
- direct 1:1 threads first;
- explicit send, list, read and mark-read;
- idempotency and duplicate-suppression;
- block/report/rate-limit minimums;
- exact delivery receipt semantics;
- retention/export/delete mechanics sufficient for controlled testers;
- no attachments, email or video yet.

**Proof:** user A and user B exchange messages through the Messages backend while unrelated user C cannot enumerate either thread or private participant state.

### V7.7.10l.3 — Cross-host connector acceptance
- connect independent accounts through at least ChatGPT and one independent MCP host where current support permits;
- test two different accounts of the same provider separately;
- text-tool fallback must work without MCP Apps;
- reconnect/revocation/token refresh/client cache behavior;
- connector onboarding guide and host-compatibility matrix.

**Hero demonstration:** ChatGPT-connected A sends → Claude-connected B reads/replies → A sees reply, with the same thread/receipt state visible in Messages PWA and no Core project required.

### V7.7.10l.4 — Messages MCP App + standalone PWA
- Inbox / Thread / Composer trusted MCP App for compliant hosts;
- no arbitrary model-generated executable UI;
- standalone mobile-first PWA with account/inbox/compose/connect instructions;
- accessibility, stale/offline/error/unsent states;
- PWA remains the reliable fallback for unsupported hosts.

### V7.7.10l.5 — CairnStone Core bridge
- Core binds to the accepted Messages service contract rather than copying tables;
- map same CairnStone account root to separate Core and Messages resource authorization;
- show human Messages in full Console with clear separation from AC1 agent/work planes;
- optional explicit project/workspace thread linking;
- 10j Tool Belt / object grants can further narrow Core-originated access;
- prove Core outage does not break standalone Messages and Messages outage degrades Core communications without corrupting project authority.

### V7.7.10l.6 — Notifications + controlled beta
- opt-in PWA/in-app notifications first;
- delivery cursor/duplicate suppression/unsubscribe;
- operational dashboards, abuse queue, rate/cost limits, backups/recovery;
- privacy/security review and incident runbook;
- invite activation + first-message + reply funnels measured;
- limited public/beta release only after isolation and deletion/retention acceptance.

### Later modules — separately gated
- email adapter;
- calendar scheduling/invitations;
- WebRTC/managed video/audio meeting adapter;
- voice notes/transcription;
- attachments/previews;
- group channels, mentions and reactions;
- cross-organization federation;
- paid/x402 communications services.

None of these are prerequisites for the standalone text-messaging connector.

## Success metrics for the product hypothesis

Measure without pretending product-market fit is proven:
- connector install → authenticated account completion;
- first authorized contact/invite;
- first successful sent message;
- recipient activation/acceptance;
- first cross-host reply;
- seven-day and thirty-day returning active users;
- active threads per connected user;
- share of sessions that succeed without full Core;
- Messages-only → Core connection rate (informational, never required);
- send failures, auth failures, duplicate deliveries, abuse reports and privacy incidents;
- latency and cost per active thread.

The most important early quality metric is not message volume; it is **correct cross-account isolation with trustworthy delivery state**.

## Public-launch non-negotiables

- no cross-tenant/thread enumeration;
- no token accepted for the wrong MCP resource;
- no model-only actor string accepted as a human identity;
- no false “sent” state before backend receipt;
- no silent private-message ingestion into project memory/RAG;
- no automatic sending from model inference;
- working account revocation and connector unlink;
- retention/deletion/export behavior documented and tested for the launch scope;
- user block/report and bounded abuse/rate controls;
- standalone PWA works when interactive host UI is absent;
- independent Worker deploy/rollback;
- Core integration cannot widen Messages ACLs.

## Relationship to V7.7.11i

V7.7.10l becomes the **standalone communications product and service boundary**. V7.7.11i becomes the **CairnStone Core / full-Console / richer in-chat communications integration** that consumes the accepted 10l service.

Therefore the standalone Messages work does **not** need to wait for V7.7.10k Response Profiles or the full V7.7.11g/h UI program. It may proceed after the 10i human-account/resource-authorization contract is sufficiently accepted for isolated test accounts. Interactive 11g/11h surfaces can then consume the same Messages tools later.

The existing V7.7.11 generic “standalone renderer extraction” gate does not block a Messages repository. This is a product/security/service boundary, not extraction of the generic adaptive renderer.

This document authorizes planning only. Independent review, explicit implementation authorization and the normal GitHub/CairnStone accepted-source procedure remain required.

