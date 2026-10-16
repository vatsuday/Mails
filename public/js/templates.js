// Reusable email templates.
import { go } from './app.js';
import { $, $$, api, busy, confirmBox, html, icon, modal, mount, previewDoc, timeAgo, toast } from './common.js';
import { createEditor } from './editor.js';
import { isAdmin, state } from './state.js';

const STARTERS = [
  {
    name: 'Announcement',
    subject: 'Important update from {{company|our team}}',
    html: `<h2 style="color:#4338ca">An important update</h2><p>Dear {{first_name|Sir/Madam}},</p>
<p>We are pleased to let you know that … (write your announcement here).</p>
<p>If you have any questions, simply reply to this email.</p><p>Warm regards,<br><b>Your Company</b></p>`,
  },
  {
    name: 'Newsletter',
    subject: '{{first_name}}, here is what is new this month',
    html: `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px">
<tr><td style="background:#4338ca;color:#ffffff;padding:20px 24px;font-size:20px;font-weight:bold">Monthly Newsletter</td></tr>
<tr><td style="padding:24px"><p>Hi {{first_name|there}},</p><h3>1. First headline</h3><p>A short paragraph about your first story.</p>
<h3>2. Second headline</h3><p>A short paragraph about your second story.</p>
<p><a href="https://example.com" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 22px;border-radius:6px">Read more</a></p></td></tr>
<tr><td style="padding:14px 24px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">You are receiving this because you are a valued contact of our company.</td></tr></table>`,
  },
  {
    name: 'Payment reminder',
    subject: 'Reminder: invoice {{invoice_no}} is due on {{due_date}}',
    html: `<p>Dear {{name|Customer}},</p><p>This is a friendly reminder that invoice <b>{{invoice_no}}</b> for <b>{{amount}}</b> is due on <b>{{due_date}}</b>.</p>
<p>If you have already paid, please ignore this message. Otherwise, kindly arrange the payment at your earliest convenience.</p>
<p>Thank you,<br>Accounts Team</p>`,
  },
];

function editTemplate(t = {}) {
  return modal((box, close) => {
    mount(box, html`<div class="modal-head"><h2>${t.id ? 'Edit template' : 'New template'}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <form class="stack">
        <div class="form-grid"><label class="field">Template name<input name="name" required value="${t.name || ''}" placeholder="e.g. Diwali offer" autofocus></label>
          <label class="field">Subject<input name="subject" value="${t.subject || ''}" placeholder="Can include {{first_name}}"></label></div>
        <div id="t-editor"></div>
        <p class="tiny muted">Use {{name}}, {{first_name}}, {{email}} or any column from your contact file, e.g. {{company}}. They are filled in during Bulk send.</p>
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Save template</button></div></form>`);
    const ed = createEditor($('#t-editor', box), { value: t.html || '', tall: true });
    box.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      close({ name: e.target.name.value.trim(), subject: e.target.subject.value.trim(), html: ed.getHTML() });
    };
  }, { wide: true, dismissable: false });
}

export async function render(main) {
  const list = await api('/templates');
  const canEdit = (t) => isAdmin() || t.user_id === state.user.id;

  mount(main, html`
    <div class="page-head"><div><h1>Templates</h1><p>Save emails you send often. Anyone in the team can use them.</p></div>
      <div class="actions"><button class="btn" id="t-new">${icon('plus')} New template</button></div></div>
    ${list.length ? html`<div class="toolbar-row"><input type="search" id="t-q" placeholder="Search templates…"></div>` : ''}
    <div class="cards" id="t-cards">
      ${list.map((t) => html`<div class="card tcard" data-name="${`${t.name} ${t.subject}`.toLowerCase()}">
        <div class="thumb" data-thumb="${t.id}"></div>
        <div><h3 class="ellipsis">${t.name}</h3><p class="small muted ellipsis">${t.subject || '(no subject)'}</p>
          <p class="tiny muted">Updated ${timeAgo(t.updated_at)}${t.owner_name ? ` · ${t.owner_name}` : ''}</p></div>
        <div class="row wrap">
          <button class="btn sm" data-use="${t.id}">${icon('send')} Email</button>
          <button class="btn sm secondary" data-bulk="${t.id}">${icon('bulk')} Bulk</button>
          <span class="grow"></span>
          ${canEdit(t) ? html`<button class="icon-btn" data-edit="${t.id}" title="Edit">${icon('edit')}</button>
            <button class="icon-btn" data-del="${t.id}" title="Delete">${icon('trash')}</button>` : ''}
        </div></div>`)}
    </div>
    ${list.length ? '' : html`<div class="card empty">${icon('template')}<h3>No templates yet</h3><p>Start from a ready-made design or create your own.</p>
      <div class="row wrap" style="justify-content:center;margin-top:14px">${STARTERS.map((s, i) => html`<button class="btn secondary" data-starter="${i}">${icon('plus')} ${s.name}</button>`)}</div></div>`}`);

  for (const t of list) {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', '');
    f.setAttribute('tabindex', '-1');
    f.title = `${t.name} preview`;
    f.srcdoc = previewDoc(t.html);
    $(`[data-thumb="${t.id}"]`, main).append(f);
  }
  const byId = (id) => list.find((t) => t.id === Number(id));
  $('#t-q')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('[data-name]', main).forEach((c) => c.classList.toggle('hidden', !c.dataset.name.includes(q)));
  });
  $('#t-new').onclick = async () => {
    const t = await editTemplate();
    if (!t) return;
    await api('/templates', { method: 'POST', body: t }).then(() => { toast('Template saved.', 'ok'); go('#/templates'); }).catch((err) => toast(err.message, 'error'));
  };
  $$('[data-starter]', main).forEach((b) => {
    b.onclick = () => busy(b, async () => {
      await api('/templates', { method: 'POST', body: STARTERS[Number(b.dataset.starter)] });
      toast('Template added. Edit it to make it yours.', 'ok');
      go('#/templates');
    });
  });
  $$('[data-use]', main).forEach((b) => {
    b.onclick = () => {
      const t = byId(b.dataset.use);
      const sig = state.user.signature_html ? `<p></p><div class="signature">${state.user.signature_html}</div>` : '';
      state.handoff = { mode: 'compose', subject: t.subject, html: t.html + sig };
      go('#/compose');
    };
  });
  $$('[data-bulk]', main).forEach((b) => {
    b.onclick = () => {
      const t = byId(b.dataset.bulk);
      state.handoff = { mode: 'bulk', subject: t.subject, html: t.html };
      go('#/bulk');
    };
  });
  $$('[data-edit]', main).forEach((b) => {
    b.onclick = async () => {
      const t = byId(b.dataset.edit);
      const r = await editTemplate(t);
      if (!r) return;
      await api(`/templates/${t.id}`, { method: 'PUT', body: r }).then(() => { toast('Template saved.', 'ok'); go('#/templates'); }).catch((err) => toast(err.message, 'error'));
    };
  });
  $$('[data-del]', main).forEach((b) => {
    b.onclick = async () => {
      const t = byId(b.dataset.del);
      if (!await confirmBox('Delete template?', `"${t.name}" will be deleted for everyone.`, { ok: 'Delete', danger: true })) return;
      await api(`/templates/${t.id}`, { method: 'DELETE' }).then(() => go('#/templates')).catch((err) => toast(err.message, 'error'));
    };
  });
}
