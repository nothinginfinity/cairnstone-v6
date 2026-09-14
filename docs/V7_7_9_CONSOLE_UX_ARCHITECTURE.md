# V7.7.9 — Console UX Architecture + Responsive Shell

Status: **PLANNED / AFTER V7.7.8**
Slice: `V7.7.9`
Implementation started: `false`

## Why this milestone exists

CairnStone Console has grown by adding capabilities one surface at a time: Chat, Evidence, Inbox, Handoff, Activity, Stones, Code, Invite, Authorize, Scope, and Bird's Eye / Universe. That incremental architecture was correct while runtime contracts were still being established, but the Console is now large enough that continuing to add top-level controls will create avoidable cognitive and mobile-layout cost.

V7.7.9 is the deliberate whole-Console UX architecture pass. It does **not** replace any authority model or runtime contract. It reorganizes how humans navigate and progressively reveal those capabilities.

> **CairnStone should expose the smallest useful operating surface first, then let complexity unfold in place.**

This extends the V7.7.8 chat principle — "complexity grows inward, not outward" — to the entire Console.

## Placement

V7.7.9 follows **V7.7.8 — Progressive Grounded Chat LOD**.

1. V7.7.8 defines the grounded-response identity and Answer Depth contract that the redesigned Chat surface must host.
2. V7.7.9 reorganizes the full Console around stable Chat, Code Session, Scope, AC1, Evidence, authorization, and response-LOD primitives.
3. V7.8 Federation / StoneLink remains architecturally separate. The shell should be able to represent future local/external trust and scope state without making federation a blocker.

Creating this plan does not move the current project-memory START HERE by itself.

## Product goals

### 1. Chat-first operating model

Chat becomes the normal landing surface rather than one equal tab among many. The user should be able to ask grounded questions immediately, see current Scope without a large setup form, inspect/change provider/model only when relevant, expand Answer Depth through V7.7.8, drill into evidence/receipts/provenance from the answer that caused them, and transition into Code / Work context without losing the thread or Scope.

Chat remains grounded by accepted CairnStone state and never becomes accepted-state authority itself.

### 2. Task-oriented primary navigation

Replace the current nine-peer-tab mental model with a small stable primary navigation layer.

Working mobile-first model:

```text
Chat · Work · Universe · Inbox · More
```

- **Chat** — grounded questions, model routing, response LOD, answer-linked evidence.
- **Work** — Persistent Code Mode, Code Sessions, checkpoints, working tree, tasks, leases, tests, relevant invitations.
- **Universe** — Scope selection, repo/chain navigation, Bird's Eye / Universe v2, saved operating views.
- **Inbox** — AC1 threads, activity, handoffs, task requests/results, actor communication.
- **More** — Stones, evidence explorer, Authorize, operator/runtime settings, diagnostics, advanced/raw surfaces.

Exact labels may change after prototype testing, but the hierarchy must remain small and task-oriented. Desktop may expose a rail/sidebar version of the same information architecture; mobile and desktop must share one semantic navigation model.

### 3. Compact context bar instead of permanent setup cards

Runtime, actor, Scope, current Code Session, trust/authority state, and provider/model should be represented through a compact contextual header/bar where possible.

```text
CairnStone
Scope: CairnStone Platform  ·  18 repos / 32 chains
Actor: console:jared
Session: cs:... (when active)
```

Tapping a context item opens the appropriate sheet/panel. Raw MCP URL, actor override, credential alias, authority digest, and exact Scope ID remain inspectable but should not occupy first-screen space during normal use.

### 4. Progressive disclosure across the whole Console

V7.7.9 generalizes LOD-style interaction beyond chat.

- Scope shows compact identity first; full chain list/authority digest expands on demand.
- Chat shows LOD 1 first; evidence and deeper analysis unfold from the same answer identity.
- Code Session shows current task/status first; checkpoints, leases, environment, sandbox, receipts, and working-tree detail open progressively.
- Inbox shows thread summaries first; immutable Stone/provenance metadata is secondary detail.
- Authorization shows human-readable material effect first; exact stored arguments/guard/provenance remain one drill-down away.
- Stones show title/currentness/provenance first; LOD/ref/raw content expands only when requested.

Progressive disclosure changes presentation only. It never changes accepted authority, mutation policy, or evidence identity.

### 5. Stable spatial layout

Controls must not disappear merely because asynchronous state finishes resolving unless the control genuinely ceases to exist. When a mode does not support a control, prefer visible + disabled + explanatory state or move it into a clearly labeled mode-specific drawer. Avoid layout jumps that make the user think the UI failed.

Loading, empty, stale, unavailable, disabled, blocked, and error states should each have explicit semantics.

### 6. Mobile-first acceptance

