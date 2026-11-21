-- User deletes are now permanent. Purge what older versions only soft-deleted.
-- (Moderator removals are kept: they're restorable and audit-logged.)

-- Posts the owner deleted
DELETE FROM reports WHERE target_type = 'post' AND target_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL);
DELETE FROM posts WHERE deleted_at IS NOT NULL;

-- Messages unsent for everyone
DELETE FROM reports WHERE target_type = 'message' AND target_id IN (SELECT id FROM messages WHERE unsent_at IS NOT NULL);
DELETE FROM messages WHERE unsent_at IS NOT NULL;

-- Comments the author deleted (removed comments without a moderator audit entry)
DELETE FROM comments c
 WHERE c.is_removed
   AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'COMMENT_REMOVE' AND a.target_id = c.id::text);

-- Re-sync denormalised comment counters
UPDATE posts p SET comments_count = (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND NOT c.is_removed);
