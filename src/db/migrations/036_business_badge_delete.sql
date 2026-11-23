-- Business pages: staff-set badge, owner self-delete (soft), and ad takedowns.
-- Ads no longer need per-ad staff approval: a business page applies once, staff approve the page, and its
-- campaigns run as soon as they're funded. Banned categories are refused at creation instead.
ALTER TABLE business_pages
  ADD COLUMN badge       text NOT NULL DEFAULT 'none' CHECK (badge IN ('none','verified','official','partner','trusted')),
  ADD COLUMN deleted_at  timestamptz;

-- Pages that were already verified keep the blue verified badge
UPDATE business_pages SET badge = 'verified' WHERE verification = 'verified';

-- Every creative that was waiting for per-ad review is approved (page approval is now the only gate)
UPDATE ad_creatives SET status = 'approved', reviewed_at = now() WHERE status = 'pending_review';
UPDATE ad_campaigns k SET status = 'active', pause_reason = NULL, updated_at = now()
  FROM business_pages b
 WHERE b.id = k.business_id AND k.status = 'pending_review' AND b.verification = 'verified' AND NOT b.is_suspended
   AND EXISTS (SELECT 1 FROM ad_creatives c WHERE c.campaign_id = k.id AND c.status = 'approved');
