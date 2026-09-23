# V7.7.11i — Cross-Host Team Communications (AC1-backed)
Status: PLANNED / DOCS-ONLY ROADMAP CANDIDATE — requires independent design review; no runtime implementation, deployment, or accepted path-HEAD movement.
Parent: docs/ROADMAP_V7.md, V7.7.11 Mobile Home and V7.7.11h In-Chat CairnStone Console.
Prerequisites: V7.7.10i account/tenant/connection-principal authentication and isolation; V7.7.10j role-scoped Tool Belts for actions; existing AC1 correspondence and V7.7.11g trusted UI surface contracts.
Primary implementation relationship: **V7.7.10l Standalone CairnStone Messages** owns the independent human-messaging product/service boundary. CairnStone Core/full Console and host-supported in-chat MCP Apps consume the same accepted Messages contract instead of duplicating its private-message tables or authorization logic.

## Relationship to standalone V7.7.10l

V7.7.10l now comes first for human messaging. It can ship a tiny remote MCP connector and Messages-only PWA after the 10i human-account/resource-auth contract is ready for isolated test users; it does **not** wait for the full V7.7.11 UI program. V7.7.11i then integrates that accepted service into CairnStone Core, the permanent full Console and richer 11g/11h host-native surfaces.

This split is deliberate: Messages users may never adopt Core, while Core users gain the same messaging network without a forked store. Standalone acceptance must prove human identity isolation, thread ACLs, receipts, retention/deletion controls and cross-host text-tool behavior before Core project-thread linking. Candidate service plan: `docs/V7_7_10L_STANDALONE_MESSAGES_MCP.md`.

## Product goal
People on a CairnStone team should be able to communicate while keeping the native UI of their preferred AI lab. A member using ChatGPT may compose a CairnStone message for another member who reads it through Claude or the full Console. All authenticated surfaces show the same appropriate thread and receipt state. CairnStone delivers communications; it does not modify or inject messages into proprietary provider-native chat histories. No requirement to build a competing, full general-purpose chat client.

## Baseline and honest gaps
Existing production primitives: AC1 immutable message Stones with per-recipient delivery state, bounded recipient inbox and thread reads, chat/work correspondence planes, existing Console Inbox and agent/actor discovery, and 10i connector-bound identity work in progress. These existing chat-plane actor IDs are AI session identities, NOT proof of a human account, provider account equivalence, privacy guarantees, or an authorization scheme for arbitrary human-to-human messaging. AC1 currently favors durable agent handoff; do not expose raw personal messages as broadly searchable project memory by default.

Not yet shipped by this planning proposal: authenticated person-to-person recipient resolution, private human inbox tenancy, participant-scoped human/group conversations, mobile in-chat compose/reply UI, proactive host-native notifications, integrated mailboxes, real-time audio/video calls, or email/calendar delivery.

## V7.7.11i.0 — Human communications contract and privacy gate
- Define CairnStone account/member identity, recipient directory visibility, optional approved team membership and blocked contacts. Authenticate server-side from 10i account + tenant + connection principal; never trust copied actor IDs, prompts, URLs or renderer-provided ownership.
- Human communications namespace and per-thread/participant ACLs must be separate from legacy chatgpt:chat and agent work-plane IDs. Link optional agent participation only via explicit project/thread grants; prevent an agent from silently reading a human's private inbox.
- Compare AC1 immutable message-envelope reuse with a privacy-sensitive human content store. Specify confidential payload policy, encryption in transit/at rest, attachment ACLs, retention/expiry, export/deletion obligations, admin visibility, consent, abuse/rate limits and moderation before storing private message bodies in immutable Stones. No implicit E2EE claim; if E2EE is proposed later, perform an independent threat model and key lifecycle design.
- Preserve chat vs work plane classification, conversation/group membership, idempotency and read/unread receipt semantics. Message bodies, contacts and attachments are not accepted project authority and must not automatically enter RAG, Stones or shared project context.
- Reuse the existing CairnStone broker, access grants and audit/receipt model; no second identity provider, execution plane or permission system.

## V7.7.11i.1 — Cross-app private message MVP
- Add permission-scoped member lookup, direct human messages, reply/read threads and narrowly defined project channels; avoid universal directory exposure or unsolicited bulk messaging.
- Use the same canonical backend for the full standalone Console/PWA and one authenticated MCP tool adapter; test independent authorized connections belonging to different AI labs, and two separately connected members of the same lab.
- First operational test: ChatGPT-connected user A sends an explicit message to authorized Claude-connected user B; B reads and replies; both see consistent thread IDs, participant ACLs, delivered/read statuses, and secure failure states. Verify unauthorized user C cannot enumerate or access the thread. A message send must be an attributable authorized mutation with idempotency/retry controls, rate limits, and confirmed server receipt before UI reports success.
- No background claim that an external AI app will automatically show unsolicited new messages. A recipient sees messages when their connected app explicitly retrieves them or when a separately supported, user-opted-in notification channel is configured.

