// My profile, staff users (admin) and email (SMTP) settings (admin).
import { go, refreshMe } from './app.js';
import { $, $$, api, busy, confirmBox, fmtDateTime, fmtNum, html, icon, initials, modal, mount, timeAgo, toast } from './common.js';
import { createEditor } from './editor.js';
import { state } from './state.js';

// ---- Profile ----

export async function renderProfile(main) {
  const u = state.user;
  mount(main, html`
    <div class="page-head"><div class="row"><span class="avatar" style="width:48px;height:48px;font-size:1.1rem">${initials(u.name)}</span>
      <div><h1>My profile</h1><p>${u.email} · ${u.role === 'admin' ? 'Admin' : 'Staff'}</p></div></div></div>
    <div class="grid-2" style="grid-template-columns:minmax(0,3fr) minmax(280px,2fr)">
      <form class="card stack" id="p-form">
        <h2>Name & signature</h2>
        <label class="field">Your name<input name="name" required value="${u.name}" maxlength="100"></label>
        <div><div class="section-title" style="margin-bottom:6px">Email signature</div><div id="sig"></div>
          <p class="hint" style="margin-top:6px">Added automatically at the end of emails you compose. Include your name, role, phone and company.</p></div>
        <div><button class="btn" data-busy="Saving…">Save profile</button></div>
      </form>
      <form class="card stack" id="pw-form" autocomplete="off">
        <h2>Change password</h2>
        ${state.app.defaultPassword ? html`<div class="alert warn">${icon('key')} You are using the default password. Please change it.</div>` : ''}
        <label class="field">Current password<input name="current" type="password" required autocomplete="current-password"></label>
        <label class="field">New password<input name="next" type="password" required minlength="8" autocomplete="new-password"><span class="hint">At least 8 characters.</span></label>
        <label class="field">Repeat new password<input name="again" type="password" required autocomplete="new-password"></label>
        <div><button class="btn" data-busy="Saving…">Change password</button></div>
      </form>
    </div>`);
  const sig = createEditor($('#sig'), {
    value: u.signature_html || '',
    placeholder: 'e.g. Ravi Kumar · Sales Manager · +91 98xxxxxx · Your Company Pvt Ltd',
  });
  sig.root.querySelector('.rte-body').style.minHeight = '140px';
  $('#p-form').onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api('/me', { method: 'PATCH', body: { name: e.target.name.value, signature_html: sig.getHTML() } });
      await refreshMe();
      toast('Profile saved.', 'ok');
      go('#/profile');
    });
  };
  $('#pw-form').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.next.value !== f.again.value) { toast('The new passwords do not match.', 'error'); return; }
    busy(e.submitter, async () => {
      await api('/me/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
      await refreshMe();
      f.reset();
      toast('Password changed. Other devices have been logged out.', 'ok');
      go('#/profile');
    });
  };
}

// ---- Users ----

const randomPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(10);
  crypto.getRandomValues(a);
  return [...a].map((n) => chars[n % chars.length]).join('');
};

function userForm(u = null) {
  return modal((box, close) => {
    mount(box, html`<div class="modal-head"><h2>${u ? `Edit ${u.name}` : 'Add staff user'}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <form class="stack" autocomplete="off">
        <div class="form-grid">
          <label class="field">Full name<input name="name" required value="${u?.name || ''}" autofocus></label>
          <label class="field">Email (used to log in)<input name="email" type="email" required value="${u?.email || ''}"></label>
        </div>
        <label class="field">Role<select name="role">
          <option value="staff" ${u?.role !== 'admin' ? 'selected' : ''}>Staff: sends emails, sees only their own history</option>
          <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Admin: everything, plus users and email settings</option></select></label>
        <label class="field">${u ? 'New password (leave empty to keep the current one)' : 'Password'}
          <div class="row"><input name="password" ${u ? '' : 'required'} minlength="8" autocomplete="new-password">
            <button type="button" class="btn secondary" id="gen">Generate</button></div>
          <span class="hint">Share it with the person; they can change it in My profile.</span></label>
        ${u ? html`<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><span>Account active <span class="hint">(untick to block log-in without deleting history)</span></span></label>` : ''}
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">${u ? 'Save' : 'Add user'}</button></div>
      </form>`);
    const form = box.querySelector('form');
    $('#gen', box).onclick = () => { form.password.value = randomPassword(); form.password.type = 'text'; };
    form.onsubmit = (e) => {
      e.preventDefault();
      const body = { name: form.name.value.trim(), email: form.email.value.trim(), role: form.role.value };
      if (form.password.value) body.password = form.password.value;
      if (u) body.active = form.active.checked;
      close(body);
    };
  }, { dismissable: false });
}

