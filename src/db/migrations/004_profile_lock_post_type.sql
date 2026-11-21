-- Profile lock (Facebook-style) + special post types
ALTER TABLE users ADD COLUMN profile_locked boolean NOT NULL DEFAULT false;
ALTER TABLE posts ADD COLUMN post_type text NOT NULL DEFAULT 'regular' CHECK (post_type IN ('regular','avatar_update'));
-- An avatar-update post is always an identity post
ALTER TABLE posts ADD CONSTRAINT posts_avatar_update_identity CHECK (post_type = 'regular' OR visibility = 'identity');
