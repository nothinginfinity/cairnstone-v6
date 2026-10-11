-- S0b-2 PRIVATE-D1 migration candidate.
-- DRAFT ONLY. Not applied. Not in the main migrations/ directory on purpose.
-- Based on docs/private-realm/schema.sql.draft at PR #73 head 5a97e9cc552a2db576ccb40236f9f699816e5073.
-- Lives under migrations/private/ so wrangler d1 migrations apply on CAIRNSTONE_DB will never pick it up.
-- Applying this requires a separate explicit owner approval and a dedicated private D1 binding.
-- Fixed: ESCAPE uses a single backslash character (SQLite requires one character).
-- Added: role column on connections for admin/member persistence.
-- Added: BEFORE INSERT authorization triggers on priv_messages/priv_deliveries. Application code
--   checks authorization first (for precise audited denials), but a revocation can commit between
--   that check and the write. These triggers re-evaluate authorization INSIDE the write, so a
--   message or delivery from a connection/grant that is no longer effective cannot commit. A
--   RAISE(ABORT) inside db.batch() rolls back the whole batch: no partial delivery.

PRAGMA foreign_keys = ON;

CREATE TABLE priv_homes (
  home_id      TEXT PRIMARY KEY CHECK (home_id LIKE 'home\_%' ESCAPE '\' AND length(home_id) BETWEEN 12 AND 80),
  account_id   TEXT NOT NULL CHECK (account_id LIKE 'acct\_%' ESCAPE '\'),
  tenant_id    TEXT NOT NULL CHECK (tenant_id LIKE 'ten\_%' ESCAPE '\'),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','exporting','retired')),
  created_at   TEXT NOT NULL,
  UNIQUE (home_id, account_id)
);
-- Exactly one default Home per account.
CREATE UNIQUE INDEX priv_homes_one_default ON priv_homes(account_id) WHERE is_default = 1;
CREATE INDEX priv_homes_account ON priv_homes(account_id);

CREATE TABLE priv_home_connections (
  home_id        TEXT NOT NULL REFERENCES priv_homes(home_id),
  connection_id  TEXT NOT NULL CHECK (connection_id LIKE 'conn\_%' ESCAPE '\'),
  principal_id   TEXT NOT NULL CHECK (principal_id LIKE 'prin\_%' ESCAPE '\'),
  provider_label TEXT NOT NULL DEFAULT 'unspecified',
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at     TEXT NOT NULL,
  revoked_at     TEXT,
  PRIMARY KEY (home_id, connection_id),
  UNIQUE (connection_id),
  UNIQUE (home_id, principal_id)
);

CREATE TABLE priv_inboxes (
  home_id    TEXT NOT NULL REFERENCES priv_homes(home_id),
  inbox_id   TEXT NOT NULL CHECK (inbox_id LIKE 'ibx\_%' ESCAPE '\' AND length(inbox_id) BETWEEN 8 AND 80),
  scope      TEXT NOT NULL CHECK (scope IN ('home','connection','agent_identity')),
  plane      TEXT NOT NULL CHECK (plane IN ('chat','work','notifications','control')),
  owner_connection_id TEXT,
  label      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (home_id, inbox_id),
  FOREIGN KEY (home_id, owner_connection_id) REFERENCES priv_home_connections(home_id, connection_id),
  CHECK ((scope = 'connection' AND owner_connection_id IS NOT NULL) OR (scope <> 'connection' AND owner_connection_id IS NULL))
);

CREATE TABLE priv_inbox_grants (
  home_id       TEXT NOT NULL,
  inbox_id      TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  can_read      INTEGER NOT NULL DEFAULT 0 CHECK (can_read IN (0,1)),
  can_send      INTEGER NOT NULL DEFAULT 0 CHECK (can_send IN (0,1)),
  can_ack       INTEGER NOT NULL DEFAULT 0 CHECK (can_ack IN (0,1)),
  granted_at    TEXT NOT NULL,
  revoked_at    TEXT,
  PRIMARY KEY (home_id, inbox_id, connection_id),
  FOREIGN KEY (home_id, inbox_id) REFERENCES priv_inboxes(home_id, inbox_id),
  FOREIGN KEY (home_id, connection_id) REFERENCES priv_home_connections(home_id, connection_id)
);

CREATE TABLE priv_messages (
  home_id            TEXT NOT NULL,
  message_id         TEXT NOT NULL CHECK (length(message_id) BETWEEN 8 AND 120),
  thread_id          TEXT NOT NULL,
  sender_inbox_id    TEXT NOT NULL,
  sender_connection_id TEXT NOT NULL,
  body_sha256        TEXT NOT NULL CHECK (length(body_sha256) = 64),
  body_text          TEXT,
  body_r2_key        TEXT,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (home_id, message_id),
  FOREIGN KEY (home_id, sender_inbox_id) REFERENCES priv_inboxes(home_id, inbox_id),
  FOREIGN KEY (home_id, sender_connection_id) REFERENCES priv_home_connections(home_id, connection_id),
  CHECK (body_text IS NOT NULL OR body_r2_key IS NOT NULL)
);
CREATE INDEX priv_messages_thread ON priv_messages(home_id, thread_id, created_at);

CREATE TRIGGER priv_messages_no_update BEFORE UPDATE ON priv_messages
BEGIN SELECT RAISE(ABORT, 'priv_messages is immutable'); END;
CREATE TRIGGER priv_messages_no_delete BEFORE DELETE ON priv_messages
BEGIN SELECT RAISE(ABORT, 'priv_messages is immutable'); END;

-- Backstop: a message may only be written by a connection that is active, in an active Home, holding
-- a live `send` grant on an active sender inbox it may reach (connection-private inboxes: owner only).
CREATE TRIGGER priv_messages_sender_authorized BEFORE INSERT ON priv_messages
WHEN NOT EXISTS (
  SELECT 1
  FROM priv_home_connections c
  JOIN priv_homes h ON h.home_id = c.home_id
  JOIN priv_inbox_grants g ON g.home_id = c.home_id AND g.connection_id = c.connection_id
  JOIN priv_inboxes i ON i.home_id = g.home_id AND i.inbox_id = g.inbox_id
  WHERE c.home_id = NEW.home_id AND c.connection_id = NEW.sender_connection_id
    AND c.status = 'active' AND h.status = 'active'
    AND g.inbox_id = NEW.sender_inbox_id AND g.revoked_at IS NULL AND g.can_send = 1
    AND i.status = 'active' AND (i.scope <> 'connection' OR i.owner_connection_id = c.connection_id)
)
BEGIN SELECT RAISE(ABORT, 'sender_not_authorized'); END;

CREATE TABLE priv_deliveries (
  home_id      TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  inbox_id     TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  read_at      TEXT,
  acked_at     TEXT,
  PRIMARY KEY (home_id, message_id, inbox_id),
  FOREIGN KEY (home_id, message_id) REFERENCES priv_messages(home_id, message_id),
  FOREIGN KEY (home_id, inbox_id) REFERENCES priv_inboxes(home_id, inbox_id)
);
CREATE INDEX priv_deliveries_inbox ON priv_deliveries(home_id, inbox_id, delivered_at);

CREATE TRIGGER priv_deliveries_no_delete BEFORE DELETE ON priv_deliveries
BEGIN SELECT RAISE(ABORT, 'priv_deliveries is append-only'); END;
CREATE TRIGGER priv_deliveries_frozen_identity BEFORE UPDATE ON priv_deliveries
WHEN NEW.home_id <> OLD.home_id OR NEW.message_id <> OLD.message_id OR NEW.inbox_id <> OLD.inbox_id OR NEW.delivered_at <> OLD.delivered_at
BEGIN SELECT RAISE(ABORT, 'priv_deliveries identity is immutable'); END;
CREATE TRIGGER priv_deliveries_no_unread BEFORE UPDATE ON priv_deliveries
WHEN (OLD.read_at IS NOT NULL AND NEW.read_at IS NOT OLD.read_at) OR (OLD.acked_at IS NOT NULL AND NEW.acked_at IS NOT OLD.acked_at)
BEGIN SELECT RAISE(ABORT, 'delivery state cannot move backwards'); END;

CREATE TABLE priv_audit (
  audit_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  home_id       TEXT,
  connection_id TEXT,
  principal_id  TEXT,
  action        TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('allow','deny')),
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE TRIGGER priv_audit_no_update BEFORE UPDATE ON priv_audit
BEGIN SELECT RAISE(ABORT, 'priv_audit is append-only'); END;
CREATE TRIGGER priv_audit_no_delete BEFORE DELETE ON priv_audit
BEGIN SELECT RAISE(ABORT, 'priv_audit is append-only'); END;

-- Backstop: a delivery may only target an inbox on which the message's sender holds a live `send`
-- grant at the moment of the write (same reachability rules as above).
CREATE TRIGGER priv_deliveries_target_authorized BEFORE INSERT ON priv_deliveries
WHEN NOT EXISTS (
  SELECT 1
  FROM priv_messages m
  JOIN priv_home_connections c ON c.home_id = m.home_id AND c.connection_id = m.sender_connection_id
  JOIN priv_homes h ON h.home_id = c.home_id
  JOIN priv_inbox_grants g ON g.home_id = c.home_id AND g.connection_id = c.connection_id
  JOIN priv_inboxes i ON i.home_id = g.home_id AND i.inbox_id = g.inbox_id
  WHERE m.home_id = NEW.home_id AND m.message_id = NEW.message_id
    AND c.status = 'active' AND h.status = 'active'
    AND g.inbox_id = NEW.inbox_id AND g.revoked_at IS NULL AND g.can_send = 1
    AND i.status = 'active' AND (i.scope <> 'connection' OR i.owner_connection_id = c.connection_id)
)
BEGIN SELECT RAISE(ABORT, 'delivery_not_authorized'); END;
