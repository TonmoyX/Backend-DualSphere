export type Role = 'user' | 'moderator' | 'admin';
export const ROLE_RANK: Record<Role, number> = { user: 0, moderator: 1, admin: 2 };

export type Visibility = 'identity' | 'anonymous';
export type FeedMode = 'all' | Visibility;

export interface AuthUser {
  id: string;
  sessionId: string;
  role: Role;
  username: string;
  isVerified: boolean;
  mfaEnabled: boolean;
  createdAt: Date;
  /** Staff permissions (admins: all, moderators: as granted, users: none). */
  permissions: import('../lib/permissions.js').Permission[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      validated?: { body?: any; query?: any; params?: any };
    }
  }
}
