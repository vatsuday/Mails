// Personalisation shared by the browser (previews) and the server (sending).
// {{name}}, {{first_name}}, {{email}}, any imported column like {{company}}, with optional fallback: {{name|there}}.

export const normKey = (k) => String(k ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function buildVars(recipient) {
  const vars = {};
  for (const [k, v] of Object.entries(recipient?.data || {})) {
    const key = normKey(k);
    if (key) vars[key] = v == null ? '' : String(v);
  }
  vars.email = recipient?.email || vars.email || '';
  vars.name = recipient?.name || vars.name || '';
  if (!vars.first_name) vars.first_name = vars.name.split(/\s+/)[0] || '';
  return vars;
}

const VAR_RE = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

/** Replaces {{vars}}. In HTML mode recipient values are escaped (the fallback is already part of the HTML). */
export function merge(text, vars, { html = false } = {}) {
  return String(text ?? '').replace(VAR_RE, (_, key, fallback) => {
    const k = normKey(key);
    const v = vars[k];
    if (v == null || v === '') return fallback ?? '';
    return html && k !== 'unsubscribe_url' ? esc(v) : v;
  });
}

export function variablesUsed(...texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t ?? '').matchAll(VAR_RE)) out.add(normKey(m[1]));
  return [...out];
}
