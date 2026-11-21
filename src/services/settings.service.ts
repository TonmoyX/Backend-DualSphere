import { z } from 'zod';
import { query } from '../config/db.js';
import { emit } from '../lib/realtime.js';

/** Admin-controlled settings. Every key here can be changed live from the admin panel. */
export const settingsSchema = z.object({
  site: z.object({
    name: z.string().min(1).max(40),
    tagline: z.string().max(120),
    description: z.string().max(400),
    logoUrl: z.string().url().nullable(),
    footerText: z.string().max(200),
    announcement: z.object({
      enabled: z.boolean(),
      text: z.string().max(280),
      variant: z.enum(['info', 'success', 'warning', 'danger']),
      link: z.string().url().nullable(),
    }),
  }),
  features: z.object({
    registrationEnabled: z.boolean(),
    anonymousPostingEnabled: z.boolean(),
    commentsEnabled: z.boolean(),
    mediaUploadsEnabled: z.boolean(),
    messagingEnabled: z.boolean(),
    videoUploadsEnabled: z.boolean(),
    requireEmailVerification: z.boolean(),
    maintenanceMode: z.boolean(),
    maintenanceMessage: z.string().max(400),
  }),
  limits: z.object({
    maxPostLength: z.number().int().min(50).max(5000),
    maxCommentLength: z.number().int().min(20).max(500),
    maxMediaPerPost: z.number().int().min(0).max(10),
    maxImageMb: z.number().int().min(1).max(50),
    maxVideoMb: z.number().int().min(1).max(500),
    anonAccountAgeHours: z.number().int().min(0).max(24 * 30),
    globalRequestsPer15Min: z.number().int().min(20).max(10_000),
    postsPerHour: z.number().int().min(1).max(500),
    anonPostsPerHour: z.number().int().min(1).max(500),
    commentsPerHour: z.number().int().min(1).max(1000),
    messagesPerMinute: z.number().int().min(1).max(600),
    maxFriends: z.number().int().min(1).max(100_000), // per account
  }),
  moderation: z.object({
    bannedWords: z.array(z.string().min(1).max(60)).max(500),
    autoHideReportThreshold: z.number().int().min(0).max(1000), // 0 = disabled
    duplicateWindowMinutes: z.number().int().min(0).max(24 * 60),
    similarityThreshold: z.number().min(0.5).max(1),
    requireMfaForIdentityLookup: z.boolean(),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  site: {
    name: 'DualSphere',
    tagline: 'Be yourself. Or be no one.',
    description: 'A dual-mode social platform: post with your identity, or speak freely and anonymously — with zero-leakage privacy.',
    logoUrl: null,
    footerText: '© DualSphere. Privacy by design.',
    announcement: { enabled: false, text: '', variant: 'info', link: null },
  },
  features: {
    registrationEnabled: true,
    anonymousPostingEnabled: true,
    commentsEnabled: true,
    mediaUploadsEnabled: true,
    messagingEnabled: true,
    videoUploadsEnabled: true,
    requireEmailVerification: false,
    maintenanceMode: false,
    maintenanceMessage: 'We are performing scheduled maintenance. Back shortly!',
  },
  limits: {
    maxPostLength: 2000,
    maxCommentLength: 500,
    maxMediaPerPost: 4,
    maxImageMb: 10,
    maxVideoMb: 100,
    anonAccountAgeHours: 24,
    globalRequestsPer15Min: 300,
    postsPerHour: 20,
    anonPostsPerHour: 5,
    commentsPerHour: 50,
    messagesPerMinute: 30,
    maxFriends: 5000, // same as Facebook
  },
  moderation: {
    bannedWords: [],
    autoHideReportThreshold: 5,
    duplicateWindowMinutes: 60,
    similarityThreshold: 0.92,
    requireMfaForIdentityLookup: true,
  },
};

let cache: Settings = structuredClone(DEFAULT_SETTINGS);

export async function loadSettings(): Promise<Settings> {
  const { rows } = await query<{ key: SettingsSection; value: any }>('SELECT key, value FROM settings');
  const next = structuredClone(DEFAULT_SETTINGS) as any;
  for (const r of rows) {
    if (r.key in next) next[r.key] = deepMerge(next[r.key], r.value);
  }
  cache = next;
  return cache;
}

export const getSettings = (): Settings => cache;

export function publicSettings() {
  const s = cache;
  return {
    site: s.site,
    features: s.features,
    limits: {
      maxPostLength: s.limits.maxPostLength,
      maxCommentLength: s.limits.maxCommentLength,
      maxFriends: s.limits.maxFriends,
      maxMediaPerPost: s.limits.maxMediaPerPost,
      maxImageMb: s.limits.maxImageMb,
      maxVideoMb: s.limits.maxVideoMb,
      anonAccountAgeHours: s.limits.anonAccountAgeHours,
    },
  };
}

export async function updateSettings(patch: Partial<Record<SettingsSection, unknown>>, actorId: string) {
  const merged = structuredClone(cache) as any;
  for (const [k, v] of Object.entries(patch)) {
    if (k in merged && v && typeof v === 'object') merged[k] = deepMerge(merged[k], v);
  }
  const valid = settingsSchema.parse(merged);
  for (const key of Object.keys(patch) as SettingsSection[]) {
    if (!(key in valid)) continue;
    await query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(valid[key]), actorId],
    );
  }
  cache = valid;
  emit.all('settings:update', publicSettings()); // frontend updates live
  return cache;
}

function deepMerge(base: any, over: any): any {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}
