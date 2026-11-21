import { z } from 'zod';

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes hex (64 chars) — run `npm run keys`');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),

  // Comma-separated list of allowed browser origins (frontend + admin)
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  ADMIN_URL: z.string().default('http://localhost:3001'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: z.coerce.number().default(0),

  JWT_ACCESS_SECRET: hex32,
  JWT_REFRESH_SECRET: hex32,
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),

  IDENTITY_ENC_KEY: hex32,
  IDENTITY_HMAC_KEY: hex32,
  AUDIT_HMAC_KEY: hex32,
  MFA_ENC_KEY: hex32,
  IP_HASH_SALT: hex32,

  // Cloudflare R2 (S3-compatible). If unset, uploads fall back to local disk.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(), // e.g. https://media.dualsphere.app or https://pub-xxx.r2.dev
  // true = browsers PUT straight to R2 (needs a CORS rule on the bucket). Default: upload via the API, which stores in R2.
  R2_DIRECT_UPLOAD: z.enum(['true', 'false']).default('false'),

  // WebRTC calls: STUN is built in; add TURN for users behind strict NATs (comma-separated urls)
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),

  // SMTP (optional — emails are logged to console when unset)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('DualSphere <no-reply@dualsphere.app>'),

  // Seed admin
  SEED_ADMIN_EMAIL: z.string().default('admin@dualsphere.local'),
  SEED_ADMIN_USERNAME: z.string().default('admin'),
  SEED_ADMIN_PASSWORD: z.string().default('ChangeMe!2026'),
  SEED_MODERATOR_EMAIL: z.string().default('mod@dualsphere.local'),
  SEED_MODERATOR_USERNAME: z.string().default('moderator'),
  SEED_MODERATOR_PASSWORD: z.string().default('ModPass!2026'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
export const r2Enabled = Boolean(
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL,
);
