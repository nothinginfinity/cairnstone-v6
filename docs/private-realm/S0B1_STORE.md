# S0b-1 — Private store interface + fake (draft)

Status: **implementation candidate**. Stacked on PR #71 design. No merge, deploy, migration, binding, or HEAD change.

## What landed

- `src/private-realm/store.js` — `assertHomeScope`, `createInMemoryHomeStore`, `resolveHomeStore`.
- Authenticated HomeScope only (account, tenant, principal, connection). Raw `homeId` is never the authority input.
- Idempotent `ensureDefaultHome`.
- Connection-private sibling denial (default; home-owned inboxes remain grantable).
- Revoke: revoked connection loses effective permission; other connections of the same Home keep theirs.
- Isolation negatives: cross-Home denied.
- `src/private-realm/boundary.js` — two-service-role plan (public gateway has no private bindings; internal private-storage Worker holds D1/R2).
- Tests: `test/private-realm-store.test.js`.

## Explicitly not done

- No production binding.
- No migration.
- No guard enforcement change.
- No private message bodies written anywhere public.
- No accepted HEAD movement.

Private messages must never land in public Stones or search. This store is the only place private bodies are allowed once a later approved binding exists.
