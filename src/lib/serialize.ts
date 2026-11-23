import { effectivePermissions } from './permissions.js';
// Response serializers — the last line of defence against data leakage.
// Every public response goes through these. Internal fields (abuse_score, password_hash,
// email, abuse_flags, reports_count, content_hash) are never emitted here.

export interface PublicAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isVerified: boolean;
  role: string;
}

export interface PublicPost {
  id: string;
  content: string;
  media: { id?: string; url: string; type: 'image' | 'video'; mime?: string }[];
  visibility: 'identity' | 'anonymous';
  postType: 'regular' | 'avatar_update' | 'cover_update';
  author: PublicAuthor | null;
  likesCount: number;
  commentsCount: number;
  createdAt: string;
  likedByMe: boolean;
  isOwner: boolean;
  sharePolicy: 'everyone' | 'friends' | 'none';
  sharesCount: number;
  isShare: boolean;
}

export function publicPost(row: any, opts: { liked?: boolean; owner?: boolean } = {}): PublicPost {
  const isIdentity = row.visibility === 'identity';
  return {
    id: row.id,
    content: row.content,
    media: Array.isArray(row.media) ? row.media.map((m: any) => ({ id: m.id, url: m.url, type: m.type, mime: m.mime })) : [],
    visibility: row.visibility,
    postType: (row.post_type ?? 'regular') as 'regular' | 'avatar_update' | 'cover_update',
    // NEVER expose author for anonymous posts — enforced here AND by a DB CHECK constraint
    author: isIdentity && row.author_id
      ? {
          id: row.author_id,
          username: row.author_username,
          displayName: row.author_display_name,
          avatarUrl: row.author_avatar_url ?? null,
          isVerified: !!row.author_is_verified,
          role: row.author_role ?? 'user',
        }
      : null,
    likesCount: row.likes_count ?? 0,
    commentsCount: row.comments_count ?? 0,
    createdAt: new Date(row.created_at).toISOString(),
    likedByMe: !!(opts.liked ?? row.liked),
    isOwner: !!opts.owner,
    sharePolicy: (row.share_policy ?? 'everyone') as 'everyone' | 'friends' | 'none',
    sharesCount: row.shares_count ?? 0,
    isShare: !!row.is_share,
  };
}

export function publicUser(row: any) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio ?? '',
    avatarUrl: row.avatar_url ?? null,
    coverUrl: row.cover_url ?? null,
    role: row.role,
    isVerified: !!row.is_verified,
    postCount: row.post_count ?? 0,
    profileLocked: !!row.profile_locked,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** The signed-in user's own view (adds private-but-own fields). */
/** Birthday as the owner chose to show it: nothing, day + month, or the full date. Never the raw value. */
export function visibleBirthday(row: any): { day: number; month: number; year?: number } | null {
  const mode = row.birthday_display ?? 'hidden';
  if (mode === 'hidden' || !row.birth_date) return null;
  const [y, m, d] = String(row.birth_date).slice(0, 10).split('-').map(Number);
  if (!m || !d) return null;
  return mode === 'full' ? { day: d, month: m, year: y } : { day: d, month: m };
}

/** Optional "About" details — only on full profiles and your own account, not on every post author. */
export function profileDetails(row: any) {
  return {
    work: row.work ?? '',
    education: row.education ?? '',
    location: row.location ?? '',
    hobbies: (row.hobbies ?? []) as string[],
    birthday: visibleBirthday(row),
  };
}

export function selfUser(row: any, anonAccountAgeHours: number) {
  const created = new Date(row.created_at).getTime();
  const anonAvailableAt = new Date(created + anonAccountAgeHours * 3600_000);
  return {
    ...publicUser(row),
    ...profileDetails(row),
    email: row.email,
    mfaEnabled: !!row.mfa_enabled,
    birthDate: row.birth_date ?? null,
    birthdayDisplay: (row.birthday_display ?? 'hidden') as 'hidden' | 'day_month' | 'full',
    gender: row.gender ?? null,
    showActivity: row.show_activity !== false,
    followingVisibility: (row.following_visibility ?? 'public') as 'public' | 'friends' | 'only_me',
    friendsVisibility: (row.friends_visibility ?? 'public') as 'public' | 'friends' | 'only_me',
    anonAvailableAt: anonAvailableAt.toISOString(),
    permissions: effectivePermissions(row.role, row.permissions), // staff panel uses this to show/hide sections
    canPostAnonymously: anonAvailableAt.getTime() <= Date.now(),
  };
}

export function publicComment(row: any, liked = false, mine = false) {
  const removed = row.is_removed;
  const asPostAuthor = !!row.as_post_author; // the anonymous post's author replying anonymously
  return {
    id: row.id,
    postId: row.post_id,
    parentId: row.parent_id ?? null,
    content: removed ? '' : row.content,
    isRemoved: !!removed,
    isPostAuthor: asPostAuthor,
    isMine: !!mine,
    author: removed || asPostAuthor
      ? null
      : {
          id: row.author_id,
          username: row.author_username,
          displayName: row.author_display_name,
          avatarUrl: row.author_avatar_url ?? null,
          isVerified: !!row.author_is_verified,
          role: row.author_role ?? 'user',
        },
    likesCount: row.likes_count ?? 0,
    likedByMe: liked || !!row.liked,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Opaque keyset cursor: (created_at, id). */
export function encodeCursor(createdAt: Date | string, id: string): string {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor?: string): { ts: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    const d = new Date(ts!);
    if (Number.isNaN(d.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { ts: d, id };
  } catch {
    return null;
  }
}
