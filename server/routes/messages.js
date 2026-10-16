import { Router } from 'express';
import { config } from '../config.js';
import { all, get, run, tx } from '../db.js';
import {
  assertConfigured, buildBulkMail, createTransport, friendlySmtpError, fromHeader, getSmtpSettings,
  toNodemailerAttachments, trackingPixel, wrapHtml,
} from '../mailer.js';
import {
  HttpError, badRequest, cleanHtml, csvCell, htmlToText, likePattern, notFound, paging, parseAddressList,
  positiveInt, str,
} from '../util.js';
import { normalizeContacts } from './contacts.js';

const r = Router();
const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

// ---- helpers ----

function parseAttachments(list) {
  const out = [];
  let total = 0;
  for (const a of Array.isArray(list) ? list.slice(0, 20) : []) {
    const filename = str(a?.filename, 200).replace(/[\\/]/g, '_');
    const data = Buffer.from(String(a?.data || ''), 'base64');
    if (!filename || !data.length) continue;
    total += data.length;
    out.push({ filename, content_type: str(a?.contentType, 120) || 'application/octet-stream', size: data.length, data });
  }
  if (total > config.maxAttachmentBytes) {
    throw badRequest(`Attachments are too large (${(total / 1048576).toFixed(1)} MB). The limit is ${config.maxAttachmentBytes / 1048576} MB in total.`);
  }
  return out;
}

async function saveAttachments(messageId, files, keepIds, fromMessageId, user) {
  for (const f of files) {
    await run(`INSERT INTO em_attachments (message_id, filename, content_type, size, data)
               VALUES (:messageId, :filename, :type, :size, :data)`, {
      messageId, filename: f.filename, type: f.content_type, size: f.size, data: f.data,
    });
  }
  // Attachments re-used from an earlier email (Resend / Duplicate).
  const ids = (Array.isArray(keepIds) ? keepIds : []).map(positiveInt).filter(Boolean);
  if (ids.length && fromMessageId) {
    await loadMessage(fromMessageId, user);
    await run(`INSERT INTO em_attachments (message_id, filename, content_type, size, data)
               SELECT :messageId, filename, content_type, size, data FROM em_attachments
               WHERE message_id = :from AND id = ANY(:ids)`, { messageId, from: fromMessageId, ids });
  }
  const { total } = await get('SELECT COALESCE(SUM(size), 0) AS total FROM em_attachments WHERE message_id = :messageId', { messageId });
  if (total > config.maxAttachmentBytes) throw badRequest(`Attachments are too large. The limit is ${config.maxAttachmentBytes / 1048576} MB in total.`);
}

async function loadMessage(id, user) {
  const msg = positiveInt(id) && await get('SELECT * FROM em_messages WHERE id = :id', { id: positiveInt(id) });
  if (!msg || (user.role !== 'admin' && msg.user_id !== user.id)) throw notFound('Email');
  return msg;
}

async function progress(messageId) {
  const msg = await get('SELECT id, status, kind FROM em_messages WHERE id = :id', { id: messageId });
  const counts = await get(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'sent') AS sent,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed,
           COUNT(*) FILTER (WHERE status = 'skipped') AS skipped,
           COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) AS pending,
           COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened
    FROM em_recipients WHERE message_id = :id`, { id: messageId });
  return { ...msg, ...counts };
}

async function sentTodayCount() {
  const { n } = await get(`SELECT COUNT(*) AS n FROM em_recipients
                           WHERE status = 'sent' AND sent_at >= (date_trunc('day', now() AT TIME ZONE :tz) AT TIME ZONE :tz)`, { tz: TZ });
  return n;
}

async function assertDailyLimit(s, needed) {
  if (!s.dailyLimit) return;
  const used = await sentTodayCount();
  if (used + needed > s.dailyLimit) {
    throw badRequest(`The daily sending limit (${s.dailyLimit}) would be exceeded: ${used} already sent today. Try again tomorrow or ask an admin to raise the limit.`);
  }
}

const baseUrl = (req) => config.appUrl || `${req.protocol}://${req.get('host')}`;

