// Contact lists, contacts and unsubscribed addresses.
import { go } from './app.js';
import {
  $, $$, api, avatar, confirmBox, debounce, download, dropzone, fmtDateTime, fmtNum, html, icon, modal, mount, popMenu, qs, readBase64, store,
  timeAgo, toast,
} from './common.js';
import { isAdmin, state } from './state.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

const tabsHtml = (on) => html`<div class="tabs">
  <button data-href="#/contacts" class="${on === 'all' ? 'on' : ''}">${icon('users')} All contacts</button>
  <button data-href="#/contacts/lists" class="${on === 'lists' ? 'on' : ''}">${icon('contacts')} Lists</button>
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

/** Add / edit a person. When adding, `lists` lets the user choose (or create) the list they go into. */
function editContact(c = {}, { lists = null, listId = null } = {}) {
  const editing = Boolean(c.email);
  const extra = Object.entries(c.data || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  return modal((box, close) => {
    mount(box, html`<div class="modal-head"><div class="row" style="gap:12px">${editing ? avatar(c.name || c.email, c.email, 'lg') : ''}
        <h2>${editing ? 'Edit contact' : 'Add contact'}</h2></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <form class="stack">
        <div class="form-grid"><label class="field">Email<input name="email" type="email" required value="${c.email || ''}" ${editing ? 'readonly' : 'autofocus'}>
          ${editing ? html`<span class="hint">To change the address, delete this contact and add the new one.</span>` : ''}</label>
          <label class="field">Name<input name="name" value="${c.name || ''}" ${editing ? 'autofocus' : ''}></label></div>
        ${lists ? html`<label class="field">Add to list<select name="list">
            ${lists.map((l) => html`<option value="${l.id}" ${Number(listId) === l.id ? 'selected' : ''}>${l.name}</option>`)}
            <option value="new" ${lists.length ? '' : 'selected'}>+ New list…</option></select></label>
          <label class="field ${lists.length ? 'hidden' : ''}" id="new-list-field">New list name<input name="newList" placeholder="e.g. Customers"></label>` : ''}
        <label class="field">Other details <span class="hint">One per line as <code>Field: value</code>, e.g. <code>Company: Acme</code>. Use them in emails as {{company}}.</span>
          <textarea name="data" rows="5">${extra}</textarea></label>
        ${editing && c.lists?.length ? html`<p class="small muted">In ${c.lists.length === 1 ? 'list' : 'lists'}: ${c.lists.map((l) => l.name).join(', ')}. Changes apply to all of them.</p>` : ''}
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
    const form = box.querySelector('form');
    if (form.list) form.list.onchange = () => $('#new-list-field', box).classList.toggle('hidden', form.list.value !== 'new');
    form.onsubmit = (e) => {
      e.preventDefault();
      const data = {};
      for (const line of form.data.value.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      if (form.list?.value === 'new' && !form.newList.value.trim()) { toast('Give the new list a name.', 'error'); form.newList.focus(); return; }
      close({ email: form.email.value.trim(), name: form.name.value.trim(), data, list: form.list?.value, newList: form.newList?.value.trim() });
    };
  });
}

const COMPANY_RE = /^(company|organi[sz]ation|firm|business|company name)$/i;
const companyOf = (r) => {
  const k = Object.keys(r.data || {}).find((x) => COMPANY_RE.test(x));
  return k ? r.data[k] : '';
};
const PAGE_SIZES = [25, 50, 100, 200];

/**
 * The contacts table (everyone, or the people in one list): selection, sorting, row menu, rows per page.
 */
