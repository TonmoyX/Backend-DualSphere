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
  communityId: uuid.optional(), // post into a community (membership + anon policy checked server-side)
  access: z.enum(['public', 'subscribers', 'paid']).default('public'), // creators only, identity posts only
  priceMinor: z.number().int().positive().max(100_000_000).optional(),
  tagIds: z.array(uuid).max(20).default([]), // friends tagged in the post (identity posts only)
});
export const sharePostSchema = z.object({
  content: z.string().max(5000).default(''),
  mode: z.enum(['identity', 'anonymous']).default('identity'),
});
// Author-only changes: who can share, and/or the post text (identity and anonymous posts alike)
export const updatePostSchema = z
  .object({
    sharePolicy: z.enum(['everyone', 'friends', 'none']).optional(),
    content: z.string().max(5000).optional(),
    tagIds: z.array(uuid).max(20).optional(), // replaces the tagged friends
    mediaIds: z.array(uuid).max(10).optional(), // the full final list: keep / add / remove / reorder photos & videos
  })
  .refine((b) => b.sharePolicy !== undefined || b.content !== undefined || b.tagIds !== undefined || b.mediaIds !== undefined, { message: 'Nothing to update' });
export const createPostWithModeSchema = createPostSchema.extend({
  mode: z.enum(['identity', 'anonymous']).default('identity'),
});

export const feedQuery = z.object({
  mode: z.enum(['all', 'identity', 'anonymous', 'communities']).default('all'),
  media: z.enum(['video']).optional(), // Reels: only posts with a video
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
  shareCoverToFeed: z.boolean().optional(),
  followingVisibility: z.enum(['public', 'friends', 'only_me']).optional(),
  birthdayDisplay: z.enum(['hidden', 'day_month', 'full']).optional(),
  work: z.string().trim().max(100).optional(),
  education: z.string().trim().max(100).optional(),
  location: z.string().trim().max(100).optional(),
  hobbies: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
});

// ── media ──
export const presignSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(3).max(100),
  size: z.number().int().positive(),
  purpose: z.enum(['post', 'avatar', 'cover', 'message', 'story', 'community', 'ad']).default('post'),
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

// ── communities ──
export const communitySlug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, 'Link name: 3–32 lowercase letters, numbers or dashes');
export const communitySlugParam = z.object({ slug: communitySlug });
export const communityMemberParam = z.object({ slug: communitySlug, userId: uuid });
export const communityPostParam = z.object({ slug: communitySlug, postId: uuid });
const communityVisibility = z.enum(['public', 'private', 'invite_only']);
const anonPolicy = z.enum(['off', 'allowed', 'anon_only']);
const tags = z.array(z.string().trim().min(1).max(24)).max(5);
export const createCommunitySchema = z.object({
  name: z.string().trim().min(3).max(60),
  slug: communitySlug,
  description: z.string().trim().max(1000).default(''),
  visibility: communityVisibility.default('public'),
  anonPolicy: anonPolicy.default('allowed'),
  postApproval: z.boolean().default(false),
  tags: tags.default([]),
});
export const updateCommunitySchema = z.object({
  name: z.string().trim().min(3).max(60).optional(),
  description: z.string().trim().max(1000).optional(),
  visibility: communityVisibility.optional(),
  anonPolicy: anonPolicy.optional(),
  postApproval: z.boolean().optional(),
  tags: tags.optional(),
  iconMediaId: uuid.nullable().optional(),
  bannerMediaId: uuid.nullable().optional(),
}).strict();
export const communityRulesSchema = z.object({
  rules: z.array(z.object({ title: z.string().trim().min(1).max(100), body: z.string().trim().max(500).default('') })).max(15),
});
export const joinCommunitySchema = z.object({
  message: z.string().trim().max(300).optional(),
  invite: z.string().trim().regex(/^[A-Za-z0-9_-]{12,40}$/).optional(),
});
export const communityRoleSchema = z.object({ role: z.enum(['mod', 'member']) });
export const communityRemoveSchema = z.object({ ban: z.boolean().default(false), reason: z.string().trim().max(300).default('') });
export const communityMuteSchema = z.object({ hours: z.number().int().min(0).max(720) });
export const communityInviteSchema = z.object({ maxUses: z.number().int().min(1).max(1000).default(50), expiresInDays: z.number().int().min(1).max(30).default(7) });
export const communityInviteParam = z.object({ slug: communitySlug, code: z.string().regex(/^[A-Za-z0-9_-]{12,40}$/) });
export const communityDecisionSchema = z.object({ approve: z.boolean(), reason: z.string().trim().max(300).optional() });
export const communityDeleteSchema = z.object({ confirmName: z.string().trim().min(1).max(60) });
export const communityTransferSchema = z.object({ userId: uuid });
