-- ═══ Admin oversight (disclosed in the Privacy Policy) ═══

-- Deleted / unsent messages: gone for users at once, kept here for 90 days for investigations, then purged.
-- No foreign keys on purpose: the record must survive the conversation being deleted.
CREATE TABLE message_archive (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id         uuid NOT NULL,
  conversation_id    uuid NOT NULL,
  conversation_title text,
  is_group           boolean NOT NULL DEFAULT false,
  participant_ids    uuid[] NOT NULL DEFAULT '{}',
  sender_id          uuid,
  kind               text NOT NULL,
  content            text NOT NULL DEFAULT '',
  media              jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to_id        uuid,
  edit_history       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{content, editedAt}]
  files              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{mediaId, objectKey, storage}] removed at purge
  sent_at            timestamptz NOT NULL,
  edited_at          timestamptz,
  reason             text NOT NULL CHECK (reason IN ('unsent','conversation_deleted')),
  deleted_by         uuid,
  deleted_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_archive_conv_idx ON message_archive (conversation_id, sent_at);
CREATE INDEX message_archive_deleted_idx ON message_archive (deleted_at);
CREATE INDEX message_archive_participants_idx ON message_archive USING gin (participant_ids);

-- Earlier versions of edited messages (same 90-day retention)
CREATE TABLE message_edits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  previous_content  text NOT NULL,
  edited_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_edits_msg_idx ON message_edits (message_id, edited_at);
CREATE INDEX message_edits_time_idx ON message_edits (edited_at);

-- Per-case access: an admin opens a case on ONE user (2FA + reason) and gets 30 minutes of access to that
-- user's conversations and anonymous posts. Every view inside a case is written to the audit log.
CREATE TABLE investigation_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  target_username text NOT NULL,
  reason          text NOT NULL,
  ip_hash         text,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  closed_at       timestamptz
);
CREATE INDEX investigation_cases_opened_idx ON investigation_cases (opened_at DESC);
CREATE INDEX investigation_cases_target_idx ON investigation_cases (target_user_id, opened_at DESC);
