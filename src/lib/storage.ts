import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, stat, unlink } from 'fs/promises';
import path from 'path';
import { env, r2Enabled } from '../config/env.js';

export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

const s3 = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      // Path-style (`<account>.r2…/<bucket>/key`) avoids a per-bucket DNS lookup that can fail intermittently.
      forcePathStyle: true,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
    })
  : null;

export const storageDriver: 'r2' | 'local' = r2Enabled ? 'r2' : 'local';

export function publicUrlFor(key: string, driver = storageDriver): string {
  return driver === 'r2'
    ? `${env.R2_PUBLIC_URL!.replace(/\/$/, '')}/${key}`
    : `${env.PUBLIC_API_URL.replace(/\/$/, '')}/uploads/${key}`;
}

/** Only URLs produced by our own storage are accepted on posts/profiles (SSRF / hotlink defence). */
export function isOwnMediaUrl(url: string): boolean {
  const bases = [`${env.PUBLIC_API_URL.replace(/\/$/, '')}/uploads/`];
  if (env.R2_PUBLIC_URL) bases.push(`${env.R2_PUBLIC_URL.replace(/\/$/, '')}/`);
  return bases.some((b) => url.startsWith(b));
}

export async function presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
  if (!s3) throw new Error('R2 not configured');
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: contentType, ContentLength: contentLength }),
    { expiresIn: 600 },
  );
}

/** Server-side write (uploads proxied through the API). */
export async function putObject(key: string, body: Buffer, contentType: string, driver = storageDriver) {
  if (driver === 'r2') {
    if (!s3) throw new Error('R2 not configured');
    await s3.send(new PutObjectCommand({
      Bucket: env.R2_BUCKET, Key: key, Body: body, ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable', // keys are random and never reused
    }));
    return;
  }
  await ensureLocalDir(key);
  const { writeFile } = await import('fs/promises');
  await writeFile(localPath(key), body);
}

/** Verify an uploaded object exists and return its size. */
export async function headObject(key: string, driver = storageDriver): Promise<{ size: number } | null> {
  try {
    if (driver === 'r2') {
      const r = await s3!.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    }
    const s = await stat(localPath(key));
    return { size: s.size };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string, driver = storageDriver) {
  try {
    if (driver === 'r2') await s3!.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    else await unlink(localPath(key));
  } catch {
    /* already gone */
  }
}

export function localPath(key: string): string {
  const p = path.resolve(UPLOAD_DIR, key);
  if (!p.startsWith(UPLOAD_DIR + path.sep)) throw new Error('Invalid key'); // path traversal guard
  return p;
}

export async function ensureLocalDir(key: string) {
  await mkdir(path.dirname(localPath(key)), { recursive: true });
}
