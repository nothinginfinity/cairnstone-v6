# V7.7.6 — Mailbox capability resolution + no-bearer persistence

**Status:** Correctness note for Worker/MCP + host clients. Transport/docs/tests only. `accepted_state_authority: false`. This PR must **not** move `cairnstone-v6-project-memory` chain HEAD or any path HEADs.

**Live incident (2026-09-13):** Host `process.env.CAIRNSTONE_MAILBOX_CAPABILITY` held an expired injected bot secret that shadowed a newer valid operator-provided capability in box-secrets. Claim returned `mailbox_capability_expired_or_invalid_time` until the fresh secret was used. Console TTL countdown + Reissue shipped in [cairnstone-v6-console#3](https://github.com/nothinginfinity/cairnstone-v6-console/pull/3) (`POST /v1/mailbox-capabilities`).

## Deterministic client/host capability-resolution rule

When multiple `CAIRNSTONE_MAILBOX_CAPABILITY` sources exist (env override, box-secrets, console Issue/Reissue, operator paste):

1. Signature-inspect each candidate (Worker helper: `inspectMailboxCapabilityMetadata`). Do **not** trust client-asserted `iat`/`exp`/`principal`/`scopes` without signature verify.
2. Prefer the **unexpired** ticket with the **latest `iat`** (tie-break: highest `exp` among unexpired). Helper: `preferUnexpiredMailboxCapability`.
3. On `mailbox_capability_expired_or_invalid_time` (including `reason: "expired"`), **never retry the same token**. Reissue via operator `POST /v1/mailbox-capabilities` (console **Reissue mailbox cap**), then retry claim with the new ticket only.
4. Invalid signature remains a distinct error (`mailbox_capability_invalid_signature`) from expiry.

Worker claim (`cairnstone_workspace_invite_claim` / `verifyMailboxCapability`) stays fail-closed: expired tickets, wrong principal (including valid `mail.read:self` for a different actor), and bad signatures are rejected. Claim does not implement multi-source preference — that is host/client responsibility outside this Worker deploy.

## No-bearer persistence

Never persist workspace or mailbox bearers in:

- AC1 messages / notes / handoffs
- Stones / search / Scope
- GitHub
- invite D1 rows (mint returns `workspace_capability: null`; public invite `bearer_in_invite_record: false`)
- logs, screenshots, checkpoints, fixtures, or docs

Use obviously fake redacted placeholders only (e.g. `REDACTED_MAILBOX_CAPABILITY_PLACEHOLDER…`). Claim may return a short-lived workspace capability **once** on the claim response; it is not stored in invite records.

## Operator-side remainder (outside this repo)

Host env overrides and box-secret precedence are operator/console configuration. Clearing a stale `CAIRNSTONE_MAILBOX_CAPABILITY` env injection, or Reissuing and selecting the newest unexpired ticket, is required on the host — not a Worker deploy.
