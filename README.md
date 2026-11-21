# DualSphere — Backend API

The REST + realtime API that powers **DualSphere**, a social network where every user can post in two ways:

- **Identity mode**: a normal post shown with your name and avatar.
- **Anonymous mode**: a post with no visible author. The link back to the author is encrypted and can only be opened by an admin, through an audited, MFA-protected process.

This repo is one of three:

| Repo | What it is |
| --- | --- |
| **Backend** (this repo) | Express API, PostgreSQL, Socket.io |
| Frontend | The user-facing Next.js web app |
| Admin | The staff / moderation panel (Next.js) |

---

## Tech stack

- **Runtime:** Node.js 20.6+ with TypeScript (ESM), run by `tsx` in development
- **Framework:** Express 5
- **Database:** PostgreSQL (`pg`), schema managed with plain SQL migrations
- **Realtime:** Socket.io (live comments, typing indicators, notifications, WebRTC call signalling)
- **Auth:** JWT access + refresh tokens in HttpOnly cookies, bcrypt password hashing, optional TOTP two-factor auth (with QR setup)
- **Storage:** Cloudflare R2 (S3-compatible) for images and video, with a fallback to local disk
- **Cache / rate limiting:** Redis (optional). Without it, rate limits are kept in memory.
- **Email:** Nodemailer over SMTP (optional). Without SMTP, emails are printed to the console.
- **Security:** Helmet, a CORS whitelist, origin checks, rate limiting, HTML sanitising, Zod input validation
- **Logging:** Pino

---

## Features

### Users and accounts
- Sign up, email verification, login, logout, forgot / reset password, change password
- Two-factor authentication (TOTP) and login alerts for new devices
- See and revoke active sessions
- Profiles with avatar, bio, date of birth, gender and profile lock
- Per-user privacy, appearance and notification settings

### Posts and feed
- Identity and anonymous posts, with photos, videos and reels
- Feed filters: everything / identity only / anonymous only
- Likes, nested comments, comment likes, share, save
- Authors can delete their own anonymous posts. The server checks ownership with an HMAC, so it never has to decrypt the author link.
- "My anonymous posts" view, visible only to the author

### Social
- Friend requests, friend lists, suggestions (which can be dismissed), friends-list visibility
- Blocking users
- Stories (24 hours) with views, reactions and replies
- Notifications, including private notifications for anonymous authors

### Messaging and calls
- One-to-one and group conversations, message requests (accept / decline)
- Edit, delete, forward, react to, pin and search messages
- Voice messages, read receipts, typing indicators, unread counts
- Voice and video calls over WebRTC, with signalling through Socket.io. STUN works out of the box and a TURN relay can be configured.

### Moderation and admin
- Report posts, comments, messages and users
- Report queue, hide / restore posts and comments, ban / unban users
- Automatic spam and abuse detection: duplicate-content hashing, similarity checks, posting-velocity limits and an abuse score per user
- **Role-based access:** `user`, `moderator`, `admin`. Admins can give each moderator their own set of permissions.
- Some actions are **admin-only and can never be delegated**: changing roles, deleting accounts, unmasking anonymous authors, managing permissions
- Site-wide settings (branding, feature toggles, limits, maintenance mode), editable from the admin panel
- "Report a problem" feedback inbox

---

## How anonymity works

The anonymous-identity design is the core of the project:

1. When an anonymous post is created, the author's user ID is **encrypted with AES** and stored in a separate table (`anonymous_post_links`) in the same database transaction as the post. The `posts` row itself holds no author.
2. An **HMAC of `postId:userId`** is stored next to it. This lets the server answer "is *this* user the author?" (to allow delete or edit) without decrypting anything, and it cannot be used to search for an author.
3. Only one module, `identity.service.ts`, is allowed to read that table.
4. **Unmasking an author** needs an admin role, a written reason and an MFA code. The audit entry is written **before** the lookup runs, so even a failed attempt is recorded.
5. Posting-velocity tracking for anonymous posts is kept **only in memory**, so it leaves no lasting per-user trail in the database.
6. Key versions are stored with each record, so encryption keys can be rotated later.

### Tamper-evident audit log
Every staff action is written to `audit_logs`. Each entry is signed with an HMAC that includes the previous entry's signature, forming a hash chain. If someone edits or deletes a past row, the chain breaks. Admins can verify the whole chain, or a single entry, from the admin panel.

---

## API overview

Every endpoint is under `/api/v1`:

| Prefix | Purpose |
| --- | --- |
| `/auth` | signup, login, MFA, refresh, sessions, password flows |
| `/posts` | create (identity / anonymous), edit, delete, like, comment, share, save, report |
| `/feed` | main feed, saved posts, my anonymous posts |
| `/users` | profiles, posts, photos, reels, friends, user search |
| `/comments` | like, delete, report |
| `/friends` | requests, lists, suggestions |
| `/conversations`, `/messages` | chats, members, pins, reactions, forwarding, search |
| `/blocks` | block / unblock |
| `/stories` | story feed, views, reactions, replies |
| `/media` | upload (presigned R2 URL or through the API) |
| `/notifications` | list, unread count, mark as read |
| `/calls` | WebRTC ICE server config |
| `/settings` | public site settings |
| `/feedback` | "Report a problem" |
| `/moderation` | report queue, hide / restore, ban / unban |
| `/admin` | stats, users, permissions, media, audit logs, identity lookup, site settings |

`GET /health` is a simple health check.

---

## Getting started

### Requirements
- Node.js **20.6 or newer** (needed for `--env-file`)
- PostgreSQL 14+
- Redis (optional)

### Environment variables

Every variable is listed in `.env.example`. The main groups are:

- **Server:** `PORT`, `PUBLIC_API_URL`, `FRONTEND_URL`, `ADMIN_URL`, `CORS_ORIGINS`, `TRUST_PROXY`
- **Database:** `DATABASE_URL`
- **Redis (optional):** `REDIS_URL`
- **Secrets:** JWT, identity encryption / HMAC, audit HMAC, MFA encryption and IP-hash salt. Generate them with `npm run keys` and never reuse them between environments.
- **Cloudflare R2 (optional):** leave empty to store uploads on local disk
- **TURN (optional):** for calls between networks that STUN can't connect
- **SMTP (optional):** leave empty to print emails to the console
- **Seed accounts:** used once by `npm run db:seed` to create the first admin and moderator

---

## Background jobs

A cleanup job runs every 10 minutes. It removes expired sessions and email tokens, pending media uploads that were never finished, and expired stories.

## Production notes

- Set `NODE_ENV=production` (this turns on HSTS and secure cookies).
- Set `TRUST_PROXY=1` when running behind Cloudflare or a load balancer.
- Set `COOKIE_DOMAIN` so the API, web app and admin panel can share auth cookies across subdomains.
- Configure Redis so rate limits are shared when you run more than one instance.
- Configure R2 for media, and a TURN server for reliable calls.
