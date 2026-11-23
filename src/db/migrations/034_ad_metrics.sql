-- Ad events (impressions / clicks) + hourly rollup. viewer_hash is a keyed hash: no raw user ids or IPs are stored.
CREATE TABLE ad_events (
  id           bigserial PRIMARY KEY,
  creative_id  uuid NOT NULL REFERENCES ad_creatives(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('impression','click')),
  viewer_hash  text NOT NULL,
  cost_micro   bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_events_campaign_idx ON ad_events (campaign_id, created_at DESC);
-- One counted impression / click per viewer per creative per hour (frequency cap + click-fraud guard)
CREATE UNIQUE INDEX ad_events_dedupe_idx ON ad_events (creative_id, kind, viewer_hash, date_trunc('hour', created_at AT TIME ZONE 'UTC'));

CREATE TABLE ad_metrics_hourly (
  creative_id  uuid NOT NULL REFERENCES ad_creatives(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  hour         timestamptz NOT NULL,
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  spend_micro  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (creative_id, hour)
);
CREATE INDEX ad_metrics_campaign_idx ON ad_metrics_hourly (campaign_id, hour DESC);
