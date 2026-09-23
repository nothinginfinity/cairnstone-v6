# V7.7.11h - In-Chat CairnStone Console / Host-Native App Surfaces

Status: PLANNED / ROADMAP CANDIDATE; docs-only in this proposal.
Parent roadmap: docs/ROADMAP_V7.md
Implementation homes: CairnStone Worker for read-only state/actions and host adapters; existing nothinginfinity/cairnstone-v6-console for shared UX/semantic targets. No duplicate authority plane or full standalone chat client.
Dependencies: V7.7.10i account, tenant and connection-principal authentication; V7.7.10j Tool Belts; V7.7.10k Response Profiles; V7.7.11g bounded adaptive UI catalog/spec/actions; V7.7.9 stable Console shell and Human Commit boundary.

## Thesis

CairnStone should appear inside supported best-in-class AI chat experiences instead of requiring users to leave those apps for every routine operational task. A user with an iPhone should be able to ask their chosen AI host to open CairnStone Home, Work, Inbox, Scope, or Profile Settings and receive a compact, authenticated interactive surface grounded in CairnStone state. The same durable backend and project identifiers continue to power the existing web/PWA Console.

This is an optional in-chat Console projection, not the full Console injected into arbitrary chat UIs, not an iframe with universal host privileges, and not a replacement for each host's navigation, prompt editor, conversation, or model-specific UI.

## Permanent standalone Console / full operator control plane

The existing browser-hosted CairnStone Console and installable iPhone PWA remain permanent, first-class **full operator interfaces**, not transitional UIs or fallbacks to be retired when chat apps gain embedded widgets. CairnStone's server remains the source of state and authorization; the standalone Console is the comprehensive, independent window into that backend. It must remain usable without ChatGPT, Claude, Grok, MCP Apps support, or another vendor's UI/account.

The standalone full Console is where an authorized owner/admin or team member, within their actual account/tenant/role/object grants, can:
- inspect all messages, threads, handoffs, unread/attention state and activity that they are entitled to see across their teams, projects, agents, connector accounts and AC1 chat/work planes, with searchable filters and provenance; never interpret "all" as cross-tenant or cross-principal access;
- configure and publish team/project/member defaults, versioned Response Profiles, accepted Skills, Tool Belts, saved Scopes, workspaces and agent/host preferences; view effective settings and rollback history;
- build, register, inspect and test custom MCP tools/skills/connectors in isolated preview or sandbox environments; run contract/schema tests, review execution traces and test receipts, and propose guarded production changes without mixing test and production credentials;
- inspect backend operations, runtime/connection health, GitHub and Cloudflare status, active Code Sessions, task runs, checkpoints, manifests, accepted Stone/path HEADs, provenance, failures, authorization requests and audit receipts;
- manage team invitations, accounts, connector principals, wallet/authenticator links, scoped access, revocation and recovery through established 10i and Human Commit flows;
- review or execute consequential operations only through the exact existing server-side authorization, scoped-grant, CAS and Human Commit gates.

The in-chat `cairnstone-console-mini` is a **bounded contextual projection** of the same authorized backend data and semantic actions, not an administration replacement. It may surface routine read-only cards and narrowly supported proposals; complex configuration, cross-project audit, tool development/test, sensitive recovery, bulk management and any action a host cannot safely authorize remain available in the standalone Console. Every mini card has a permission-aware **Open Full Console** deep link to the same object or operation when relevant.

**Parity and independence gate:** no new fundamental backend capability may ship only inside an AI host's embedded UI. A tested standalone operator path (possibly linking to existing authorized backend flows) and reliable full-Console access must remain available, even if an MCP host rejects an app, loses its cached tools, changes subscription availability or is offline.

## Host capability and fallback contract

Use the publicly supported MCP Apps / host app-component mechanism only where a given host and account actually expose it. At implementation time verify the exact supported MCP Apps spec, ChatGPT developer tools, Claude connector UI support, mobile constraints, consent/access requirements and app review. Never assume Grok, Cursor, Replit or every account/mobile plan supports interactive MCP Apps merely because the underlying model can call MCP tools.

