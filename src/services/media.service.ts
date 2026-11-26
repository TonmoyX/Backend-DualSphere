import type { PoolClient } from 'pg';
import { one, query } from '../config/db.js';
import { env } from '../config/env.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { signUploadToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { deleteObject, headObject, presignPut, publicUrlFor, putObject, storageDriver } from '../lib/storage.js';
import { emit } from '../lib/realtime.js';
import { getSettings } from './settings.service.js';

const MIME: Record<string, { ext: string; kind: 'image' | 'video' | 'audio' }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/avif': { ext: 'avif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  // Voice messages (MediaRecorder: Chrome/Firefox → webm/opus, Safari → mp4/aac)
  'audio/webm': { ext: 'weba', kind: 'audio' },
  'audio/ogg': { ext: 'ogg', kind: 'audio' },
  'audio/mp4': { ext: 'm4a', kind: 'audio' },
  'audio/mpeg': { ext: 'mp3', kind: 'audio' },
};

/** Magic-byte sniffing for local uploads — the declared Content-Type must match the bytes. */
/** Same container, different declared media type (e.g. a webm file holding only audio). */
function compatible(sniffed: string | null, declared: string) {
  if (sniffed === declared) return true;
  if (declared === 'audio/webm') return sniffed === 'video/webm';
  if (declared === 'audio/mp4') return sniffed === 'video/mp4' || sniffed === 'video/quicktime';
  return false;
}

const AUDIO_MAX_MB = 20;

