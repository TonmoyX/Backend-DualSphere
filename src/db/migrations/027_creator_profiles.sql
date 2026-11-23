-- ═══════════════════════════════════════════════════════════════
-- Creator Economy (DualSphere Next · Phase 2)
-- Money and anonymity never touch: only identity accounts can be creators, and only identity posts can be paid/tipped.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE creator_profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_active   boolean NOT NULL DEFAULT true,
  tagline     text NOT NULL DEFAULT '' CHECK (char_length(tagline) <= 140),
  tips_enabled boolean NOT NULL DEFAULT true,
  -- KYC must be verified before the first payout
  kyc_status  text NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 40),
  description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  benefits     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(benefits) <= 8),
  -- Money is always integer minor units (poisha / cents) + a currency. Never floats.
  price_minor  bigint NOT NULL CHECK (price_minor > 0),
  currency     text NOT NULL CHECK (currency IN ('BDT','USD')),
  position     integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX membership_tiers_creator_idx ON membership_tiers (creator_id, position);
