import type { Request, Response } from 'express';
import { pool } from '../config/db.js';

const VERSION = process.env.npm_package_version ?? '1.0.0';

function formatUptime(totalSeconds: number) {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [d && `${d}d`, (d || h) && `${h}h`, `${m}m`, `${s % 60}s`].filter(Boolean);
  return parts.join(' ');
}

async function pingDb(): Promise<{ ok: boolean; ms: number }> {
  const start = performance.now();
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    return { ok: true, ms: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - start) };
  }
}

/** GET / — human-friendly landing page for the API ("DualSphere Engine"). */
export async function enginePage(_req: Request, res: Response) {
  const db = await pingDb();
  const uptime = formatUptime(process.uptime());
  const allOk = db.ok;

  // Inline styles only; no scripts. Override the global CSP just for this page.
  res.set({
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>DualSphere Engine</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/icon.png">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#050505;--card:rgba(255,255,255,.03);--line:rgba(255,255,255,.07);--text:#f2f2f2;--muted:#8a8a8a;--ok:#34d399;--bad:#f87171}
  body{min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:32px;overflow:hidden;position:relative}
  /* white spotlight from the top, slowly breathing */
  body::before{content:"";position:fixed;left:50%;top:-30vh;width:1100px;height:80vh;transform:translateX(-50%);background:radial-gradient(ellipse at center,rgba(255,255,255,.13) 0%,rgba(255,255,255,.04) 40%,transparent 70%);z-index:0;pointer-events:none;animation:breathe 7s ease-in-out infinite}
  /* vignette to pull focus to the centre */
  body::after{content:"";position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 40%,rgba(0,0,0,.85) 100%);z-index:0;pointer-events:none}
  @keyframes breathe{50%{opacity:.6;transform:translateX(-50%) scale(1.06)}}
  .grid{position:fixed;inset:-56px;z-index:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:56px 56px;mask-image:radial-gradient(ellipse at 50% 40%,#000 0,transparent 65%);-webkit-mask-image:radial-gradient(ellipse at 50% 40%,#000 0,transparent 65%);animation:pan 20s linear infinite}
  @keyframes pan{to{transform:translate(56px,56px)}}
  main{position:relative;z-index:1;width:100%;max-width:660px;text-align:center;animation:rise .9s cubic-bezier(.2,.7,.2,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}}
  .tag{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#bdbdbd;border:1px solid var(--line);background:var(--card);padding:6px 14px;border-radius:999px;margin-bottom:22px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
  .dot{width:8px;height:8px;border-radius:50%;background:${allOk ? 'var(--ok)' : 'var(--bad)'};box-shadow:0 0 0 0 ${allOk ? 'rgba(52,211,153,.6)' : 'rgba(248,113,113,.6)'};animation:pulse 2s infinite}
  @keyframes pulse{70%{box-shadow:0 0 0 10px transparent}100%{box-shadow:0 0 0 0 transparent}}
  /* silver heading with a light sweep */
  h1{font-size:clamp(40px,8vw,68px);line-height:1.02;font-weight:700;letter-spacing:-.04em;background:linear-gradient(100deg,#6b6b6b 0%,#fff 30%,#bdbdbd 45%,#fff 50%,#bdbdbd 55%,#fff 70%,#6b6b6b 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shine 6s ease-in-out infinite;filter:drop-shadow(0 0 30px rgba(255,255,255,.12))}
  @keyframes shine{0%{background-position:100% 0}60%,100%{background-position:0 0}}
  p.sub{color:var(--muted);margin:16px auto 40px;max-width:440px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px}
  .stat{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.01));border:1px solid var(--line);border-radius:16px;padding:20px 12px;backdrop-filter:blur(8px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 20px 40px -20px rgba(0,0,0,.8);transition:transform .25s,border-color .25s}
  .stat::before{content:"";position:absolute;top:-1px;left:20%;right:20%;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent)}
  .stat:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.18)}
  .stat .k{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .stat .v{font-size:20px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
  .ok{color:var(--ok)} .bad{color:var(--bad)}
  .links{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .links a{color:#0a0a0a;background:#f2f2f2;text-decoration:none;font-size:13px;font-weight:500;padding:10px 18px;border-radius:10px;transition:.2s}
  .links a:hover{background:#fff;box-shadow:0 0 24px rgba(255,255,255,.25)}
  .base{font-size:13px;padding:10px 16px;border-radius:10px;border:1px dashed rgba(255,255,255,.14);color:var(--muted)}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#e5e5e5}
  footer{margin-top:40px;font-size:12px;color:#5c5c5c}
  @media (max-width:520px){.stats{grid-template-columns:1fr}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head>
<body>
<div class="grid"></div>
<main>
  <div class="tag"><span class="dot"></span>${allOk ? 'All systems operational' : 'Degraded'}</div>
  <h1>DualSphere Engine</h1>
  <p class="sub">The API core powering DualSphere — auth, feed, messaging, realtime and media.</p>
  <section class="stats">
    <div class="stat"><div class="k">API</div><div class="v ok">Online</div></div>
    <div class="stat"><div class="k">Database</div><div class="v ${db.ok ? 'ok' : 'bad'}">${db.ok ? `${db.ms} ms` : 'Down'}</div></div>
    <div class="stat"><div class="k">Uptime</div><div class="v">${uptime}</div></div>
  </section>
  <div class="links">
    <a href="/health">Health check</a>
    <span class="base">Base path: <code>/api/v1</code></span>
  </div>
  <footer>v${VERSION} · ${new Date().toUTCString()}</footer>
</main>
</body>
</html>`);
}
