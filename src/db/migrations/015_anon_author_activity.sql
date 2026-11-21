-- ═══════════════════════════════════════════════════════════════
-- Anonymous authors: reply anonymously on their own anonymous posts + get notified about activity.
-- PRIVACY: nothing here stores a user ↔ anonymous-post link.
--   • An "as post author" comment has author_id NULL; ownership is proven via the post's HMAC link.
--   • anon_notifications are keyed by POST only (no recipient column). The recipient is resolved at read
--     time by recomputing HMAC(postId:userId) for the signed-in user.
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE comments ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE comments ADD COLUMN as_post_author boolean NOT NULL DEFAULT false;
ALTER TABLE comments ADD CONSTRAINT comments_author_or_anon_op CHECK (
  (author_id IS NOT NULL AND NOT as_post_author) OR (author_id IS NULL AND as_post_author)
);

CREATE TABLE anon_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('like','comment','reply','share')),
  actor_id    uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL when the actor was anonymous
  comment_id  uuid REFERENCES comments(id) ON DELETE CASCADE,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX anon_notifications_created_idx ON anon_notifications (created_at DESC);
CREATE INDEX anon_notifications_post_idx ON anon_notifications (post_id);

-- "Anonymous (author) replied to your comment" — actor hidden
ALTER TABLE notifications ADD COLUMN actor_anon boolean NOT NULL DEFAULT false;