/** Errors that mean "stop and try later" rather than "this address is bad". */
function isFatal(err) {
  return ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(err?.code)
    || (err?.responseCode >= 400 && err?.responseCode < 500 && err?.code !== 'EENVELOPE')
    || /ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(err?.message || '');
}

// ---- single email ----

r.post('/messages/send', async (req, res) => {
  const b = req.body || {};
  const to = parseAddressList(b.to, 'To');
  const cc = parseAddressList(b.cc, 'Cc');
  const bcc = parseAddressList(b.bcc, 'Bcc');
  if (!to.length) throw badRequest('Add at least one recipient in "To".');
  if (to.length + cc.length + bcc.length > 100) throw badRequest('A single email can have at most 100 recipients. Use Bulk send for more.');
  const subject = str(b.subject, 300);
  if (!subject) throw badRequest('Please add a subject.');
  const html = cleanHtml(b.html);
  if (!htmlToText(html) && !/<img/i.test(html)) throw badRequest('The message is empty.');
  const replyTo = b.replyTo ? parseAddressList(b.replyTo, 'Reply-To')[0] || '' : '';
  const files = parseAttachments(b.attachments);

  const s = await getSmtpSettings();
  assertConfigured(s);
  await assertDailyLimit(s, 1);

  const msgId = await tx(async () => {
    const msg = await get(`INSERT INTO em_messages (user_id, kind, subject, html, from_name, reply_to, cc, bcc, status, started_at, track_opens, base_url)
                           VALUES (:userId, 'single', :subject, :html, :fromName, :replyTo, :cc, :bcc, 'sending', now(), :track, :baseUrl) RETURNING id`, {
      userId: req.user.id, subject, html, fromName: str(b.fromName, 100), replyTo, cc: cc.join(', '), bcc: bcc.join(', '),
      track: b.trackOpens !== false, baseUrl: baseUrl(req),
    });
    await run("INSERT INTO em_recipients (message_id, email, status, attempts, claimed_at) VALUES (:id, :email, 'sending', 1, now())", { id: msg.id, email: to.join(', ') });
    await saveAttachments(msg.id, files, b.keepAttachments, positiveInt(b.fromMessageId), req.user);
    return msg.id;
  });
  res.json(await deliverSingle(msgId, s));
});

async function deliverSingle(msgId, s) {
  const msg = await get('SELECT * FROM em_messages WHERE id = :id', { id: msgId });
  const rec = await get('SELECT * FROM em_recipients WHERE message_id = :id ORDER BY id LIMIT 1', { id: msgId });
  const attachments = toNodemailerAttachments(await all('SELECT filename, content_type, data FROM em_attachments WHERE message_id = :id', { id: msgId }));
  const transport = createTransport(s);
  try {
    const mail = {
      from: fromHeader(s, msg.from_name),
      to: rec.email,
      subject: msg.subject,
      html: wrapHtml(msg.html + trackingPixel(msg, rec.id)),
      text: htmlToText(msg.html),
      attachments,
    };
    if (msg.cc) mail.cc = msg.cc;
    if (msg.bcc) mail.bcc = msg.bcc;
    if (msg.reply_to) mail.replyTo = msg.reply_to;
    const info = await transport.sendMail(mail);
    const rejected = (info.rejected || []).map(String);
    await run("UPDATE em_recipients SET status = 'sent', sent_at = now(), error = :error WHERE id = :id", {
      id: rec.id, error: rejected.length ? `Rejected by server: ${rejected.join(', ')}` : null,
    });
    await run("UPDATE em_messages SET status = 'done', finished_at = now() WHERE id = :id", { id: msgId });
    return { id: msgId, ok: true, rejected };
  } catch (err) {
    const error = friendlySmtpError(err, s);
    await run("UPDATE em_recipients SET status = 'failed', error = :error WHERE id = :id", { id: rec.id, error });
    await run("UPDATE em_messages SET status = 'failed', finished_at = now() WHERE id = :id", { id: msgId });
    throw new HttpError(502, `The email could not be sent. ${error}`, { id: msgId });
  } finally {
    transport.close();
  }
}

