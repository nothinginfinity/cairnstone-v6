# V7.7.11 — Mobile Home Surface / Installable PWA Dashboard

Status: **PLANNED / AFTER V7.7.10 ACCEPTANCE**

Repository decision: **start inside `nothinginfinity/cairnstone-v6-console`; do not create a separate repo yet.**

## Why

The first useful version is tightly coupled to the existing CairnStone Console and can reuse the proven `nothinginfinity/infinitypaste` PWA pattern. A separate product/repo should only be extracted after the generic Home Surface abstraction is proven across multiple products.

## Goal

Turn the iPhone Home Screen into a lightweight CairnStone entry surface: one app-like icon launches a compact, glanceable dashboard with current CairnStone state and one-tap navigation into the full Console.

The installed surface is a presentation/client layer only. It creates no accepted state, grants no authority, and must not persist capability bearers or secrets merely to support installation.

**Permanent full Console requirement:** the browser/PWA CairnStone Console is not only a compact launchpad or fallback for unsupported chat apps. It remains the independent, fully capable operator UI for permission-scoped all-project/all-agent message inspection, team and project settings, Response Profile/Skill/Tool Belt administration, custom tool development and isolated tests, Cloudflare/GitHub and connector observability, receipts, security reviews and explicit Human Commit workflows. The mobile Home dashboard is a fast entry point into that *full* Console; the V7.7.11h in-chat mini-Console is an optional smaller projection of the same backend. Neither removes or replaces the full operator surface.

## V7.7.11a — CairnStone Console PWA packaging

Add the installable PWA shell to the existing Console using the InfinityPaste pattern:

- Web App Manifest with stable identity, `display: "standalone"`, start URL, theme/background colors, and 192/512 icons.
- iOS Home Screen metadata and `apple-touch-icon`.
- Service worker with conservative network-first/offline fallback behavior.
- Safe-area-aware, portrait-friendly standalone shell.
- Full browser-hosted Console remains the same codebase.

Acceptance:

- installable Home Screen icon on iPhone;
- standalone launch where supported;
- stable icon/title/theme behavior;
- update strategy does not strand users on stale Console code;
- full Console remains one tap away;
- no secrets, workspace capabilities, mailbox bearers, or accepted-state authority persisted for installation.

## V7.7.11b — Mobile Home dashboard

Add a dedicated mobile-first landing surface, working route/query form `/home` or `?surface=home`, optimized for a few seconds of inspection rather than full Console operation.

Candidate cards/metrics:

- runtime health/version;
- current START HERE / active roadmap slice;
- unread Inbox / pending human-action count;
- active Code Sessions / task runs;
- recent agent activity;
- current Scope / Saved View;
- one-tap `Open Full Console`, `Inbox`, `Work`, `Chat`, and `Universe`.

Use bounded reads and progressive disclosure. Dashboard cards are projections over current evidence, never new authority.

## V7.7.11c — Home Screen badge / attention state

Where installed iOS web apps support it, add an optional bounded attention contract such as unread messages or pending human approvals.

Rules:

- badge state is convenience metadata, not authority;
- notification permission remains explicit;
- no consequential action executes from a notification without the existing human authorization boundary;
- badge counts tolerate stale/offline conditions honestly.

## V7.7.11d — Generalized Home Surface schema experiment

After the CairnStone PWA proves useful in real daily use, extract the abstraction behind it into a provider-neutral configuration model:

```text
Source + View + Action + Appearance
```

Example:

```text
Source: CairnStone
View: unread inbox + active sessions + runtime health
Action: open CairnStone Console
Appearance: icon/title/theme/layout
```

The schema should eventually describe other Home Screen surfaces such as GitHub, x402 wallet, student-loan operations, analytics, or other APIs without hard-coding CairnStone semantics into the renderer.

This experiment remains inside the CairnStone/Console workstream first. It must not create a second authority plane.

## V7.7.11e–h — Guided workflows + portable recipes + Safe Adaptive UI + In-Chat Console

The later V7.7.11 family extends the same mobile/Console surface without creating a second UI authority plane:

