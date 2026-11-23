-- Posts can belong to a community. Community posts never appear in the main feed or on profiles.
ALTER TABLE posts
  ADD COLUMN community_id  uuid REFERENCES communities(id) ON DELETE CASCADE,
  ADD COLUMN is_pending    boolean NOT NULL DEFAULT false,  -- held for community-mod approval
  ADD COLUMN pinned_at     timestamptz;
-- Only community posts can be pending or pinned
ALTER TABLE posts ADD CONSTRAINT posts_community_flags CHECK (community_id IS NOT NULL OR (NOT is_pending AND pinned_at IS NULL));
CREATE INDEX posts_community_feed_idx ON posts (community_id, created_at DESC, id DESC) WHERE community_id IS NOT NULL;
CREATE INDEX posts_global_feed_idx ON posts (created_at DESC, id DESC) WHERE community_id IS NULL AND NOT is_removed AND deleted_at IS NULL;
