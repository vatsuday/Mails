import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { buildTemplateXlsx, parseContactFile } from '../importer.js';
import { badRequest, csvCell, likePattern, normalizeEmail, notFound, paging, positiveInt, str } from '../util.js';

const r = Router();

/** Cleans uploaded contacts: valid + de-duplicated rows, and counts of what was dropped. */
export function normalizeContacts(input, max) {
  const seen = new Set();
  const valid = [];
  let invalid = 0;
  let duplicates = 0;
  for (const c of Array.isArray(input) ? input : []) {
    const email = normalizeEmail(c?.email);
    if (!email) { invalid += 1; continue; }
    if (seen.has(email)) { duplicates += 1; continue; }
    seen.add(email);
    const data = {};
    for (const [k, v] of Object.entries(c?.data && typeof c.data === 'object' ? c.data : {}).slice(0, 40)) {
      const key = str(k, 60);
      if (key) data[key] = str(v, 500);
    }
    valid.push({ email, name: str(c?.name, 150), data });
    if (max && valid.length > max) throw badRequest(`Too many recipients. The limit is ${max.toLocaleString()} per send.`);
  }
  return { valid, invalid, duplicates };
}

async function upsertContacts(listId, contacts) {
  let added = 0;
  // Chunks keep each statement reasonably small.
  for (let i = 0; i < contacts.length; i += 2000) {
    const rows = await all(`
      INSERT INTO em_contacts (list_id, email, name, data)
      SELECT :listId, c.email, COALESCE(c.name, ''), COALESCE(c.data, '{}'::jsonb)
      FROM jsonb_to_recordset(:rows::jsonb) AS c(email text, name text, data jsonb)
      ON CONFLICT (list_id, email) DO UPDATE
        SET name = COALESCE(NULLIF(EXCLUDED.name, ''), em_contacts.name),
            data = em_contacts.data || EXCLUDED.data
      RETURNING (xmax = 0) AS inserted`, { listId, rows: JSON.stringify(contacts.slice(i, i + 2000)) });
    added += rows.filter((x) => x.inserted).length;
  }
  return { added, updated: contacts.length - added };
}

async function loadList(req) {
  const id = positiveInt(req.params.id);
  const list = id && await get('SELECT * FROM em_lists WHERE id = :id', { id });
  if (!list) throw notFound('Contact list');
  return list;
}

r.get('/contacts/template.xlsx', async (req, res) => {
  const reserved = new Set(['email', 'name', 'first_name', 'unsubscribe_url', 'company', 'designation', 'city', 'phone']);
  const extra = String(req.query.fields || '').split(',').map((f) => f.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
    .filter((f) => f && !reserved.has(f)).slice(0, 20);
  const buf = await buildTemplateXlsx(extra);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="bulk-email-template.xlsx"',
  });
  res.send(buf);
});

r.post('/contacts/parse', async (req, res) => {
  res.json(await parseContactFile(str(req.body?.filename, 200), req.body?.data));
});

r.get('/contacts/search', async (req, res) => {
  const q = likePattern(req.query.q);
  if (!q) return res.json([]);
  const rows = await all(`
    SELECT DISTINCT ON (email) email, name FROM em_contacts
    WHERE email ILIKE :q ESCAPE '\\' OR name ILIKE :q ESCAPE '\\'
    ORDER BY email LIMIT 8`, { q });
  res.json(rows);
});

// ---- Everyone in any list, one row per email address ----

const CONTACT_SORTS = {
  name: "lower(NULLIF(g.name, '')) %DIR% NULLS LAST, g.email",
  email: 'g.email %DIR%',
  company: `lower(NULLIF(COALESCE(g.data->>'Company', g.data->>'company', g.data->>'COMPANY', g.data->>'Organisation', g.data->>'Organization', ''), ''))
            %DIR% NULLS LAST, g.email`,
  added: 'g.created_at %DIR%, g.email',
  last_sent: 'last_sent %DIR% NULLS LAST, g.email',
};

