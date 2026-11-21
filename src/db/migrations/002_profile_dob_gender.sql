-- Private profile fields collected at sign-up (never in public API responses)
ALTER TABLE users ADD COLUMN birth_date date;
ALTER TABLE users ADD COLUMN gender text CHECK (gender IN ('female','male','custom','prefer_not_say'));