// ---- bulk email ----

/** Sends one personalised test copy to the logged-in user. */
r.post('/messages/test', async (req, res) => {
  const b = req.body || {};
  const s = await getSmtpSettings();
  assertConfigured(s);
  const files = parseAttachments(b.attachments);
  let attachments = files.map((f) => ({ filename: f.filename, contentType: f.content_type, content: f.data }));
  if (b.fromMessageId && Array.isArray(b.keepAttachments) && b.keepAttachments.length) {
    await loadMessage(b.fromMessageId, req.user);
    const kept = await all('SELECT filename, content_type, data FROM em_attachments WHERE message_id = :id AND id = ANY(:ids)', {
      id: positiveInt(b.fromMessageId), ids: b.keepAttachments.map(positiveInt).filter(Boolean),
    });
    attachments = attachments.concat(toNodemailerAttachments(kept));
  }
  const sample = normalizeContacts([b.sample || {}]).valid[0] || { email: req.user.email, name: req.user.name, data: {} };
  const msg = {
    subject: `[TEST] ${str(b.subject, 300)}`,
    html: cleanHtml(b.html),
    from_name: str(b.fromName, 100),
    reply_to: '',
    add_unsubscribe: Boolean(b.addUnsubscribe),
    base_url: baseUrl(req),
  };
  const mail = buildBulkMail(msg, sample, s, attachments);
  mail.to = req.user.email;
  const transport = createTransport(s);
  try {
    await transport.sendMail(mail);
  } catch (err) {
    throw new HttpError(502, `Test email failed: ${friendlySmtpError(err, s)}`);
  } finally {
    transport.close();
  }
  res.json({ ok: true, to: req.user.email });
});

r.post('/messages/bulk', async (req, res) => {
  const b = req.body || {};
  const subject = str(b.subject, 300);
  if (!subject) throw badRequest('Please add a subject.');
  const html = cleanHtml(b.html);
  if (!htmlToText(html) && !/<img/i.test(html)) throw badRequest('The message is empty.');
  const replyTo = b.replyTo ? parseAddressList(b.replyTo, 'Reply-To')[0] || '' : '';
  const files = parseAttachments(b.attachments);

  let input = Array.isArray(b.recipients) ? b.recipients : [];
  const listIds = (Array.isArray(b.listIds) ? b.listIds : []).map(positiveInt).filter(Boolean);
  if (listIds.length) {
    input = input.concat(await all('SELECT email, name, data FROM em_contacts WHERE list_id = ANY(:ids) ORDER BY id', { ids: listIds }));
  }
  const { valid, invalid, duplicates } = normalizeContacts(input, config.maxRecipients);
  if (!valid.length) throw badRequest('There are no valid recipients to send to.');

  const s = await getSmtpSettings();
  assertConfigured(s);

  const suppressed = new Set((await all('SELECT email FROM em_suppressions WHERE email = ANY(:emails)', {
    emails: valid.map((v) => v.email),
  })).map((x) => x.email));

  const id = await tx(async () => {
    const msg = await get(`INSERT INTO em_messages (user_id, kind, subject, html, from_name, reply_to, add_unsubscribe, source, status, base_url, track_opens)
                           VALUES (:userId, 'bulk', :subject, :html, :fromName, :replyTo, :unsub, :source, 'queued', :baseUrl, :track) RETURNING id`, {
      userId: req.user.id, subject, html, fromName: str(b.fromName, 100), replyTo,
      unsub: Boolean(b.addUnsubscribe), source: str(b.source, 200), baseUrl: baseUrl(req), track: b.trackOpens !== false,
    });
    const rows = valid.map((v) => ({ ...v, status: suppressed.has(v.email) ? 'skipped' : 'pending', error: suppressed.has(v.email) ? 'Unsubscribed' : null }));
    for (let i = 0; i < rows.length; i += 2000) {
      await run(`INSERT INTO em_recipients (message_id, email, name, data, status, error)
                 SELECT :id, x.email, COALESCE(x.name, ''), COALESCE(x.data, '{}'::jsonb), x.status, x.error
                 FROM jsonb_to_recordset(:rows::jsonb) AS x(email text, name text, data jsonb, status text, error text)`, {
        id: msg.id, rows: JSON.stringify(rows.slice(i, i + 2000)),
      });
    }
    await saveAttachments(msg.id, files, b.keepAttachments, positiveInt(b.fromMessageId), req.user);
    return msg.id;
  });
  res.json({ id, total: valid.length, invalid, duplicates, suppressed: suppressed.size });
});