async function contactsTable(main, { listId = null } = {}) {
  const f = { q: '', sort: 'name', dir: 'asc', page: 1, limit: PAGE_SIZES.includes(store.get('contacts:limit')) ? store.get('contacts:limit') : 50 };
  const selected = new Map(); // email -> row
  let rows = [];
  let total = 0;
  let lists = await api('/lists');
  const list = listId ? lists.find((l) => l.id === Number(listId)) : null;
  if (listId && !list) throw Object.assign(new Error('This contact list no longer exists.'), { status: 404 });

  const sortHead = (key, label) => html`<th><button type="button" class="th-sort ${f.sort === key ? 'on' : ''}" data-sort="${key}">${label}
    ${icon(f.sort === key ? (f.dir === 'asc' ? 'up' : 'down') : 'sort', 'icon sort-icon')}</button></th>`;

  mount(main, html`
    ${list ? html`<a class="crumb" href="#/contacts/lists">${icon('left')} Lists</a>` : ''}
    <div class="page-head"><div><h1>${list ? list.name : 'Contacts'}</h1><p id="c-count">${list ? 'Contact list' : 'Everyone in your contact lists'}</p></div>
      <div class="actions">
        ${list ? html`<button class="btn secondary" id="l-bulk">${icon('send')} Email this list</button>
          <button class="btn secondary" id="l-import">${icon('upload')} Import</button>
          <button class="icon-btn" id="l-more" title="More list actions">${icon('dots')}</button>`
    : html`<button class="btn secondary" id="c-import">${icon('upload')} Import</button>`}
        <button class="btn dark" id="c-add">${icon('plus')} Add contact</button>
      </div></div>
    ${list ? '' : tabsHtml('all')}
    <div class="table-card">
      <div class="table-top">
        <div class="sel-bar hidden" id="sel-bar"><b id="sel-n"></b>
          <button class="btn sm" id="sel-email">${icon('send')} Email</button>
          <button class="btn sm secondary" id="sel-list">${icon('tag')} Add to list</button>
          <button class="btn sm danger-outline" id="sel-del">${icon('trash')} ${list ? 'Remove from list' : 'Delete'}</button>
          <button class="btn sm ghost" id="sel-clear">Clear</button></div>
        <label class="search-box">${icon('search', 'icon search-icon')}<input type="search" id="c-q" placeholder="Search by name, email or any field…" aria-label="Search contacts"></label>
      </div>
      <div id="c-table"><div class="loading-block"><span class="spinner"></span></div></div>
      <div class="table-foot" id="c-foot"></div>
    </div>`);
  wireTabs(main);

  const load = async () => {
    const d = await api(`/contacts${qs({ q: f.q, sort: f.sort, dir: f.dir, page: f.page, limit: f.limit, list: listId || '' })}`);
    rows = d.rows;
    total = Number(d.total);
    const pages = Math.max(1, Math.ceil(total / f.limit));
    if (f.page > pages) { f.page = pages; return load(); }
    $('#c-count').textContent = `${fmtNum(total)} ${f.q ? 'matching ' : ''}${total === 1 ? 'person' : 'people'}${list ? ' in this list' : ''}`;
    const showCompany = rows.some((r) => companyOf(r));
    const box = $('#c-table');
    if (!rows.length) {
      mount(box, html`<div class="empty">${icon('users')}<p>${f.q ? 'Nobody matches your search.' : list ? 'This list is empty. Add people or import a file.' : 'No contacts yet. Add someone or import an Excel / CSV file.'}</p></div>`);
    } else {
      const allOn = rows.every((r) => selected.has(r.email));
      mount(box, html`<div class="table-scroll"><table class="data contacts">
        <thead><tr><th class="cb"><input type="checkbox" id="sel-all" ${allOn ? 'checked' : ''} aria-label="Select all on this page"></th>
          ${sortHead('name', 'Name')}${sortHead('email', 'Email')}${showCompany ? sortHead('company', 'Company') : ''}
          <th>Lists</th><th>Status</th>${sortHead('last_sent', 'Last emailed')}<th class="cb"></th></tr></thead>
        <tbody>${rows.map((r, i) => html`<tr class="${selected.has(r.email) ? 'selected' : ''}" data-i="${i}">
          <td class="cb"><input type="checkbox" data-sel="${i}" ${selected.has(r.email) ? 'checked' : ''} aria-label="Select ${r.email}"></td>
          <td><button type="button" class="person" data-open="${i}">${avatar(r.name || r.email, r.email)}<span class="ellipsis"><b>${r.name || r.email.split('@')[0]}</b></span></button></td>
          <td class="small"><span class="ellipsis" style="display:block;max-width:260px">${r.email}</span></td>
          ${showCompany ? html`<td class="small">${companyOf(r)}</td>` : ''}
          <td><div class="tag-list">${r.lists.slice(0, 3).map((l) => html`<a class="tag" href="#/contacts/${l.id}">${l.name}</a>`)}${r.lists.length > 3 ? html`<span class="tag more">+${r.lists.length - 3}</span>` : ''}</div></td>
          <td class="nowrap">${r.unsubscribed ? html`<span class="dot-status off">Unsubscribed</span>` : r.last_opened ? html`<span class="dot-status ok" title="Last opened ${fmtDateTime(r.last_opened)}">Engaged</span>` : html`<span class="dot-status">Subscribed</span>`}</td>
          <td class="small muted nowrap">${r.last_sent ? html`<span title="${fmtDateTime(r.last_sent)}">${timeAgo(r.last_sent)}</span>` : 'Never'}</td>
          <td class="cb"><button class="icon-btn" data-menu="${i}" aria-label="Actions for ${r.email}">${icon('dots')}</button></td>
        </tr>`)}</tbody></table></div>`);
    }
    mount($('#c-foot'), html`
      <label class="row small" style="gap:8px"><select id="c-limit" aria-label="Rows per page">${PAGE_SIZES.map((n) => html`<option ${n === f.limit ? 'selected' : ''}>${n}</option>`)}</select> rows per page</label>
      <div class="row small" style="gap:6px"><span style="margin-right:6px">Page <b>${f.page}</b> of <b>${pages}</b></span>
        <button class="icon-btn page-btn" data-page="1" ${f.page <= 1 ? 'disabled' : ''} title="First page">${icon('first')}</button>
        <button class="icon-btn page-btn" data-page="${f.page - 1}" ${f.page <= 1 ? 'disabled' : ''} title="Previous page">${icon('left')}</button>
        <button class="icon-btn page-btn" data-page="${f.page + 1}" ${f.page >= pages ? 'disabled' : ''} title="Next page">${icon('right')}</button>
        <button class="icon-btn page-btn" data-page="${pages}" ${f.page >= pages ? 'disabled' : ''} title="Last page">${icon('last')}</button></div>`);
    $('#c-limit').onchange = (e) => { f.limit = Number(e.target.value); f.page = 1; store.set('contacts:limit', f.limit); load(); };
    $$('[data-page]', main).forEach((b) => { b.onclick = () => { f.page = Number(b.dataset.page); load(); }; });
    $$('[data-sort]', box).forEach((b) => {
      b.onclick = () => {
        if (f.sort === b.dataset.sort) f.dir = f.dir === 'asc' ? 'desc' : 'asc';
        else { f.sort = b.dataset.sort; f.dir = b.dataset.sort === 'last_sent' ? 'desc' : 'asc'; }
        f.page = 1;
        load();
      };
    });
    $('#sel-all')?.addEventListener('change', (e) => {
      for (const r of rows) { if (e.target.checked) selected.set(r.email, r); else selected.delete(r.email); }
      load();
    });
    $$('[data-sel]', box).forEach((c) => {
      c.onchange = () => {
        const r = rows[Number(c.dataset.sel)];
        if (c.checked) selected.set(r.email, r); else selected.delete(r.email);
        c.closest('tr').classList.toggle('selected', c.checked);
        $('#sel-all').checked = rows.every((x) => selected.has(x.email));
        drawSel();
      };
    });
    $$('[data-open]', box).forEach((b) => { b.onclick = () => edit(rows[Number(b.dataset.open)]); });
    $$('[data-menu]', box).forEach((b) => { b.onclick = () => rowMenu(b, rows[Number(b.dataset.menu)]); });
    drawSel();
    return undefined;
  };

  const drawSel = () => {
    $('#sel-bar').classList.toggle('hidden', !selected.size);
    $('#sel-n').textContent = `${fmtNum(selected.size)} selected`;
  };

  const emailPeople = (people) => {
    if (people.length === 1) {
      state.handoff = { mode: 'compose', to: [people[0].email], names: people[0].name ? { [people[0].email]: people[0].name } : {} };
      go('#/compose');
    } else {
      state.handoff = { mode: 'bulk', pasted: people.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join('\n') };
      go('#/bulk');
    }
  };

  const edit = async (r) => {
    const v = await editContact(r);
    if (!v) return;
    await api('/contacts/update', { method: 'POST', body: { email: r.email, name: v.name, data: v.data } })
      .then(() => { toast('Saved.', 'ok'); load(); }).catch((err) => toast(err.message, 'error'));
  };

  const remove = async (people) => {
    const n = people.length;
    const what = n === 1 ? people[0].name || people[0].email : `${fmtNum(n)} people`;
    if (!await confirmBox(list ? `Remove ${what} from this list?` : `Delete ${what}?`,
      list ? `They stay in your other lists.` : `${n === 1 ? 'This person is' : 'They are'} removed from every contact list. Emails already sent are not affected.`,
      { ok: list ? 'Remove' : 'Delete', danger: true })) return;
    await api('/contacts/delete', { method: 'POST', body: { emails: people.map((p) => p.email), listId: listId || null } })
      .then(() => { for (const p of people) selected.delete(p.email); toast(`${what} ${list ? 'removed' : 'deleted'}.`); load(); })
      .catch((err) => toast(err.message, 'error'));
  };

  const addToList = async (people) => {
    const v = await modal((box, close) => {
      mount(box, html`<div class="modal-head"><h2>Add ${fmtNum(people.length)} ${people.length === 1 ? 'person' : 'people'} to a list</h2></div>
        <form class="stack"><label class="field">List<select name="list">${lists.map((l) => html`<option value="${l.id}">${l.name}</option>`)}<option value="new" ${lists.length ? '' : 'selected'}>+ New list…</option></select></label>
          <label class="field ${lists.length ? 'hidden' : ''}" id="nl">New list name<input name="name"></label>
          <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Add</button></div></form>`);
      const form = box.querySelector('form');
      form.list.onchange = () => $('#nl', box).classList.toggle('hidden', form.list.value !== 'new');
      form.onsubmit = (e) => { e.preventDefault(); close({ list: form.list.value, name: form.name.value.trim() }); };
    });
    if (!v) return;
    const contacts = people.map((p) => ({ email: p.email, name: p.name, data: p.data }));
    try {
      if (v.list === 'new') {
        if (!v.name) { toast('Give the new list a name.', 'error'); return; }
        await api('/lists', { method: 'POST', body: { name: v.name, contacts } });
      } else {
        await api(`/lists/${v.list}/contacts`, { method: 'POST', body: { contacts } });
      }
      lists = await api('/lists');
      toast('Added to the list.', 'ok');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };

  const setSubscribed = async (r, on) => {
    try {
      if (on) await api(`/suppressions/${encodeURIComponent(r.email)}`, { method: 'DELETE' });
      else await api('/suppressions', { method: 'POST', body: { email: r.email } });
      toast(on ? `${r.email} will receive bulk emails again.` : `${r.email} won't receive bulk emails any more.`, 'ok');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };

  const rowMenu = (btn, r) => popMenu(btn, [
    { label: 'Send email', icon: 'send', onClick: () => emailPeople([r]) },
    { label: 'Edit details', icon: 'edit', onClick: () => edit(r) },
    { label: 'Copy email address', icon: 'copy', onClick: () => navigator.clipboard?.writeText(r.email).then(() => toast('Copied.')) },
    { label: 'Add to list…', icon: 'tag', onClick: () => addToList([r]) },
    '-',
    r.unsubscribed
      ? (isAdmin() ? { label: 'Subscribe again', icon: 'check', onClick: () => setSubscribed(r, true) } : null)
      : { label: 'Unsubscribe from bulk emails', icon: 'ban', onClick: () => setSubscribed(r, false) },
    { label: list ? 'Remove from this list' : 'Delete contact', icon: 'trash', danger: true, onClick: () => remove([r]) },
  ].filter(Boolean));

  $('#c-q').oninput = debounce(() => { f.q = $('#c-q').value.trim(); f.page = 1; load(); }, 300);
  $('#sel-clear').onclick = () => { selected.clear(); load(); };
  $('#sel-email').onclick = () => emailPeople([...selected.values()]);
  $('#sel-del').onclick = () => remove([...selected.values()]);
  $('#sel-list').onclick = () => addToList([...selected.values()]);

  $('#c-add').onclick = async () => {
    const v = await editContact({}, { lists, listId });
    if (!v) return;
    const contact = { email: v.email, name: v.name, data: v.data };
    try {
      if (v.list === 'new') {
        const r = await api('/lists', { method: 'POST', body: { name: v.newList, contacts: [contact] } });
        if (!r.added) throw new Error('Enter a valid email address.');
      } else {
        const r = await api(`/lists/${v.list}/contacts`, { method: 'POST', body: { contacts: [contact] } });
        if (!r.added) toast('This person was already in that list; details updated.');
      }
      lists = await api('/lists');
      toast('Contact saved.', 'ok');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };

  const importInto = async (id, name) => {
    const r = await importContacts({ title: `Import into "${name}"` });
    if (!r?.contacts.length) return;
    try {
      const t = await uploadContacts(id, r.contacts);
      toast(`Import finished: ${importSummary(t)}.`, 'ok');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#c-import')?.addEventListener('click', async () => {
    const r = await importContacts({ askName: true, title: 'Import contacts into a new list' });
    if (!r) return;
    if (!r.name) { toast('Give the list a name.', 'error'); return; }
    try {
      const first = await api('/lists', { method: 'POST', body: { name: r.name, contacts: r.contacts.slice(0, 2000) }, timeout: 120000 });
      const t = await uploadContacts(first.id, r.contacts, first);
      lists = await api('/lists');
      toast(`List "${r.name}" created: ${importSummary(t)}.`, 'ok');
      load();
    } catch (err) { toast(err.message, 'error'); }
  });

  if (list) {
    $('#l-bulk').onclick = () => { state.handoff = { mode: 'bulk', listIds: [list.id] }; go('#/bulk'); };
    $('#l-import').onclick = () => importInto(list.id, list.name);
    $('#l-more').onclick = (e) => popMenu(e.currentTarget, [
      { label: 'Export to CSV', icon: 'download', onClick: () => download(`/api/lists/${list.id}/export`) },
      { label: 'Rename list', icon: 'edit', onClick: renameList },
      '-',
      { label: 'Delete list', icon: 'trash', danger: true, onClick: deleteList },
    ]);
  }
  async function renameList() {
    const name = await modal((box, close) => {
      mount(box, html`<div class="modal-head"><h2>Rename list</h2></div><form class="stack"><input name="n" value="${list.name}" required autofocus>
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
      box.querySelector('form').onsubmit = (e) => { e.preventDefault(); close(e.target.n.value.trim()); };
    });
    if (!name) return;
    await api(`/lists/${list.id}`, { method: 'PATCH', body: { name } }).then(() => go(`#/contacts/${list.id}`)).catch((err) => toast(err.message, 'error'));
  }
  async function deleteList() {
    if (!await confirmBox('Delete this list?', `"${list.name}" will be deleted. People who are also in other lists stay there. Emails already sent are not affected.`, { ok: 'Delete list', danger: true })) return;
    await api(`/lists/${list.id}`, { method: 'DELETE' }).then(() => { toast('List deleted.'); go('#/contacts/lists'); }).catch((err) => toast(err.message, 'error'));
  }

  await load();
}

export const renderAll = (main) => contactsTable(main);
export const renderList = (main, id) => contactsTable(main, { listId: id });

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
