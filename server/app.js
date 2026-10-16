import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { csrfGuard, requireUser } from './auth.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import contactRoutes from './routes/contacts.js';
import messageRoutes from './routes/messages.js';
import unsubscribe from './unsubscribe.js';
import { HttpError } from './util.js';

const CSP = "default-src 'self'; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
  + "connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
  });
  if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use('/api', express.json({ limit: '4.4mb' }), csrfGuard, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api', accountRoutes);
app.use('/api', requireUser, contactRoutes);
app.use('/api', requireUser, messageRoutes);
app.use('/api', requireUser, adminRoutes);
app.use('/api', () => { throw new HttpError(404, 'Not found.'); });

app.use(unsubscribe);

// Static files (on Vercel these are served by the CDN from /public before reaching this function).
const publicDir = path.join(config.root, 'public');
app.use(express.static(publicDir, {
  setHeaders(res, file) {
    if (/\.(html|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
  },
}));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'This upload is too large. Keep attachments and files under 3 MB.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

export default app;
