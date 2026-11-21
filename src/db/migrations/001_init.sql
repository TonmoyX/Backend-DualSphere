-- ═══════════════════════════════════════════════════════════════
-- DualSphere — initial schema (PostgreSQL 14+)
-- Privacy rule enforced at the DB level: anonymous posts have NO author.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── users ─────────────────────────────────────────────────────
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text NOT NULL CHECK (username ~ '^[a-zA-Z0-9_]{3,32}$'),
  email            text NOT NULL,
  password_hash    text NOT NULL,
  display_name     text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
  bio              text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 300),
  avatar_url       text,
  cover_url        text,
  role             text NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  is_verified      boolean NOT NULL DEFAULT false,
  is_banned        boolean NOT NULL DEFAULT false,
  ban_reason       text,
  banned_until     timestamptz,
  abuse_score      integer NOT NULL DEFAULT 0,           -- internal, NEVER in public API
  post_count       integer NOT NULL DEFAULT 0,           -- identity posts only
  mfa_enabled      boolean NOT NULL DEFAULT false,
  mfa_secret_enc   text,                                 -- AES-256-GCM encrypted TOTP secret
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_idx    ON users (lower(email));
CREATE INDEX users_role_idx       ON users (role);
CREATE INDEX users_created_at_idx ON users (created_at DESC);

-- ── sessions (refresh-token store, JWT access tokens reference sid) ──
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,              -- sha256 of opaque token (rotated on every refresh)
  prev_token_hash    text,                              -- previous token, accepted for a short grace window (multi-tab races)
  rotated_at         timestamptz,
  user_agent         text,
  ip_hash            text,                              -- hashed for privacy
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Known devices — account-takeover detection
CREATE TABLE known_devices (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint  text NOT NULL,                           -- hash(user-agent + ip /24)
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);

-- Email verification + password reset tokens
CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('verify','reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── posts ─────────────────────────────────────────────────────
CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content         text NOT NULL CHECK (char_length(content) <= 5000),
  media           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{url,type,width?,height?}]
  visibility      text NOT NULL CHECK (visibility IN ('identity','anonymous')),
  author_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  likes_count     integer NOT NULL DEFAULT 0,
  comments_count  integer NOT NULL DEFAULT 0,
  reports_count   integer NOT NULL DEFAULT 0,
  is_removed      boolean NOT NULL DEFAULT false,       -- moderator soft delete
  removed_reason  text,
  deleted_at      timestamptz,                          -- owner delete (soft, kept for investigations)
  abuse_flags     text[] NOT NULL DEFAULT '{}',
  content_hash    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- CRITICAL PRIVACY INVARIANT
  CONSTRAINT posts_author_matches_visibility CHECK (
    (visibility = 'identity'  AND author_id IS NOT NULL) OR
    (visibility = 'anonymous' AND author_id IS NULL)
  )
);
CREATE INDEX posts_author_created_idx     ON posts (author_id, created_at DESC);
CREATE INDEX posts_visibility_created_idx ON posts (visibility, created_at DESC);
CREATE INDEX posts_public_created_idx     ON posts (created_at DESC) WHERE is_removed = false AND deleted_at IS NULL;
CREATE INDEX posts_content_hash_idx       ON posts (content_hash);
CREATE INDEX posts_flags_idx              ON posts USING gin (abuse_flags);

-- ── anonymous_post_links — SECURE / RESTRICTED ────────────────
-- Only identity.service.ts touches this table.
CREATE TABLE anonymous_post_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             uuid NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  encrypted_user_id   text NOT NULL,                    -- iv:authTag:ciphertext (hex)
  hmac_key            text NOT NULL,                    -- HMAC-SHA256(postId + userId)
  encryption_version  integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ── likes ─────────────────────────────────────────────────────
CREATE TABLE post_likes (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_likes_user_idx ON post_likes (user_id);

-- ── comments (threaded) ───────────────────────────────────────
CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES comments(id) ON DELETE CASCADE,
  author_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  likes_count  integer NOT NULL DEFAULT 0,
  is_removed   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_post_idx   ON comments (post_id, created_at);
CREATE INDEX comments_parent_idx ON comments (parent_id);
CREATE INDEX comments_author_idx ON comments (author_id);

CREATE TABLE comment_likes (
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

-- ── reports ───────────────────────────────────────────────────
CREATE TABLE reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id       uuid NOT NULL,
  target_type     text NOT NULL CHECK (target_type IN ('post','comment')),
  reporter_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason          text NOT NULL CHECK (reason IN ('spam','harassment','misinformation','illegal','other')),
  details         text CHECK (char_length(details) <= 500),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','actioned','dismissed')),
  reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX reports_target_idx ON reports (target_type, target_id);

-- ── notifications ─────────────────────────────────────────────
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,                            -- like | comment | reply | security | system
  actor_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid REFERENCES posts(id) ON DELETE CASCADE,
  comment_id  uuid REFERENCES comments(id) ON DELETE CASCADE,
  message     text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ── media (Cloudflare R2 / local) ─────────────────────────────
-- owner_id is cleared when media is attached to an anonymous post (privacy).
CREATE TABLE media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  post_id     uuid REFERENCES posts(id) ON DELETE SET NULL,
  storage     text NOT NULL CHECK (storage IN ('r2','local')),
  object_key  text NOT NULL UNIQUE,
  url         text NOT NULL,
  mime        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('image','video')),
  purpose     text NOT NULL DEFAULT 'post' CHECK (purpose IN ('post','avatar','cover')),
  size_bytes  bigint NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','attached')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_owner_idx   ON media (owner_id);
CREATE INDEX media_created_idx ON media (created_at DESC);

-- ── site settings (admin-controlled, drives the frontend) ─────
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── audit_logs — APPEND-ONLY / IMMUTABLE, HMAC hash-chained ───
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  actor_id        uuid,                                 -- no FK: logs must survive user deletion
  actor_role      text,
  action          text NOT NULL,
  target_id       text,
  target_type     text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_signature  text,
  hmac_signature  text NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_action_idx  ON audit_logs (action, created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- updated_at helper
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER posts_touch BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
