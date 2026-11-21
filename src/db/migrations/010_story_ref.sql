-- Replies/reactions to a story arrive as DMs carrying a snapshot of the story
ALTER TABLE messages ADD COLUMN story_ref jsonb;
