// Shared helpers: DOM, safe HTML templating, API calls, toasts, modals, formatting, icons.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- Safe HTML templating (all interpolations are escaped unless wrapped with raw()) ----

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderValue(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (v === false || v == null) return '';
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += renderValue(v) + strings[i + 1]; });
  return new Raw(out);
}

export function mount(el, tpl) {
  el.innerHTML = tpl instanceof Raw ? tpl.s : esc(tpl);
  return el;
}

// ---- API ----

export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, timeout = 90000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = { 'X-Requested-With': 'CM' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, credentials: 'same-origin',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(0, 'The server took too long to respond. Please try again.');
    throw new ApiError(0, navigator.onLine === false ? 'You are offline. Connect to the internet and try again.' : 'Could not reach the server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/')) onUnauthorized(data?.error);
    if (res.status === 413) throw new ApiError(413, 'This upload is too large. Keep attachments under 3 MB in total.', data);
    throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`, data);
  }
  return data;
}

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null && v !== false) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---- Feedback ----

export function toast(message, type = '') {
  let wrap = $('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.setAttribute('role', 'status');
    document.body.append(wrap);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  wrap.append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
}

/** Runs an async action with a spinner on the button; errors become a toast. Returns the result or undefined. */
export async function busy(btn, fn, { quiet = false } = {}) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${btn.dataset.busy ? esc(btn.dataset.busy) : ''}`; }
  try {
    return await fn();
  } catch (err) {
    if (!quiet) toast(err.message || String(err), 'error');
    else throw err;
    return undefined;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; }
  }
}

/** Opens a modal. `render(box, close)` fills it. Resolves with the value passed to close(). */
export function modal(render, { wide = false, dismissable = true } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = `modal${wide ? ' wide' : ''}`;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    back.append(box);
    const prevFocus = document.activeElement;
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      back.remove();
      prevFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(undefined); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back && dismissable) close(undefined); });
    document.body.append(back);
    render(box, close);
    box.querySelector('[data-close]')?.addEventListener('click', () => close(undefined));
    (box.querySelector('[autofocus]') || box.querySelector('input, select, textarea, button.btn'))?.focus();
  });
}

export function confirmBox(title, message, { ok = 'Yes', danger = false } = {}) {
  return modal((box, close) => {
    mount(box, html`
      <div class="modal-head"><h2>${title}</h2></div>
      <p class="muted">${message}</p>
      <div class="modal-actions">
        <button class="btn secondary" data-close>Cancel</button>
        <button class="btn ${danger ? 'danger' : ''}" data-ok autofocus>${ok}</button>
      </div>`);
    box.querySelector('[data-ok]').onclick = () => close(true);
  });
}

// ---- Files ----

export function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    r.readAsDataURL(file);
  });
}

export function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

/** Makes an element a drop target and click-to-browse area. */
export function dropzone(el, onFiles, opts = {}) {
  el.addEventListener('click', async () => { const f = await pickFiles(opts); if (f.length) onFiles(f); });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  });
}

export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

// ---- Formatting ----

const dtf = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' });
export const fmtDateTime = (v) => (v ? dtf.format(new Date(v)) : '');
export const fmtDay = (v) => (v ? df.format(new Date(v)) : '');
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
export function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
export function timeAgo(v) {
  if (!v) return '';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return fmtDay(v);
}
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
/** Round avatar with initials; the colour is stable per person. For an email, the part before @ is used. */
export function avatar(label, key = label, cls = '') {
  const text = String(label || '').includes('@') ? String(label).split('@')[0].replace(/[._+-]+/g, ' ') : label;
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return html`<span class="av ${cls}" style="--h:${h}" aria-hidden="true">${initials(text)}</span>`;
}

/** Small dropdown menu next to a button. items: [{ label, icon, danger, onClick }] or '-' for a divider. */
export function popMenu(anchor, items) {
  document.querySelector('.pop-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'pop-menu';
  m.setAttribute('role', 'menu');
  mount(m, html`${items.map((it, i) => (it === '-' ? html`<hr>` : html`<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${it.label}</span></button>`))}`);
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  m.style.top = `${r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  let close;
  const outside = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  close = () => {
    m.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', key);
    window.removeEventListener('scroll', close, true);
  };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', key);
  window.addEventListener('scroll', close, true);
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    close();
    items[Number(b.dataset.i)].onClick?.();
  });
  m.querySelector('button')?.focus();
  return close;
}

export const debounce = (fn, ms = 300) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const STATUS = {
  queued: ['Queued', 'info'], sending: ['Sending', 'primary'], paused: ['Paused', 'warn'], done: ['Sent', 'ok'],
  failed: ['Failed', 'danger'], cancelled: ['Cancelled', ''], pending: ['Waiting', ''], sent: ['Sent', 'ok'], skipped: ['Skipped', ''],
};
export function statusBadge(s) {
  const [label, cls] = STATUS[s] || [s, ''];
  return html`<span class="badge ${cls}">${label}</span>`;
}

export function progressBar(p, cls = '') {
  const t = Math.max(1, Number(p.total) || 0);
  const pct = (n) => `${(100 * (Number(n) || 0)) / t}%`;
  return html`<div class="progress ${cls}" title="${fmtNum(p.sent)} sent, ${fmtNum(p.failed)} failed, ${fmtNum(p.skipped)} skipped, ${fmtNum(p.pending)} waiting">
    <i class="p-sent" style="width:${pct(p.sent)}"></i><i class="p-failed" style="width:${pct(p.failed)}"></i><i class="p-skipped" style="width:${pct(p.skipped)}"></i></div>`;
}

/** Full HTML document for previews (sandboxed iframe, no scripts). */
export function previewDoc(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2937;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}

export function previewFrame(body, cls = 'preview-frame') {
  const f = document.createElement('iframe');
  f.className = cls;
  f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  f.title = 'Email preview';
  f.srcdoc = previewDoc(body);
  return f;
}

// ---- Icons (inline SVG, stroke style) ----

const P = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  bulk: '<path d="M4 6h16M4 12h16M4 18h10"/><path d="m17 16 3 2-3 2"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  alertOff: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7"/><path d="M16 4a4 4 0 0 1 0 8"/><path d="M22 21c0-3-2-6-5-7"/>',
  contacts: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M8 17c1-2 2.5-3 4-3s3 1 4 3"/>',
  template: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  clip: '<path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  dotsV: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  sort: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  first: '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  last: '<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  type: '<path d="M4 20h16"/><path d="m6 16 6-12 6 12M8.5 11h7"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
};
export const icon = (name, cls = 'icon') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`);

// ---- Local storage (best effort) ----

export const store = {
  get(key, def = null) { try { const v = localStorage.getItem(`cm:${key}`); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(key, v) { try { localStorage.setItem(`cm:${key}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(key) { try { localStorage.removeItem(`cm:${key}`); } catch { /* storage unavailable */ } },
};