Compatibility tiers:
- Tier A: fully interactive trusted in-chat MCP App/card where officially supported and tested;
- Tier B: native rich response plus callable read-only CairnStone tools, without interactive app embedding;
- Tier C: portable text/Markdown summary and authenticated deep link to existing Console/PWA.

A host adapter must describe capability, renderer version, cache and identity behavior truthfully. The same semantic surface may have different visual layouts across hosts. CairnStone controls data/contracts/actions, not the host's native chrome or renderer.

## Reuse V7.7.11g, do not fork UI authority

Define the embedded Console as a registered target of cairnstone-ui-surface-v1 and cairnstone-ui-catalog-v1. Reuse Source + View + Action + Appearance:

Source = authorized, bounded CairnStone API projections.
View = validated component-tree contract (existing 11g catalog, semantic IDs, mobile density, accessibility).
Action = existing registered semantic action IDs via tool broker / intents / Human Commit, independently authorized on server.
Appearance = approved per-host renderer/theme/layout and optional accepted 10k Response Profile.

The Worker returns compact surface data or a validated surface specification; the client/host renderer displays trusted components. No model-generated arbitrary executable HTML, JS, CSS, event handlers, invented action IDs, or unchecked external URLs. The app surface never holds or receives reusable wallet, OAuth, mailbox, or workspace bearer secrets.

## Minimum embedded Console surface

Working name: cairnstone-console-mini.

Read-only-first initial tabs/panels, rendered only when there is current authorization:
- Home: account/project context, runtime status, canonical START HERE and next milestone, active Scope;
- Work: Code Session snapshot, task, current checkpoint, actors, test/receipt summary, draft proposal status;
- Inbox: recipient-owned unread thread summaries and handoff details, with separate identity and ownership enforcement;
- Scope/Evidence: navigate selected project and accepted Stones with citations and provenance; no synthetic global HEAD;
- Profiles: inspect accepted 10k team/project/member Response Profiles and current host compatibility; edit/publish only in later permitted phase;
- Actions: view already-proposed actions and make the explicit existing approval/authorize workflow accessible when verified safe on a specific host.

Build around concise cards, intentional detail expansion, predictable touch targets, screen-reader semantics, good loading/error/stale states and trusted native host styling where supported. The comprehensive Universe view, large diff editor, complete permission-scoped message archive, custom tool testbench, backend observability, complex account recovery and bulk administration belong in the full standalone Console. Any selected feature later exposed inside a host must reuse its server-side contracts and must not become its only supported entry point.

## Identity, authorization and Human Commit

The app must derive its identity from the authenticated 10i MCP connection principal and current account/tenant, never from a user-entered actor ID, prompt, URL possession, team profile ID, or a copied session token.

Enforce existing object/Scope grants and 10j Tool Belt policy for every read and action. Rendered buttons do not grant rights. Protected state must not be transferred to an unverified host/client. Model-visible summaries and component-bound data may be differently redacted by policy.

Separate interaction from execution:
1. user opens in-chat surface; server derives authorization and returns bounded current state;
2. user taps a safe navigation/read action or requests a consequential proposal;
3. server re-checks account/principal, grant, belt, object identity, current accepted-state/operational revision and broker policy at call time;
4. any consequential mutation/execution stays behind the existing explicit Human Commit/Authorize guard;
5. result produces an attributable receipt and refreshes state only after real host/runtime confirmation.

An action proposal cannot be hidden, mislabeled as a normal read, replayed through stale UI, or executed by an auto-advancing model. Sensitive actions that cannot offer a trustworthy host approval affordance must deep-link to the existing Console approval screen, preserving context.

## Contracts and operational envelopes

Proposed optional cairnstone-inchat-surface-session-v1 carries:
- surface_id and semantic surface kind; 11g validated catalog and spec digest;
- account, connection-principal and authorized object/Scope identity (non-secret IDs only where safe);
- selected 10k profile ID/version and effective host render capability;
- source object identities and exact freshness/revision/authority digests;
- response/conversation/code-session IDs where applicable;
- action catalog, availability and explicit human-commit requirements;
- cache revision, expiration/reconnect behavior and trace/receipt IDs.

