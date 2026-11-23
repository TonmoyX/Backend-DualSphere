-- Who can see who you follow: like the friends list (everyone / friends / only me). Replaces following_private.
ALTER TABLE users ADD COLUMN following_visibility text NOT NULL DEFAULT 'public'
  CHECK (following_visibility IN ('public','friends','only_me'));
UPDATE users SET following_visibility = 'only_me' WHERE following_private;
ALTER TABLE users DROP COLUMN following_private;
