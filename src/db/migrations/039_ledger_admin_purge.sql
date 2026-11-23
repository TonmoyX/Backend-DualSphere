-- Admin "delete permanently" for payments, payouts and business pages.
-- The ledger stays append-only for normal code. Only the admin purge path may DELETE, and only after it sets
-- `SET LOCAL dualsphere.ledger_purge = 'on'` inside its own transaction. The purge code always deletes whole
-- transactions (every leg), so the books still balance. UPDATE is never allowed.
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('dualsphere.ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ledger is append-only';
END $$;