/** Sends the next batch of a bulk email. The browser calls this repeatedly and shows the progress. */
r.post('/messages/:id/batch', async (req, res) => {
  const started = Date.now();
  const msg = await loadMessage(req.params.id, req.user);
  if (msg.kind !== 'bulk') throw badRequest('This is not a bulk email.');
  if (!['queued', 'sending'].includes(msg.status)) return res.json(await progress(msg.id));

  const s = await getSmtpSettings();
  assertConfigured(s);
  await run("UPDATE em_messages SET status = 'sending', started_at = COALESCE(started_at, now()) WHERE id = :id", { id: msg.id });
  // Rows claimed by a request that died (closed tab, timeout) go back in the queue.
  await run(`UPDATE em_recipients SET status = 'pending'
             WHERE message_id = :id AND status = 'sending' AND claimed_at < now() - interval '3 minutes'`, { id: msg.id });

  let size = Math.max(1, Math.min(50, Number(s.batchSize) || 10));
  if (s.dailyLimit) {
    const left = s.dailyLimit - await sentTodayCount();
    if (left <= 0) {
      await run("UPDATE em_messages SET status = 'paused' WHERE id = :id", { id: msg.id });
      return res.json({ ...(await progress(msg.id)), notice: `Daily limit of ${s.dailyLimit} emails reached. Sending is paused. Resume it tomorrow.` });
    }
    size = Math.min(size, left);
  }

  const claimed = await all(`
    UPDATE em_recipients SET status = 'sending', claimed_at = now(), attempts = attempts + 1
    WHERE id IN (SELECT id FROM em_recipients WHERE message_id = :id AND status = 'pending'
                 ORDER BY id LIMIT :size FOR UPDATE SKIP LOCKED)
    RETURNING id, email, name, data`, { id: msg.id, size });
  claimed.sort((a, b) => Number(a.id) - Number(b.id));

  const results = [];
  let notice = null;
  if (claimed.length) {
    const attachments = toNodemailerAttachments(await all('SELECT filename, content_type, data FROM em_attachments WHERE message_id = :id', { id: msg.id }));
    const transport = createTransport(s, { pool: true });
    const delay = Math.max(0, Math.min(10000, Number(s.delayMs) || 0));
    try {
      for (let i = 0; i < claimed.length; i += 1) {
        const rec = claimed[i];
        const current = await get('SELECT status FROM em_messages WHERE id = :id', { id: msg.id });
        if (current.status !== 'sending' || Date.now() - started > config.batchTimeBudgetMs) {
          await run("UPDATE em_recipients SET status = 'pending' WHERE id = ANY(:ids) AND status = 'sending'", { ids: claimed.slice(i).map((x) => x.id) });
          break;
        }
        try {
          await transport.sendMail(buildBulkMail(msg, rec, s, attachments));
          await run("UPDATE em_recipients SET status = 'sent', sent_at = now(), error = NULL WHERE id = :id", { id: rec.id });
          results.push({ email: rec.email, status: 'sent' });
        } catch (err) {
          const error = friendlySmtpError(err, s);
          if (isFatal(err)) {
            // Server / login problem: keep the rest queued and pause, instead of failing every address.
            await run("UPDATE em_recipients SET status = 'pending' WHERE id = ANY(:ids) AND status = 'sending'", { ids: claimed.slice(i).map((x) => x.id) });
            await run("UPDATE em_messages SET status = 'paused' WHERE id = :id", { id: msg.id });
            notice = `Sending paused: ${error}`;
            break;
          }
          await run("UPDATE em_recipients SET status = 'failed', error = :error WHERE id = :id", { id: rec.id, error });
          results.push({ email: rec.email, status: 'failed', error });
        }
        if (delay && i < claimed.length - 1) await sleep(delay);
      }
    } finally {
      transport.close();
    }
  }

  let p = await progress(msg.id);
  if (p.pending === 0 && ['sending', 'queued'].includes(p.status)) {
    const status = p.sent === 0 && p.failed > 0 ? 'failed' : 'done';
    await run('UPDATE em_messages SET status = :status, finished_at = now() WHERE id = :id', { status, id: msg.id });
    p = await progress(msg.id);
  }
  res.json({ ...p, results, notice });
});

