-- Abuse flags can be reviewed: dismissed (false positive) or resolved by removing/restoring the post.
-- A flag is "open" only while the post is flagged, unreviewed, not removed and not deleted.
ALTER TABLE posts
  ADD COLUMN abuse_reviewed_at timestamptz,
  ADD COLUMN abuse_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Flagged posts that were already removed count as handled
UPDATE posts SET abuse_reviewed_at = now() WHERE cardinality(abuse_flags) > 0 AND is_removed AND abuse_reviewed_at IS NULL;

CREATE INDEX posts_open_flags_idx ON posts (created_at DESC)
  WHERE cardinality(abuse_flags) > 0 AND abuse_reviewed_at IS NULL AND NOT is_removed AND deleted_at IS NULL;
