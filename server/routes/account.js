import { Router } from 'express';
import {
  DUMMY_HASH, assertNotLocked, checkPasswordStrength, clearFailures, createSession, destroySession,
  destroyUserSessions, ensureFirstAdmin, hashPassword, loginKey, recordFailure, requireUser, verifyPassword,
} from '../auth.js';
import { config } from '../config.js';
import { get, run } from '../db.js';
import { getSmtpSettings, isConfigured } from '../mailer.js';
import { HttpError, badRequest, cleanHtml, str } from '../util.js';

const r = Router();

r.post('/auth/login', async (req, res) => {
  await ensureFirstAdmin();
  const email = str(req.body?.email, 254).toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) throw badRequest('Enter your email and password.');
  const key = loginKey(req, email);
  await assertNotLocked(key);
  const user = await get('SELECT id, password_hash, active FROM em_users WHERE email = :email', { email });
  const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) {
    await recordFailure(key);
    throw new HttpError(401, 'Incorrect email or password.');
  }
  if (!user.active) throw new HttpError(403, 'Your account has been deactivated. Please contact your admin.');
  await clearFailures(key);
  await run('UPDATE em_users SET last_login_at = now() WHERE id = :id', { id: user.id });
  await createSession(req, res, user.id);
  res.json({ ok: true });
});

r.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

r.use(requireUser);

r.get('/me', async (req, res) => {
  const smtp = await getSmtpSettings();
  res.json({
    user: req.user,
    app: {
      name: config.appName,
      smtpConfigured: isConfigured(smtp),
      fromEmail: smtp.fromEmail,
      fromName: smtp.fromName,
      maxAttachmentBytes: config.maxAttachmentBytes,
      maxRecipients: config.maxRecipients,
      // Reminds the first admin to change the built-in password.
      defaultPassword: req.user.role === 'admin' && req.user.email === config.adminEmail
        && await verifyPassword('Admin@123', (await get('SELECT password_hash FROM em_users WHERE id = :id', { id: req.user.id })).password_hash),
    },
  });
});

r.patch('/me', async (req, res) => {
  const name = str(req.body?.name, 100);
  if (!name) throw badRequest('Name is required.');
  const signature = cleanHtml(req.body?.signature_html ?? req.user.signature_html).slice(0, 20000);
  await run('UPDATE em_users SET name = :name, signature_html = :signature WHERE id = :id', { name, signature, id: req.user.id });
  res.json({ ok: true });
});

r.post('/me/password', async (req, res) => {
  const { current, next } = req.body || {};
  const row = await get('SELECT password_hash FROM em_users WHERE id = :id', { id: req.user.id });
  if (!await verifyPassword(current, row.password_hash)) throw badRequest('Your current password is incorrect.');
  checkPasswordStrength(next);
  await run('UPDATE em_users SET password_hash = :hash WHERE id = :id', { hash: await hashPassword(next), id: req.user.id });
  await destroyUserSessions(req.user.id);
  await createSession(req, res, req.user.id);
  res.json({ ok: true });
});

export default r;