r.post('/messages/:id/pause', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  await run("UPDATE em_messages SET status = 'paused' WHERE id = :id AND status IN ('queued', 'sending')", { id: msg.id });
  res.json(await progress(msg.id));
});

r.post('/messages/:id/resume', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  await run("UPDATE em_messages SET status = 'sending', finished_at = NULL WHERE id = :id AND status IN ('paused', 'queued', 'sending')", { id: msg.id });
  res.json(await progress(msg.id));
});

r.post('/messages/:id/cancel', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  await tx(async () => {
    await run("UPDATE em_recipients SET status = 'skipped', error = 'Cancelled' WHERE message_id = :id AND status = 'pending'", { id: msg.id });
    await run("UPDATE em_messages SET status = 'cancelled', finished_at = now() WHERE id = :id AND status IN ('queued', 'sending', 'paused')", { id: msg.id });
  });
  res.json(await progress(msg.id));
});

r.post('/messages/:id/retry', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  if (msg.kind === 'single') {
    if (msg.status !== 'failed') throw badRequest('This email was already sent.');
    const s = await getSmtpSettings();
    assertConfigured(s);
    await run("UPDATE em_recipients SET status = 'sending', attempts = attempts + 1, claimed_at = now() WHERE message_id = :id", { id: msg.id });
    await run("UPDATE em_messages SET status = 'sending', finished_at = NULL WHERE id = :id", { id: msg.id });
    return res.json(await deliverSingle(msg.id, s));
  }
  const { changes } = await run("UPDATE em_recipients SET status = 'pending', error = NULL WHERE message_id = :id AND status = 'failed'", { id: msg.id });
  if (!changes) throw badRequest('There are no failed recipients to retry.');
  await run("UPDATE em_messages SET status = 'sending', finished_at = NULL WHERE id = :id", { id: msg.id });
  res.json(await progress(msg.id));
});

// ---- history ----