The Console must be genuinely usable on iPhone-sized viewports, not merely responsive enough to avoid horizontal scrolling.

Targets:

- 44px+ touch targets for primary actions;
- bottom/compact navigation suitable for one-handed use;
- no 3x3 dense top-level tab matrix;
- no required horizontal scrolling;
- contextual sheets/drawers for configuration;
- sticky/persistent primary actions where appropriate;
- keyboard-safe input layout;
- reduced-motion and non-spatial fallbacks;
- understandable content at 320–430px widths;
- desktop uses extra width to reveal context, not to create different semantics.

## Bird's Eye / Universe v2

V7.7.3 established the authority-safe Universe projection and proved shared Scope selection. V7.7.9 treats that implementation as the first functional projection, not the final interaction design.

Use `nothinginfinity/prax-your-universe` as an interaction/rendering reference where useful while keeping CairnStone's own data and authority model.

Semantic zoom ladder:

1. **Vault / workspace view** — repository constellations/groups, saved operating views, bounded activity/status cues.
2. **Repository view** — repository as primary selected object; child chains unfold only for the selected/focused repo.
3. **Chain view** — chain identity, canonical HEAD, high-value milestones, bounded recent/accepted intelligence.
4. **Intelligence view** — selected START HERE, path HEADs, handoffs, evidence, Code Sessions, or other grounded objects; never every Stone by default.

Desired interactions include touch orbit/pan/zoom where supported, sphere/grid or equivalent projections, raycast/tap selection, search-to-focus, multi-select with explicit Apply, selection preservation when switching spatial/list/grid views, a clear Back-to-list escape path, selected-node detail sheet, and temporary retrieval/reasoning paths visually distinct from permanent grounded relationships.

Spatial coordinates, clustering, size, animation, and proximity are presentation metadata only. They never create graph edges, authority relationships, repository membership, or accepted-state claims. List/search Scope navigation remains a first-class fallback.

## Chat architecture after V7.7.8

V7.7.8c remains responsible for the first Answer Depth UX. V7.7.9 incorporates it into the redesigned shell.

The Chat surface should support persistent conversation/thread presentation, compact Scope context, provider/model controls in secondary settings, stable provider/model visibility when modes change, LOD 1–5 controls attached to each grounded answer, stale-answer refresh-vs-original-snapshot behavior, answer-linked Evidence drawers, receipts/authorization state, Code Session identity when operating inside Persistent Code Mode, and natural-language transitions such as "LOD 4 that", "show evidence", "open this in Code", or "switch Scope to repo X" where runtime authority permits.

Grounded Chat and agent/tool-capable interactions must remain visibly distinguishable where authority/execution behavior differs.

## Work / Persistent Code Mode UX

The current V7.7.7f Code Session Console is the functional base. V7.7.9 evolves it into a coherent Work surface showing active Code Session, project/workspace identity, current task/state, participating actors and leases, test summary, working-tree status, most recent checkpoint, environment/sandbox state, invitations, execution receipts, and propose/review/accept flow.

Deep details open from summaries rather than forcing all state onto one page. Chat and Work should be cross-linked without duplicating authority state.

## Inbox / communication UX

Consolidate the human mental model currently split across Inbox, Handoff, Activity, and invitation/task correspondence. Backend contracts remain distinct, but the UI may present one coherent communication/work stream with filters for threads, unread/needs-response, handoffs, task requests/results, workspace invitations, grounded actor activity, priority, and scoped vs unscoped correspondence.

Do not infer project/repository ownership from actor names or message text. Scope filtering remains evidence-based only. Compose actions should clearly distinguish message, handoff, task request, and invite. None grants execution authority merely by being sent.

## Evidence, Stones, and Authorize

These remain essential but do not need equal permanent top-level prominence.

Evidence should be accessible contextually from a grounded Chat answer, Code Session/checkpoint/receipt, Scope/Universe selection, or authorization request. A general Evidence explorer remains available under More/advanced navigation.

Stones remain the durable inspection plane. Default presentation prioritizes accepted/current vs historical, title/path/repo, canonical/head identity, and concise summary. Raw LOD/ref expansion remains on demand.

Authorize remains a deliberately distinct trusted-human boundary. The redesign must not make approval feel like an ordinary chat button. Consequential mutation approval should visibly display material effect, target resource, guard/concurrency condition, one-time/expiry semantics, exact argument/provenance drill-down, and clear Approve/Reject actions.

## Saved operating views

Carry forward the original V7.7 saved-workspace/navigation idea without conflating it with the later shared-agent Workspace draft plane. Use a clearer UX term such as **Saved View** or **Operating View** for user-defined Scope/navigation presets.

Examples: CairnStone Platform, Music Projects, Financial Software, Everything.

