import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { parseContactFile } from '../importer.js';
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
