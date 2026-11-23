// ═══════════════════════════════════════════════════════════════
// AI Ad Studio: product media / idea → brief → copy variants → safety check → campaign.
// Runs as a background job (worker). Guardrails from the blueprint:
//  • Per-user daily job quota + rate limit; max 6 files; video length capped when FFmpeg is available.
//  • Copy uses only facts from the brief; numeric claims need the advertiser's tick before the ad can skip review.
//  • Ads are always Sponsored posts from a business page (Identity mode). Risky output → human review.
// ═══════════════════════════════════════════════════════════════
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { one, query, tx } from '../config/db.js';
import { env } from '../config/env.js';
import { type AdGoal, type AdLanguage, aiEnabled, costMicroUsd, generateBrief, generateCopy } from '../lib/ai-client.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertAmount } from '../lib/money.js';
import { emit } from '../lib/realtime.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { insertCreatives, policyCheck, submitForDelivery } from './ads.service.js';
import { requireBusinessRole } from './business.service.js';
import { enqueue } from './jobs.service.js';

const run = promisify(execFile);
const STEPS = [
  { key: 'upload', label: 'Uploading to R2' },
  { key: 'frames', label: 'Extracting key frames & audio' },
  { key: 'analyze', label: 'Analysing product & audience' },
  { key: 'copy', label: 'Writing copy variants' },
  { key: 'safety', label: 'Safety & policy check' },
  { key: 'publish', label: 'Scheduling Sponsored post' },
] as const;

export interface StudioInput {
  businessId: string;
  mediaIds: string[];
  productName: string;
  concept: string;
  language: AdLanguage;
  goal: AdGoal;
  dailyBudgetMinor: number;
  autoPublish: boolean;
  linkUrl?: string;
  geo?: string[];
}

const jobOut = (j: any) => ({
  id: j.id, businessId: j.business_id, status: j.status, step: j.step, progress: j.progress, input: j.input, brief: j.brief,
  campaignId: j.campaign_id, engine: j.engine, error: j.error, createdAt: j.created_at, updatedAt: j.updated_at,
  steps: STEPS.map((s) => s.label),
});

async function progress(jobId: string, userId: string | null, stepIndex: number, extra: Record<string, unknown> = {}) {
  const pct = Math.round(((stepIndex + 1) / STEPS.length) * 100);
  const step = STEPS[stepIndex]!.label;
  await query('UPDATE ad_studio_jobs SET step = $2, progress = $3, updated_at = now() WHERE id = $1', [jobId, step, Math.min(pct, 99)]);
  if (userId) emit.user(userId, 'adjob:progress', { jobId, step, stepIndex, progress: pct, ...extra });
}

