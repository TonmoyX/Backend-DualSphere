-- Suspended accounts can ask for a review ("request review" on the suspension page). Staff with users.ban decide.
CREATE TABLE ban_appeals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message      text NOT NULL,
  ban_reason   text,                 -- snapshot of the reason at the time of the appeal
  banned_until timestamptz,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  response     text,                 -- shown to the user
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ban_appeals_one_pending ON ban_appeals (user_id) WHERE status = 'pending';
CREATE INDEX ban_appeals_status_idx ON ban_appeals (status, created_at DESC);
CREATE INDEX ban_appeals_user_idx ON ban_appeals (user_id, created_at DESC);