- **V7.7.11e — Guided Mode / Conversational Cursor + Simple Stone Workflows** instruments stable semantic UI targets and lets CairnStone guide a user through existing Console workflows without blind coordinate automation.
- **V7.7.11f — Simple Stone Library / portability** saves, versions, validates, imports/exports, and later shares those declarative workflows.
- **V7.7.11g — Safe Adaptive UI / Surface Composer** turns the `Source + View + Action + Appearance` idea into a bounded component catalog + declarative surface spec + renderer architecture. It is inspired by the catalog/spec/validation patterns in `vercel-labs/json-render`, including its experimental Jev UI composer, but CairnStone remains the authority boundary and does not require json-render as a runtime dependency.
- **V7.7.11h — In-Chat CairnStone Console** reuses that same trusted UI catalog, actions and existing Console backend to render compact authenticated Home/Work/Inbox/Profile cards inside host-supported MCP Apps. It is an optional distribution channel, with read-only native rich response or authenticated PWA deep-link fallback if the host does not support interactive embedding. `V7.7.10k` Response Profiles remain presentation policy only.

- **V7.7.11i — Cross-Host Team Communications** follows 11h's initially read-only Inbox with a privacy-gated human Inbox/Composer on the same full standalone Console/PWA backend and optionally as a host-supported in-chat MCP App; no independent store, trusted actor-ID guessing, native-host notification guarantees, or project-memory auto-ingestion. Initial scope: authenticated direct/team messages plus explicit read/send receipts and separate account isolation. The first mobile fallback must always work as an authenticated Console/PWA deep link. Email and video calling remain optional separately gated future adapters, not MVP requirements. Candidate plan: \`docs/V7_7_11I_CROSS_HOST_COMMUNICATIONS.md\`.

V7.7.11g may use the V7.7.10h Decision Plane to choose among **application-supplied UI candidates** for visibility, grouping, ordering, or an allowed layout template. It may not invent executable component/action IDs, widen capabilities, approve a mutation, or bypass Human Commit.

Canonical detailed contracts:

- `docs/V7_7_11E_GUIDED_MODE_SIMPLE_STONES.md`
- `docs/V7_7_11G_SAFE_ADAPTIVE_UI_SURFACE.md`
- `docs/V7_7_11H_IN_CHAT_CONSOLE.md`

External design-reference snapshot:

- CairnStone chain `reference:vercel-labs/json-render`
- upstream immutable commit `3ad381881194e7011ad3ccd6d668033495a06c29`

## Standalone-repo extraction gate

Create a separate repository/product only when all are true:

1. the CairnStone PWA/Home surface is successful as a real iPhone workflow;
2. the same generic schema drives at least **three distinct products/sources**, including at least one non-CairnStone source;
3. the renderer/configuration lifecycle is clearly separable from CairnStone Console releases;
4. the product needs its own onboarding, configuration/storage model, branding, or native iOS/WidgetKit bridge;
5. extraction does not duplicate CairnStone authority, secrets, or operational state.

If those gates are met, the broader product becomes an independent **programmable Home Screen information/control layer**. PWAs remain the initial render target; native iOS widgets may be added later. CairnStone becomes one source/adapter among many.

## Non-goals for the first slice

- no App Store/native Swift requirement;
- no attempt to programmatically rearrange the iOS Home Screen;
- no claim that a PWA icon is itself a continuously rendered live widget;
- no new accepted-state or execution authority;
- no fork of the full Console into a second mobile codebase;
- no standalone repo before the extraction gate.

## Overall acceptance

V7.7.11 is accepted when:

- CairnStone Console installs on an iPhone Home Screen and launches as a standalone web app;
- the installed default landing surface is useful as a compact dashboard;
- the dashboard deep-links into existing Console surfaces without duplicating business logic;
- offline/stale state is represented honestly;
- capability/secret persistence and authorization boundaries are unchanged;
- at least one bounded badge/attention path is proven if platform support permits it;
- the `Source + View + Action + Appearance` schema is documented and tested against CairnStone plus at least two additional source adapters before a standalone-repo extraction decision.
