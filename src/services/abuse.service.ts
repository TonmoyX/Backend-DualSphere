import { query } from '../config/db.js';
import { contentHash, similarity, spamSignals } from '../lib/text.js';
import { conflict } from '../lib/errors.js';
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

export interface AbuseVerdict {
  hash: string;
  flags: string[];
  score: number;
}

export const abuseService = {
  /** Runs before a post is stored. Throws on exact duplicates; returns flags for everything else. */
  async inspectPost(content: string, userId: string): Promise<AbuseVerdict> {
    const s = getSettings();
    const hash = contentHash(content);
    const flags: string[] = [];
    let score = 0;

    if (content.length > 0 && s.moderation.duplicateWindowMinutes > 0) {
      const dup = await query(
        `SELECT 1 FROM posts WHERE content_hash = $1 AND created_at > now() - ($2 || ' minutes')::interval LIMIT 1`,
        [hash, String(s.moderation.duplicateWindowMinutes)],
      );
      if (dup.rowCount) throw conflict('DUPLICATE_CONTENT', 'This exact content was posted recently');

      // Near-duplicate detection (Levenshtein) against the recent global stream
      if (content.length >= 20) {
        const { rows } = await query<{ content: string }>(
          `SELECT content FROM posts WHERE created_at > now() - interval '1 hour' AND char_length(content) >= 20
            ORDER BY created_at DESC LIMIT 50`,
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

  /** Admin view: users with elevated scores + flagged posts. */
  async flagged() {
    const users = await query(
      `SELECT id, username, display_name, avatar_url, abuse_score, is_banned, created_at, post_count
         FROM users WHERE abuse_score > 0 ORDER BY abuse_score DESC LIMIT 100`,
    );
    const posts = await query(
      `SELECT p.id, p.content, p.visibility, p.abuse_flags, p.reports_count, p.is_removed, p.created_at,
              u.username AS author_username
         FROM posts p LEFT JOIN users u ON u.id = p.author_id
        WHERE cardinality(p.abuse_flags) > 0 AND p.deleted_at IS NULL
        ORDER BY p.created_at DESC LIMIT 100`,
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
      })),
    };
  },
};
