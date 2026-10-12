-- S1-3 staging-only durable authorization store (issue #94). Version 1.
-- NEVER applied to production or to the private realm D1. A SEPARATE staging D1 (cairnstone-staging-auth),
-- provisioned and migrated only under an owner gate (issue #90). Synthetic data only.
--
-- Semantics (the adapter in src/staging-gateway/staging-auth-store.js enforces them again at read time):
--   * A token family is valid only if its row exists, revoked = 0, it belongs to the connection AND account named in the
--     token, and that connection row exists, is 'active', and belongs to the same account.
--   * Revocation is permanent: a revoked family or connection can never be revived (triggers below).
--   * Identity columns are immutable, so a row can never be re-associated with another account or connection.

CREATE TABLE IF NOT EXISTS staging_auth_schema (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE staging_connections (
  connection_id TEXT PRIMARY KEY CHECK (length(connection_id) BETWEEN 5 AND 80),
  account_id    TEXT NOT NULL CHECK (length(account_id) BETWEEN 5 AND 80),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','revoked')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX staging_connections_account ON staging_connections(account_id);

CREATE TABLE staging_token_families (
  token_family_id TEXT PRIMARY KEY CHECK (length(token_family_id) BETWEEN 5 AND 80),
  account_id      TEXT NOT NULL CHECK (length(account_id) BETWEEN 5 AND 80),
  connection_id   TEXT NOT NULL REFERENCES staging_connections(connection_id),
  revoked         INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  CHECK ((revoked = 0 AND revoked_at IS NULL) OR (revoked = 1 AND revoked_at IS NOT NULL))
);
CREATE INDEX staging_token_families_connection ON staging_token_families(connection_id);

CREATE TRIGGER staging_connections_identity_frozen BEFORE UPDATE ON staging_connections
WHEN NEW.connection_id <> OLD.connection_id OR NEW.account_id <> OLD.account_id OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'staging_connections identity is immutable'); END;

CREATE TRIGGER staging_connections_revoked_is_terminal BEFORE UPDATE ON staging_connections
WHEN OLD.status = 'revoked' AND NEW.status <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'revoked connection cannot be revived'); END;

CREATE TRIGGER staging_connections_no_delete BEFORE DELETE ON staging_connections
BEGIN SELECT RAISE(ABORT, 'staging_connections is append-only'); END;

CREATE TRIGGER staging_token_families_identity_frozen BEFORE UPDATE ON staging_token_families
WHEN NEW.token_family_id <> OLD.token_family_id OR NEW.account_id <> OLD.account_id OR NEW.connection_id <> OLD.connection_id OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'staging_token_families identity is immutable'); END;

CREATE TRIGGER staging_token_families_revocation_is_permanent BEFORE UPDATE ON staging_token_families
WHEN OLD.revoked = 1 AND (NEW.revoked <> 1 OR NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT, 'revocation is permanent'); END;

CREATE TRIGGER staging_token_families_no_delete BEFORE DELETE ON staging_token_families
BEGIN SELECT RAISE(ABORT, 'staging_token_families is append-only'); END;

-- A family must belong to a connection of the SAME account.
CREATE TRIGGER staging_token_families_same_account BEFORE INSERT ON staging_token_families
WHEN NOT EXISTS (SELECT 1 FROM staging_connections c WHERE c.connection_id = NEW.connection_id AND c.account_id = NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'token family account does not match connection account'); END;

INSERT INTO staging_auth_schema (version, applied_at) VALUES (1, 0);
