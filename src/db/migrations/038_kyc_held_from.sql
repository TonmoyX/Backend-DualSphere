-- Identity check put on hold remembers its previous status, so "release" returns it there.
ALTER TABLE kyc_records ADD COLUMN held_from text CHECK (held_from IS NULL OR held_from IN ('pending','verified'));