async function showPassword(email, password) {
  await modal((box) => {
    mount(box, html`<div class="modal-head"><h2>Login details</h2></div>
      <p class="muted">Share these with the user. The password will not be shown again.</p>
      <dl class="kv" style="margin-top:12px"><dt>Website</dt><dd>${location.origin}</dd><dt>Email</dt><dd>${email}</dd><dt>Password</dt><dd class="mono">${password}</dd></dl>
      <div class="modal-actions"><button class="btn secondary" id="copy">${icon('copy')} Copy</button><button class="btn" data-close>Done</button></div>`);
    $('#copy', box).onclick = () => navigator.clipboard?.writeText(`Website: ${location.origin}\nEmail: ${email}\nPassword: ${password}`)
      .then(() => toast('Copied.', 'ok')).catch(() => toast('Could not copy. Select the text instead.', 'error'));
  });
}

export async function renderUsers(main) {
  const users = await api('/users');
  mount(main, html`
    <div class="page-head"><div><h1>Staff users</h1><p>People who can log in and send emails.</p></div>
      <div class="actions"><button class="btn" id="u-add">${icon('plus')} Add user</button></div></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th class="num">Sent (30 d)</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr>
        <td><div class="row"><span class="avatar" style="width:30px;height:30px;font-size:.75rem">${initials(u.name)}</span><b>${u.name}</b>${u.id === state.user.id ? html`<span class="badge">you</span>` : ''}</div></td>
        <td>${u.email}</td>
        <td>${u.role === 'admin' ? html`<span class="badge primary">Admin</span>` : html`<span class="badge">Staff</span>`}</td>
        <td>${u.active ? html`<span class="badge ok">Active</span>` : html`<span class="badge danger">Blocked</span>`}</td>
        <td class="small" title="${fmtDateTime(u.last_login_at)}">${u.last_login_at ? timeAgo(u.last_login_at) : html`<span class="muted">never</span>`}</td>
        <td class="num">${fmtNum(u.sent_30)}</td>
        <td class="nowrap"><button class="icon-btn" data-edit="${u.id}" title="Edit">${icon('edit')}</button>
          ${u.id !== state.user.id ? html`<button class="icon-btn" data-del="${u.id}" title="Delete">${icon('trash')}</button>` : ''}</td>
      </tr>`)}</tbody></table></div>`);

  $('#u-add').onclick = async () => {
    const body = await userForm();
    if (!body) return;
    try {
      await api('/users', { method: 'POST', body });
      await showPassword(body.email, body.password);
      go('#/admin/users');
    } catch (err) { toast(err.message, 'error'); }
  };
  $$('[data-edit]', main).forEach((b) => {
    b.onclick = async () => {
      const u = users.find((x) => x.id === Number(b.dataset.edit));
      const body = await userForm(u);
      if (!body) return;
      try {
        await api(`/users/${u.id}`, { method: 'PATCH', body });
        if (body.password) await showPassword(body.email, body.password);
        else toast('Saved.', 'ok');
        if (u.id === state.user.id) await refreshMe();
        go('#/admin/users');
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  $$('[data-del]', main).forEach((b) => {
    b.onclick = async () => {
      const u = users.find((x) => x.id === Number(b.dataset.del));
      if (!await confirmBox(`Delete ${u.name}?`, 'They will no longer be able to log in. Emails they sent stay in the history. To only block log-in, edit the user and untick "Account active".', { ok: 'Delete user', danger: true })) return;
      await api(`/users/${u.id}`, { method: 'DELETE' }).then(() => { toast('User deleted.'); go('#/admin/users'); }).catch((err) => toast(err.message, 'error'));
    };
  });
}

// ---- SMTP settings ----

const PRESETS = [
  { name: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false, dailyLimit: 450, delayMs: 1000, note: 'Turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords and use it as the password. Gmail allows about 500 emails per day.' },
  { name: 'Google Workspace', host: 'smtp.gmail.com', port: 587, secure: false, dailyLimit: 1800, delayMs: 1000, note: 'Use your company Google account with an App Password. Limit is about 2,000 emails per day per user.' },
  { name: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, secure: false, dailyLimit: 9000, delayMs: 2000, note: 'SMTP AUTH must be enabled for the mailbox in the Microsoft 365 admin centre. Limit is 30 emails per minute and 10,000 per day.' },
  { name: 'Zoho Mail', host: 'smtppro.zoho.in', port: 465, secure: true, dailyLimit: 300, delayMs: 2000, note: 'For a company address (you@yourcompany.com) on zoho.in. Use smtp.zoho.in for a personal @zoho.in address, or .com instead of .in if you sign in at mail.zoho.com. Turn on IMAP/SMTP access in Zoho Mail settings, and use an app-specific password if 2FA is on. Zoho limits daily sending, so keep the daily limit modest.' },
  { name: 'Hostinger', host: 'smtp.hostinger.com', port: 465, secure: true, dailyLimit: 0, delayMs: 500, note: 'Use the full email address and its password from hPanel → Emails.' },
  { name: 'GoDaddy', host: 'smtpout.secureserver.net', port: 465, secure: true, dailyLimit: 250, delayMs: 1000, note: 'GoDaddy Professional Email allows about 250 recipients per day.' },
  { name: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, secure: false, dailyLimit: 0, delayMs: 200, note: 'Bulk-friendly. Use the SMTP login and the SMTP key from Brevo → SMTP & API. Verify your sender address in Brevo first.' },
  { name: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false, dailyLimit: 0, delayMs: 200, user: 'apikey', note: 'Username is literally "apikey"; password is your SendGrid API key. Verify your sender first.' },
];

export async function renderSettings(main) {
  const s = await api('/settings/smtp');
  mount(main, html`
    <div class="page-head"><div><h1>Email settings</h1><p>The mail server (SMTP) used to send every email from this website.</p></div></div>
    <form class="stack" id="smtp-form" autocomplete="off">
      <div class="card stack">
        <div class="card-title" style="margin:0"><h2>Quick setup</h2><span class="small muted">Pick your email provider to fill in the server details</span></div>
        <div class="row wrap">${PRESETS.map((p, i) => html`<button type="button" class="btn sm secondary" data-preset="${i}">${p.name}</button>`)}</div>
        <div class="alert info hidden" id="preset-note"></div>
      </div>
      <div class="grid-2">
        <div class="card stack">
          <h2>Server</h2>
          <div class="form-grid" style="grid-template-columns:2fr 1fr">
            <label class="field">SMTP host<input name="host" required value="${s.host || ''}" placeholder="smtp.yourcompany.com"></label>
            <label class="field">Port<input name="port" type="number" required value="${s.port || 587}"></label>
          </div>
          <label class="check"><input type="checkbox" name="secure" ${s.secure ? 'checked' : ''}><span>Use SSL (port 465)<br><span class="hint">Leave off for port 587. It upgrades to TLS automatically.</span></span></label>
          <label class="field">Username<input name="user" value="${s.user || ''}" placeholder="usually your full email address" autocomplete="off"></label>
          <label class="field">Password<input name="pass" type="password" placeholder="${s.hasPassword ? '•••••••• (saved, leave empty to keep)' : 'SMTP / app password'}" autocomplete="new-password">
            <span class="hint">Stored encrypted. ${s.hasPassword ? html`<label class="check" style="display:inline-flex;margin-top:4px"><input type="checkbox" name="clearPassword"> Remove the saved password</label>` : ''}</span></label>
        </div>
        <div class="stack">
          <div class="card stack">
            <h2>Sender</h2>
            <label class="field">From email<input name="fromEmail" type="email" required value="${s.fromEmail || ''}" placeholder="info@yourcompany.com">
              <span class="hint">Must be an address your mail server allows you to send from (usually the same as the username).</span></label>
            <label class="field">From name<input name="fromName" value="${s.fromName || ''}" placeholder="Your Company"></label>
          </div>
          <div class="card stack">
            <h2>Bulk sending speed</h2>
            <div class="form-grid" style="grid-template-columns:1fr 1fr">
              <label class="field">Pause between emails (ms)<input name="delayMs" type="number" min="0" max="10000" value="${s.delayMs ?? 500}"></label>
              <label class="field">Emails per batch<input name="batchSize" type="number" min="1" max="50" value="${s.batchSize ?? 10}"></label>
            </div>
            <label class="field">Daily limit (whole company)<input name="dailyLimit" type="number" min="0" value="${s.dailyLimit || 0}">
              <span class="hint">0 = no limit. Bulk sends pause automatically when it is reached and can be resumed the next day. Stay under your provider's limit to avoid your account being blocked.</span></label>
          </div>
        </div>
      </div>
      <div class="sticky-actions">
        <div class="row wrap"><input name="testTo" type="email" placeholder="Send test to: ${state.user.email}" style="width:260px">
          <button type="button" class="btn secondary" id="test" data-busy="Testing…">${icon('send')} Test connection</button></div>
        <button class="btn lg" data-busy="Saving…">Save settings</button>
      </div>
    </form>`);

  const form = $('#smtp-form');
  const values = () => ({
    host: form.host.value.trim(), port: Number(form.port.value), secure: form.secure.checked, user: form.user.value.trim(),
    pass: form.pass.value, clearPassword: Boolean(form.clearPassword?.checked), fromEmail: form.fromEmail.value.trim(),
    fromName: form.fromName.value.trim(), delayMs: Number(form.delayMs.value), batchSize: Number(form.batchSize.value), dailyLimit: Number(form.dailyLimit.value),
  });
  form.port.addEventListener('change', () => { form.secure.checked = Number(form.port.value) === 465; });
  $$('[data-preset]', main).forEach((b) => {
    b.onclick = () => {
      const p = PRESETS[Number(b.dataset.preset)];
      form.host.value = p.host;
      form.port.value = p.port;
      form.secure.checked = p.secure;
      form.delayMs.value = p.delayMs;
      form.dailyLimit.value = p.dailyLimit;
      if (p.user) form.user.value = p.user;
      $$('[data-preset]', main).forEach((x) => x.classList.toggle('on', x === b));
      const note = $('#preset-note');
      note.textContent = `${p.name}: ${p.note}`;
      note.classList.remove('hidden');
      (p.user ? form.pass : form.user).focus();
    };
  });
  $('#test').onclick = (e) => {
    if (!form.reportValidity()) return;
    busy(e.currentTarget, async () => {
      const r = await api('/settings/smtp/test', { method: 'POST', body: { ...values(), to: form.testTo.value.trim() }, timeout: 60000 });
      toast(`It works! A test email was sent to ${r.to}. Remember to save.`, 'ok');
    });
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      if (values().clearPassword && !await confirmBox('Remove the saved password?', 'Sending will stop working until a new password is entered.', { ok: 'Remove', danger: true })) return;
      await api('/settings/smtp', { method: 'PUT', body: values() });
      await refreshMe();
      toast('Email settings saved.', 'ok');
      go('#/admin/settings');
    });
  };
}
