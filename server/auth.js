import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { get, run } from './db.js';
import { HttpError, clientIp } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, key);
}

// Used so a login with an unknown email takes as long as a real one.
export const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

export function checkPasswordStrength(password) {
  const p = String(password ?? '');
  if (p.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (p.length > 200) throw new HttpError(400, 'Password is too long.');
}

let adminChecked = false;
/** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when the database has no users yet. */
export async function ensureFirstAdmin() {
  if (adminChecked) return;
  const { n } = await get('SELECT COUNT(*) AS n FROM em_users');
  if (n === 0) {
    await run(`INSERT INTO em_users (name, email, password_hash, role) VALUES ('Administrator', :email, :hash, 'admin')
               ON CONFLICT (email) DO NOTHING`, { email: config.adminEmail, hash: await hashPassword(config.adminPassword) });
    console.log(`[auth] Created first admin account: ${config.adminEmail}`);
  }
  adminChecked = true;
}

// ---- Cookies & sessions ----

const COOKIE = 'cm_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
    }
  }
  return out;
}

function setCookie(res, value, maxAgeSec) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await run(`INSERT INTO em_sessions (token_hash, user_id, created_at, expires_at, user_agent)
             VALUES (:hash, :userId, :now, :expires, :ua)`, {
    hash: sha256(token), userId,
    now: now.toISOString(),
    expires: new Date(now.getTime() + config.sessionHours * 3600e3).toISOString(),
    ua: String(req.headers['user-agent'] || '').slice(0, 300),
  });
  setCookie(res, token, Math.round(config.sessionHours * 3600));
  // Opportunistic cleanup (no background timers on serverless).
  if (Math.random() < 0.05) purgeExpired().catch(() => {});
}

export async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await run('DELETE FROM em_sessions WHERE token_hash = :hash', { hash: sha256(token) });
  setCookie(res, '', 0);
}

export const destroyUserSessions = (userId) => run('DELETE FROM em_sessions WHERE user_id = :userId', { userId });

export async function purgeExpired() {
  await run('DELETE FROM em_sessions WHERE expires_at <= now()');
  await run("DELETE FROM em_login_failures WHERE at < now() - interval '1 day'");
}

// ---- Middleware ----

export async function requireUser(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  const user = token && await get(`SELECT u.id, u.name, u.email, u.role, u.active, u.signature_html
                                   FROM em_sessions s JOIN em_users u ON u.id = s.user_id
                                   WHERE s.token_hash = :hash AND s.expires_at > now()`, { hash: sha256(token) });
  if (!user) throw new HttpError(401, 'Please log in to continue.');
  if (!user.active) {
    await destroySession(req, res);
    throw new HttpError(401, 'Your account has been deactivated. Please contact your admin.');
  }
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Only admins can do this.');
  next();
}

/** State-changing API calls must come from our own pages (custom header + same-origin). */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'CM') throw new HttpError(403, 'Request blocked.');
  const origin = req.get('Origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = ''; }
    if (host !== req.get('Host')) throw new HttpError(403, 'Request blocked (origin mismatch).');
  }
  next();
}

// ---- Login throttling (stored in the database so it works across serverless instances) ----

const MAX_FAILS = 8;

export const loginKey = (req, email) => `${clientIp(req)}:${String(email || '').toLowerCase()}`.slice(0, 200);

export async function assertNotLocked(key) {
  const { n } = await get("SELECT COUNT(*) AS n FROM em_login_failures WHERE key = :key AND at > now() - interval '15 minutes'", { key });
  if (n >= MAX_FAILS) throw new HttpError(429, 'Too many failed attempts. Please wait 15 minutes and try again.');
}

export const recordFailure = (key) => run('INSERT INTO em_login_failures (key) VALUES (:key)', { key });
export const clearFailures = (key) => run('DELETE FROM em_login_failures WHERE key = :key', { key });
