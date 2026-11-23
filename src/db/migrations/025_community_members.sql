-- Membership, roles, rules, join requests, bans, invite links and the community mod log.
-- Community roles are separate from platform roles: a community mod has no Admin Panel access.
CREATE TABLE community_members (
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','mod','member')),
  muted_until   timestamptz,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX community_members_user_idx ON community_members (user_id, joined_at DESC);
-- Exactly one owner per community
CREATE UNIQUE INDEX community_one_owner_idx ON community_members (community_id) WHERE role = 'owner';

CREATE TABLE community_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  position      integer NOT NULL DEFAULT 0,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  body          text NOT NULL DEFAULT '' CHECK (char_length(body) <= 500)
);
CREATE INDEX community_rules_idx ON community_rules (community_id, position);

CREATE TABLE community_join_requests (
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message       text NOT NULL DEFAULT '' CHECK (char_length(message) <= 300),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE community_bans (
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

-- Invite links (needed for invite-only communities; skip approval for private ones)
CREATE TABLE community_invites (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9_-]{12,40}$'),
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  max_uses      integer NOT NULL DEFAULT 50 CHECK (max_uses BETWEEN 1 AND 1000),
  uses          integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_invites_idx ON community_invites (community_id, created_at DESC);

-- Everything community owners/mods do. Platform staff read this to spot repeat offenders.
CREATE TABLE community_mod_log (
  id              bigserial PRIMARY KEY,
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  target_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  target_post_id  uuid REFERENCES posts(id) ON DELETE SET NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_mod_log_idx ON community_mod_log (community_id, created_at DESC);
CREATE INDEX community_mod_log_target_idx ON community_mod_log (target_user_id, created_at DESC);