function sniff(buf: Buffer): string | null {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (hex.startsWith('4f676753')) return 'audio/ogg';
  if (hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3')) return 'audio/mpeg';
  if (buf.subarray(4, 8).toString() === 'ftyp') {
    const brand = buf.subarray(8, 12).toString();
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}

const mapMedia = (m: any) => ({
  id: m.id, url: m.url, kind: m.kind, mime: m.mime, size: Number(m.size_bytes), status: m.status, purpose: m.purpose,
  storage: m.storage, createdAt: m.created_at, postId: m.post_id, ownerId: m.owner_id,
});

/**
 * Permanently delete posts that have nothing left to show: no text and no files. Shares are kept (they show the
 * original post). Same clean-up as a normal delete: reports, counters, remaining files, live removal from feeds.
 */
export async function deleteEmptyPosts(postIds: string[]) {
  if (!postIds.length) return [] as string[];
  const { rows } = await query<{ id: string; visibility: string; author_id: string | null; community_id: string | null; is_pending: boolean }>(
    `SELECT id, visibility, author_id, community_id, is_pending FROM posts
      WHERE id = ANY($1::uuid[]) AND NOT is_share AND btrim(COALESCE(content, '')) = '' AND jsonb_array_length(COALESCE(media, '[]'::jsonb)) = 0`,
    [postIds],
  );
  for (const p of rows) {
    const { rows: files } = await query<{ object_key: string; storage: 'r2' | 'local' }>('DELETE FROM media WHERE post_id = $1 RETURNING object_key, storage', [p.id]);
    await query(
      `DELETE FROM reports WHERE (target_type = 'post' AND target_id = $1)
          OR (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = $1))`,
      [p.id],
    );
    await query('DELETE FROM posts WHERE id = $1', [p.id]);
    if (p.community_id) {
      if (!p.is_pending) await query('UPDATE communities SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1', [p.community_id]);
      emit.community(p.community_id, 'post:removed', { id: p.id });
    } else {
      if (p.visibility === 'identity' && p.author_id) await query('UPDATE users SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1', [p.author_id]);
      emit.feed('post:removed', { id: p.id });
    }
    for (const f of files) await deleteObject(f.object_key, f.storage).catch(() => {});
  }
  return rows.map((r) => r.id);
}

export const mediaService = {
  /** Step 1: reserve an object key and return a direct-upload URL (R2 presigned PUT, or signed local URL). */
  async presign(userId: string, input: { filename: string; contentType: string; size: number; purpose: 'post' | 'avatar' | 'cover' | 'message' | 'story' | 'community' | 'ad' | 'group' }) {
    const s = getSettings();
    if (!s.features.mediaUploadsEnabled) throw forbidden('UPLOADS_DISABLED', 'Media uploads are disabled');
    const info = MIME[input.contentType];
    if (!info) throw badRequest('UNSUPPORTED_TYPE', 'Supported: JPG, PNG, WebP, GIF, AVIF, MP4, WebM, MOV');
    if (info.kind === 'video' && (!s.features.videoUploadsEnabled || !['post', 'message', 'story', 'ad'].includes(input.purpose))) {
      throw forbidden('VIDEO_DISABLED', 'Video uploads are not allowed here');
    }
    if (info.kind === 'audio' && input.purpose !== 'message') throw forbidden('AUDIO_NOT_ALLOWED', 'Audio is only allowed in messages');
    const maxMb = info.kind === 'image' ? s.limits.maxImageMb : info.kind === 'audio' ? AUDIO_MAX_MB : s.limits.maxVideoMb;
    const maxBytes = maxMb * 1024 * 1024;
    if (input.size > maxBytes) throw badRequest('TOO_LARGE', `Max ${maxMb} MB`);

    // Keys carry NO user identifiers (keys are visible in public URLs)
    const d = new Date();
    const key = `${input.purpose}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randomToken(18)}.${info.ext}`;
    const url = publicUrlFor(key);

    const m = await one<{ id: string }>(
      `INSERT INTO media (owner_id, storage, object_key, url, mime, kind, purpose, size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [userId, storageDriver, key, url, input.contentType, info.kind, input.purpose, input.size],
    );

    // R2 direct upload needs a bucket CORS rule; by default the browser uploads to the API, which writes to R2
    const uploadUrl = storageDriver === 'r2' && env.R2_DIRECT_UPLOAD === 'true'
      ? await presignPut(key, input.contentType, input.size)
      : `${env.PUBLIC_API_URL}/api/v1/media/local-upload?token=${encodeURIComponent(signUploadToken(key, m!.id, maxBytes, input.contentType))}`;

    return { mediaId: m!.id, uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': input.contentType }, publicUrl: url, storage: storageDriver };
  },

  /** Receive raw bytes via the API (mirrors an R2 PUT) and store them in R2 or on local disk. Contents are sniffed first. */
  async receiveLocal(token: { key: string; mid: string; max: number; mime: string }, contentType: string | undefined, body: Buffer) {
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('EMPTY_UPLOAD', 'No file received');
    if (body.length > token.max) throw badRequest('TOO_LARGE', 'File too large');
    if (contentType?.split(';')[0] !== token.mime) throw badRequest('TYPE_MISMATCH', 'Content-Type mismatch');
    const sniffed = sniff(body);
    if (!compatible(sniffed, token.mime)) throw badRequest('TYPE_MISMATCH', 'File contents do not match its type');
    const m = await one<{ storage: 'r2' | 'local' }>('SELECT storage FROM media WHERE id = $1', [token.mid]);
    if (!m) throw notFound('Media');
    await putObject(token.key, body, token.mime, m.storage);
    await query('UPDATE media SET size_bytes = $2 WHERE id = $1', [token.mid, body.length]);
  },

  /** Step 2: confirm the object landed in storage, then mark it ready. */
  async complete(userId: string, mediaId: string) {
    const m = await one('SELECT * FROM media WHERE id = $1 AND owner_id = $2', [mediaId, userId]);
    if (!m) throw notFound('Media');
    if (m.status !== 'pending') return mapMedia(m);
    const head = await headObject(m.object_key, m.storage);
    if (!head || head.size === 0) throw badRequest('UPLOAD_MISSING', 'Upload not found — try again');
    const s = getSettings();
    const max = (m.kind === 'image' ? s.limits.maxImageMb : m.kind === 'audio' ? AUDIO_MAX_MB : s.limits.maxVideoMb) * 1024 * 1024;
    if (head.size > max) {
      await deleteObject(m.object_key, m.storage);
      await query('DELETE FROM media WHERE id = $1', [mediaId]);
      throw badRequest('TOO_LARGE', 'File too large');
    }
    const { rows } = await query(`UPDATE media SET status = 'ready', size_bytes = $2 WHERE id = $1 RETURNING *`, [mediaId, head.size]);
    return mapMedia(rows[0]);
  },

  async claimable(ids: string[], userId: string, purpose: 'post' | 'message' | 'story' = 'post') {
    if (ids.length === 0) return [];
    const { rows } = await query(
      `SELECT id, url, kind, mime FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND status = 'ready' AND purpose = $3`,
      [ids, userId, purpose],
    );
    if (rows.length !== new Set(ids).size) throw badRequest('INVALID_MEDIA', 'One or more attachments are invalid or still uploading');
    // keep the order the user chose
    return ids.map((id) => rows.find((r) => r.id === id)!);
  },

  async attach(c: PoolClient, ids: string[], postId: string, anonymous: boolean) {
    if (ids.length === 0) return;
    await c.query(
      `UPDATE media SET status = 'attached', post_id = $2, owner_id = CASE WHEN $3 THEN NULL ELSE owner_id END
        WHERE id = ANY($1::uuid[])`,
      [ids, postId, anonymous],
    );
  },

  async attachToMessage(c: PoolClient, ids: string[], messageId: string) {
    if (ids.length === 0) return;
    await c.query(`UPDATE media SET status = 'attached', message_id = $2 WHERE id = ANY($1::uuid[])`, [ids, messageId]);
  },

  /**
   * Ad creative media (purpose "ad"): ready uploads by this user. Marked attached so cleanup never deletes them.
   * Returns the public shape stored on the creative.
   */
  async claimableForAd(ids: string[], userId: string) {
    if (ids.length === 0) return [];
    const { rows } = await query(
      `SELECT id, url, kind, mime FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND status IN ('ready','attached') AND purpose = 'ad' AND kind IN ('image','video')`,
      [ids, userId],
    );
    if (rows.length !== new Set(ids).size) throw badRequest('INVALID_MEDIA', 'One or more ad files are invalid or still uploading');
    await query(`UPDATE media SET status = 'attached' WHERE id = ANY($1::uuid[])`, [ids]);
    return ids.map((id) => { const r = rows.find((x) => x.id === id)!; return { id: r.id, url: r.url, type: r.kind, mime: r.mime }; });
  },

  /** Business logo (purpose "ad", image). */
  async useForAd(userId: string, mediaId: string) {
    const m = await one(`SELECT * FROM media WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND purpose = 'ad' AND kind = 'image'`, [mediaId, userId]);
    if (!m) throw badRequest('INVALID_MEDIA', 'Upload the image first');
    await query(`UPDATE media SET status = 'attached' WHERE id = $1`, [mediaId]);
    return m.url as string;
  },

  /** Group chat photo: a ready image this user uploaded with purpose "group". */
  async useForGroup(userId: string, mediaId: string) {
    const m = await one(`SELECT * FROM media WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND purpose = 'group' AND kind = 'image'`, [mediaId, userId]);
    if (!m) throw badRequest('INVALID_MEDIA', 'Upload the image first');
    await query(`UPDATE media SET status = 'attached' WHERE id = $1`, [mediaId]);
    return m.url as string;
  },

  /** Community icon / banner: a ready image this user uploaded with purpose "community". */
  async useForCommunity(userId: string, mediaId: string) {
    const m = await one(`SELECT * FROM media WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND purpose = 'community' AND kind = 'image'`, [mediaId, userId]);
    if (!m) throw badRequest('INVALID_MEDIA', 'Upload the image first');
    await query(`UPDATE media SET status = 'attached' WHERE id = $1`, [mediaId]);
    return m.url as string;
  },

  /** Avatar / cover: returns URL of a ready media row owned by the user. */
  async useForProfile(userId: string, mediaId: string, purpose: 'avatar' | 'cover') {
    const m = await one(`SELECT * FROM media WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND purpose = $3 AND kind = 'image'`, [mediaId, userId, purpose]);
    if (!m) throw badRequest('INVALID_MEDIA', 'Upload the image first');
    await query(`UPDATE media SET status = 'attached' WHERE id = $1`, [mediaId]);
    return m.url as string;
  },

  /**
   * Delete a file from storage (R2/local) once nothing uses it any more — e.g. an old profile/cover photo
   * that was replaced, unless it is still shown in an "updated profile picture" post.
   */
  async releaseIfUnused(url: string | null | undefined) {
    if (!url) return;
    const m = await one<{ id: string; object_key: string; storage: 'r2' | 'local' }>('SELECT id, object_key, storage FROM media WHERE url = $1', [url]);
    if (!m) return;
    const used = await one(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM users WHERE avatar_url = $1 OR cover_url = $1)
          OR EXISTS (SELECT 1 FROM posts WHERE media @> jsonb_build_array(jsonb_build_object('url', $1::text)))
          OR EXISTS (SELECT 1 FROM stories WHERE media_url = $1)
          OR EXISTS (SELECT 1 FROM communities WHERE icon_url = $1 OR banner_url = $1)
          OR EXISTS (SELECT 1 FROM conversations WHERE avatar_url = $1)
          OR EXISTS (SELECT 1 FROM business_pages WHERE logo_url = $1)
          OR EXISTS (SELECT 1 FROM ad_creatives WHERE media @> jsonb_build_array(jsonb_build_object('url', $1::text)))`,
      [url],
    );
    if (used) return;
    await query('DELETE FROM media WHERE id = $1', [m.id]);
    await deleteObject(m.object_key, m.storage);
  },

  // ── admin ──
  async list(page: number, limit: number, kind?: string) {
    const params: unknown[] = [limit, (page - 1) * limit];
    let where = 'WHERE 1=1';
    if (kind === 'image' || kind === 'video') { params.push(kind); where += ` AND kind = $${params.length}`; }
    const { rows } = await query(`SELECT *, count(*) OVER() AS total FROM media ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, params);
    const totalBytes = await one<{ b: number }>(`SELECT coalesce(sum(size_bytes),0)::bigint AS b FROM media WHERE status <> 'pending'`);
    // ownerId intentionally omitted when media belongs to an anonymous post (it's NULL anyway)
    return { items: rows.map(mapMedia), total: rows[0]?.total ?? 0, totalBytes: Number(totalBytes?.b ?? 0), driver: storageDriver };
  },

  async adminDelete(mediaId: string) {
    const m = await one('SELECT * FROM media WHERE id = $1', [mediaId]);
    if (!m) throw notFound('Media');
    await deleteObject(m.object_key, m.storage);
    // Take the file out of every post that shows it (its own post, and e.g. "updated profile picture" posts)
    const { rows: touched } = await query<{ id: string }>(
      `UPDATE posts SET media = coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(media) x WHERE x->>'id' <> $2 AND x->>'url' <> $3), '[]'::jsonb)
        WHERE id = $1 OR media @> jsonb_build_array(jsonb_build_object('id', $2::text)) OR media @> jsonb_build_array(jsonb_build_object('url', $3::text))
        RETURNING id`,
      [m.post_id, mediaId, m.url],
    );
    await query('UPDATE users SET avatar_url = NULL WHERE avatar_url = $1', [m.url]);
    await query('UPDATE users SET cover_url = NULL WHERE cover_url = $1', [m.url]);
    await query('DELETE FROM media WHERE id = $1', [mediaId]);
    // A post left with no text and no files is deleted entirely (no blank posts in feeds)
    const removed = await deleteEmptyPosts(touched.map((t) => t.id));
    return { ...m, removedPosts: removed };
  },

  /** Background job: drop abandoned uploads older than 24h. */
  async cleanupPending() {
    const { rows } = await query(`DELETE FROM media WHERE status = 'pending' AND created_at < now() - interval '24 hours' RETURNING object_key, storage`);
    for (const r of rows) await deleteObject(r.object_key, r.storage);
    if (rows.length) logger.info(`Cleaned ${rows.length} abandoned uploads`);
  },
};
