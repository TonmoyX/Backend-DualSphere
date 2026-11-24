-- Real view count: distinct signed-in people who actually saw the post (≥50% on screen ~1s, or opened it).
-- One per person, the author's own views never count. Kept on the post so feeds don't count rows.
ALTER TABLE posts ADD COLUMN views_count integer NOT NULL DEFAULT 0;
UPDATE posts p SET views_count = sub.n
  FROM (SELECT v.post_id, count(*)::int AS n FROM post_views v JOIN posts x ON x.id = v.post_id
         WHERE v.user_id IS DISTINCT FROM x.author_id GROUP BY v.post_id) sub
 WHERE sub.post_id = p.id;
