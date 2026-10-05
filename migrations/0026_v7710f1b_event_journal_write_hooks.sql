-- V7.7.10f.1b: fail-closed semantic audit hooks for authoritative writes.
--
-- These triggers keep the state mutation and its semantic audit event inside
-- the same SQLite transaction/statement boundary. If the event_journal insert
-- fails, SQLite aborts the originating Stone / HEAD / edge mutation as well.
-- Event rows remain telemetry only: accepted_state_authority is always 0 and
-- the journal never mutates chain_heads or path_heads.

CREATE TRIGGER IF NOT EXISTS event_journal_stone_created
AFTER INSERT ON stones
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
    'stone.created',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NEW.author,
    'stone:' || NEW.hash,
    NULL,
    NEW.chain_hash,
    NEW.path,
    NEW.hash,
    NULL,
    NULL,
    NULL,
    NULL,
    NEW.commit_sha,
    CASE
      WHEN NEW.raw_key GLOB 'raw/[0-9a-fA-F]*.txt' AND length(NEW.raw_key) = 72
        THEN lower(substr(NEW.raw_key, 5, 64))
      ELSE NULL
    END,
    NULL,
    '{}',
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_chain_head_inserted
AFTER INSERT ON chain_heads
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
    'head.chain.changed',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NULL,
    'chain:' || NEW.chain,
    'stone:' || NEW.head_hash,
    NEW.chain,
    NULL,
    NEW.head_hash,
    NULL,
    NULL,
    NEW.head_hash,
    NULL,
    NULL,
    NULL,
    NULL,
    '{}',
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_chain_head_updated
AFTER UPDATE OF head_hash ON chain_heads
WHEN OLD.head_hash IS NOT NEW.head_hash
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
    'head.chain.changed',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NULL,
    'chain:' || NEW.chain,
    'stone:' || NEW.head_hash,
    NEW.chain,
    NULL,
    NEW.head_hash,
    NULL,
    OLD.head_hash,
    NEW.head_hash,
    NULL,
    NULL,
    NULL,
    NULL,
    '{}',
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_path_head_inserted
AFTER INSERT ON path_heads
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
    'head.path.changed',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NULL,
    'path-head:' || NEW.chain || ':' || NEW.path,
    'stone:' || NEW.head_hash,
    NEW.chain,
    NEW.path,
    NEW.head_hash,
    NULL,
    NULL,
    NEW.head_hash,
    NULL,
    NULL,
    NULL,
    NULL,
    '{}',
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_path_head_updated
AFTER UPDATE OF head_hash ON path_heads
WHEN OLD.head_hash IS NOT NEW.head_hash
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
    'head.path.changed',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NULL,
    'path-head:' || NEW.chain || ':' || NEW.path,
    'stone:' || NEW.head_hash,
    NEW.chain,
    NEW.path,
    NEW.head_hash,
    NULL,
    OLD.head_hash,
    NEW.head_hash,
    NULL,
    NULL,
    NULL,
    NULL,
    '{}',
    0
  );
END;

CREATE TRIGGER IF NOT EXISTS event_journal_edge_created
AFTER INSERT ON stone_edges
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
    'edge.created',
    'semantic',
    'journal',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    NULL,
    'edge:' || NEW.id,
    'stone:' || NEW.to_hash,
    (SELECT chain_hash FROM stones WHERE hash = NEW.from_hash),
    NULL,
    NEW.from_hash,
    NEW.to_hash,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    json_object('edge_type', NEW.edge_type),
    0
  );
END;
