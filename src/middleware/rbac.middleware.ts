import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Permission } from '../lib/permissions.js';
import { ROLE_RANK, type Role } from '../types/index.js';

export const requireRole = (minRole: Role) => (req: Request, _res: Response, next: NextFunction) => {
  const role = req.user?.role;
  if (!role) throw unauthorized();
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden();
  next();
};

export const isStaff = (role?: Role) => !!role && ROLE_RANK[role] >= ROLE_RANK.moderator;

/** Staff route guard by permission (admins always pass). */
export const requirePermission = (...perms: Permission[]) => (req: Request, _res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u) throw unauthorized();
  if (u.role === 'admin') return next();
  if (!isStaff(u.role) || !perms.every((p) => u.permissions.includes(p))) {
    throw forbidden('NO_PERMISSION', "You don't have permission to do this. Ask an admin for access.");
  }
  next();
};

export const hasPermission = (u: { role: Role; permissions: Permission[] } | undefined, p: Permission) =>
  !!u && (u.role === 'admin' || u.permissions.includes(p));
