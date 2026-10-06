-- V7.7.10f.1c: semantic state/read hooks.
--
-- Freshness results and AC1 delivery transitions are fail-closed D1 triggers:
-- the recorded state change and its semantic audit event share one SQLite
-- statement boundary. A journal insert failure aborts the freshness or
-- delivery mutation. LOD reads are recorded by the application before the
-- payload is returned; this migration does not store LOD payload content.
-- Event rows remain telemetry: accepted_state_authority is always 0.
-- Journal rows never move chain_heads or path_heads.

CREATE TRIGGER IF NOT EXISTS event_journal_freshness_checked_inserted
AFTER INSERT ON source_freshness
BEGIN
  INSERT INTO event_journal (
    event_id, schema, event_type, event_class, source, occurred_at,
    actor_id, object_ref, subject_ref, chain_name, path,
    stone_hash, related_hash, from_state, to_state, lod_level,
    observed_commit_sha, content_sha256, request_correlation_id,
    detail_json, accepted_state_authority
  ) VALUES (
    'evt:' || lower(hex(randomblob(16))),
    'cairnstone-semantic-event-v1',
    'freshness.checked',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NULL,
    'freshness:' || NEW.chain || ':' || NEW.path,
    CASE WHEN NEW.accepted_stone_hash IS NULL THEN NULL ELSE 'stone:' || NEW.accepted_stone_hash END,
    NEW.chain,
    NEW.path,
    NEW.accepted_stone_hash,
    NULL,
    NULL,
    CASE
      WHEN NEW.drift_reason = 'removed' OR NEW.drift_reason = 'no_accepted_stone_and_missing_source' THEN 'removed'
      WHEN NEW.drift_reason LIKE 'observation_failed:%' THEN 'error'
      WHEN NEW.drift = 0 THEN 'in_sync'
      ELSE 'drifted'
    END,
    NULL,
    NEW.observed_commit_sha,
    NEW.observed_content_sha256,
    NULL,
    json_object(
      'outcome',
      CASE
        WHEN NEW.drift_reason = 'removed' OR NEW.drift_reason = 'no_accepted_stone_and_missing_source' THEN 'removed'
        WHEN NEW.drift_reason LIKE 'observation_failed:%' THEN 'error'
        WHEN NEW.drift = 0 THEN 'in_sync'
        ELSE 'drifted'
      END,
      'drift_reason', NEW.drift_reason
    ),
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_freshness_checked_updated
AFTER UPDATE ON source_freshness
BEGIN
  INSERT INTO event_journal (
    event_id, schema, event_type, event_class, source, occurred_at,
    actor_id, object_ref, subject_ref, chain_name, path,
    stone_hash, related_hash, from_state, to_state, lod_level,
    observed_commit_sha, content_sha256, request_correlation_id,
    detail_json, accepted_state_authority
  ) VALUES (
    'evt:' || lower(hex(randomblob(16))),
    'cairnstone-semantic-event-v1',
    'freshness.checked',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NULL,
    'freshness:' || NEW.chain || ':' || NEW.path,
    CASE WHEN NEW.accepted_stone_hash IS NULL THEN NULL ELSE 'stone:' || NEW.accepted_stone_hash END,
    NEW.chain,
    NEW.path,
    NEW.accepted_stone_hash,
    NULL,
    CASE
      WHEN OLD.drift_reason = 'removed' OR OLD.drift_reason = 'no_accepted_stone_and_missing_source' THEN 'removed'
      WHEN OLD.drift_reason LIKE 'observation_failed:%' THEN 'error'
      WHEN OLD.drift = 0 THEN 'in_sync'
      ELSE 'drifted'
    END,
    CASE
      WHEN NEW.drift_reason = 'removed' OR NEW.drift_reason = 'no_accepted_stone_and_missing_source' THEN 'removed'
      WHEN NEW.drift_reason LIKE 'observation_failed:%' THEN 'error'
      WHEN NEW.drift = 0 THEN 'in_sync'
      ELSE 'drifted'
    END,
    NULL,
    NEW.observed_commit_sha,
    NEW.observed_content_sha256,
    NULL,
    json_object(
      'outcome',
      CASE
        WHEN NEW.drift_reason = 'removed' OR NEW.drift_reason = 'no_accepted_stone_and_missing_source' THEN 'removed'
        WHEN NEW.drift_reason LIKE 'observation_failed:%' THEN 'error'
        WHEN NEW.drift = 0 THEN 'in_sync'
        ELSE 'drifted'
      END,
      'drift_reason', NEW.drift_reason
    ),
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_ac1_delivery_inserted
AFTER INSERT ON correspondence_deliveries
BEGIN
  INSERT INTO event_journal (
    event_id, schema, event_type, event_class, source, occurred_at,
    actor_id, object_ref, subject_ref, chain_name, path,
    stone_hash, related_hash, from_state, to_state, lod_level,
    observed_commit_sha, content_sha256, request_correlation_id,
    detail_json, accepted_state_authority
  ) VALUES (
    'evt:' || lower(hex(randomblob(16))),
    'cairnstone-semantic-event-v1',
    'ac1.delivery.transitioned',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NEW.recipient_id,
    'delivery:' || NEW.id,
    'stone:' || NEW.stone_hash,
    NULL,
    NULL,
    NEW.stone_hash,
    NULL,
    NULL,
    NEW.status,
    NULL,
    NULL,
    NULL,
    NULL,
    json_object('recipient_id', NEW.recipient_id, 'message_id', NEW.message_id, 'sender_id', NEW.sender_id),
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_ac1_delivery_updated
AFTER UPDATE OF status ON correspondence_deliveries
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO event_journal (
    event_id, schema, event_type, event_class, source, occurred_at,
    actor_id, object_ref, subject_ref, chain_name, path,
    stone_hash, related_hash, from_state, to_state, lod_level,
    observed_commit_sha, content_sha256, request_correlation_id,
    detail_json, accepted_state_authority
  ) VALUES (
    'evt:' || lower(hex(randomblob(16))),
    'cairnstone-semantic-event-v1',
    'ac1.delivery.transitioned',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NEW.recipient_id,
    'delivery:' || NEW.id,
    'stone:' || NEW.stone_hash,
    NULL,
    NULL,
    NEW.stone_hash,
    NULL,
    OLD.status,
    NEW.status,
    NULL,
    NULL,
    NULL,
    NULL,
    json_object('recipient_id', NEW.recipient_id, 'message_id', NEW.message_id, 'sender_id', NEW.sender_id),
    0
  );
END;
