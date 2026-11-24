import { one, query, tx } from '../config/db.js';
import { emit } from '../lib/realtime.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { contentHash, similarity, spamSignals } from '../lib/text.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { getSettings } from './settings.service.js';

/**
 * Ephemeral posting-velocity tracker (in memory, never persisted). It intentionally lives
 * outside the database so anonymous posting leaves no durable per-user trail.
 */
const velocity = new Map<string, number[]>();
const VELOCITY_WINDOW = 10 * 60 * 1000;

function recordVelocity(userId: string): number {
  const now = Date.now();
  const hits = (velocity.get(userId) ?? []).filter((t) => now - t < VELOCITY_WINDOW);
  hits.push(now);
  velocity.set(userId, hits);
  return hits.length;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of velocity) if (!v.some((t) => now - t < VELOCITY_WINDOW)) velocity.delete(k);
}, 5 * 60 * 1000).unref();

/** SQL condition for a flag that still needs a decision (alias `p`). */
export const OPEN_FLAG = `cardinality(p.abuse_flags) > 0 AND p.abuse_reviewed_at IS NULL AND NOT p.is_removed AND p.deleted_at IS NULL`;

export interface AbuseVerdict {
  hash: string;
  flags: string[];
  score: number;
}

export const abuseService = {
  /** Runs before a post is stored. Throws on exact duplicates; returns flags for everything else. */
  async inspectPost(content: string, userId: string, opts: { excludePostId?: string } = {}): Promise<AbuseVerdict> {
    // Editing: the post being edited must not count as a duplicate of itself
    const self = opts.excludePostId ?? null;
    const s = getSettings();
    const hash = contentHash(content);
    const flags: string[] = [];
    let score = 0;

    if (content.length > 0 && s.moderation.duplicateWindowMinutes > 0) {
      const dup = await query(
        `SELECT 1 FROM posts WHERE content_hash = $1 AND created_at > now() - ($2 || ' minutes')::interval
            AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
        [hash, String(s.moderation.duplicateWindowMinutes), self],
      );
      if (dup.rowCount) throw conflict('DUPLICATE_CONTENT', 'This exact content was posted recently');

      // Near-duplicate detection (Levenshtein) against the recent global stream
      if (content.length >= 20) {
        const { rows } = await query<{ content: string }>(
          `SELECT content FROM posts WHERE created_at > now() - interval '1 hour' AND char_length(content) >= 20
              AND ($1::uuid IS NULL OR id <> $1::uuid)
            ORDER BY created_at DESC LIMIT 50`,
          [self],
        );
        if (rows.some((r) => similarity(r.content, content) >= s.moderation.similarityThreshold)) {
          flags.push('duplicate:similar');
          score += 10;
        }
      }
    }

    const spam = spamSignals(content, s.moderation.bannedWords);
    flags.push(...spam.flags);
    score += spam.score;

    const v = recordVelocity(userId);
    if (v > 8) { flags.push('bot:velocity'); score += 15; }
    else if (v > 5) { flags.push('bot:fast'); score += 5; }

    return { hash, flags, score };
  },

  async bumpUserScore(userId: string, delta: number) {
    if (delta > 0) await query('UPDATE users SET abuse_score = abuse_score + $2 WHERE id = $1', [userId, delta]);
  },

  /** Admin view: users with elevated scores + flagged posts (open = still needs a decision). */
  async flagged(status: 'open' | 'resolved' = 'open') {
    const users = await query(
      `SELECT id, username, display_name, avatar_url, abuse_score, is_banned, created_at, post_count
         FROM users WHERE abuse_score > 0 ORDER BY abuse_score DESC LIMIT 100`,
    );
    const where = status === 'open'
      ? `${OPEN_FLAG}`
      : `cardinality(p.abuse_flags) > 0 AND (p.abuse_reviewed_at IS NOT NULL OR p.is_removed OR p.deleted_at IS NOT NULL)`;
    const posts = await query(
      `SELECT p.id, p.content, p.visibility, p.abuse_flags, p.reports_count, p.is_removed, p.deleted_at, p.created_at,
              p.abuse_reviewed_at, r.username AS reviewed_by, u.username AS author_username
         FROM posts p
         LEFT JOIN users u ON u.id = p.author_id
         LEFT JOIN users r ON r.id = p.abuse_reviewed_by
        WHERE ${where}
        ORDER BY coalesce(p.abuse_reviewed_at, p.created_at) DESC LIMIT 100`,
    );
    return {
      users: users.rows.map((u) => ({
        id: u.id, username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url,
        abuseScore: u.abuse_score, isBanned: u.is_banned, postCount: u.post_count, createdAt: u.created_at,
      })),
      posts: posts.rows.map((p) => ({
        id: p.id, content: p.content, visibility: p.visibility, abuseFlags: p.abuse_flags, reportsCount: p.reports_count,
        isRemoved: p.is_removed, createdAt: p.created_at,
        author: p.visibility === 'identity' ? p.author_username : null, // anon stays anon even here
        resolution: p.deleted_at ? 'deleted' : p.is_removed ? 'removed' : p.abuse_reviewed_at ? 'dismissed' : null,
        reviewedAt: p.abuse_reviewed_at, reviewedBy: p.reviewed_by ?? null,
      })),
    };
  },

  /** "Looks fine": close the flag without touching the post. */
  async dismiss(postId: string, actor: AuthUser) {
    const p = await one('SELECT id, abuse_flags, abuse_reviewed_at, is_removed FROM posts WHERE id = $1 AND deleted_at IS NULL', [postId]);
    if (!p) throw notFound('Post');
    if (!p.abuse_flags?.length) throw badRequest('NOT_FLAGGED', 'This post has no abuse flags');
    if (p.abuse_reviewed_at) return;
    await tx(async (c) => {
      await c.query('UPDATE posts SET abuse_reviewed_at = now(), abuse_reviewed_by = $2 WHERE id = $1', [postId, actor.id]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'ABUSE_FLAG_DISMISS', targetId: postId, targetType: 'post', metadata: { flags: p.abuse_flags } }, c);
    });
    emit.staff('admin:flagged', { postId, reviewed: true });
  },

  /** Undo a dismissal so the flag needs a decision again. */
  async reopen(postId: string, actor: AuthUser) {
    const p = await one('SELECT id, is_removed FROM posts WHERE id = $1 AND deleted_at IS NULL AND cardinality(abuse_flags) > 0', [postId]);
    if (!p) throw notFound('Flagged post');
    if (p.is_removed) throw badRequest('REMOVED', 'Restore the post first to reopen its flag');
    await tx(async (c) => {
      await c.query('UPDATE posts SET abuse_reviewed_at = NULL, abuse_reviewed_by = NULL WHERE id = $1', [postId]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'ABUSE_FLAG_REOPEN', targetId: postId, targetType: 'post' }, c);
    });
    emit.staff('admin:flagged', { postId, reopened: true });
  },
};
