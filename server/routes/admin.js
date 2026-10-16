// Templates (everyone), users and email settings (admins only).
import { Router } from 'express';
import { checkPasswordStrength, destroyUserSessions, hashPassword, requireAdmin } from '../auth.js';
import { all, get, run } from '../db.js';
import { SMTP_DEFAULTS, createTransport, friendlySmtpError, getSmtpSettings, saveSmtpSettings, wrapHtml } from '../mailer.js';
import { HttpError, badRequest, cleanHtml, normalizeEmail, notFound, positiveInt, str } from '../util.js';

const r = Router();

// ---- templates ----

r.get('/templates', async (req, res) => {
  res.json(await all(`SELECT t.id, t.name, t.subject, t.html, t.user_id, t.updated_at, u.name AS owner_name
                      FROM em_templates t LEFT JOIN em_users u ON u.id = t.user_id ORDER BY lower(t.name)`));
});

function templateInput(body) {
  const name = str(body?.name, 100);
  if (!name) throw badRequest('Give the template a name.');
  return { name, subject: str(body?.subject, 300), html: cleanHtml(body?.html) };
}

r.post('/templates', async (req, res) => {
  const t = templateInput(req.body);
  const row = await get('INSERT INTO em_templates (name, subject, html, user_id) VALUES (:name, :subject, :html, :userId) RETURNING id', { ...t, userId: req.user.id });
  res.json(row);
});

async function ownTemplate(req) {
  const t = await get('SELECT * FROM em_templates WHERE id = :id', { id: positiveInt(req.params.id) });
  if (!t) throw notFound('Template');
  if (req.user.role !== 'admin' && t.user_id !== req.user.id) throw new HttpError(403, 'Only the person who created this template or an admin can change it.');
  return t;
}

r.put('/templates/:id', async (req, res) => {
  const t = await ownTemplate(req);
  await run('UPDATE em_templates SET name = :name, subject = :subject, html = :html, updated_at = now() WHERE id = :id', { ...templateInput(req.body), id: t.id });
  res.json({ ok: true });
});

r.delete('/templates/:id', async (req, res) => {
  const t = await ownTemplate(req);
  await run('DELETE FROM em_templates WHERE id = :id', { id: t.id });
  res.json({ ok: true });
});

// ---- users (admin) ----

r.get('/users', requireAdmin, async (req, res) => {
  res.json(await all(`
    SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login_at,
           (SELECT COUNT(*) FROM em_recipients x JOIN em_messages m ON m.id = x.message_id
            WHERE m.user_id = u.id AND x.status = 'sent' AND x.sent_at >= now() - interval '30 days') AS sent_30
    FROM em_users u ORDER BY u.active DESC, lower(u.name)`));
});

function userInput(body) {
  const name = str(body?.name, 100);
  const email = normalizeEmail(body?.email);
  if (!name) throw badRequest('Name is required.');
  if (!email) throw badRequest('Enter a valid email address.');
  const role = body?.role === 'admin' ? 'admin' : 'staff';
  return { name, email, role };
}

r.post('/users', requireAdmin, async (req, res) => {
  const u = userInput(req.body);
  checkPasswordStrength(req.body?.password);
  try {
    const row = await get(`INSERT INTO em_users (name, email, role, password_hash) VALUES (:name, :email, :role, :hash) RETURNING id`, {
      ...u, hash: await hashPassword(req.body.password),
    });
    res.json(row);
  } catch (err) {
    if (/duplicate|unique/i.test(err.message)) throw badRequest('A user with this email already exists.');
    throw err;
  }
});

async function otherActiveAdmins(id) {
  const { n } = await get("SELECT COUNT(*) AS n FROM em_users WHERE role = 'admin' AND active AND id <> :id", { id });
  return n;
}