r.get('/contacts', async (req, res) => {
  const { limit, offset } = paging(req.query, 50, 200);
  const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
  const order = (CONTACT_SORTS[req.query.sort] || CONTACT_SORTS.name).replaceAll('%DIR%', dir);
  const params = { q: likePattern(req.query.q), listId: positiveInt(req.query.list) || null, limit, offset };
  const rows = await all(`
    WITH g AS (
      SELECT c.email,
             (array_agg(c.name ORDER BY (c.name = ''), c.created_at DESC))[1] AS name,
             (array_agg(c.data ORDER BY c.created_at DESC))[1] AS data,
             jsonb_agg(DISTINCT jsonb_build_object('id', l.id, 'name', l.name)) AS lists,
             MIN(c.created_at) AS created_at
      FROM em_contacts c JOIN em_lists l ON l.id = c.list_id
      WHERE CAST(:listId AS integer) IS NULL OR c.email IN (SELECT email FROM em_contacts WHERE list_id = :listId)
      GROUP BY c.email
    )
    SELECT g.email, g.name, g.data, g.lists, g.created_at, (s.email IS NOT NULL) AS unsubscribed,
           (SELECT MAX(x.sent_at) FROM em_recipients x WHERE x.email = g.email AND x.status = 'sent') AS last_sent,
           (SELECT MAX(x.opened_at) FROM em_recipients x WHERE x.email = g.email) AS last_opened,
           COUNT(*) OVER () AS total
    FROM g LEFT JOIN em_suppressions s ON s.email = g.email
    WHERE CAST(:q AS text) IS NULL OR g.email ILIKE :q ESCAPE '\\' OR g.name ILIKE :q ESCAPE '\\' OR g.data::text ILIKE :q ESCAPE '\\'
    ORDER BY ${order}
    LIMIT :limit OFFSET :offset`, params);
  let total = rows[0]?.total ?? 0;
  if (!rows.length && offset) {
    // Page past the end (e.g. after deleting): still report the real total.
    ({ total } = await get(`SELECT COUNT(DISTINCT email) AS total FROM em_contacts
      WHERE CAST(:listId AS integer) IS NULL OR list_id = :listId`, params));
  }
  for (const x of rows) delete x.total;
  res.json({ rows, total });
});

/** Updates name and details of one person in every list they are in. */
r.post('/contacts/update', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) throw badRequest('Enter a valid email address.');
  const { valid } = normalizeContacts([{ email, name: req.body?.name, data: req.body?.data }]);
  const { changes } = await run('UPDATE em_contacts SET name = :name, data = :data::jsonb WHERE email = :email', {
    email, name: valid[0].name, data: JSON.stringify(valid[0].data),
  });
  if (!changes) throw notFound('Contact');
  res.json({ ok: true });
});

/** Removes people from one list, or from every list when no list is given. */
r.post('/contacts/delete', async (req, res) => {
  const emails = (Array.isArray(req.body?.emails) ? req.body.emails : []).map(normalizeEmail).filter(Boolean);
  if (!emails.length) throw badRequest('Select at least one contact.');
  const { changes } = await run(`DELETE FROM em_contacts WHERE email = ANY(:emails)
                                 AND (CAST(:listId AS integer) IS NULL OR list_id = :listId)`, {
    emails, listId: positiveInt(req.body?.listId) || null,
  });
  res.json({ deleted: changes });
});

r.get('/lists', async (req, res) => {
  res.json(await all(`
    SELECT l.id, l.name, l.created_at, l.user_id, u.name AS owner_name,
           (SELECT COUNT(*) FROM em_contacts c WHERE c.list_id = l.id) AS count
    FROM em_lists l LEFT JOIN em_users u ON u.id = l.user_id
    ORDER BY lower(l.name)`));
});

r.post('/lists', async (req, res) => {
  const name = str(req.body?.name, 100);
  if (!name) throw badRequest('Give the list a name.');
  const { valid, invalid, duplicates } = normalizeContacts(req.body?.contacts || [], 50000);
  const result = await tx(async () => {
    const list = await get('INSERT INTO em_lists (name, user_id) VALUES (:name, :userId) RETURNING id', { name, userId: req.user.id });
    const counts = await upsertContacts(list.id, valid);
    return { id: list.id, ...counts };
  });
  res.json({ ...result, invalid, duplicates });
});

r.patch('/lists/:id', async (req, res) => {
  const list = await loadList(req);
  const name = str(req.body?.name, 100);
  if (!name) throw badRequest('Give the list a name.');
  await run('UPDATE em_lists SET name = :name WHERE id = :id', { name, id: list.id });
  res.json({ ok: true });
});

