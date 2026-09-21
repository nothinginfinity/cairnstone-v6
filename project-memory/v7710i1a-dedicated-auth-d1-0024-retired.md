# V7.7.10i.1a — Dedicated Auth D1; shared 0024 retired before production

Status: **WIRING LANDED / DEPLOY NOT AUTHORIZED / LIVE RUNTIME STILL 0.5.43.**

Authority: Jared approved dedicated Auth D1 via ChatGPT `msg:e938b6a9-51a3-4287-aac8-791795a17769`.
Branches from main SHA: `6df4cef45694a8064307091483c498ec2646e21c`.
START HERE (10i.1 merged/deploy held): `11394b4d666dfdaf4ab3ff08a2800aa55f2e42db483207e8474eaca8306e5f17`.

## What changed

- `CAIRNSTONE_DB` remains vault/graph/workspace/AC1.
- New production binding `CAIRNSTONE_AUTH_DB` → D1 name `cairnstone-v6-auth` with `migrations_dir = "migrations/auth"`.
- Auth schema re-homed to `migrations/auth/0001_v7710i1_core_auth.sql`.
- **Retired:** `migrations/0024_v7710i1_core_auth.sql` from the shared migration stream.
- Shared `0024` was **superseded before production application** (10i.1 START HERE: no remote migration 0024 authorized). Do not reintroduce auth tables under `migrations/`.
- Deploy workflow adds `apply_auth_migrations` (default `false`), fail-closed if Auth D1 id is still `PLACEHOLDER_*`. Shared `apply_migrations` unchanged (default `false`).

## Manual provision (Jared)

```bash
npx wrangler d1 create cairnstone-v6-auth
# replace PLACEHOLDER_CREATE_cairnstone-v6-auth in wrangler.toml
```

Do **not** substitute the shared `cairnstone-v6` database id.

## Held

No deploy-cloudflare dispatch, Worker publish, remote migration apply, enforcement flip, canary auto-admit, or seeded admissions.

See `docs/V7_7_10I_1_ADDITIVE_CORE_AUTH.md`.
