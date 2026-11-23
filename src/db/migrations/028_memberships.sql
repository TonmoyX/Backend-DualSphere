-- Memberships (monthly) + paid / subscriber-only posts
CREATE TABLE memberships (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id             uuid NOT NULL REFERENCES membership_tiers(id) ON DELETE RESTRICT,
  creator_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled','expired')),
  current_period_end  timestamptz NOT NULL,
  canceled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (creator_id <> member_id)
);
-- One live membership per fan per creator
CREATE UNIQUE INDEX memberships_one_live_idx ON memberships (creator_id, member_id) WHERE status IN ('active','canceled');
CREATE INDEX memberships_member_idx ON memberships (member_id, status);
CREATE INDEX memberships_expiry_idx ON memberships (current_period_end) WHERE status IN ('active','canceled');

-- Post access: public (default), subscribers (any active membership with the author), paid (one-time unlock)
ALTER TABLE posts
  ADD COLUMN access       text NOT NULL DEFAULT 'public' CHECK (access IN ('public','subscribers','paid')),
  ADD COLUMN price_minor  bigint CHECK (price_minor IS NULL OR price_minor > 0),
  ADD COLUMN currency     text CHECK (currency IS NULL OR currency IN ('BDT','USD'));
-- Paid/subscriber posts are identity posts outside communities; paid needs a price
ALTER TABLE posts ADD CONSTRAINT posts_access_rules CHECK (
  access = 'public'
  OR (visibility = 'identity' AND community_id IS NULL AND (access <> 'paid' OR (price_minor IS NOT NULL AND currency IS NOT NULL)))
);

CREATE TABLE post_unlocks (
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