## V7.7.11i.2 — In-chat Inbox/Composer plus full Console parity
- Reuse 11h 'cairnstone-console-mini' and 11g trusted component/action catalog for authenticated Inbox, thread read, compose and reply cards where a host supports installed MCP Apps. Expose the same registered read/send tools to assistant-mediated chat turns where embedding is unavailable. Fallback: useful Markdown summary and permission-aware authenticated standalone Console/PWA deep link.
- An arbitrary generated in-chat control has only its host-provided local actions; it cannot directly access CairnStone databases absent a registered/authenticated tool invocation. Rendered buttons neither prove recipient identity nor grant message-send rights.
- Keep full searchable, permission-scoped communications archive, directory, account settings and security review in the independent standalone Console. In-chat mini is an optional distribution surface, not a second message store or mandatory UI.
- Validate iPhone touch, reconnect/cache invalidation, logout/revocation, tenant switch, stale thread membership, retries, offline/unsent indicators and useful reader accessibility. Host capability and mobile support must be tested per host/account, never asserted universally.

## V7.7.11i.3 — User-controlled notifications
- Add an optional, narrowly scoped notification preference contract for unread human messages, mentions or pending handoffs. Start with in-app/PWA badges and user-requested polling or explicitly opted-in external notifications.
- Email/push delivery of a notification is not permission to expose full private message bodies or to send mail on behalf of a person. Prevent private data in OS notification previews unless user authorized that display.
- Cross-client freshness/cursor semantics, duplicate suppression, unsubscribe, rate limits and disabled/revoked connections are mandatory.

## External-channel follow-ons (separate gates; not prerequisites for messaging MVP)
### Email integration
Connect existing user-owned Gmail/Microsoft 365 mailboxes through user-consented scopes, or use a vetted email delivery provider for CairnStone-managed notices. Draft, inspect, choose recipients and require explicit user consent/authorization for sending externally. Keep provider message IDs, delivery/error/webhook receipts, unsubscribe and anti-spam/abuse controls. OAuth scopes should be minimal; do not automatically ingest an entire personal mailbox into Stones, train on private mail, or treat email addresses as proof of CairnStone membership. Inbound replies should be linked to authorized thread views only with explicit identity mapping; an email reply is not an authenticated project command.

### Video / audio meeting integration
Use a dedicated standards-based WebRTC/video service or managed conferencing adapter for media transport, rooms and participant lifecycle. AC1 carries only invitation and state/event references, NOT live camera/microphone streams, wallet tokens or reusable meeting bearer secrets. Start with permission-aware 'Create meeting / Invite / Join' controls and a secure standalone Console/PWA meeting link. Embed actual in-chat video only where current host, account and mobile client have tested camera, microphone, network, sandbox, permission and lifecycle support. Provide browser/PWA join fallback by default. Never claim native ChatGPT/Claude/Grok video calls or universal video support. Recording/transcription/AI summaries require explicit separate participant consent, retention policy and disclosure; default off.

## Aside — Future feature opportunities (parking lot, NOT commitments)
Possible later add-ons after the human messaging privacy gate and real usage evidence: opt-in voice notes with transcription; meeting scheduling and calendar invitations; threaded group reactions and @mentions; shared file previews with per-object ACL; multilingual translation and live captions; optional meeting summaries/action items with participant consent; searchable private team channels; project-linked conversation or task suggestions without silently accepting chat as project memory; native/PWA push notifications; optional phone/SMS adapter with opt-in and abuse safeguards; cross-organization federation with consent and tenancy isolation; separately authorized paid professional communications or x402 service invitations. Each requires its own host-support, cost, security, abuse and consent assessment; none is in initial 11i scope.

## Acceptance and sequencing
First complete enough of 10i account/connection-principal and resource-server authorization to isolate real human test accounts. Then execute V7.7.10l as the standalone text-messaging service and connector proving ground. V7.7.11i consumes that accepted service inside Core/full Console and richer in-chat UI; 10j remains an additional ceiling for Core-originated actions but is not a reason to expose the full Core catalog through the tiny Messages connector. Only after controlled private-message MVP tests may richer interactive in-chat composition expand. Email and video receive separate proposals/authorization and resource-cost budgets after the MVP, not presumed to be installed because MCP is connected.

Acceptance must prove cross-provider and same-provider distinct human accounts, per-tenant per-thread isolation, explicit sender authorization, robust idempotent delivery/read receipts, honest notification limitations, abuse controls and retention policy; independent full Console remains functional without any embedded AI host. Prove no leakage into shared RAG/Stone acceptance, no false delivery claims, no secret-bearing UI payload and no bypass of Human Commit for unrelated consequential tasks. No production implementation, Auth DB migration, email service enrollment, camera/microphone capture, paid provider use or user notification is authorized by this planning document.

## Review and handoff
This is a docs-only candidate extension to PR #49. Claude and Grok Bot should review the new human-message privacy design and 11h compatibility alongside 10i/10j dependency ordering. After GitHub review/merge, accept only exact immutable repo file revisions through existing CairnStone per-path acceptance procedure. Do not advance START HERE or silently move chain/path HEADs for a proposal.
