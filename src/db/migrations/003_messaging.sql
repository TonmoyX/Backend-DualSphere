-- ═══════════════════════════════════════════════════════════════
-- Direct messaging (Instagram-style): 1:1 + groups, requests, reactions,
-- replies, unsend, read receipts, blocks, activity status.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_group         boolean NOT NULL DEFAULT false,
  title            text CHECK (char_length(title) <= 60),
  dm_key           text UNIQUE,                         -- "<smaller uuid>:<larger uuid>" for 1:1 chats
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((is_group AND dm_key IS NULL) OR (NOT is_group AND dm_key IS NOT NULL))
);
CREATE INDEX conversations_last_msg_idx ON conversations (last_message_at DESC);

CREATE TABLE conversation_participants (
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status           text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','pending')), -- pending = message request
  hidden           boolean NOT NULL DEFAULT false,     -- "delete chat" for me (reappears on new message)
  muted            boolean NOT NULL DEFAULT false,
  cleared_at       timestamptz,                          -- history before this is hidden for this user
  last_read_at     timestamptz,
  joined_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conv_participants_user_idx ON conversation_participants (user_id);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  kind             text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','media','heart','system')),
  content          text NOT NULL DEFAULT '' CHECK (char_length(content) <= 2000),
  media            jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  unsent_at        timestamptz,
  removed_by_mod   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_created_idx ON messages (conversation_id, created_at DESC);

CREATE TABLE message_reactions (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 8),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE user_blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);

-- Activity status (Instagram-style, can be turned off)
ALTER TABLE users ADD COLUMN last_active_at timestamptz;
ALTER TABLE users ADD COLUMN show_activity boolean NOT NULL DEFAULT true;

-- Media can be attached to messages
ALTER TABLE media ADD COLUMN message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE media DROP CONSTRAINT media_purpose_check;
ALTER TABLE media ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post','avatar','cover','message'));

-- Messages can be reported
ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('post','comment','message'));
