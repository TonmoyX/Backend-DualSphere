-- Payments run on Stripe and SSLCommerz only (no direct bKash / Nagad), in US dollars.
-- Payouts are bank transfers. (No money rows existed when this ran.)
ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('test','stripe','sslcommerz'));

ALTER TABLE payout_methods DROP CONSTRAINT payout_methods_type_check;
ALTER TABLE payout_methods ADD CONSTRAINT payout_methods_type_check CHECK (type IN ('bank'));
