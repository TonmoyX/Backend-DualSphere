-- Follow system: friends follow each other automatically, and either side can unfollow without unfriending.
CREATE TABLE follows (
  follower_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id, created_at DESC);

-- Existing friends follow each other
INSERT INTO follows (follower_id, followee_id, created_at)
  SELECT user_a, user_b, created_at FROM friendships
  UNION ALL
  SELECT user_b, user_a, created_at FROM friendships
ON CONFLICT DO NOTHING;
