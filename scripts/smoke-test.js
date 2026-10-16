// End-to-end check: starts the app with a fresh local database and a fake SMTP server,
// then logs in, configures SMTP and exercises single send, bulk send, contacts, templates, users and unsubscribe.
// Usage: npm run smoke
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-smoke-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const SMTP_PORT = PORT + 100;
const B = `http://127.0.0.1:${PORT}`;
const mails = [];
let failures = 0;

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onAuth: (auth, session, cb) => cb(null, { user: auth.username }),
  onRcptTo(addr, session, cb) {
    if (addr.address.startsWith('bounce')) return cb(Object.assign(new Error('550 Mailbox not found'), { responseCode: 550 }));
    return cb();
  },
  onData(stream, session, cb) {
    let raw = '';
    stream.on('data', (c) => { raw += c; });
    stream.on('end', () => { mails.push({ to: session.envelope.rcptTo.map((r) => r.address), raw }); cb(); });
  },
});
await new Promise((r) => { smtp.listen(SMTP_PORT, '127.0.0.1', r); });

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, DATABASE_URL: '', SMTP_HOST: '', APP_SECRET: 'smoke-test-secret', ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'Admin@123' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures += 1;
}

function client() {
  let cookie = '';
  return async (method, p, body, { csrf = true } = {}) => {
    const headers = { Cookie: cookie };
    if (csrf) headers['X-Requested-With'] = 'CM';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${B}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${B}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => { setTimeout(r, 200); });
  }
  const admin = client();

  let r = await admin('GET', '/');
  check('home page served', r.status === 200 && String(r.data).includes('/js/app.js'));
  r = await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'wrong' });
  check('wrong password rejected', r.status === 401);
  r = await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'Admin@123' }, { csrf: false });
  check('CSRF header required', r.status === 403);
  r = await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'Admin@123' });
  check('admin login', r.status === 200);
  r = await admin('GET', '/api/me');
  check('/me says SMTP not configured + default password', r.data.app?.smtpConfigured === false && r.data.app?.defaultPassword === true);

  r = await admin('POST', '/api/messages/send', { to: ['a@x.com'], subject: 'x', html: '<p>x</p>' });
  check('sending blocked until SMTP is set', r.status === 400 && /not set up/i.test(r.data.error));

  const smtpCfg = { host: '127.0.0.1', port: SMTP_PORT, secure: false, user: 'u', pass: 'p', fromEmail: 'info@test.local', fromName: 'Test Co', batchSize: 5, delayMs: 0, dailyLimit: 0 };
  r = await admin('POST', '/api/settings/smtp/test', smtpCfg);
  check('SMTP test email', r.status === 200 && mails.length === 1, r.data.error);
  r = await admin('PUT', '/api/settings/smtp', smtpCfg);
  check('SMTP settings saved', r.status === 200);
  r = await admin('GET', '/api/settings/smtp');
  check('password stored but not returned', r.data.hasPassword === true && r.data.pass === undefined);

  // Single email with attachment
  const att = Buffer.from('hello attachment').toString('base64');
  r = await admin('POST', '/api/messages/send', {
    to: ['Ravi <ravi@client.com>'], cc: 'cc@client.com', subject: 'Quarterly report', html: '<p>Please find the report attached.</p><script>alert(1)</script>',
    attachments: [{ filename: 'report.txt', contentType: 'text/plain', data: att }],
  });
  const single = mails.at(-1);
  check('single email sent', r.status === 200 && r.data.ok && single.to.includes('ravi@client.com') && single.to.includes('cc@client.com'));
  check('attachment included', /report\.txt/.test(single.raw));
  check('script stripped from HTML', !/<script/i.test(single.raw));
  const singleId = r.data.id;

  r = await admin('POST', '/api/messages/send', { to: ['not-an-email'], subject: 's', html: '<p>x</p>' });
  check('invalid address rejected', r.status === 400);

  // Parse a CSV contact file
  const csv = 'Email,Name,Company\nravi@client.com,Ravi Kumar,Acme\npriya@client.com,Priya Shah,\nbad-address,No One,X\nbounce@client.com,Bounce Test,Fail Inc\nRAVI@client.com,Dup,Acme\n';
  r = await admin('POST', '/api/contacts/parse', { filename: 'people.csv', data: Buffer.from(csv).toString('base64') });
  check('CSV parsed', r.status === 200 && r.data.columns.join() === 'Email,Name,Company' && r.data.rows.length === 5);
  const contacts = r.data.rows.map((x) => ({ email: x.Email, name: x.Name, data: { Company: x.Company } }));

  // Contact list
  r = await admin('POST', '/api/lists', { name: 'Clients', contacts });
  check('list created with dedupe/invalid counts', r.status === 200 && r.data.added === 3 && r.data.invalid === 1 && r.data.duplicates === 1, JSON.stringify(r.data));
  const listId = r.data.id;
  r = await admin('GET', `/api/lists/${listId}/contacts?q=acme`);
  check('contact search by field', r.data.total === 1 && r.data.rows[0].email === 'ravi@client.com');
  r = await admin('GET', '/api/contacts/search?q=pri');
  check('autocomplete search', r.data.length === 1);
  r = await admin('GET', `/api/lists/${listId}/contacts?q=${encodeURIComponent('50%')}`);
  check('search with % is literal', r.status === 200 && r.data.total === 0);
  r = await admin('GET', `/api/lists/${listId}/export`);
  check('list export CSV', r.status === 200 && String(r.data).includes('Company'));

  // Suppression
  r = await admin('POST', '/api/suppressions', { email: 'priya@client.com' });
  check('suppression added', r.status === 200);

  // Bulk send from list + pasted recipient
  const before = mails.length;
  r = await admin('POST', '/api/messages/bulk', {
    subject: 'Hello {{first_name}} from {{company|your company}}', html: '<p>Hi {{name}}, at {{company|your company}}.</p>',
    listIds: [listId], recipients: [{ email: 'extra@client.com', name: 'Extra Person', data: {} }], addUnsubscribe: true, source: 'smoke',
  });
  check('bulk created', r.status === 200 && r.data.total === 4 && r.data.suppressed === 1, JSON.stringify(r.data));
  const bulkId = r.data.id;
  let p;
  for (let i = 0; i < 10; i += 1) {
    p = (await admin('POST', `/api/messages/${bulkId}/batch`, {})).data;
    if (p.pending === 0) break;
  }
  check('bulk finished', p.status === 'done' && p.sent === 2 && p.failed === 1 && p.skipped === 1, JSON.stringify({ ...p, results: undefined }));
  const bulkMails = mails.slice(before);
  const ravi = bulkMails.find((m) => m.to.includes('ravi@client.com'));
  check('personalised subject', /Hello Ravi from Acme/.test(ravi?.raw || ''));
  check('fallback used when field empty', /Hello Extra from your company/.test(bulkMails.find((m) => m.to.includes('extra@client.com'))?.raw || ''));
  check('List-Unsubscribe header', /List-Unsubscribe:/i.test(ravi?.raw || ''));
  r = await admin('GET', `/api/messages/${bulkId}/recipients?status=failed`);
  check('failed recipient reported with reason', r.data.total === 1 && /550|not found/i.test(r.data.rows[0].error || ''), r.data.rows[0]?.error);
  r = await admin('GET', `/api/messages/${bulkId}/export`);
  check('report CSV', String(r.data).includes('bounce@client.com'));

  // Unsubscribe link from the email
  const unsubUrl = (ravi?.raw.replace(/=\r?\n/g, '').match(/\/u\/[A-Za-z0-9_.=-]+/) || [])[0]?.replace(/=3D/g, '=');
  r = await admin('GET', unsubUrl || '/u/none');
  check('unsubscribe page opens', r.status === 200 && /Unsubscribe\?/.test(r.data));
  await fetch(`${B}${unsubUrl}`, { method: 'POST' });
  r = await admin('GET', '/api/suppressions');
  check('unsubscribe recorded', r.data.some((x) => x.email === 'ravi@client.com'));
  r = await admin('GET', '/u/bad.token');
  check('tampered unsubscribe link rejected', r.status === 400);

  // History & dashboard
  r = await admin('GET', '/api/messages?q=Quarterly');
  check('history search', r.data.total === 1 && r.data.rows[0].id === singleId);
  r = await admin('GET', '/api/dashboard');
  check('dashboard numbers', r.status === 200 && r.data.sent_today >= 3, JSON.stringify({ sent: r.data.sent_today }));

  // Templates
  r = await admin('POST', '/api/templates', { name: 'Welcome', subject: 'Hi {{first_name}}', html: '<p>Welcome!</p>' });
  check('template created', r.status === 200 && r.data.id);
  const tplId = r.data.id;

  // Staff user permissions
  r = await admin('POST', '/api/users', { name: 'Staff One', email: 'staff@test.local', password: 'Staff@1234', role: 'staff' });
  check('staff user created', r.status === 200);
  const staff = client();
  r = await staff('POST', '/api/auth/login', { email: 'staff@test.local', password: 'Staff@1234' });
  check('staff login', r.status === 200);
  r = await staff('GET', '/api/users');
  check('staff cannot list users', r.status === 403);
  r = await staff('GET', '/api/settings/smtp');
  check('staff cannot read SMTP settings', r.status === 403);
  r = await staff('GET', `/api/messages/${singleId}`);
  check("staff cannot open admin's email", r.status === 404);
  r = await staff('PUT', `/api/templates/${tplId}`, { name: 'Hacked', html: '' });
  check("staff cannot edit admin's template", r.status === 403);
  r = await staff('GET', '/api/messages');
  check('staff history is empty', r.data.total === 0);

  // Retry failed + delete
  r = await admin('POST', `/api/messages/${bulkId}/retry`, {});
  check('retry failed queues them again', r.status === 200 && r.data.pending === 1);
  r = await admin('POST', `/api/messages/${bulkId}/cancel`, {});
  check('cancel', r.data.status === 'cancelled');
  r = await admin('DELETE', `/api/messages/${bulkId}`);
  check('delete email', r.status === 200);

  // Static frontend modules
  for (const f of ['app', 'common', 'editor', 'compose', 'bulk', 'history', 'contacts', 'templates', 'admin', 'runner', 'state', 'merge']) {
    r = await admin('GET', `/js/${f}.js`);
    if (r.status !== 200) check(`/js/${f}.js served`, false);
  }
  check('frontend modules served', true);

  r = await admin('POST', '/api/auth/logout', {});
  r = await admin('GET', '/api/me');
  check('logout ends session', r.status === 401);
} catch (err) {
  console.error(err);
  failures += 1;
} finally {
  server.kill();
  smtp.close();
  if (failures) console.log(`\nServer log:\n${serverLog}`);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file lock */ }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