r.get('/messages', async (req, res) => {
  const { limit, offset } = paging(req.query, 25, 100);
  const params = {
    userId: req.user.role === 'admin' && req.query.scope !== 'mine' ? null : req.user.id,
    q: likePattern(req.query.q),
    kind: ['single', 'bulk'].includes(req.query.kind) ? req.query.kind : null,
    status: ['queued', 'sending', 'paused', 'done', 'failed', 'cancelled'].includes(req.query.status) ? req.query.status : null,
    limit, offset,
  };
  const where = `(CAST(:userId AS integer) IS NULL OR m.user_id = :userId)
    AND (CAST(:kind AS text) IS NULL OR m.kind = :kind)
    AND (CAST(:status AS text) IS NULL OR m.status = :status)
    AND (CAST(:q AS text) IS NULL OR m.subject ILIKE :q ESCAPE '\\' OR m.source ILIKE :q ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM em_recipients x WHERE x.message_id = m.id AND x.email ILIKE :q ESCAPE '\\'))`;
  const rows = await all(`
    SELECT m.id, m.kind, m.subject, m.status, m.source, m.created_at, m.finished_at, m.track_opens, u.name AS user_name,
           c.total, c.sent, c.failed, c.skipped, c.pending, c.opened, c.first_email,
           (SELECT COUNT(*) FROM em_attachments a WHERE a.message_id = m.id) AS attachments
    FROM em_messages m
    LEFT JOIN em_users u ON u.id = m.user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'sent') AS sent,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed,
             COUNT(*) FILTER (WHERE status = 'skipped') AS skipped,
             COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) AS pending,
             COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
             MIN(email) AS first_email
      FROM em_recipients WHERE message_id = m.id) c ON TRUE
    WHERE ${where}
    ORDER BY m.created_at DESC, m.id DESC LIMIT :limit OFFSET :offset`, params);
  const { n } = await get(`SELECT COUNT(*) AS n FROM em_messages m WHERE ${where}`, params);
  res.json({ rows, total: n });
});

r.get('/messages/:id', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  const user = msg.user_id ? await get('SELECT name, email FROM em_users WHERE id = :id', { id: msg.user_id }) : null;
  const attachments = await all('SELECT id, filename, content_type, size FROM em_attachments WHERE message_id = :id ORDER BY id', { id: msg.id });
  const p = await progress(msg.id);
  const first = msg.kind === 'single'
    ? await get('SELECT email, error, open_count, opened_at, last_opened_at FROM em_recipients WHERE message_id = :id LIMIT 1', { id: msg.id }) : null;
  delete msg.base_url;
  res.json({
    ...msg, ...p, user, attachments, to: first?.email || '', error: first?.error || null,
    open_count: first?.open_count ?? null, opened_at: first?.opened_at ?? null, last_opened_at: first?.last_opened_at ?? null,
  });
});

r.get('/messages/:id/recipients', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  const { limit, offset } = paging(req.query, 50, 500);
  const params = {
    id: msg.id, limit, offset, q: likePattern(req.query.q),
    status: ['pending', 'sending', 'sent', 'failed', 'skipped'].includes(req.query.status) ? req.query.status : null,
    opened: req.query.opened === 'yes' ? true : req.query.opened === 'no' ? false : null,
  };
  const where = `message_id = :id AND (CAST(:status AS text) IS NULL OR status = :status)
                 AND (CAST(:opened AS boolean) IS NULL OR (opened_at IS NOT NULL) = :opened)
                 AND (CAST(:q AS text) IS NULL OR email ILIKE :q ESCAPE '\\' OR name ILIKE :q ESCAPE '\\')`;
  const rows = await all(`SELECT id, email, name, data, status, error, attempts, sent_at, open_count, opened_at, last_opened_at FROM em_recipients WHERE ${where} ORDER BY id LIMIT :limit OFFSET :offset`, params);
  const { n } = await get(`SELECT COUNT(*) AS n FROM em_recipients WHERE ${where}`, params);
  res.json({ rows, total: n });
});

