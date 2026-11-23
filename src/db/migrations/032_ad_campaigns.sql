-- Campaign → ad set (targeting, bid) → creative
CREATE TABLE ad_campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES business_pages(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  objective           text NOT NULL DEFAULT 'awareness' CHECK (objective IN ('sales','messages','awareness')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','active','paused','rejected','completed')),
  currency            text NOT NULL CHECK (currency IN ('BDT','USD')),
  daily_budget_minor  bigint NOT NULL CHECK (daily_budget_minor > 0),
  total_budget_minor  bigint CHECK (total_budget_minor IS NULL OR total_budget_minor >= daily_budget_minor),
  spent_micro         bigint NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  day_spent_micro     bigint NOT NULL DEFAULT 0 CHECK (day_spent_micro >= 0),
  spend_day           date NOT NULL DEFAULT current_date,
  starts_at           timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz,
  pause_reason        text,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX ad_campaigns_business_idx ON ad_campaigns (business_id, created_at DESC);
CREATE INDEX ad_campaigns_active_idx ON ad_campaigns (status) WHERE status = 'active';

CREATE TABLE ad_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  name          text NOT NULL DEFAULT 'Ad set' CHECK (char_length(name) BETWEEN 1 AND 80),
  -- { geo: string[], ageMin: int, ageMax: int, interests: string[] }
  targeting     jsonb NOT NULL DEFAULT '{}',
  bid_cpm_minor bigint NOT NULL CHECK (bid_cpm_minor > 0),   -- price per 1000 impressions
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_sets_campaign_idx ON ad_sets (campaign_id);

CREATE TABLE ad_creatives (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_set_id          uuid NOT NULL REFERENCES ad_sets(id) ON DELETE CASCADE,
  campaign_id        uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  variant_label      text NOT NULL DEFAULT 'A',
  headline           text NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 90),
  body               text NOT NULL DEFAULT '' CHECK (char_length(body) <= 600),
  cta                text NOT NULL DEFAULT 'learn_more' CHECK (cta IN ('learn_more','shop_now','message','sign_up','book_now')),
  link_url           text CHECK (link_url IS NULL OR link_url ~ '^https://'),
  media              jsonb NOT NULL DEFAULT '[]',
  hashtags           text[] NOT NULL DEFAULT '{}',
  language           text NOT NULL DEFAULT 'en',
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
  job_id             uuid,
  status             text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected','paused')),
  review_reason      text,
  reviewed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at        timestamptz,
  policy_flags       text[] NOT NULL DEFAULT '{}',
  claims_to_verify   text[] NOT NULL DEFAULT '{}',
  claims_confirmed   boolean NOT NULL DEFAULT false,
  impressions        bigint NOT NULL DEFAULT 0,
  clicks             bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_creatives_campaign_idx ON ad_creatives (campaign_id);
CREATE INDEX ad_creatives_review_idx ON ad_creatives (created_at) WHERE status = 'pending_review';