The in-chat surface is an ephemeral projection. It is not a new database of project truth, does not mint its own identity, does not move chain/path HEADs, and does not substitute iframe/browser-side checks for server enforcement.

Never assume every MCP client refreshes schemas or UI state reliably. On reconnect, tenant switch, principal revocation, belt update or source revision change, disable stale consequential actions and re-resolve.

## Implementation slices

V7.7.11h.0 - host/support investigation and threat model: current ChatGPT MCP Apps and Claude connector behavior, iOS access, authentication, consent/review and native UI limitations; fallback matrix for other hosts.
V7.7.11h.1 - minimal read-only cairnstone-console-mini surface using 11g trusted catalog/components, backed by 10i authenticated source projection; first cards: Home, latest Code Session, Inbox.
V7.7.11h.2 - ChatGPT host adapter / MCP App spike on non-production resources and independently verifiable authenticated connection; add deep-link/Markdown fallback.
V7.7.11h.3 - Claude adapter test if current client support permits; verify equivalent meaning, accessibility and correct fallback on unsupported mobile clients; add another host when feasible.
V7.7.11h.4 - 10k Response Profile preview/selection card using same accepted profile resolution and tenant/role constraints; no separate preference store.
V7.7.11h.5 - safe proposal and approval review cards; action execution only via existing canonical broker/Human Commit workflow, preserving human-confirmation boundary and fresh CAS guards; deep link if host cannot provide safe flow.
V7.7.11h.6 - telemetry, abuse/host-isolation review, cross-host mobile acceptance and progressive rollout; no general availability until threat-model gate closes.

## Live acceptance

- a user can open an authenticated, live CairnStone read-only card from inside a supported ChatGPT chat using a connected CairnStone account without pasting bearer tokens or manual actor IDs;
- panel data matches the existing full Console for same principal, project and revision;
- each independently connected team member sees only authorized projects, conversations, grants, inboxes and active sessions; second same-provider account cannot inherit another user's state;
- ChatGPT and at least one independent host are tested where interactive UI support exists; unsupported hosts give an honest useful fallback;
- opening, navigating or switching appearance/profile grants no new capability and causes zero accepted-state mutation;
- stale/revoked state blocks sensitive actions, and user-level approval remains explicit and attributable;
- an in-chat Console card can display a legitimate pending proposal without executing it; when approval is supported, a separate Human Commit and broker receipt prove it;
- tests exercise malicious prompt injection in project content, forged component action, guessed surface ID, cross-tenant request, stale render, replay, and hostile host/client conditions;
- important status cards provide current/stale/error distinctions and links to provenance, never synthetic HEAD claims;
- iPhone touch and screen-reader accessibility is validated, while the independent full web/PWA Console remains fully functional and directly accessible without any embedded-host dependency;
- an authorized admin can use the standalone full Console to inspect all permitted AC1 messages and audit activity, manage team/project Response Profiles, safely test a custom tool in a non-production environment, and inspect underlying system evidence even when interactive MCP Apps are unavailable; mini-Console data for the same account/object/revision matches the corresponding full-Console projection without expanding permission.

## First demonstration

From a mobile ChatGPT chat, request "Open my CairnStone project." An authenticated, read-only Home card appears showing the user's own selected project, current accepted START HERE, Code Session status and unread work inbox. Tap the current Code Session to inspect a live checkpoint, then open the accepted Response Profile picker. Open the same project from an independent supported host or receive a rich response/deep link if that host lacks interactive embedding. Cross-account negative tests must pass before expanding to approvals.

## Relationship to existing Console and other projects

Build the first renderer using the established Console component and semantic action vocabulary, not a new standalone Console app or copied authorizations. This is another distribution channel for the same CairnStone backend and may later expose other Cloudflare-hosted projects, such as paid tools and specialized MCP workers, using separately scoped source adapters. Wallet/payment functionality remains behind independent economic authorization.

This planning document does not authorize deployment, migration, account-permission changes, implementation rollout, repository merge, or promotion of CairnStone accepted-state HEADs.
