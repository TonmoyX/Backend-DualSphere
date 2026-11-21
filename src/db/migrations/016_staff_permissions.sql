-- Per-moderator permissions chosen by an admin. NULL = the default moderator set (see lib/permissions.ts).
ALTER TABLE users ADD COLUMN permissions text[];
