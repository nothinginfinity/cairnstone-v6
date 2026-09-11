-- V7.7.5: Seed workspace_members for existing workspace
-- ws:v775-multi-actor-workplane.
--
-- Idempotent: safe to re-run. Relies on the workspace_members FK against
-- workspaces(workspace_id) - if the target workspace does not exist on the
-- live D1, this migration fails closed with an FK violation rather than
-- silently creating orphaned membership rows.
--
-- Does NOT touch chain_heads / path_heads / stones / accepted state.

INSERT INTO workspace_members (workspace_id, actor_id, role, created_at)
VALUES
  ('ws:v775-multi-actor-workplane', 'grok:coairnstone-v6', 'drafter', datetime('now')),
  ('ws:v775-multi-actor-workplane', 'chatgpt:cairnstone-v6', 'drafter', datetime('now')),
  ('ws:v775-multi-actor-workplane', 'claude:cairnstone-v6', 'drafter', datetime('now'))
ON CONFLICT(workspace_id, actor_id) DO UPDATE SET role=excluded.role;