/** FFmpeg: a few key frames from the first video (only if FFMPEG_PATH is set). */
async function extractFrames(videoUrl: string) {
  if (!env.FFMPEG_PATH) return [];
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-frames-'));
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 200 * 1024 * 1024) return [];
    const input = path.join(dir, 'in');
    await writeFile(input, buf);
    // Probe duration and refuse overly long videos (AI cost guard)
    const { stderr } = await run(env.FFMPEG_PATH, ['-i', input], { timeout: 20_000 }).catch((e) => ({ stderr: String(e.stderr ?? '') }));
    const m = /Duration: (\d+):(\d+):(\d+)/.exec(stderr);
    const secs = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
    if (secs > env.AI_MAX_VIDEO_SEC) throw new AppError(400, 'VIDEO_TOO_LONG', `Videos up to ${env.AI_MAX_VIDEO_SEC}s`);
    const every = Math.max(1, Math.floor((secs || 30) / 6));
    await run(env.FFMPEG_PATH, ['-i', input, '-vf', `fps=1/${every},scale=768:-2`, '-frames:v', '6', '-q:v', '4', path.join(dir, 'f%02d.jpg')], { timeout: 60_000 });
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort();
    return Promise.all(files.map(async (f) => ({ mediaType: 'image/jpeg' as const, data: (await readFile(path.join(dir, f))).toString('base64') })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const adStudioService = {
  status() {
    return { aiEnabled, ffmpeg: !!env.FFMPEG_PATH, jobsPerDay: env.AI_JOBS_PER_DAY, maxVideoSec: env.AI_MAX_VIDEO_SEC };
  },

  async create(user: AuthUser, input: StudioInput) {
    const b = await requireBusinessRole(input.businessId, user, 'admin');
    if (b.is_suspended) throw forbidden('BUSINESS_SUSPENDED', 'This business is suspended');
    assertAmount(input.dailyBudgetMinor, 'Daily budget');
    if (input.dailyBudgetMinor < env.ADS_MIN_DAILY_BUDGET_MINOR) throw badRequest('BUDGET_TOO_LOW', 'Daily budget is below the minimum');
    const productName = cleanText(input.productName).slice(0, 120);
    const concept = cleanText(input.concept).slice(0, 2000);
    if (!productName) throw badRequest('PRODUCT_REQUIRED', 'Name the product');
    if (!input.mediaIds.length && concept.length < 15) throw badRequest('MORE_INFO', 'Add a photo/video or describe the product (15+ characters)');
    if (input.mediaIds.length > 6) throw badRequest('TOO_MANY', 'Up to 6 files');
    if (input.mediaIds.length) {
      const { rows } = await query(`SELECT id FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND purpose = 'ad' AND status IN ('ready','attached')`, [input.mediaIds, user.id]);
      if (rows.length !== new Set(input.mediaIds).size) throw badRequest('INVALID_MEDIA', 'Upload the files first');
    }
    const today = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ad_studio_jobs WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [user.id]);
    if ((today?.n ?? 0) >= env.AI_JOBS_PER_DAY) throw new AppError(429, 'AI_QUOTA', `You can run ${env.AI_JOBS_PER_DAY} AI jobs a day`);

    const job = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ad_studio_jobs (business_id, user_id, input) VALUES ($1, $2, $3) RETURNING *`,
        [input.businessId, user.id, JSON.stringify({ ...input, productName, concept, geo: (input.geo ?? []).map((g) => cleanText(g).slice(0, 40)).slice(0, 10) })],
      );
      await enqueue(c, 'ad-studio', { jobId: rows[0].id });
      return rows[0];
    });
    return { job: jobOut(job) };
  },

  async get(user: AuthUser, jobId: string) {
    const j = await one('SELECT * FROM ad_studio_jobs WHERE id = $1', [jobId]);
    if (!j) throw notFound('Job');
    await requireBusinessRole(j.business_id, user, 'analyst');
    return { job: jobOut(j) };
  },

  async list(user: AuthUser, businessId: string) {
    await requireBusinessRole(businessId, user, 'analyst');
    const { rows } = await query('SELECT * FROM ad_studio_jobs WHERE business_id = $1 ORDER BY created_at DESC LIMIT 30', [businessId]);
    return { jobs: rows.map(jobOut) };
  },
};

/** Worker handler for queue "ad-studio". */
export async function processStudioJob(jobId: string) {
  const j = await one('SELECT * FROM ad_studio_jobs WHERE id = $1', [jobId]);
  if (!j || j.status === 'ready') return;
  const input = j.input as StudioInput;
  const userId = j.user_id as string | null;
  await query(`UPDATE ad_studio_jobs SET status = 'processing', error = NULL, updated_at = now() WHERE id = $1`, [jobId]);
  try {
    // 1 · media
    await progress(jobId, userId, 0);
    const { rows: media } = await query(`SELECT id, url, kind FROM media WHERE id = ANY($1::uuid[])`, [input.mediaIds]);
    const imageUrls = media.filter((m) => m.kind === 'image' && /^https:\/\//.test(m.url)).map((m) => m.url as string);

    // 2 · frames (FFmpeg if installed)
    await progress(jobId, userId, 1, { note: env.FFMPEG_PATH ? undefined : 'FFmpeg not installed — using photos and text only' });
    const video = media.find((m) => m.kind === 'video');
    const frames = video ? await extractFrames(video.url).catch((e) => { if (e instanceof AppError) throw e; logger.warn({ err: e }, 'frame extraction failed'); return []; }) : [];

    const aiInput = { productName: input.productName, concept: input.concept, language: input.language, goal: input.goal, imageUrls, frames };

    // 3 · brief
    await progress(jobId, userId, 2);
    const b = await generateBrief(aiInput);
    if (input.geo?.length) b.brief.audience.geo = input.geo;
    await query('UPDATE ad_studio_jobs SET brief = $2, engine = $3, cost_micro = cost_micro + $4 WHERE id = $1', [jobId, JSON.stringify(b.brief), b.engine, costMicroUsd(b.usage)]);

    // 4 · copy
    await progress(jobId, userId, 3);
    const c = await generateCopy(aiInput, b.brief);
    await query('UPDATE ad_studio_jobs SET cost_micro = cost_micro + $2 WHERE id = $1', [jobId, costMicroUsd(c.usage)]);

    // 5 · safety
    await progress(jobId, userId, 4);
    const briefCheck = policyCheck(`${input.productName}\n${input.concept}\n${b.brief.features.join('\n')}`);
    const extraFlags = [...new Set([...b.brief.policy_flags.map((f) => f.toLowerCase().slice(0, 40)), ...briefCheck.flags])];
    const extraClaims = [...new Set([...b.brief.claims_to_verify, ...briefCheck.claims])].slice(0, 10);

    // 6 · campaign (+ ad set + creatives). Goes live only if the normal auto-approval rules allow it.
    await progress(jobId, userId, 5);
    const campaignId = await tx(async (cl) => {
      const { rows } = await cl.query(
        `INSERT INTO ad_campaigns (business_id, name, objective, currency, daily_budget_minor, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [j.business_id, `${input.productName} · AI`.slice(0, 80), input.goal, env.DEFAULT_CURRENCY, input.dailyBudgetMinor, userId],
      );
      const id = rows[0].id as string;
      const aud = b.brief.audience;
      const set = await cl.query(
        `INSERT INTO ad_sets (campaign_id, name, targeting, bid_cpm_minor) VALUES ($1, 'AI audience', $2, $3) RETURNING id`,
        [id, JSON.stringify({ geo: (input.geo ?? []).map((g) => g.toLowerCase()).slice(0, 10), ageMin: 18, ageMax: 65, interests: [] }), 200], // AI-guessed interests are shown in the brief but never used to exclude viewers
      );
      const { needsReview } = await insertCreatives(cl, id, set.rows[0].id, userId!, c.copy.variants.slice(0, 5).map((v) => ({
        headline: v.headline, body: v.body, cta: v.cta, hashtags: v.hashtags, label: v.label, language: input.language,
        linkUrl: input.linkUrl ?? null, mediaIds: input.mediaIds, claimsConfirmed: false,
      })), { source: 'ai', jobId, extraFlags, extraClaims });
      if (input.autoPublish) await submitForDelivery(cl, id, j.business_id, needsReview);
      await cl.query(`UPDATE ad_studio_jobs SET status = 'ready', progress = 100, step = 'Ready', campaign_id = $2, updated_at = now() WHERE id = $1`, [jobId, id]);
      return id;
    });
    if (userId) emit.user(userId, 'adjob:ready', { jobId, campaignId });
  } catch (err) {
    const msg = err instanceof AppError ? err.message : 'Something went wrong while generating the ad';
    logger.error({ err, jobId }, 'ad studio job failed');
    await query(`UPDATE ad_studio_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [jobId, msg]);
    if (userId) emit.user(userId, 'adjob:progress', { jobId, failed: true, error: msg });
    if (!(err instanceof AppError)) throw err; // let the queue retry unexpected errors
  }
}
