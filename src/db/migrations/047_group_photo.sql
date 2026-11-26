-- Group chats can have their own photo (any member can change it, like the group name)
ALTER TABLE conversations ADD COLUMN avatar_url text;
ALTER TABLE media DROP CONSTRAINT media_purpose_check;
ALTER TABLE media ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post','avatar','cover','message','story','community','ad','group'));
