# V7.7.10k — X Action Connectors / Governed Social Operator

Status: **ROADMAP-ACCEPTED / DESIGN-FIRST; BUILD AFTER MINIMUM ACCOUNT/CONNECTION IDENTITY IS AVAILABLE.** The first implementation should reuse X's official API/MCP primitives where possible and add CairnStone policy, durable state, idempotency, receipts, and cross-model continuity rather than rebuilding the entire X API surface.

## Motivation

Grok already has strong native read/search awareness of X, but account actions, durable workflow state, and cross-model continuation need a governed connector layer. X now operates a hosted X API MCP endpoint at `https://api.x.com/mcp`; CairnStone should treat that as an upstream capability adapter where practical, not as CairnStone authority.

The product goal is:

> Let Grok, ChatGPT, Claude, and CairnStone agents safely operate the same X account workflows through one durable CairnStone policy/state layer.

## Architectural decision

```text
LLM host / Grok
  -> CairnStone semantic capability / Tool Belt
  -> V7.7.10i account + connection principal
  -> CairnStone policy / proposal / confirmation boundary
  -> X adapter
       -> official X MCP and/or X REST endpoint
  -> normalized result
  -> immutable execution receipt + cursor/idempotency state
  -> optional mini-stone / AC1 / analytics continuity
```

X authentication proves what the X API will accept. CairnStone separately determines what this agent/session/user is allowed to propose or execute.

## Why not build a giant X MCP clone

X's hosted MCP already exposes broad official API capability. CairnStone's differentiated layer is:

- stable semantic tool names;
- minimum-scope projection / Tool Belts;
- explicit draft/confirm behavior;
- idempotency and replay protection;
- account/connection-principal binding;
- cursor/state persistence;
- receipts and evidence;
- cross-model continuity;
- no silent posting;
- policy separation between reads, drafts, and external mutations.

Where X's official MCP does not expose a required operation cleanly, use the official REST API behind the same CairnStone contract.

## Authentication shape

Use a dedicated X connection under V7.7.10i:

```text
CairnStone account
  -> X connector installation
  -> X developer app / OAuth 2.0 PKCE user authorization
  -> CairnStone connection_id + principal_id
  -> encrypted X credential/token material
  -> per-tool minimum scopes
```

Important constraints:

- X credentials/tokens never enter Stones, AC1, normal model context, or ordinary receipts;
- connector reinstall may create a new CairnStone connection principal under the same account;
- app-only/read-only and user-context/write connections remain distinguishable;
- account A can never act as account B through shared model/session state;
- revocation fails closed.

## First tool schemas

Start with two narrow groups.

### Group A — Post / Reply Writer

Stable CairnStone-facing operations:

- `x_post_draft`
- `x_post_publish`
- `x_reply_draft`
- `x_reply_publish`
- `x_quote_draft`
- `x_quote_publish`
- `x_thread_draft`
- `x_thread_publish`

Rules:

- draft operations are non-publishing;
- publish operations require explicit confirmation unless a later accepted policy grants narrower authority;
- every publish call requires `idempotency_key`;
- duplicate replay returns the original receipt/result;
- conflicting key reuse fails closed;
- no silent auto-posting;
- thread publishing records per-post IDs plus one aggregate receipt.

Recommended publish envelope:

```json
{
  "draft_ref": "...",
  "idempotency_key": "...",
  "expected_account_id": "...",
  "confirm": true
}
```

The server derives the authenticated principal/account binding; caller-supplied account identity is only a consistency check.

### Group B — Bookmark / Read-Later Inbox

Operations:

- `x_bookmark_save`
- `x_bookmark_remove`
- `x_bookmark_list`
- `x_read_later_list`
- `x_read_later_mark_processed`

The CairnStone read-later layer may maintain a cursor and processed state without mutating the underlying X bookmark object unless explicitly requested.

This is a strong first mobile workflow because it converts X discovery into durable CairnStone research/task state.

## Later groups

3. List / audience operator:
   - create list;
   - add/remove member;
   - list timeline.

4. Engagement radar:
   - mentions / notifications / quote-posts since cursor;
   - triage only by default;
   - no automatic reply.

5. Analytics pull:
   - post/date-range impressions and engagements where available;
   - follower deltas;
   - normalized snapshot mini-stones / receipts.

6. DM digest:
   - opt-in read of DM threads;
   - sending always requires idempotency and explicit confirmation by default;
   - highest privacy sensitivity; ship later.

7. Search-to-action bridge:
   - saved search / current query in;
   - bounded top posts out;
   - optional bookmark or draft reply;
   - publish still uses the normal confirmation boundary.

## Tool Belt recommendation

Expose X capabilities as belts rather than one giant catalog:

- `x-researcher`: public search/read + optional bookmarks;
- `x-publisher-draft`: research + draft creation, no publish;
- `x-publisher-confirmed`: publish only through explicit confirmation;
- `x-community-triage`: mentions/quotes/list reads, no automatic reply;
- later `x-analytics`.

A belt can narrow capability but never expand the account's X scopes or CairnStone authority.

## Relationship to mini-stone plugin strategy

The X connector is an action/distribution adapter, not the persistence layer.

Examples:

- a "Decision Log" or "Meeting Notes" plugin can optionally publish a human-approved summary to X;
- Plugin Idea Scout can record hypotheses as mini-stones and use X search/analytics as evidence;
- Handoff Pack can create an internal artifact and separately draft a public announcement;
- X engagement/analytics snapshots can become evidence refs without making social metrics accepted project truth.

## Build sequence

1. `10k.0` — freeze X connection/auth/tool/receipt/idempotency contracts and threat model.
2. `10k.1` — official-X capability probe + adapter abstraction; prove read-only account identity.
3. `10k.2` — bookmark/read-later tools with cursor/processed state.
4. `10k.3` — post/reply/quote/thread draft tools.
5. `10k.4` — human-confirmed publishing + idempotency/replay receipts.
6. `10k.5` — lists + engagement radar.
7. `10k.6` — analytics.
8. `10k.7` — DM digest/send under stricter privacy/confirmation rules.
9. `10k.8` — cross-model/mobile acceptance on Grok plus at least ChatGPT and Claude.

## Acceptance

Must prove:

- no write can occur without the required idempotency key;
- default publishing is confirmation-gated;
- replay is deterministic and conflicting reuse fails closed;
- X account identity is server-bound and tenant-isolated;
- revoked/expired credentials fail closed;
- minimum scopes are documented per tool group;
- no connector secret appears in Stones, AC1, model context, receipts, or logs;
- Grok can discover and call the stable CairnStone X tools;
- at least one workflow can begin in Grok and continue in ChatGPT/Claude with the same CairnStone state;
- upstream X MCP/REST changes do not silently change CairnStone tool semantics;
- read-later state and receipts survive host/app reconnect.

## Source context

Originating AC1 message:
- message: `msg:90d4e785-9039-41c7-8f4e-328e250f1f14`
- thread: `x-connectors-for-grok-2026-10`
- source Stone: `5d3173eca5fe69c6b60d6f7fe348a09c339b7bfdfd41f1b16806db4a6cba40fc`

This slice should be implemented as an adapter/policy layer over official X capabilities wherever practical, with CairnStone owning durable state, authorization policy, receipts, and provider-neutral semantics.
