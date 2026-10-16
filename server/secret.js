// Encryption for the stored SMTP password and signing for unsubscribe links.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let key;
function secretKey() {
  if (key) return key;
  let secret = config.appSecret;
  if (!secret) {
    if (config.onVercel) throw new Error('APP_SECRET is not set. Add it under Vercel → Settings → Environment Variables.');
    // Local development: generate once and keep it in the data folder.
    const file = path.join(config.dataDir, 'app-secret.txt');
    if (fs.existsSync(file)) secret = fs.readFileSync(file, 'utf8').trim();
    else {
      secret = crypto.randomBytes(32).toString('base64url');
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  key = crypto.createHash('sha256').update(`company-mail:${secret}`).digest();
  return key;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob) {
  const [v, iv, tag, enc] = String(blob || '').split(':');
  if (v !== 'v1' || !enc) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

const hmac = (s) => crypto.createHmac('sha256', secretKey()).update(s).digest('base64url').slice(0, 22);

export function unsubscribeToken(email) {
  return `${Buffer.from(email).toString('base64url')}.${hmac(`unsub:${email}`)}`;
}

/** Signed id for the open-tracking image, so nobody can mark other recipients as opened. */
export const openToken = (recipientId) => `${recipientId}.${hmac(`open:${recipientId}`)}`;

export function readOpenToken(token) {
  const [id, sig] = String(token || '').replace(/\.gif$/i, '').split('.');
  if (!/^\d{1,18}$/.test(id || '') || !sig) return null;
  const expected = hmac(`open:${id}`);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? id : null;
}

export function readUnsubscribeToken(token) {
  const [b64, sig] = String(token || '').split('.');
  if (!b64 || !sig) return null;
  const email = Buffer.from(b64, 'base64url').toString('utf8');
  const expected = hmac(`unsub:${email}`);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? email : null;
}
