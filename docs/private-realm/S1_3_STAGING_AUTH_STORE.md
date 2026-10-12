# Staging-only durable auth store (source-only)

Required for `STAGING_AUTH_STORE` binding in the gateway Worker.

## Interface
The binding must expose:
- `isRevoked(tokenFamilyId: string): Promise<boolean>`
- `connectionActive(connectionId: string): Promise<boolean>`

Absent binding, missing record, revoked family, inactive connection, or any store error **denies**.

## Proposed schema (staging D1 only; never production)
```sql
CREATE TABLE IF NOT EXISTS staging_token_families (
  token_family_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS staging_connections (
  connection_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
```

Wrangler binding example (not activated):
```toml
[[d1_databases]]
binding = "STAGING_AUTH_STORE"
database_name = "cairnstone-staging-auth"
database_id = "<owner-provisioned>"
```

Activation is an owner gate under issue #90. No secrets or production data.
