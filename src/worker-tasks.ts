// The worker's job handlers and periodic tasks (used by src/worker.ts, or in-process when WORKER_IN_PROCESS=true).
import { processStudioJob } from './services/ad-studio.service.js';
import { billAdSpend, completeCampaigns, optimizeCreatives, rollupAdMetrics } from './services/ads.service.js';
import { cleanupFeedSessions } from './services/feed-ranking.service.js';
import { startWorker } from './services/jobs.service.js';
import { expireMemberships, expireStaleCheckouts, releaseHeldEarnings } from './services/payment.service.js';

const MIN = 60_000;

export function runWorker() {
  return startWorker(
    { 'ad-studio': (p) => processStudioJob(String(p.jobId)) },
    [
      { name: 'release-earnings', everyMs: 10 * MIN, run: releaseHeldEarnings },
      { name: 'expire-checkouts', everyMs: 10 * MIN, run: expireStaleCheckouts },
      { name: 'expire-memberships', everyMs: 10 * MIN, run: expireMemberships },
      { name: 'ad-billing', everyMs: 5 * MIN, run: billAdSpend },
      { name: 'ad-rollup', everyMs: 5 * MIN, run: rollupAdMetrics },
      { name: 'ad-complete', everyMs: 5 * MIN, run: completeCampaigns },
      { name: 'feed-cleanup', everyMs: 60 * MIN, run: cleanupFeedSessions },
      { name: 'ad-optimize', everyMs: 60 * MIN, run: optimizeCreatives },
    ],
  );
}