r.delete('/lists/:id', async (req, res) => {
  const list = await loadList(req);
  if (req.user.role !== 'admin' && list.user_id !== req.user.id) throw badRequest('Only the person who created this list or an admin can delete it.');
  await run('DELETE FROM em_lists WHERE id = :id', { id: list.id });
  res.json({ ok: true });
});

r.get('/lists/:id/contacts', async (req, res) => {
  const list = await loadList(req);
  const { limit, offset } = paging(req.query, 50, 500);
  const params = { listId: list.id, q: likePattern(req.query.q), limit, offset };
  const where = `list_id = :listId AND (CAST(:q AS text) IS NULL OR email ILIKE :q ESCAPE '\\' OR name ILIKE :q ESCAPE '\\' OR data::text ILIKE :q ESCAPE '\\')`;
  const rows = await all(`SELECT id, email, name, data, created_at FROM em_contacts WHERE ${where} ORDER BY lower(name), email LIMIT :limit OFFSET :offset`, params);
  const { n } = await get(`SELECT COUNT(*) AS n FROM em_contacts WHERE ${where}`, params);
  res.json({ list, rows, total: n });
});

r.post('/lists/:id/contacts', async (req, res) => {
  const list = await loadList(req);
  const { valid, invalid, duplicates } = normalizeContacts(req.body?.contacts, 50000);
  if (!valid.length) throw badRequest('No valid email addresses were found.');
  res.json({ ...(await upsertContacts(list.id, valid)), invalid, duplicates });
});

r.post('/lists/:id/contacts/delete', async (req, res) => {
  const list = await loadList(req);
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(positiveInt).filter(Boolean);
  if (!ids.length) throw badRequest('Select at least one contact.');
  const { changes } = await run('DELETE FROM em_contacts WHERE list_id = :listId AND id = ANY(:ids)', { listId: list.id, ids });
  res.json({ deleted: changes });
});

r.patch('/lists/:id/contacts/:cid', async (req, res) => {
  const list = await loadList(req);
  const email = normalizeEmail(req.body?.email);
  if (!email) throw badRequest('Enter a valid email address.');
  const { valid } = normalizeContacts([{ email, name: req.body?.name, data: req.body?.data }]);
  try {
    const { changes } = await run('UPDATE em_contacts SET email = :email, name = :name, data = :data::jsonb WHERE id = :id AND list_id = :listId', {
      email, name: valid[0].name, data: JSON.stringify(valid[0].data), id: positiveInt(req.params.cid), listId: list.id,
    });
    if (!changes) throw notFound('Contact');
  } catch (err) {
    if (/duplicate|unique/i.test(err.message)) throw badRequest('This email is already in the list.');
    throw err;
  }
  res.json({ ok: true });
});

r.get('/lists/:id/export', async (req, res) => {
  const list = await loadList(req);
  const rows = await all('SELECT email, name, data FROM em_contacts WHERE list_id = :id ORDER BY lower(name), email', { id: list.id });
  const extra = [...new Set(rows.flatMap((x) => Object.keys(x.data || {})))].filter((k) => !/^(email|name)$/i.test(k));
  const lines = [['Email', 'Name', ...extra].map(csvCell).join(',')];
  for (const x of rows) lines.push([x.email, x.name, ...extra.map((k) => x.data?.[k] ?? '')].map(csvCell).join(','));
  const file = `${list.name.replace(/[^\w -]+/g, '').trim() || 'contacts'}.csv`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"` });
  res.send(`﻿${lines.join('\r\n')}`);
});

// ---- Unsubscribed addresses ----

r.get('/suppressions', async (req, res) => {
  res.json(await all('SELECT email, reason, created_at FROM em_suppressions ORDER BY created_at DESC LIMIT 2000'));
});

r.post('/suppressions', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) throw badRequest('Enter a valid email address.');
  await run("INSERT INTO em_suppressions (email, reason) VALUES (:email, 'added manually') ON CONFLICT (email) DO NOTHING", { email });
  res.json({ ok: true });
});

r.delete('/suppressions/:email', requireAdmin, async (req, res) => {
  await run('DELETE FROM em_suppressions WHERE email = :email', { email: String(req.params.email).toLowerCase() });
  res.json({ ok: true });
});

export default r;