r.patch('/users/:id', requireAdmin, async (req, res) => {
  const id = positiveInt(req.params.id);
  const existing = id && await get('SELECT * FROM em_users WHERE id = :id', { id });
  if (!existing) throw notFound('User');
  const u = userInput({ ...existing, ...req.body });
  const active = req.body?.active === undefined ? existing.active : Boolean(req.body.active);
  if ((u.role !== 'admin' || !active) && existing.role === 'admin' && !await otherActiveAdmins(id)) {
    throw badRequest('There must be at least one active admin.');
  }
  try {
    await run('UPDATE em_users SET name = :name, email = :email, role = :role, active = :active WHERE id = :id', { ...u, active, id });
  } catch (err) {
    if (/duplicate|unique/i.test(err.message)) throw badRequest('A user with this email already exists.');
    throw err;
  }
  if (req.body?.password) {
    checkPasswordStrength(req.body.password);
    await run('UPDATE em_users SET password_hash = :hash WHERE id = :id', { hash: await hashPassword(req.body.password), id });
    if (id !== req.user.id) await destroyUserSessions(id);
  }
  if (!active) await destroyUserSessions(id);
  res.json({ ok: true });
});

r.delete('/users/:id', requireAdmin, async (req, res) => {
  const id = positiveInt(req.params.id);
  if (id === req.user.id) throw badRequest('You cannot delete your own account.');
  const existing = id && await get('SELECT role FROM em_users WHERE id = :id', { id });
  if (!existing) throw notFound('User');
  if (existing.role === 'admin' && !await otherActiveAdmins(id)) throw badRequest('There must be at least one active admin.');
  await run('DELETE FROM em_users WHERE id = :id', { id });
  res.json({ ok: true });
});

// ---- SMTP settings (admin) ----

function smtpInput(b) {
  const host = str(b?.host, 200).replace(/^smtps?:\/\//i, '');
  const port = Number(b?.port);
  if (!host) throw badRequest('SMTP host is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Enter a valid port (usually 587 or 465).');
  const fromEmail = normalizeEmail(b?.fromEmail);
  if (!fromEmail) throw badRequest('Enter a valid "From" email address.');
  const int = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
  };
  return {
    host, port,
    secure: Boolean(b?.secure),
    user: str(b?.user, 200),
    pass: typeof b?.pass === 'string' ? b.pass : '',
    fromName: str(b?.fromName, 100),
    fromEmail,
    batchSize: int(b?.batchSize, 1, 50, SMTP_DEFAULTS.batchSize),
    delayMs: int(b?.delayMs, 0, 10000, SMTP_DEFAULTS.delayMs),
    dailyLimit: int(b?.dailyLimit, 0, 1000000, 0),
  };
}

r.get('/settings/smtp', requireAdmin, async (req, res) => {
  const s = await getSmtpSettings();
  res.json({ ...s, pass: undefined, hasPassword: Boolean(s.pass) });
});

r.put('/settings/smtp', requireAdmin, async (req, res) => {
  const input = smtpInput(req.body);
  await saveSmtpSettings(input, { keepPassword: !input.pass && !req.body?.clearPassword });
  res.json({ ok: true });
});

/** Checks the login and sends a test email, using the form values (not yet saved). */
r.post('/settings/smtp/test', requireAdmin, async (req, res) => {
  const input = smtpInput(req.body);
  if (!input.pass && !req.body?.clearPassword) input.pass = (await getSmtpSettings()).pass;
  const to = normalizeEmail(req.body?.to) || req.user.email;
  const transport = createTransport(input);
  try {
    await transport.verify();
    await transport.sendMail({
      from: input.fromName ? { name: input.fromName, address: input.fromEmail } : input.fromEmail,
      to,
      subject: 'Test email from Company Mail',
      html: wrapHtml('<p>Hello!</p><p>Your SMTP settings work. Emails from Company Mail will be sent through this server.</p>'),
      text: 'Hello! Your SMTP settings work. Emails from Company Mail will be sent through this server.',
    });
  } catch (err) {
    throw new HttpError(400, friendlySmtpError(err, input));
  } finally {
    transport.close();
  }
  res.json({ ok: true, to });
});

export default r;
