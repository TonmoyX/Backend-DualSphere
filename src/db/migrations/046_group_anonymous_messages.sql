-- Group chats: members can send a message anonymously. The sender is still stored (so they can edit/unsend it,
-- and for disclosed admin investigations) but the API never shows it to other members or to moderators.
ALTER TABLE messages ADD COLUMN is_anonymous boolean NOT NULL DEFAULT false;
ALTER TABLE message_archive ADD COLUMN is_anonymous boolean NOT NULL DEFAULT false;
