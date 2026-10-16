export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found.`);

export function str(v, max = 200) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** LIKE pattern for a "contains" search (use with ESCAPE '\'). */
export function likePattern(q) {
  const s = str(q, 100);
  return s ? `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
}

export function paging(query, def = 50, max = 500) {
  const limit = Math.min(max, positiveInt(query.limit) || def);
  const page = positiveInt(query.page) || 1;
  return { limit, page, offset: (page - 1) * limit };
}

const EMAIL_RE = /^[^\s@<>()[\]\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function normalizeEmail(v) {
  const s = String(v ?? '').trim().replace(/^mailto:/i, '').toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

/** Splits "a@x.com, Bob <b@y.com>; c@z.com" into normalized addresses. Throws on any invalid entry. */
export function parseAddressList(v, field) {
  const parts = (Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/)).map((p) => String(p).trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = p.match(/<([^>]+)>\s*$/);
    const email = normalizeEmail(m ? m[1] : p);
    if (!email) throw badRequest(`"${p.slice(0, 80)}" in ${field} is not a valid email address.`);
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** Removes active content from user-written email HTML (previews in the app are also sandboxed). */
export function cleanHtml(html) {
  return String(html ?? '')
    .replace(/<(script|iframe|object|embed|form|meta|link|base)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<(script|iframe|object|embed|form|meta|link|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"')
    .slice(0, 1_000_000);
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
      const t = txt.replace(/<[^>]+>/g, '').trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function csvCell(v) {
  const s = String(v ?? '');
  // Leading = + - @ would run as a formula when the CSV is opened in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
