-- ═══ Ranked feed ═══
-- What each person has already seen (the feed pushes seen posts down so the top keeps changing).
CREATE TABLE post_views (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  views          integer NOT NULL DEFAULT 1,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX post_views_recent_idx ON post_views (user_id, last_seen_at DESC);

-- "Hide post" and "Snooze <person> for 30 days"
CREATE TABLE post_hides (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE author_snoozes (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  until       timestamptz NOT NULL,
  PRIMARY KEY (user_id, author_id),
  CHECK (user_id <> author_id)
);

-- A ranked feed is computed once per visit and paged from this snapshot (no duplicates / gaps while scrolling).
CREATE TABLE feed_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  post_ids    uuid[] NOT NULL,
  floor_ts    timestamptz,     -- after the ranked window, older posts continue newest-first from here
  floor_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_sessions_created_idx ON feed_sessions (created_at);
CREATE INDEX post_likes_user_recent_idx ON post_likes (user_id, created_at DESC);
CREATE INDEX post_likes_post_recent_idx ON post_likes (post_id, created_at DESC);

-- ═══ Ads Manager ═══
ALTER TABLE ad_campaigns DROP CONSTRAINT ad_campaigns_objective_check;
ALTER TABLE ad_campaigns ADD CONSTRAINT ad_campaigns_objective_check CHECK (objective IN ('awareness','traffic','engagement','messages','leads','sales'));
ALTER TABLE ad_campaigns ADD COLUMN archived_at timestamptz;

ALTER TABLE ad_sets
  ADD COLUMN status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  ADD COLUMN placements     text[] NOT NULL DEFAULT '{feed,sidebar,reels}' CHECK (placements <@ ARRAY['feed','sidebar','reels']::text[] AND cardinality(placements) > 0),
  ADD COLUMN billing_event  text NOT NULL DEFAULT 'impression' CHECK (billing_event IN ('impression','click')),
  ADD COLUMN bid_strategy   text NOT NULL DEFAULT 'lowest_cost' CHECK (bid_strategy IN ('lowest_cost','bid_cap')),
  ADD COLUMN bid_cpc_minor  bigint CHECK (bid_cpc_minor IS NULL OR bid_cpc_minor > 0),
  ADD COLUMN frequency_cap  integer NOT NULL DEFAULT 3 CHECK (frequency_cap BETWEEN 1 AND 20),
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();

-- Coarse, non-identifying breakdowns for reports (no user ids)
ALTER TABLE ad_events
  ADD COLUMN placement   text NOT NULL DEFAULT 'feed',
  ADD COLUMN age_bucket  text NOT NULL DEFAULT 'unknown',
  ADD COLUMN gender      text NOT NULL DEFAULT 'unknown';
CREATE INDEX ad_events_viewer_idx ON ad_events (viewer_hash, campaign_id, created_at DESC);
CREATE INDEX ad_events_created_idx ON ad_events (created_at DESC);

-- People can hide an ad or all ads from a business, and report an ad
CREATE TABLE ad_hides (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('ad','business')),
  target_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, target_id)
);
CREATE TABLE ad_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creative_id  uuid NOT NULL REFERENCES ad_creatives(id) ON DELETE CASCADE,
  reporter_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason       text NOT NULL CHECK (reason IN ('misleading','scam','offensive','sexual','violence','prohibited','other')),
  details      text CHECK (char_length(details) <= 500),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creative_id, reporter_id)
);
CREATE INDEX ad_reports_open_idx ON ad_reports (created_at DESC) WHERE status = 'open';
