-- Telegram-style messaging: edit, forward, pinned message per chat, pinned chats per user
ALTER TABLE messages ADD COLUMN edited_at timestamptz;
ALTER TABLE messages ADD COLUMN forwarded_from_name text;
ALTER TABLE messages ADD COLUMN forwarded_from_user uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN pinned_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE conversation_participants ADD COLUMN pinned_at timestamptz;
CREATE INDEX messages_search_idx ON messages USING gin (to_tsvector('simple', content));
