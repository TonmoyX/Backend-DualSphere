// ═══════════════════════════════════════════════════════════════
// Staff permissions. Admins have everything. Moderators get the permissions an admin grants them
// (users.permissions); NULL means the default set below — what moderators could always do.
// Some actions are never delegable: changing roles, deleting accounts, identity lookups (unmasking
// anonymous authors) and managing permissions stay admin-only, so a moderator can't escalate.
// ═══════════════════════════════════════════════════════════════
import type { Role } from '../types/index.js';

export const PERMISSIONS = [
  { key: 'dashboard.view', group: 'Overview', label: 'Dashboard', desc: 'See platform statistics and recent activity', default: true },
  { key: 'reports.view', group: 'Moderation', label: 'View reports', desc: 'See the report queue', default: true },
  { key: 'reports.resolve', group: 'Moderation', label: 'Resolve reports', desc: 'Dismiss, review or action reports', default: true },
  { key: 'posts.view', group: 'Moderation', label: 'View posts', desc: 'Browse all posts', default: true },
  { key: 'posts.moderate', group: 'Moderation', label: 'Hide & restore posts', desc: 'Remove posts from the site or bring them back', default: true },
  { key: 'comments.view', group: 'Moderation', label: 'View comments', desc: 'Browse all comments', default: true },
  { key: 'comments.moderate', group: 'Moderation', label: 'Hide & restore comments', desc: 'Remove comments or bring them back', default: true },
  { key: 'abuse.view', group: 'Moderation', label: 'Abuse flags', desc: 'See posts flagged by the spam/abuse filters', default: false },
  { key: 'feedback.view', group: 'Moderation', label: 'Feedback inbox', desc: 'Read and handle "Report a problem" messages', default: true },
  { key: 'users.view', group: 'People', label: 'View users', desc: 'Browse accounts and their details', default: true },
  { key: 'users.ban', group: 'People', label: 'Ban & unban users', desc: 'Suspend accounts temporarily or permanently', default: true },
  { key: 'users.manage', group: 'People', label: 'Manage accounts', desc: 'Verify, reset abuse score, remove avatar, revoke sessions, reset 2FA', default: false },
  { key: 'media.view', group: 'Platform', label: 'Media library', desc: 'Browse uploaded photos and videos', default: true },
  { key: 'media.delete', group: 'Platform', label: 'Delete media', desc: 'Permanently delete uploaded files', default: false },
  { key: 'audit.view', group: 'Security', label: 'Audit log', desc: 'Read the tamper-evident staff audit log', default: false },
  { key: 'settings.manage', group: 'Platform', label: 'Site settings', desc: 'Change branding, features, limits and moderation rules', default: false },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];
export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key) as Permission[];
export const DEFAULT_MODERATOR_PERMISSIONS = PERMISSIONS.filter((p) => p.default).map((p) => p.key) as Permission[];
export const ADMIN_ONLY = ['Change roles', 'Delete accounts', 'Identity lookups (unmasking anonymous authors)', 'Manage moderator permissions'];

/** The permissions a user effectively has. */
export function effectivePermissions(role: Role, stored: string[] | null | undefined): Permission[] {
  if (role === 'admin') return ALL_PERMISSIONS;
  if (role !== 'moderator') return [];
  if (!stored) return DEFAULT_MODERATOR_PERMISSIONS;
  return stored.filter((p): p is Permission => (ALL_PERMISSIONS as string[]).includes(p));
}
