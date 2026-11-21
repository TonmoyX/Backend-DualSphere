// ═══════════════════════════════════════════════════════════════
// identity.service.ts — THE ONLY module allowed to touch anonymous_post_links.
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { one, query } from '../config/db.js';
import { env } from '../config/env.js';
import { aesDecrypt, aesEncrypt, hmacHex, safeEqual } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { auditService } from './audit.service.js';

const CURRENT_KEY_VERSION = 1;

function keyFor(version: number): string {
  // Key rotation: add IDENTITY_ENC_KEY_V2 etc. and map versions here; re-encrypt with a migration job.
  if (version === 1) return env.IDENTITY_ENC_KEY;
  throw new Error(`Unknown identity key version ${version}`);
}

const linkHmac = (postId: string, userId: string) => hmacHex(env.IDENTITY_HMAC_KEY, `${postId}:${userId}`);

export const identityService = {
  encryptMapping(postId: string, userId: string) {
    return {
      encryptedUserId: aesEncrypt(userId, keyFor(CURRENT_KEY_VERSION)),
      hmacKey: linkHmac(postId, userId),
      encryptionVersion: CURRENT_KEY_VERSION,
    };
  },

  /** Store the encrypted link. Must run in the same transaction as the post insert. */
  async storeLink(client: PoolClient, postId: string, userId: string) {
    const m = this.encryptMapping(postId, userId);
    await client.query(
      `INSERT INTO anonymous_post_links (post_id, encrypted_user_id, hmac_key, encryption_version) VALUES ($1,$2,$3,$4)`,
      [postId, m.encryptedUserId, m.hmacKey, m.encryptionVersion],
    );
  },

  /**
   * Ownership proof WITHOUT decryption: recompute HMAC(postId:userId) and compare.
   * Used so authors can delete their own anonymous posts. Not a lookup — it can only
   * answer "is this specific user the author?" for the requesting user themself.
   */
  async ownedBy(postIds: string[], userId: string): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();
    const { rows } = await query<{ post_id: string; hmac_key: string }>(
      'SELECT post_id, hmac_key FROM anonymous_post_links WHERE post_id = ANY($1::uuid[])',
      [postIds],
    );
    return new Set(rows.filter((r) => safeEqual(r.hmac_key, linkHmac(r.post_id, userId))).map((r) => r.post_id));
  },

  /**
   * De-anonymisation. Admin only, MFA-gated, reason required.
   * The audit entry is written BEFORE the lookup, so even a failed/aborted lookup is recorded.
   */
  async lookupPostAuthor(postId: string, actor: { id: string; role: string }, reason: string, ip: string | null) {
    await auditService.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'IDENTITY_LOOKUP',
      targetId: postId,
      targetType: 'post',
      metadata: { reason, ipHash: ip },
    });

    const link = await one<{ post_id: string; encrypted_user_id: string; hmac_key: string; encryption_version: number }>(
      'SELECT post_id, encrypted_user_id, hmac_key, encryption_version FROM anonymous_post_links WHERE post_id = $1',
      [postId],
    );
    if (!link) throw notFound('Anonymous link');

    const userId = aesDecrypt(link.encrypted_user_id, keyFor(link.encryption_version));
    if (!safeEqual(link.hmac_key, linkHmac(link.post_id, userId))) {
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'IDENTITY_TAMPER_DETECTED', targetId: postId, targetType: 'post' });
      throw new AppError(500, 'TAMPERED', 'Identity link failed integrity check');
    }

    const user = await one(
      `SELECT id, username, display_name, email, role, is_banned, abuse_score, created_at FROM users WHERE id = $1`,
      [userId],
    );
    return {
      postId,
      integrity: 'verified' as const,
      user: user
        ? {
            id: user.id, username: user.username, displayName: user.display_name, email: user.email,
            role: user.role, isBanned: user.is_banned, abuseScore: user.abuse_score, createdAt: user.created_at,
          }
        : null, // account deleted since posting
    };
  },
};
