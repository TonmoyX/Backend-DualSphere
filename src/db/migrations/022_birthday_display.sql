-- How your birthday shows on your profile. Hidden by default.
ALTER TABLE users ADD COLUMN birthday_display text NOT NULL DEFAULT 'hidden'
  CHECK (birthday_display IN ('hidden','day_month','full'));
