// Contact lists, contacts and unsubscribed addresses.
import { go } from './app.js';
import {
  $, $$, api, busy, confirmBox, debounce, download, dropzone, fmtDateTime, fmtNum, html, icon, modal, mount, qs, readBase64, timeAgo, toast,
} from './common.js';
import { isAdmin, state } from './state.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

const tabsHtml = (on) => html`<div class="tabs">
  <button data-href="#/contacts" class="${on === 'lists' ? 'on' : ''}">${icon('contacts')} Contact lists</button>
  <button data-href="#/contacts/unsubscribed" class="${on === 'unsub' ? 'on' : ''}">${icon('ban')} Unsubscribed</button></div>`;
const wireTabs = (root) => $$('[data-href]', root).forEach((b) => { b.onclick = () => go(b.dataset.href); });

/**
 * Modal to import contacts from a file or pasted text.
 * Resolves with { name, contacts } (name only when askName) or undefined.
 */
export function importContacts({ askName = false, title = 'Import contacts' } = {}) {
  return modal((box, close) => {
    let parsed = null; // { file, columns, rows, emailCol, nameCol }
    let mode = 'file';
    const draw = () => {
      mount(box, html`
        <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <form class="stack" id="imp">
          ${askName ? html`<label class="field">List name<input name="name" required placeholder="e.g. Customers – Mumbai" autofocus></label>` : ''}
          <div class="tabs" style="margin:0"><button type="button" data-m="file" class="${mode === 'file' ? 'on' : ''}">Excel / CSV file</button>
            <button type="button" data-m="paste" class="${mode === 'paste' ? 'on' : ''}">Paste addresses</button>
            ${askName ? html`<button type="button" data-m="empty" class="${mode === 'empty' ? 'on' : ''}">Start empty</button>` : ''}</div>
          <div id="imp-body"></div>
          <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn" id="imp-ok">${askName ? 'Create list' : 'Import'}</button></div>
        </form>`);
      box.querySelector('[data-close]').onclick = () => close(undefined);
      $$('[data-close]', box).forEach((b) => { b.onclick = () => close(undefined); });
      $$('[data-m]', box).forEach((b) => { b.onclick = () => { const n = box.querySelector('[name="name"]')?.value; mode = b.dataset.m; draw(); if (n && box.querySelector('[name="name"]')) box.querySelector('[name="name"]').value = n; }; });
      const body = $('#imp-body', box);
      if (mode === 'file') {
        if (!parsed) {
          mount(body, html`<div class="dropzone" id="imp-dz">${icon('upload')}<p><b>Drop an Excel or CSV file</b> or click to choose</p><p class="tiny">First row should contain the column titles (Email, Name, …).</p></div>`);
          dropzone($('#imp-dz', box), async (files) => {
            const f = files[0];
            $('#imp-dz', box).innerHTML = '<span class="spinner"></span>';
            try {
              const r = await api('/contacts/parse', { method: 'POST', body: { filename: f.name, data: await readBase64(f) } });
              const emailCol = r.columns.find((c) => /e-?mail/i.test(c)) || r.columns.find((c) => r.rows.slice(0, 30).some((x) => /@/.test(x[c] || ''))) || '';
              const nameCol = r.columns.find((c) => /^(full ?name|name)$/i.test(c)) || r.columns.find((c) => /name/i.test(c)) || '';
              parsed = { file: f.name, columns: r.columns, rows: r.rows, emailCol, nameCol };
              const nameInput = box.querySelector('[name="name"]');
              const n = nameInput?.value || f.name.replace(/\.[^.]+$/, '');
              draw();
              if (box.querySelector('[name="name"]')) box.querySelector('[name="name"]').value = n;
            } catch (err) { toast(err.message, 'error'); draw(); }
          }, { accept: '.xlsx,.xlsm,.csv,.txt,.tsv' });
        } else {
          const valid = parsed.emailCol ? parsed.rows.filter((r) => EMAIL_RE.test(String(r[parsed.emailCol] || '').trim())).length : 0;
          mount(body, html`<div class="stack">
            <div class="row between"><span>${icon('file')} <b>${parsed.file}</b> · ${fmtNum(parsed.rows.length)} rows</span><button type="button" class="btn sm ghost" id="imp-rm">Change file</button></div>
            <div class="form-grid">
              <label class="field">Email column<select id="imp-email"><option value="">— choose —</option>${parsed.columns.map((c) => html`<option ${c === parsed.emailCol ? 'selected' : ''}>${c}</option>`)}</select></label>
              <label class="field">Name column<select id="imp-name"><option value="">— none —</option>${parsed.columns.map((c) => html`<option ${c === parsed.nameCol ? 'selected' : ''}>${c}</option>`)}</select></label>
            </div>
            <p class="small">${parsed.emailCol ? html`<b>${fmtNum(valid)}</b> valid email addresses. Other columns are saved too and can be used as {{fields}}.` : 'Choose the email column.'}</p></div>`);
          $('#imp-rm', box).onclick = () => { parsed = null; draw(); };
          $('#imp-email', box).onchange = (e) => { parsed.emailCol = e.target.value; draw(); };
          $('#imp-name', box).onchange = (e) => { parsed.nameCol = e.target.value; };
        }
      } else if (mode === 'paste') {
        mount(body, html`<label class="field">One per line<textarea id="imp-paste" rows="8" placeholder="ravi@example.com&#10;Priya Sharma &lt;priya@example.com&gt;&#10;amit@example.com, Amit Kumar"></textarea></label>`);
      } else {
        mount(body, html`<p class="small muted">Create an empty list and add people one by one later.</p>`);
      }
      $('#imp', box).onsubmit = (e) => {
        e.preventDefault();
        let contacts = [];
        if (mode === 'file') {
          if (!parsed?.emailCol) return toast('Upload a file and choose the email column.', 'error');
          contacts = parsed.rows.map((r) => ({
            email: String(r[parsed.emailCol] || '').trim(),
            name: parsed.nameCol ? String(r[parsed.nameCol] || '').trim() : '',
            data: Object.fromEntries(Object.entries(r).filter(([k]) => k !== parsed.emailCol && k !== parsed.nameCol)),
          }));
        } else if (mode === 'paste') {
          for (const line of $('#imp-paste', box).value.split(/\r?\n/)) {
            const l = line.trim();
            if (!l) continue;
            const angle = l.match(/^(.*?)<([^>]+)>/);
            if (angle) { contacts.push({ email: angle[2].trim(), name: angle[1].replace(/["',]/g, '').trim() }); continue; }
            const parts = l.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
            const email = parts.find((p) => /@/.test(p)) || parts[0];
            contacts.push({ email, name: parts.filter((p) => p !== email).join(' ') });
          }
          if (!contacts.length) return toast('Paste at least one email address.', 'error');
        }
        return close({ name: box.querySelector('[name="name"]')?.value.trim(), contacts });
      };
    };
    draw();
  }, { wide: true });
}

/** Uploads contacts in chunks so large files stay under the request size limit. */
async function uploadContacts(listId, contacts, firstResult = null) {
  const total = { added: firstResult?.added || 0, updated: firstResult?.updated || 0, invalid: firstResult?.invalid || 0, duplicates: firstResult?.duplicates || 0 };
  for (let i = firstResult ? 2000 : 0; i < contacts.length; i += 2000) {
    const r = await api(`/lists/${listId}/contacts`, { method: 'POST', body: { contacts: contacts.slice(i, i + 2000) }, timeout: 120000 }).catch((err) => {
      if (/no valid/i.test(err.message)) return { added: 0, updated: 0, invalid: Math.min(2000, contacts.length - i), duplicates: 0 };
      throw err;
    });
    for (const k of Object.keys(total)) total[k] += r[k] || 0;
  }
  return total;
}
const importSummary = (r) => [`${fmtNum(r.added)} added`, r.updated ? `${fmtNum(r.updated)} updated` : '', r.invalid ? `${fmtNum(r.invalid)} invalid skipped` : '', r.duplicates ? `${fmtNum(r.duplicates)} duplicates skipped` : ''].filter(Boolean).join(', ');

export async function renderLists(main) {
  const lists = await api('/lists');
  mount(main, html`
    <div class="page-head"><div><h1>Contacts</h1><p>Save groups of people to email again later. Upload once, send many times.</p></div>
      <div class="actions"><button class="btn" id="new-list">${icon('plus')} New list</button></div></div>
    ${tabsHtml('lists')}
    ${lists.length ? html`<div class="cards">${lists.map((l) => html`
      <div class="card tcard">
        <a href="#/contacts/${l.id}" style="text-decoration:none;color:inherit"><h3 class="ellipsis">${l.name}</h3>
          <p class="small muted">${fmtNum(l.count)} contacts · created ${timeAgo(l.created_at)}${l.owner_name ? ` by ${l.owner_name}` : ''}</p></a>
        <div class="row wrap">
          <a class="btn sm secondary" href="#/contacts/${l.id}">${icon('eye')} Open</a>
          <button class="btn sm" data-bulk="${l.id}" ${l.count ? '' : 'disabled'}>${icon('send')} Email this list</button>
        </div>
      </div>`)}</div>`
    : html`<div class="card empty">${icon('contacts')}<h3>No contact lists yet</h3><p>Create a list from an Excel / CSV file of your customers, staff or partners.</p>
        <p style="margin-top:12px"><button class="btn" id="new-list-2">${icon('plus')} Create your first list</button></p></div>`}`);
  wireTabs(main);
  const create = async () => {
    const r = await importContacts({ askName: true, title: 'New contact list' });
    if (!r) return;
    if (!r.name) { toast('Give the list a name.', 'error'); return; }
    try {
      const first = await api('/lists', { method: 'POST', body: { name: r.name, contacts: r.contacts.slice(0, 2000) }, timeout: 120000 });
      const total = await uploadContacts(first.id, r.contacts, first);
      toast(r.contacts.length ? `List created: ${importSummary(total)}.` : 'List created.', 'ok');
      go(`#/contacts/${first.id}`);
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#new-list').onclick = create;
  $('#new-list-2')?.addEventListener('click', create);
  $$('[data-bulk]', main).forEach((b) => {
    b.onclick = () => { state.handoff = { mode: 'bulk', listIds: [Number(b.dataset.bulk)] }; go('#/bulk'); };
  });
}

function editContact(c = {}) {
  const extra = Object.entries(c.data || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  return modal((box, close) => {
    mount(box, html`<div class="modal-head"><h2>${c.id ? 'Edit contact' : 'Add contact'}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <form class="stack">
        <div class="form-grid"><label class="field">Email<input name="email" type="email" required value="${c.email || ''}" autofocus></label>
          <label class="field">Name<input name="name" value="${c.name || ''}"></label></div>
        <label class="field">Other details <span class="hint">One per line as <code>Field: value</code>, e.g. <code>Company: Acme</code>. Use them in emails as {{company}}.</span>
          <textarea name="data" rows="5">${extra}</textarea></label>
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
    box.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      const data = {};
      for (const line of f.data.value.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      close({ email: f.email.value.trim(), name: f.name.value.trim(), data });
    };
  });
}

export async function renderList(main, id) {
  const f = { q: '', page: 1 };
  const selected = new Set();
  let list;
  let lastRows = [];

  const load = async () => {
    const limit = 50;
    const d = await api(`/lists/${id}/contacts${qs({ q: f.q, page: f.page, limit })}`);
    list = d.list;
    lastRows = d.rows;
    const pages = Math.max(1, Math.ceil(d.total / limit));
    $('#l-title').textContent = list.name;
    $('#l-count').textContent = `${fmtNum(d.total)} ${f.q ? 'matching ' : ''}contacts`;
    const keys = [...new Set(d.rows.flatMap((r) => Object.keys(r.data || {})))].slice(0, 4);
    const box = $('#c-table');
    if (!d.rows.length) {
      mount(box, html`<div class="empty">${f.q ? 'No contacts match your search.' : 'This list is empty. Add people or import a file.'}</div>`);
      return drawSel();
    }
    mount(box, html`<div class="table-wrap"><table class="data">
      <thead><tr><th style="width:36px"><input type="checkbox" id="sel-all" aria-label="Select all"></th><th>Email</th><th>Name</th>${keys.map((k) => html`<th>${k}</th>`)}<th>Added</th><th></th></tr></thead>
      <tbody>${d.rows.map((r) => html`<tr><td><input type="checkbox" data-sel="${r.id}" ${selected.has(r.id) ? 'checked' : ''} aria-label="Select ${r.email}"></td>
        <td>${r.email}</td><td>${r.name}</td>${keys.map((k) => html`<td class="small">${r.data?.[k] ?? ''}</td>`)}
        <td class="small muted nowrap">${timeAgo(r.created_at)}</td>
        <td><button class="icon-btn" data-edit="${r.id}" title="Edit">${icon('edit')}</button></td></tr>`)}</tbody></table></div>
      <div class="pager"><span></span><div class="row"><button class="btn sm secondary" id="cp-prev" ${f.page <= 1 ? 'disabled' : ''}>${icon('left')}</button>
        <span>Page ${f.page} of ${pages}</span><button class="btn sm secondary" id="cp-next" ${f.page >= pages ? 'disabled' : ''}>${icon('right')}</button></div></div>`);
    $('#cp-prev').onclick = () => { f.page -= 1; load(); };
    $('#cp-next').onclick = () => { f.page += 1; load(); };
    $('#sel-all').onchange = (e) => { for (const r of d.rows) { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); } load(); };
    $$('[data-sel]', box).forEach((c) => { c.onchange = () => { if (c.checked) selected.add(Number(c.dataset.sel)); else selected.delete(Number(c.dataset.sel)); drawSel(); }; });
    $$('[data-edit]', box).forEach((b) => {
      b.onclick = async () => {
        const c = lastRows.find((x) => x.id === Number(b.dataset.edit));
        const r = await editContact(c);
        if (!r) return;
        await api(`/lists/${id}/contacts/${c.id}`, { method: 'PATCH', body: r }).then(() => { toast('Saved.', 'ok'); load(); }).catch((err) => toast(err.message, 'error'));
      };
    });
    return drawSel();
  };
  const drawSel = () => {
    $('#del-sel').classList.toggle('hidden', !selected.size);
    $('#del-sel').textContent = `Delete ${selected.size} selected`;
  };

  mount(main, html`
    <a class="crumb" href="#/contacts">${icon('left')} Contacts</a>
    <div class="page-head"><div><h1 id="l-title">…</h1><p id="l-count"></p></div>
      <div class="actions">
        <button class="btn" id="l-bulk">${icon('send')} Email this list</button>
        <button class="btn secondary" id="l-add">${icon('plus')} Add person</button>
        <button class="btn secondary" id="l-import">${icon('upload')} Import</button>
        <button class="btn secondary" id="l-export">${icon('download')} Export</button>
        <button class="icon-btn" id="l-rename" title="Rename list">${icon('edit')}</button>
        <button class="icon-btn" id="l-delete" title="Delete list">${icon('trash')}</button>
      </div></div>
    <div class="toolbar-row"><input type="search" id="c-q" placeholder="Search name, email or any field…"><button class="btn sm danger-outline hidden" id="del-sel"></button></div>
    <div id="c-table"><div class="loading-block"><span class="spinner"></span></div></div>`);

  $('#c-q').oninput = debounce(() => { f.q = $('#c-q').value.trim(); f.page = 1; load(); }, 300);
  $('#l-bulk').onclick = () => { state.handoff = { mode: 'bulk', listIds: [Number(id)] }; go('#/bulk'); };
  $('#l-export').onclick = () => download(`/api/lists/${id}/export`);
  $('#l-add').onclick = async () => {
    const r = await editContact();
    if (!r) return;
    await api(`/lists/${id}/contacts`, { method: 'POST', body: { contacts: [r] } })
      .then((x) => { toast(x.added ? 'Contact added.' : 'This email was already in the list; details updated.', 'ok'); load(); })
      .catch((err) => toast(err.message, 'error'));
  };
  $('#l-import').onclick = async () => {
    const r = await importContacts({ title: `Import into "${list.name}"` });
    if (!r?.contacts.length) return;
    try {
      const total = await uploadContacts(id, r.contacts);
      toast(`Import finished: ${importSummary(total)}.`, 'ok');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#l-rename').onclick = async () => {
    const name = await modal((box, close) => {
      mount(box, html`<div class="modal-head"><h2>Rename list</h2></div><form class="stack"><input name="n" value="${list.name}" required autofocus>
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
      box.querySelector('form').onsubmit = (e) => { e.preventDefault(); close(e.target.n.value.trim()); };
    });
    if (!name) return;
    await api(`/lists/${id}`, { method: 'PATCH', body: { name } }).then(load).catch((err) => toast(err.message, 'error'));
  };
  $('#l-delete').onclick = async () => {
    if (!await confirmBox('Delete this list?', `"${list.name}" and all its contacts will be deleted. Emails already sent are not affected.`, { ok: 'Delete list', danger: true })) return;
    await api(`/lists/${id}`, { method: 'DELETE' }).then(() => { toast('List deleted.'); go('#/contacts'); }).catch((err) => toast(err.message, 'error'));
  };
  $('#del-sel').onclick = async (e) => {
    if (!await confirmBox(`Delete ${selected.size} contacts?`, 'They will be removed from this list.', { ok: 'Delete', danger: true })) return;
    await busy(e.currentTarget, async () => {
      const r = await api(`/lists/${id}/contacts/delete`, { method: 'POST', body: { ids: [...selected] } });
      toast(`${fmtNum(r.deleted)} deleted.`);
      selected.clear();
      await load();
    });
  };
  await load();
}

export async function renderSuppressions(main) {
  const draw = async () => {
    const rows = await api('/suppressions');
    mount(main, html`
      <div class="page-head"><div><h1>Contacts</h1><p>People on this list never receive bulk emails, even if they are in a contact list or file.</p></div>
        <div class="actions"><button class="btn secondary" id="s-add">${icon('ban')} Block an address</button></div></div>
      ${tabsHtml('unsub')}
      <div class="toolbar-row"><input type="search" id="s-q" placeholder="Search…"></div>
      ${rows.length ? html`<div class="table-wrap"><table class="data"><thead><tr><th>Email</th><th>Reason</th><th>Date</th>${isAdmin() ? html`<th></th>` : ''}</tr></thead>
        <tbody>${rows.map((r) => html`<tr data-row="${r.email}"><td>${r.email}</td><td><span class="badge">${r.reason}</span></td><td class="small muted">${fmtDateTime(r.created_at)}</td>
          ${isAdmin() ? html`<td><button class="btn sm ghost" data-rm="${r.email}">Remove</button></td>` : ''}</tr>`)}</tbody></table></div>`
      : html`<div class="card empty">${icon('ban')}<p>Nobody has unsubscribed yet.</p></div>`}`);
    wireTabs(main);
    $('#s-q').oninput = () => {
      const q = $('#s-q').value.toLowerCase();
      $$('[data-row]', main).forEach((tr) => tr.classList.toggle('hidden', !tr.dataset.row.includes(q)));
    };
    $('#s-add').onclick = async () => {
      const email = await modal((box, close) => {
        mount(box, html`<div class="modal-head"><h2>Block an address</h2></div><form class="stack">
          <label class="field">Email<input name="e" type="email" required autofocus><span class="hint">This person will be skipped in all future bulk sends.</span></label>
          <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Block</button></div></form>`);
        box.querySelector('form').onsubmit = (e) => { e.preventDefault(); close(e.target.e.value.trim()); };
      });
      if (!email) return;
      await api('/suppressions', { method: 'POST', body: { email } }).then(() => { toast('Address blocked.', 'ok'); draw(); }).catch((err) => toast(err.message, 'error'));
    };
    $$('[data-rm]', main).forEach((b) => {
      b.onclick = async () => {
        if (!await confirmBox('Remove from unsubscribed?', `${b.dataset.rm} will receive bulk emails again. Only do this if they asked to be re-subscribed.`, { ok: 'Remove' })) return;
        await api(`/suppressions/${encodeURIComponent(b.dataset.rm)}`, { method: 'DELETE' }).then(draw).catch((err) => toast(err.message, 'error'));
      };
    });
  };
  await draw();
}
