-- Post editing (author only, identity AND anonymous). Set only when the text changes, so likes/counters
-- bumping updated_at never show a post as "Edited".
ALTER TABLE posts ADD COLUMN edited_at timestamptz;
