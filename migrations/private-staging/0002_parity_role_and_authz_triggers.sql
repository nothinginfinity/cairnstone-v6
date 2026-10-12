-- S1-3 repair (B1): bring the isolated staging schema to parity with canonical S0b-2
-- (migrations/private/0001_s0b2_private_realm.sql). NOT APPLIED to any Cloudflare resource.
-- Applying this to the staging D1 needs separate explicit owner approval. The existing staging DB
-- has no wrangler migration ledger, so execute statement-by-statement (or recreate the DB from 0001+0002).
-- Staging holds synthetic data only.

ALTER TABLE priv_home_connections ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member'));

CREATE INDEX IF NOT EXISTS priv_service_nonces_issued ON priv_service_nonces(issued_at);

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
