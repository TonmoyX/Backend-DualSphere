-- Staff controls on identity checks and payouts: hold, suspend, delete.
--  • KYC can be put on hold (more review) or suspended (verification revoked). Either blocks payouts.
--  • A payout can be put on hold (paused; money stays reserved). A creator's payouts can be suspended entirely.
ALTER TABLE kyc_records DROP CONSTRAINT kyc_records_status_check;
ALTER TABLE kyc_records ADD CONSTRAINT kyc_records_status_check CHECK (status IN ('pending','verified','rejected','on_hold','suspended'));

ALTER TABLE creator_profiles DROP CONSTRAINT creator_profiles_kyc_status_check;
ALTER TABLE creator_profiles ADD CONSTRAINT creator_profiles_kyc_status_check CHECK (kyc_status IN ('none','pending','verified','rejected','on_hold','suspended'));
ALTER TABLE creator_profiles
  ADD COLUMN payouts_suspended  boolean NOT NULL DEFAULT false,
  ADD COLUMN payouts_suspend_reason text;

ALTER TABLE payouts DROP CONSTRAINT payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('requested','approved','paid','rejected','on_hold'));
ALTER TABLE payouts
  ADD COLUMN hold_reason   text,
  ADD COLUMN held_from     text CHECK (held_from IS NULL OR held_from IN ('requested','approved'));  -- status to return to on release
