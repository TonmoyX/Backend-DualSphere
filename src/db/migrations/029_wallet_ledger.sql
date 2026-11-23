-- ═══════════════════════════════════════════════════════════════
-- Double-entry ledger. Every money movement is one transaction whose entries sum to zero.
-- Entries are append-only: UPDATE/DELETE are blocked by triggers. Balances are derived, never stored.
-- Sign convention: amount > 0 = debit, amount < 0 = credit. User balances are liabilities (credit-normal).
-- Accounts:  cash:<provider>            money held at a payment provider (asset)
--            user:<id>:pending          creator earnings inside the refund window
--            user:<id>:available        creator earnings that can be paid out
--            user:<id>:payout_hold      requested payouts awaiting staff approval
--            business:<id>:ad_balance   advertiser prepaid balance
--            platform:fees | platform:ad_revenue | payouts:sent
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE ledger_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,         -- the same event can never be booked twice
  reference_id     uuid,                          -- payment / payout / campaign it belongs to
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  tx_id         uuid NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account       text NOT NULL CHECK (account ~ '^[a-z_]+(:[A-Za-z0-9_-]+)*$'),
  amount_minor  bigint NOT NULL CHECK (amount_minor <> 0),
  currency      text NOT NULL CHECK (currency IN ('BDT','USD')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account, currency, created_at DESC);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (tx_id);

-- Append-only
CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only';
END $$;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_tx_no_update BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

-- debit = credit: each transaction must balance per currency (checked at commit)
CREATE FUNCTION ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT currency, sum(amount_minor) AS s INTO bad FROM ledger_entries WHERE tx_id = NEW.tx_id GROUP BY currency HAVING sum(amount_minor) <> 0 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'ledger transaction % is unbalanced (% %)', NEW.tx_id, bad.s, bad.currency; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_balanced();
