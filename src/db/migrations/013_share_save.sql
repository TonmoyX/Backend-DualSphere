-- ═══════════════════════════════════════════════════════════════
-- Post sharing (with author-controlled permission) + saved posts
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE posts ADD COLUMN share_policy text NOT NULL DEFAULT 'everyone' CHECK (share_policy IN ('everyone','friends','none'));
-- "friends" would reveal the hidden author's friendships, so anonymous posts can't use it
ALTER TABLE posts ADD CONSTRAINT posts_anon_share_policy CHECK (visibility = 'identity' OR share_policy <> 'friends');
ALTER TABLE posts ADD COLUMN is_share boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN shared_post_id uuid REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN shares_count integer NOT NULL DEFAULT 0;
CREATE INDEX posts_shared_post_idx ON posts (shared_post_id);

CREATE TABLE saved_posts (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX saved_posts_user_idx ON saved_posts (user_id, created_at DESC);
