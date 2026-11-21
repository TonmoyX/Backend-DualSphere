// Seeds: admin + moderator + demo users, sample identity & anonymous posts, default settings.
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { one, pool, query, tx } from '../config/db.js';
import { contentHash } from '../lib/text.js';
import { auditService } from '../services/audit.service.js';
import { identityService } from '../services/identity.service.js';
import { DEFAULT_SETTINGS } from '../services/settings.service.js';

async function upsertUser(u: { username: string; email: string; password: string; displayName: string; role: string; bio?: string }) {
  const existing = await one('SELECT id FROM users WHERE lower(username) = lower($1)', [u.username]);
  if (existing) return existing.id as string;
  const row = await one(
    `INSERT INTO users (username, email, password_hash, display_name, role, bio, is_verified, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,true, now() - interval '3 days') RETURNING id`,
    [u.username, u.email, await bcrypt.hash(u.password, 12), u.displayName, u.role, u.bio ?? ''],
  );
  console.log(`  + ${u.role.padEnd(9)} ${u.username}  (${u.email})`);
  return row!.id as string;
}

console.log('Seeding DualSphere…');

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  await query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
}
console.log('  ✓ default settings');

const adminId = await upsertUser({
  username: env.SEED_ADMIN_USERNAME, email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD,
  displayName: 'DualSphere Admin', role: 'admin', bio: 'Platform administrator.',
});
await upsertUser({ username: env.SEED_MODERATOR_USERNAME, email: env.SEED_MODERATOR_EMAIL, password: env.SEED_MODERATOR_PASSWORD, displayName: 'Mod Squad', role: 'moderator' });
const demo = [
  await upsertUser({ username: 'ayesha', email: 'ayesha@dualsphere.local', password: 'DemoPass!2026', displayName: 'Ayesha Rahman', role: 'user', bio: 'Designer. Coffee. Pixels.' }),
  await upsertUser({ username: 'rafi', email: 'rafi@dualsphere.local', password: 'DemoPass!2026', displayName: 'Rafi Hasan', role: 'user', bio: 'Building things on the web.' }),
  await upsertUser({ username: 'nadia', email: 'nadia@dualsphere.local', password: 'DemoPass!2026', displayName: 'Nadia Karim', role: 'user', bio: 'Reader, writer, wanderer.' }),
];

const { rows: countRows } = await query('SELECT count(*)::int AS n FROM posts');
if (countRows[0].n === 0) {
  const samples: { by: string; mode: 'identity' | 'anonymous'; text: string; ago: number }[] = [
    { by: demo[0]!, mode: 'identity', text: 'Just shipped a new design system for our team 🎨 Dark mode first, always.', ago: 300 },
    { by: demo[1]!, mode: 'anonymous', text: 'Honest question: does anyone else feel burnt out by the constant "hustle" posts? Taking a slow week and not feeling guilty about it.', ago: 240 },
    { by: demo[2]!, mode: 'identity', text: 'Finished reading "The Remains of the Day". Quiet, devastating, perfect.', ago: 200 },
    { by: demo[0]!, mode: 'anonymous', text: 'My manager takes credit for my work in every meeting. How do you handle this without burning bridges?', ago: 150 },
    { by: demo[1]!, mode: 'identity', text: 'Tip: Postgres keyset pagination (WHERE (created_at, id) < ($1, $2)) beats OFFSET at scale. Your feed will thank you.', ago: 90 },
    { by: demo[2]!, mode: 'anonymous', text: 'I finally told my family I want to change careers. It went better than I feared. If you\'re scared to have that conversation — you might be surprised.', ago: 45 },
    { by: adminId, mode: 'identity', text: 'Welcome to DualSphere 👋 Post as yourself, or post anonymously — your anonymous posts are never linked to your profile.', ago: 10 },
  ];
  for (const s of samples) {
    await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO posts (content, visibility, author_id, content_hash, created_at)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval) RETURNING id`,
        [s.text, s.mode, s.mode === 'identity' ? s.by : null, contentHash(s.text), String(s.ago)],
      );
      if (s.mode === 'anonymous') await identityService.storeLink(c, rows[0].id, s.by);
      else await c.query('UPDATE users SET post_count = post_count + 1 WHERE id = $1', [s.by]);
    });
  }
  console.log(`  ✓ ${samples.length} sample posts`);
}

await auditService.log({ actorId: adminId, actorRole: 'admin', action: 'SYSTEM_SEED', targetType: 'system' });
console.log('\nDone. Admin login →', env.SEED_ADMIN_EMAIL, '/', env.SEED_ADMIN_PASSWORD, '(change it!)');
await pool.end();
