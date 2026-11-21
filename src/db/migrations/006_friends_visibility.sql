-- Who can see a user's full friends list (others only ever see mutual friends)
ALTER TABLE users ADD COLUMN friends_visibility text NOT NULL DEFAULT 'public' CHECK (friends_visibility IN ('public','friends','only_me'));