A Saved View stores selectors and presentation preferences, not accepted-state authority and not agent workspace mutation capability. Opening it resolves a fresh Scope snapshot.

## Design system / implementation constraints

V7.7.9 should establish reusable Console primitives rather than continue one-off feature markup. Define consistent components/tokens for app shell, navigation, context pills, cards/panels, drawers/sheets, status chips, action hierarchy, loading/empty/error/stale/blocked states, evidence/provenance rows, LOD controls, thread/message rows, Code Session/task/checkpoint rows, responsive typography/spacing, touch targets, and focus/accessibility states.

The Console should remain lightweight. Framework adoption is allowed only if measured complexity justifies it; this milestone does not require a framework rewrite.

## Initial implementation sequence

### V7.7.9a — Information architecture + responsive shell

- establish `Chat · Work · Universe · Inbox · More` or acceptance-tested equivalent;
- responsive mobile bottom navigation / desktop rail;
- compact context header;
- preserve current feature reachability;
- eliminate dense top-level 3x3 navigation.

### V7.7.9b — Chat + contextual evidence integration

- integrate V7.7.8 Answer Depth into the new Chat surface;
- move route/model controls into stable contextual configuration;
- answer-linked evidence/provenance/receipt drawers;
- preserve single-chain vs multi-chain capability honesty.

### V7.7.9c — Work + communications consolidation

- evolve V7.7.7f Code into the Work surface;
- consolidate Inbox/Handoff/Activity into coherent communication navigation;
- preserve underlying AC1 intent and authority boundaries.

### V7.7.9d — Universe v2

- implement semantic zoom from Vault -> Repo -> Chain -> Intelligence;
- richer touch/spatial projection using Prax patterns where useful;
- list/grid fallback parity;
- search-to-focus and selection preservation;
- bounded current-LOD loading.

### V7.7.9e — Progressive disclosure + Saved Views

- apply progressive-disclosure patterns across Scope, Stones, Evidence, Work, and Authorize;
- introduce Saved Views as navigation convenience state;
- preserve exact current authority resolution on open.

### V7.7.9f — Cross-device UX acceptance

- iPhone-size mobile acceptance;
- desktop acceptance;
- accessibility and reduced-motion;
- performance/loading-state acceptance;
- no hidden/unreachable legacy capability;
- live authority/mutation boundary verification.

## Acceptance

V7.7.9 is complete only when live acceptance proves:

- every currently supported Console capability remains reachable after redesign;
- mobile primary navigation uses a small stable information architecture rather than nine equal top-level tabs;
- no horizontal overflow at accepted phone viewports;
- common Chat and Code/Work tasks require materially less scrolling/configuration before first action;
- asynchronous Scope/model/runtime resolution does not cause unexplained disappearing controls or destructive layout jumps;
- Chat defaults to V7.7.8 LOD behavior and deeper evidence remains bound to the same grounded response identity;
- single-chain and cross-Scope behavior remain honest about routing/tool differences;
- active Scope persists coherently across Chat, Work, Universe, Evidence, and Stones where contracts support it;
- Code Session identity/checkpoints/leases/environment/receipts remain authoritative runtime data, not duplicated UI state;
- Inbox/Handoff/Activity consolidation preserves AC1 intent, immutable message identity, and evidence-based Scope association;
- Authorize remains visually and operationally distinct from ordinary chat/work actions;
- Universe v2 and list/search navigation resolve to the same canonical Scope selectors and authority snapshot;
- spatial presentation creates zero synthetic authority/graph relationships;
- Saved Views store selectors/presentation only and resolve fresh authority when opened;
- loading, stale, unavailable, disabled, blocked, empty, and error states are explicit;
- keyboard/focus/reduced-motion basics are verified;
- accepted-state chain/path HEADs are unchanged by pure navigation/presentation workflows;
- mutation/execution boundaries remain governed by V7.3 authorization;
- the Console remains a client of CairnStone authority, never a competing source of truth.

## Non-goals

- No replacement of CairnStone chain/path-HEAD authority.
- No synthetic global HEAD.
- No silent merging of Chat, Work, and authorization authority.
- No requirement to render every Stone/chain in spatial mode.
- No removal of advanced/raw inspection capabilities.
- No design-only state that masquerades as accepted evidence.
- No framework rewrite solely for aesthetics.
- No federation requirement for V7.7.9 completion.

## First bounded step when activated

Start with **V7.7.9a — Information Architecture + Responsive Shell**, using the current live Console as a behavior-preservation baseline.

Before implementation, capture mobile and desktop baseline receipts for navigation reachability, first-action distance for Chat and Code Session, viewport overflow, Scope/context visibility, and key loading-state behavior. Then change shell/navigation before redesigning individual feature internals so subsequent Chat, Work, Inbox, and Universe work targets the accepted new architecture.
