-- ═══════════════════════════════════════════════════════════════
-- Friends (Facebook-style): requests, friendships, suggestions by mutual friends
-- ═══════════════════════════════════════════════════════════════

-- One row per friendship, stored as an ordered pair (user_a < user_b) so it can't duplicate
CREATE TABLE friendships (
  user_a      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX friendships_b_idx ON friendships (user_b);

CREATE TABLE friend_requests (
  sender_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sender_id, receiver_id),
  CHECK (sender_id <> receiver_id)
);
CREATE INDEX friend_requests_receiver_idx ON friend_requests (receiver_id, created_at DESC);

-- Dismissed suggestions ("Remove" on People you may know)
CREATE TABLE friend_suggestion_dismissals (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dismissed_id)
);

-- Convenience view: both directions
CREATE VIEW friend_edges AS
  SELECT user_a AS user_id, user_b AS friend_id, created_at FROM friendships
  UNION ALL
  SELECT user_b AS user_id, user_a AS friend_id, created_at FROM friendships;
