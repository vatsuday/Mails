// Public pages linked from sent emails: the open-tracking image and the unsubscribe page.
// Unsubscribing needs a POST so link scanners can't unsubscribe people.
import express, { Router } from 'express';
import { config } from './config.js';
import { run } from './db.js';
import { readOpenToken, readUnsubscribeToken } from './secret.js';
import { escapeHtml } from './util.js';

const r = Router();

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f5f9;color:#111827;padding:16px}
  .card{background:#fff;max-width:420px;width:100%;padding:32px;border-radius:16px;box-shadow:0 10px 30px rgba(16,24,40,.08);text-align:center}
  h1{font-size:1.3rem;margin:0 0 8px} p{color:#4b5563;line-height:1.5;margin:0 0 20px}
  button{font:inherit;font-weight:600;background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 22px;cursor:pointer}
  button:hover{background:#4338ca}
  @media (prefers-color-scheme: dark){body{background:#0f1117;color:#e5e7eb}.card{background:#181b24;box-shadow:none}p{color:#9ca3af}}
</style></head><body><div class="card">${body}</div></body></html>`;

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

r.get('/u/o/:token', async (req, res) => {
  const id = readOpenToken(req.params.token);
  if (id) {
    await run(`UPDATE em_recipients SET open_count = open_count + 1, opened_at = COALESCE(opened_at, now()), last_opened_at = now()
               WHERE id = :id AND status = 'sent'`, { id }).catch((err) => console.error('[open] not recorded:', err.message));
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' });
  res.send(PIXEL);
});

r.get('/u/:token', (req, res) => {
  const email = readUnsubscribeToken(req.params.token);
  if (!email) return res.status(400).send(page('Invalid link', '<h1>This link is not valid</h1><p>Please use the unsubscribe link from the latest email you received.</p>'));
  res.send(page('Unsubscribe', `<h1>Unsubscribe?</h1><p><strong>${escapeHtml(email)}</strong> will no longer receive bulk emails from ${escapeHtml(config.appName)}.</p>
    <form method="post"><button type="submit">Yes, unsubscribe me</button></form>`));
});

r.post('/u/:token', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  const email = readUnsubscribeToken(req.params.token);
  if (!email) return res.status(400).send(page('Invalid link', '<h1>This link is not valid</h1>'));
  await run("INSERT INTO em_suppressions (email, reason) VALUES (:email, 'unsubscribed') ON CONFLICT (email) DO NOTHING", { email });
  res.send(page('Unsubscribed', `<h1>You're unsubscribed</h1><p><strong>${escapeHtml(email)}</strong> has been removed from our mailing lists.</p>`));
});

export default r;
