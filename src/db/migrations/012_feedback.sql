-- "Report a problem" submissions (visible in the admin panel)
CREATE TABLE feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  category    text NOT NULL DEFAULT 'bug' CHECK (category IN ('bug','account','safety','idea','other')),
  message     text NOT NULL CHECK (char_length(message) BETWEEN 5 AND 2000),
  page_url    text CHECK (char_length(page_url) <= 500),
  user_agent  text CHECK (char_length(user_agent) <= 300),
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','resolved')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_status_idx ON feedback (status, created_at DESC);
