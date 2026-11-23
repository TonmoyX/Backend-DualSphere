-- Allow "updated their cover photo" feed posts (identity-only, like avatar updates)
ALTER TABLE posts DROP CONSTRAINT posts_post_type_check;
ALTER TABLE posts ADD CONSTRAINT posts_post_type_check CHECK (post_type IN ('regular','avatar_update','cover_update'));
