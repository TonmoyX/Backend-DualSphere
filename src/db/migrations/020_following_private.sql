-- Hide who you follow: others see "0 following" and an empty list
ALTER TABLE users ADD COLUMN following_private boolean NOT NULL DEFAULT false;
