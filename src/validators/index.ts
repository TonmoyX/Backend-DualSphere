import { z } from 'zod';

export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid id');
export const idParam = z.object({ id: uuid });
export const postIdParam = z.object({ postId: uuid });

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[a-zA-Z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const username = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_]{3,32}$/, 'Username: 3–32 letters, numbers or underscores');

// ── auth ──
export const signupSchema = z.object({
  username,
  email: z.string().trim().toLowerCase().email('Invalid email').max(254),
  password,
  displayName: z.string().trim().min(1).max(64),
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Select your date of birth')
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    }, 'That date does not exist')
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`);
      const now = new Date();
      let age = now.getUTCFullYear() - d.getUTCFullYear();
      const m = now.getUTCMonth() - d.getUTCMonth();
      if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
      return age >= 13 && age <= 120;
    }, 'You must be at least 13 years old to sign up'),
  gender: z.enum(['female', 'male', 'custom', 'prefer_not_say'], { message: 'Select your gender' }),
  website: z.string().optional(), // honeypot — real users never fill this
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254), // email or username
  password: z.string().min(1).max(128),
});

export const mfaLoginSchema = z.object({ challenge: z.string().min(10), code: z.string().regex(/^\d{6}$/) });
export const tokenSchema = z.object({ token: z.string().min(10).max(200) });
export const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const resetPasswordSchema = z.object({ token: z.string().min(10).max(200), password });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: password });
export const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });
export const mfaDisableSchema = z.object({ code: z.string().regex(/^\d{6}$/), password: z.string().min(1) });

// ── posts ──
export const createPostSchema = z.object({
  content: z.string().max(5000).default(''),
  mediaIds: z.array(uuid).max(10).default([]),
  sharePolicy: z.enum(['everyone', 'friends', 'none']).default('everyone'),
});
export const sharePostSchema = z.object({
  content: z.string().max(5000).default(''),
  mode: z.enum(['identity', 'anonymous']).default('identity'),
});
export const updatePostSchema = z.object({
  sharePolicy: z.enum(['everyone', 'friends', 'none']),
});
export const createPostWithModeSchema = createPostSchema.extend({
  mode: z.enum(['identity', 'anonymous']).default('identity'),
});

export const feedQuery = z.object({
  mode: z.enum(['all', 'identity', 'anonymous']).default('all'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(100).optional(),
});

export const pageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const commentSchema = z.object({
  content: z.string().trim().min(1, 'Comment cannot be empty').max(500),
  parentId: uuid.nullable().optional(),
  asPostAuthor: z.boolean().optional(), // reply as "Anonymous · Author" (anonymous post's author only)
});

export const reportSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'misinformation', 'illegal', 'other']),
  details: z.string().trim().max(500).optional(),
});

// ── users ──
export const updateMeSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  bio: z.string().trim().max(300).optional(),
  avatarMediaId: uuid.nullable().optional(), // null removes avatar
  coverMediaId: uuid.nullable().optional(),
  showActivity: z.boolean().optional(),
  profileLocked: z.boolean().optional(),
  friendsVisibility: z.enum(['public', 'friends', 'only_me']).optional(),
  shareAvatarToFeed: z.boolean().optional(),
});

// ── media ──
export const presignSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(3).max(100),
  size: z.number().int().positive(),
  purpose: z.enum(['post', 'avatar', 'cover', 'message', 'story']).default('post'),
});

// ── moderation / admin ──
export const removeSchema = z.object({ reason: z.string().trim().min(3).max(300) });
export const banSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  durationHours: z.number().int().positive().max(24 * 365 * 10).nullable().optional(), // null = permanent
});
export const reportUpdateSchema = z.object({
  status: z.enum(['reviewed', 'actioned', 'dismissed']),
  note: z.string().trim().max(500).optional(),
  action: z.enum(['none', 'remove_content', 'ban_author']).default('none'),
  applyToAll: z.boolean().default(true),
});
export const identityLookupSchema = z.object({
  reason: z.string().trim().min(10, 'Provide a detailed reason (min 10 chars)').max(500),
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
});
export const adminUserUpdateSchema = z.object({
  role: z.enum(['user', 'moderator', 'admin']).optional(),
  isVerified: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(64).optional(),
  bio: z.string().trim().max(300).optional(),
  resetAbuseScore: z.boolean().optional(),
  removeAvatar: z.boolean().optional(),
});
export const adminListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  role: z.enum(['user', 'moderator', 'admin']).optional(),
  status: z.string().max(30).optional(),
  visibility: z.enum(['identity', 'anonymous']).optional(),
});
export const auditQuery = z.object({
  actorId: uuid.optional(),
  action: z.string().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
