-- ═══════════════════════════════════════════════════════════════
-- Voice messages, call history, stories
-- ═══════════════════════════════════════════════════════════════

-- Voice notes are 'audio' media; stories have their own media purpose
ALTER TABLE media DROP CONSTRAINT media_kind_check;
ALTER TABLE media ADD CONSTRAINT media_kind_check CHECK (kind IN ('image','video','audio'));
ALTER TABLE media DROP CONSTRAINT media_purpose_check;
ALTER TABLE media ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post','avatar','cover','message','story'));

-- Call records appear in the chat history
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','media','heart','system','call'));

-- ── Stories (24h) ──
CREATE TABLE stories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('image','video','text')),
  media_url   text,
  media_id    uuid REFERENCES media(id) ON DELETE SET NULL,
  text        text CHECK (char_length(text) <= 500),
  background  text CHECK (char_length(background) <= 200),
  audience    text NOT NULL DEFAULT 'friends' CHECK (audience IN ('friends','public')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CHECK ((kind = 'text' AND text IS NOT NULL) OR (kind <> 'text' AND media_url IS NOT NULL))
);
CREATE INDEX stories_author_idx ON stories (author_id, created_at DESC);
CREATE INDEX stories_expires_idx ON stories (expires_at);

CREATE TABLE story_views (
  story_id   uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   text CHECK (char_length(reaction) <= 8),
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);
