-- AI Ad Studio jobs + a small Postgres job queue for the worker (no Redis needed)
CREATE TABLE ad_studio_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES business_pages(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','failed')),
  step          text NOT NULL DEFAULT 'queued',
  progress      integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  -- { mediaIds, concept, productName, language, goal, dailyBudgetMinor, autoPublish, linkUrl }
  input         jsonb NOT NULL,
  brief         jsonb,                     -- structured product brief (ad_ai_analyses in the blueprint)
  campaign_id   uuid REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  engine        text NOT NULL DEFAULT 'template' CHECK (engine IN ('template','claude')),
  cost_micro    bigint NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_studio_jobs_business_idx ON ad_studio_jobs (business_id, created_at DESC);
CREATE INDEX ad_studio_jobs_user_day_idx ON ad_studio_jobs (user_id, created_at);

CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  queue       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
