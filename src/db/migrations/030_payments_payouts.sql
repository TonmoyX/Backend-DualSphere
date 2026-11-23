-- Payments (in), payouts (out), payout methods and KYC. Sensitive numbers are encrypted at rest.
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose          text NOT NULL CHECK (purpose IN ('tip','unlock','membership','ad_topup')),
  creator_id       uuid REFERENCES users(id) ON DELETE SET NULL,   -- who earns (tip / unlock / membership)
  post_id          uuid REFERENCES posts(id) ON DELETE SET NULL,
  tier_id          uuid REFERENCES membership_tiers(id) ON DELETE SET NULL,
  business_id      uuid,                                          -- ad top-up (FK added in 031)
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  fee_minor        bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency         text NOT NULL CHECK (currency IN ('BDT','USD')),
  provider         text NOT NULL CHECK (provider IN ('test','stripe','sslcommerz','bkash','nagad')),
  provider_ref     text,                                          -- provider's session / transaction id
  status           text NOT NULL DEFAULT 'created' CHECK (status IN ('created','succeeded','failed','refunded','expired')),
  note             text CHECK (char_length(note) <= 200),         -- optional message with a tip
  released_at      timestamptz,                                   -- earnings moved pending → available
  succeeded_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (fee_minor <= amount_minor)
);
CREATE INDEX payments_payer_idx ON payments (payer_id, created_at DESC);
CREATE INDEX payments_creator_idx ON payments (creator_id, created_at DESC) WHERE status = 'succeeded';
CREATE INDEX payments_release_idx ON payments (succeeded_at) WHERE status = 'succeeded' AND released_at IS NULL AND creator_id IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_ref_idx ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Every webhook event is processed exactly once
CREATE TABLE payment_webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  payment_id   uuid,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE payout_methods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('bkash','nagad','bank','stripe')),
  details_enc  text NOT NULL,          -- AES-GCM: account number etc. Never returned to the owner in full.
  label        text NOT NULL,          -- masked, e.g. "bKash ••••5678"
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_methods_user_idx ON payout_methods (user_id);

CREATE TABLE payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  method_id       uuid NOT NULL REFERENCES payout_methods(id) ON DELETE RESTRICT,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL CHECK (currency IN ('BDT','USD')),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','paid','rejected')),
  reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  provider_ref    text,                -- transfer reference the staff member entered
  reject_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_status_idx ON payouts (status, created_at);
CREATE INDEX payouts_user_idx ON payouts (user_id, created_at DESC);

CREATE TABLE kyc_records (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_name     text NOT NULL CHECK (char_length(legal_name) BETWEEN 3 AND 100),
  id_type        text NOT NULL CHECK (id_type IN ('nid','passport','driving_license')),
  id_number_enc  text NOT NULL,        -- AES-GCM
  id_last4       text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  notes          text,
  submitted_at   timestamptz NOT NULL DEFAULT now()
);
