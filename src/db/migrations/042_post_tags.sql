-- Tag friends in a post ("— with Rahim and 2 others"). Identity posts only, outside communities:
-- tagging from an anonymous post would point at the hidden author's friends.
CREATE TABLE post_tags (
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_tags_user_idx ON post_tags (user_id, created_at DESC);