r.get('/messages/:id/export', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  const rows = await all('SELECT email, name, status, error, sent_at, open_count, opened_at, last_opened_at FROM em_recipients WHERE message_id = :id ORDER BY id', { id: msg.id });
  const iso = (d) => (d ? new Date(d).toISOString() : '');
  const lines = [['Email', 'Name', 'Status', 'Sent at', 'Opened', 'First opened', 'Last opened', 'Times opened', 'Error'].join(',')];
  for (const x of rows) {
    lines.push([x.email, x.name, x.status, iso(x.sent_at), x.opened_at ? 'yes' : 'no', iso(x.opened_at), iso(x.last_opened_at), x.open_count || 0, x.error || ''].map(csvCell).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="email-${msg.id}-report.csv"` });
  res.send(`﻿${lines.join('\r\n')}`);
});

r.get('/messages/:id/attachments/:aid', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  const a = await get('SELECT filename, content_type, data FROM em_attachments WHERE id = :aid AND message_id = :id', { aid: positiveInt(req.params.aid), id: msg.id });
  if (!a) throw notFound('Attachment');
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${a.filename.replace(/["\r\n]/g, '')}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
  });
  res.send(Buffer.from(a.data));
});

r.delete('/messages/:id', async (req, res) => {
  const msg = await loadMessage(req.params.id, req.user);
  if (['sending', 'queued'].includes(msg.status)) throw badRequest('Pause or cancel this email before deleting it.');
  await run('DELETE FROM em_messages WHERE id = :id', { id: msg.id });
  res.json({ ok: true });
});

// ---- dashboard ----

r.get('/dashboard', async (req, res) => {
  const params = { userId: req.user.role === 'admin' ? null : req.user.id, tz: TZ };
  const mine = '(CAST(:userId AS integer) IS NULL OR m.user_id = :userId)';
  const stats = await get(`
    SELECT COUNT(*) FILTER (WHERE r.status = 'sent' AND r.sent_at >= (date_trunc('day', now() AT TIME ZONE :tz) AT TIME ZONE :tz)) AS sent_today,
           COUNT(*) FILTER (WHERE r.status = 'sent' AND r.sent_at >= now() - interval '30 days') AS sent_30,
           COUNT(*) FILTER (WHERE r.status = 'failed' AND m.created_at >= now() - interval '30 days') AS failed_30,
           COUNT(*) FILTER (WHERE r.status IN ('pending', 'sending')) AS queued,
           COUNT(*) FILTER (WHERE r.status = 'sent' AND m.track_opens AND r.sent_at >= now() - interval '30 days') AS tracked_30,
           COUNT(*) FILTER (WHERE r.status = 'sent' AND m.track_opens AND r.sent_at >= now() - interval '30 days' AND r.opened_at IS NOT NULL) AS opened_30
    FROM em_recipients r JOIN em_messages m ON m.id = r.message_id WHERE ${mine}`, params);
  const daily = await all(`
    SELECT to_char(r.sent_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day, COUNT(*) AS n
    FROM em_recipients r JOIN em_messages m ON m.id = r.message_id
    WHERE ${mine} AND r.status = 'sent' AND r.sent_at >= now() - interval '14 days'
    GROUP BY 1 ORDER BY 1`, params);
  const active = await all(`
    SELECT m.id, m.subject, m.status, m.created_at FROM em_messages m
    WHERE ${mine} AND m.kind = 'bulk' AND m.status IN ('queued', 'sending', 'paused') ORDER BY m.created_at DESC LIMIT 5`, params);
  const recent = await all(`
    SELECT m.id, m.kind, m.subject, m.created_at, c.sent, c.opened
    FROM em_messages m
    JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE status = 'sent') AS sent, COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened
                  FROM em_recipients WHERE message_id = m.id) c ON TRUE
    WHERE ${mine} AND m.status = 'done' AND m.track_opens AND c.sent > 0
    ORDER BY m.created_at DESC LIMIT 6`, params);
  const { contacts } = await get('SELECT COUNT(DISTINCT email) AS contacts FROM em_contacts');
  const s = await getSmtpSettings();
  res.json({ ...stats, contacts, daily, active, recent, dailyLimit: s.dailyLimit || 0, sentTodayAll: s.dailyLimit ? await sentTodayCount() : null });
});

export default r;
