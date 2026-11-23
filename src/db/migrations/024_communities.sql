-- ═══════════════════════════════════════════════════════════════
-- Communities (DualSphere Next · Phase 1)
-- Spaces with their own rules, mods and anonymous-posting policy.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE communities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 60),
  description      text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  icon_url         text,
  banner_url       text,
  -- public: anyone can see posts · private: anyone sees the About page, members see posts · invite_only: hidden from everyone but members
  visibility       text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private','invite_only')),
  -- off: identity posts only · allowed: both · anon_only: anonymous posts only (confession pages, campus Q&A)
  anon_policy      text NOT NULL DEFAULT 'allowed' CHECK (anon_policy IN ('off','allowed','anon_only')),
  post_approval    boolean NOT NULL DEFAULT false,   -- hold new posts for community-mod review
  tags             text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 5),
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  member_count     integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  post_count       integer NOT NULL DEFAULT 0 CHECK (post_count >= 0),
  is_featured      boolean NOT NULL DEFAULT false,
  is_suspended     boolean NOT NULL DEFAULT false,
  suspended_reason text,
  deleted_at       timestamptz,                      -- soft delete: content stays for staff, hidden from everyone
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX communities_slug_idx ON communities (slug);
CREATE INDEX communities_discover_idx ON communities (is_featured DESC, member_count DESC) WHERE deleted_at IS NULL AND NOT is_suspended;
CREATE INDEX communities_owner_idx ON communities (owner_id);

-- Community icons and banners are uploaded like any other image
ALTER TABLE media DROP CONSTRAINT media_purpose_check;
ALTER TABLE media ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post','avatar','cover','message','story','community'));
