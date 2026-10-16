// SMTP settings, transport and message building.
import nodemailer from 'nodemailer';
import { buildVars, merge } from '../public/js/merge.js';
import { config } from './config.js';
import { get, run } from './db.js';
import { decrypt, encrypt, openToken, unsubscribeToken } from './secret.js';
import { HttpError, escapeHtml, htmlToText } from './util.js';

export const SMTP_DEFAULTS = {
  batchSize: 10, // emails per batch request
  delayMs: 500, // pause between two emails (helps with provider rate limits)
  dailyLimit: 0, // company-wide emails per day, 0 = no limit (Gmail: ~500, Google Workspace: ~2000)
};

/** Effective SMTP settings: values saved by an admin override the SMTP_* environment variables. */
export async function getSmtpSettings() {
  const row = await get("SELECT value FROM em_settings WHERE key = 'smtp'");
  const saved = row?.value || {};
  const s = { ...config.smtp, ...SMTP_DEFAULTS, ...saved };
  s.pass = saved.passEnc ? decrypt(saved.passEnc) : config.smtp.pass;
  delete s.passEnc;
  return s;
}

export async function saveSmtpSettings(input, { keepPassword }) {
  const current = (await get("SELECT value FROM em_settings WHERE key = 'smtp'"))?.value || {};
  const value = { ...input };
  delete value.pass;
  if (keepPassword) {
    if (current.passEnc) value.passEnc = current.passEnc;
  } else if (input.pass) {
    value.passEnc = encrypt(input.pass);
  }
  await run(`INSERT INTO em_settings (key, value, updated_at) VALUES ('smtp', :value::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, { value: JSON.stringify(value) });
}

export const isConfigured = (s) => Boolean(s.host && s.fromEmail);

export function assertConfigured(s) {
  if (!isConfigured(s)) {
    throw new HttpError(400, 'Email sending is not set up yet. An admin needs to enter the SMTP details under Admin → Email settings.');
  }
}

export function createTransport(s, { pool = false } = {}) {
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 587,
    secure: Boolean(s.secure),
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    pool,
    maxConnections: 1,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

/** Turns nodemailer errors into something an office user can act on. */
export function friendlySmtpError(err, s = {}) {
  const code = err?.code || '';
  const resp = String(err?.response || '').slice(0, 300);
  if (code === 'EAUTH') {
    return `The SMTP server rejected the username or password.${/gmail|google/i.test(s.host || '') ? ' For Gmail, use an App Password, not your normal password.' : ''}${resp ? ` (${resp})` : ''}`;
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(code) || /ENOTFOUND|ECONNREFUSED|timeout/i.test(err?.message || '')) {
    return `Could not connect to ${s.host || 'the SMTP server'}:${s.port || ''}. Check the host, port and the "secure" (SSL) setting. (${err.message})`;
  }
  if (code === 'EENVELOPE') return `The address was rejected: ${resp || err.message}`;
  return resp || err?.message || 'Unknown sending error.';
}

export const fromHeader = (s, fromName) => {
  const name = (fromName || s.fromName || '').trim();
  return name ? { name, address: s.fromEmail } : s.fromEmail;
};

export function wrapHtml(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>`
    + `<body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2937">${body}</body></html>`;
}

/** Invisible 1×1 image; loading it tells us the email was opened (when the reader's app shows images). */
export function trackingPixel(msg, recipientId) {
  if (!msg.track_opens || !msg.base_url || !recipientId) return '';
  return `<img src="${escapeHtml(`${msg.base_url}/u/o/${openToken(recipientId)}.gif`)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0">`;
}

export const toNodemailerAttachments = (rows) => rows.map((a) => ({
  filename: a.filename,
  contentType: a.content_type,
  content: Buffer.from(a.data),
}));

/** Builds one personalised email of a bulk send. */
export function buildBulkMail(msg, recipient, s, attachments) {
  const vars = buildVars(recipient);
  let unsubscribeUrl = '';
  if (msg.add_unsubscribe && msg.base_url) {
    unsubscribeUrl = `${msg.base_url}/u/${unsubscribeToken(recipient.email)}`;
    vars.unsubscribe_url = unsubscribeUrl;
  }
  let body = merge(msg.html, vars, { html: true });
  if (unsubscribeUrl && !/unsubscribe_url/i.test(msg.html)) {
    body += `<p style="margin-top:28px;font-size:12px;color:#6b7280">Don't want to receive these emails? `
      + `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a></p>`;
  }
  const mail = {
    from: fromHeader(s, msg.from_name),
    to: recipient.name ? { name: recipient.name, address: recipient.email } : recipient.email,
    subject: merge(msg.subject, vars),
    html: wrapHtml(body + trackingPixel(msg, recipient.id)),
    text: htmlToText(body),
    attachments,
  };
  if (msg.reply_to) mail.replyTo = msg.reply_to;
  if (unsubscribeUrl) {
    mail.list = { unsubscribe: { url: unsubscribeUrl, comment: 'Unsubscribe' } };
    mail.headers = { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  }
  return mail;
}
