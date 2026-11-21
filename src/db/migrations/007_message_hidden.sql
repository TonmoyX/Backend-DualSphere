-- "Remove for you": messages hidden only for one participant
CREATE TABLE message_hidden (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_hidden_user_idx ON message_hidden (user_id);
