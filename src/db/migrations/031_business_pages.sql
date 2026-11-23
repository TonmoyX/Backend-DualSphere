-- ═══════════════════════════════════════════════════════════════
-- Ads (DualSphere Next · Phase 3). Ads always run from a business page, in Identity mode — never anonymous.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE business_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  description     text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  category        text NOT NULL DEFAULT 'other',
  website         text CHECK (website IS NULL OR website ~ '^https://'),
  logo_url        text,
  owner_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Staff verify a business before its ads can run
  verification    text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','pending','verified','rejected')),
  verification_note text,
  is_suspended    boolean NOT NULL DEFAULT false,
  suspended_reason text,
  approved_ads    integer NOT NULL DEFAULT 0,     -- the first 3 ads of every advertiser always go to human review
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_members (
  business_id  uuid NOT NULL REFERENCES business_pages(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'analyst' CHECK (role IN ('owner','admin','analyst')),
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX business_members_user_idx ON business_members (user_id);
CREATE UNIQUE INDEX business_one_owner_idx ON business_members (business_id) WHERE role = 'owner';

-- Spendable prepaid balance in micro-units (1/1,000,000 of a poisha/cent). The CHECK makes overspending impossible:
-- every impression debits it with a conditional UPDATE, so budget is checked atomically.
CREATE TABLE business_ad_balances (
  business_id      uuid PRIMARY KEY REFERENCES business_pages(id) ON DELETE CASCADE,
  currency         text NOT NULL CHECK (currency IN ('BDT','USD')),
  available_micro  bigint NOT NULL DEFAULT 0 CHECK (available_micro >= 0),
  billed_micro     bigint NOT NULL DEFAULT 0 CHECK (billed_micro >= 0)  -- spend already moved to the ledger
);

ALTER TABLE payments ADD CONSTRAINT payments_business_fk FOREIGN KEY (business_id) REFERENCES business_pages(id) ON DELETE SET NULL;
ALTER TABLE media DROP CONSTRAINT media_purpose_check;
ALTER TABLE media ADD CONSTRAINT media_purpose_check CHECK (purpose IN ('post','avatar','cover','message','story','community','ad'));
