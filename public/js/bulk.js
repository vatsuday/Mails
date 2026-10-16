// Bulk send wizard: 1. recipients  2. message  3. review & send.
import { go, setLeaveGuard } from './app.js';
import {
  $, $$, api, busy, confirmBox, debounce, dropzone, fmtNum, html, icon, mount, previewDoc, previewFrame, raw, readBase64, store, toast,
} from './common.js';
import { attachments, pickTemplate, saveAsTemplate } from './compose.js';
import { STARTERS } from './templates.js';
import { createEditor } from './editor.js';
import { buildVars, merge, normKey, variablesUsed } from './merge.js';
import { run } from './runner.js';
import { state } from './state.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const BIG_PAYLOAD = 2_000_000; // above this, recipients are uploaded in chunks as a contact list first

function guessColumn(columns, rows, re) {
  const byName = columns.find((c) => re.test(c));
  if (byName) return byName;
  if (re.source.includes('mail')) {
    // The column where most values look like email addresses.
    let best = ''; let bestN = 0;
    for (const c of columns) {
      const n = rows.slice(0, 50).filter((r) => /@/.test(r[c] || '')).length;
      if (n > bestN) { best = c; bestN = n; }
    }
    return best;
  }
  return '';
}

function parsePasted(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const angle = l.match(/^(.*?)<([^>]+)>/);
    if (angle) { out.push({ email: angle[2].trim().toLowerCase(), name: angle[1].replace(/["',]/g, '').trim(), data: {} }); continue; }
    const parts = l.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    const email = parts.find((p) => /@/.test(p)) || parts[0];
    const name = parts.filter((p) => p !== email).join(' ');
    if (parts.length > 1 || EMAIL_RE.test(email)) out.push({ email: email.toLowerCase(), name, data: {} });
    else for (const p of l.split(/\s+/)) out.push({ email: p.toLowerCase(), name: '', data: {} });
  }
  return out;
}

export async function render(main) {
  const handoff = state.handoff?.mode === 'bulk' ? state.handoff : null;
  state.handoff = null;
  const lists = await api('/lists');

  const s = {
    step: 1,
    tab: handoff?.listIds?.length ? 'lists' : handoff?.pasted ? 'paste' : 'file',
    file: null, // { name, columns, rows, emailCol, nameCol }
    pasted: handoff?.pasted || '',
    listIds: new Set(handoff?.listIds || []),
    listSamples: new Map(), // listId -> { keys, rows }
    saveList: false,
    listName: '',
    subject: handoff?.subject || '',
    html: handoff?.html || '',
    fromName: handoff?.fromName || '',
    replyTo: handoff?.replyTo ?? state.user.email,
    addUnsubscribe: handoff?.addUnsubscribe ?? true,
    trackOpens: handoff?.trackOpens ?? true,
    keepAttachments: handoff?.keepAttachments || [],
    fromMessageId: handoff?.fromMessageId || null,
    previewIndex: 0,
  };
  let editor = null;
  let att = null;
  const attachEl = document.createElement('div'); // kept across steps so picked files are not lost
  let sending = false;

  // ---- derived data ----
  const fileRecipients = () => {
    if (!s.file?.emailCol) return [];
    return s.file.rows.map((r) => ({
      email: String(r[s.file.emailCol] || '').trim().toLowerCase(),
      name: s.file.nameCol ? String(r[s.file.nameCol] || '').trim() : '',
      data: Object.fromEntries(Object.entries(r).filter(([k]) => k !== s.file.emailCol && k !== s.file.nameCol)),
    }));
  };
  const localRecipients = () => {
    const all = [...fileRecipients(), ...parsePasted(s.pasted)];
    const seen = new Set();
    const valid = [];
    let invalid = 0; let dupes = 0;
    for (const r of all) {
      if (!EMAIL_RE.test(r.email)) { invalid += 1; continue; }
      if (seen.has(r.email)) { dupes += 1; continue; }
      seen.add(r.email);
      valid.push(r);
    }
    return { valid, invalid, dupes };
  };
  const selectedLists = () => lists.filter((l) => s.listIds.has(l.id));
  const totalEstimate = () => localRecipients().valid.length + selectedLists().reduce((a, l) => a + Number(l.count), 0);
  const sampleRecipients = () => {
    const out = localRecipients().valid.slice(0, 200);
    for (const id of s.listIds) out.push(...(s.listSamples.get(id)?.rows || []));
    return out.length ? out : [{ email: state.user.email, name: state.user.name, data: {} }];
  };
  const fieldNames = () => {
    const keys = new Set(['name', 'first_name', 'email']);
    if (s.file) for (const c of s.file.columns) if (c !== s.file.emailCol && c !== s.file.nameCol) keys.add(normKey(c));
    for (const id of s.listIds) for (const k of s.listSamples.get(id)?.keys || []) keys.add(normKey(k));
    if (s.addUnsubscribe) keys.add('unsubscribe_url');
    return [...keys].filter(Boolean);
  };

  async function loadListSample(id) {
    if (s.listSamples.has(id)) return;
    const r = await api(`/lists/${id}/contacts?limit=20`);
    s.listSamples.set(id, { keys: [...new Set(r.rows.flatMap((x) => Object.keys(x.data || {})))], rows: r.rows });
  }
  for (const id of s.listIds) await loadListSample(id).catch(() => s.listIds.delete(id));

  setLeaveGuard(() => (!sending && (s.file || s.pasted.trim() || s.listIds.size || (editor && !editor.isEmpty()))
    ? 'Leave Bulk send? Your recipients and message will be lost.' : null));

  // ---- layout ----
  mount(main, html`
    <div class="page-head"><div><h1>Bulk send</h1><p>Send a personalised email to many people from an Excel / CSV file or a saved contact list.</p></div></div>
    ${!state.app.smtpConfigured ? html`<div class="alert warn" style="margin-bottom:14px">${icon('alert')} Email sending is not set up yet. An admin must enter the SMTP details first.</div>` : ''}
    <div class="steps" id="steps"></div>
    <div id="step-body"></div>`);

  function drawSteps() {
    const labels = ['Recipients', 'Message', 'Review & send'];
    mount($('#steps'), html`${labels.map((l, i) => html`<button type="button" data-step="${i + 1}" class="${s.step === i + 1 ? 'on' : ''} ${s.step > i + 1 ? 'done' : ''}">
      <span class="n">${s.step > i + 1 ? raw('&#10003;') : i + 1}</span>${l}</button>`)}`);
    $$('[data-step]', $('#steps')).forEach((b) => { b.onclick = () => goStep(Number(b.dataset.step)); });
  }

  function goStep(n) {
    if (n === s.step) return;
    if (n > 1 && !validateRecipients()) return;
    if (n > 2 && !validateMessage()) return;
    if (s.step === 2) captureMessage();
    s.step = n;
    drawSteps();
    if (n === 1) drawRecipients();
    if (n === 2) drawMessage();
    if (n === 3) drawReview();
    window.scrollTo(0, 0);
  }

  function validateRecipients() {
    if (s.file && !s.file.emailCol) { toast('Choose which column has the email addresses.', 'error'); return false; }
    if (!totalEstimate()) { toast('Add recipients first: upload a file, pick a saved list or paste addresses.', 'error'); return false; }
    return true;
  }
  function captureMessage() {
    if (!editor) return;
    s.subject = $('#b-subject').value;
    s.html = editor.getHTML();
    s.fromName = $('#b-from').value;
    s.replyTo = $('#b-reply').value;
    s.addUnsubscribe = $('#b-unsub').checked;
    s.trackOpens = $('#b-track').checked;
  }
  function validateMessage() {
    if (s.step === 2) captureMessage();
    if (!s.subject.trim()) { toast('Please add a subject.', 'error'); if (s.step !== 2) goStep(2); return false; }
    if (!s.html.replace(/<(?!img)[^>]*>/gi, '').replace(/&nbsp;/g, ' ').trim()) { toast('The message is empty.', 'error'); if (s.step !== 2) goStep(2); return false; }
    return true;
  }

  // ---- step 1: recipients ----
  const summaryHtml = (loc) => html`<div><b>${fmtNum(totalEstimate())}</b>recipients</div>
    ${loc.invalid ? html`<div style="color:var(--danger)"><b>${fmtNum(loc.invalid)}</b>invalid (skipped)</div>` : ''}
    ${loc.dupes ? html`<div class="muted"><b>${fmtNum(loc.dupes)}</b>duplicates (skipped)</div>` : ''}`;
  // Updates only the counts, so typing doesn't redraw the page (a redraw would swallow a click on Next).
  const drawSummary = () => { const el = $('#r-summary'); if (el) mount(el, summaryHtml(localRecipients())); };

  function drawRecipients() {
    const loc = localRecipients();
    const body = $('#step-body');
    mount(body, html`
      <div class="card">
        <div class="tabs">
          <button data-tab="file" class="${s.tab === 'file' ? 'on' : ''}">${icon('upload')} Upload Excel / CSV ${s.file ? raw('&#10003;') : ''}</button>
          <button data-tab="lists" class="${s.tab === 'lists' ? 'on' : ''}">${icon('contacts')} Saved lists ${s.listIds.size ? `(${s.listIds.size})` : ''}</button>
          <button data-tab="paste" class="${s.tab === 'paste' ? 'on' : ''}">${icon('edit')} Paste addresses ${s.pasted.trim() ? raw('&#10003;') : ''}</button>
        </div>
        <div id="tab-body"></div>
      </div>
      <div class="sticky-actions">
        <div class="summary-box" id="r-summary">${summaryHtml(loc)}</div>
        <button class="btn lg" id="next1">Next: write message ${icon('right')}</button>
      </div>`);
    $$('[data-tab]', body).forEach((b) => { b.onclick = () => { s.tab = b.dataset.tab; drawRecipients(); }; });
    $('#next1').onclick = () => goStep(2);
    const tb = $('#tab-body');
    if (s.tab === 'file') drawFileTab(tb);
    if (s.tab === 'lists') drawListsTab(tb);
    if (s.tab === 'paste') drawPasteTab(tb);
  }

  /** Excel template link; also adds columns for fields the message already uses (e.g. from a template). */
  function templateUrl() {
    const fields = variablesUsed(s.subject, s.html).filter((v) => !['email', 'name', 'first_name', 'unsubscribe_url'].includes(v));
    return `/api/contacts/template.xlsx${fields.length ? `?fields=${encodeURIComponent(fields.join(','))}` : ''}`;
  }

  function drawFileTab(tb) {
    if (!s.file) {
      mount(tb, html`
        <div class="dropzone" id="dz">${icon('upload', 'icon')}<p style="margin-top:8px"><b>Drop your Excel or CSV file here</b> or click to choose</p>
          <p class="small" style="margin-top:4px">First row = column titles, e.g. <b>Email</b>, <b>Name</b>, Company, City… Every column can be used in the message as {{column}}.</p></div>
        <div class="xl-help">
          <span class="xl-icon">${icon('file')}</span>
          <div class="grow"><b>Don't have a file yet?</b><div class="small muted">Download the Excel template, fill in one person per row, save it and upload it here.</div></div>
          <a class="btn secondary" id="xl-template" href="${templateUrl()}" download>${icon('download')} Download Excel template</a>
        </div>
        <p class="tiny muted" style="margin-top:10px">Supported: .xlsx, .csv (up to ${fmtNum(state.app.maxRecipients)} rows).</p>`);
      dropzone($('#dz'), async (files) => {
        const f = files[0];
        const dz = $('#dz');
        dz.innerHTML = '<span class="spinner"></span><p style="margin-top:8px">Reading file…</p>';
        try {
          if (f.size > 3 * 1024 * 1024) throw new Error('This file is larger than 3 MB. Save it as CSV or split it into smaller files.');
          const r = await api('/contacts/parse', { method: 'POST', body: { filename: f.name, data: await readBase64(f) } });
          if (!r.rows.length) throw new Error('The file has a header row but no data rows.');
          s.file = {
            name: f.name, columns: r.columns, rows: r.rows,
            emailCol: guessColumn(r.columns, r.rows, /e-?mail/i),
            nameCol: guessColumn(r.columns, r.rows, /^(full ?name|name|contact ?name|customer ?name)$/i) || guessColumn(r.columns, r.rows, /name/i),
          };
          s.listName = f.name.replace(/\.[^.]+$/, '');
          drawRecipients();
        } catch (err) {
          toast(err.message, 'error');
          drawRecipients();
        }
      }, { accept: '.xlsx,.xlsm,.csv,.txt,.tsv' });
      return;
    }
    const f = s.file;
    const loc = localRecipients();
    const cols = f.columns;
    mount(tb, html`
      <div class="stack">
        <div class="row between wrap">
          <div class="row">${icon('file')}<b>${f.name}</b><span class="badge">${fmtNum(f.rows.length)} rows</span></div>
          <button class="btn sm secondary" id="rm-file">${icon('x')} Use another file</button>
        </div>
        <div class="form-grid">
          <label class="field">Email address column<select id="email-col"><option value="">— choose —</option>${cols.map((c) => html`<option ${c === f.emailCol ? 'selected' : ''}>${c}</option>`)}</select></label>
          <label class="field">Name column <span class="hint">Optional. Used for {{name}} and {{first_name}}.</span><select id="name-col"><option value="">— none —</option>${cols.map((c) => html`<option ${c === f.nameCol ? 'selected' : ''}>${c}</option>`)}</select></label>
        </div>
        ${!f.emailCol ? html`<div class="alert warn">${icon('alert')} Choose the column that contains the email addresses.</div>` : ''}
        <div class="table-wrap" style="max-height:300px">
          <table class="data"><thead><tr><th>#</th>${cols.map((c) => html`<th>${c}${c === f.emailCol ? html` <span class="badge primary">email</span>` : ''}${c === f.nameCol ? html` <span class="badge primary">name</span>` : ''}</th>`)}</tr></thead>
          <tbody>${f.rows.slice(0, 8).map((r, i) => html`<tr><td class="muted">${i + 1}</td>${cols.map((c) => html`<td class="nowrap">${(r[c] || '').slice(0, 60)}</td>`)}</tr>`)}</tbody></table>
        </div>
        ${f.rows.length > 8 ? html`<p class="tiny muted">Showing the first 8 of ${fmtNum(f.rows.length)} rows.</p>` : ''}
        ${f.emailCol ? html`<p class="small">${icon('check')} <b>${fmtNum(loc.valid.length)}</b> valid addresses${loc.invalid ? html`, <span style="color:var(--danger)">${fmtNum(loc.invalid)} invalid or empty</span>` : ''}${loc.dupes ? `, ${fmtNum(loc.dupes)} duplicates` : ''}.</p>` : ''}
        <label class="check"><input type="checkbox" id="save-list" ${s.saveList ? 'checked' : ''}><span>Also save these people as a contact list
          <input id="list-name" value="${s.listName}" placeholder="List name" style="margin-top:6px;max-width:320px" ${s.saveList ? '' : 'disabled'}></span></label>
      </div>`);
    $('#rm-file').onclick = () => { s.file = null; drawRecipients(); };
    $('#email-col').onchange = (e) => { f.emailCol = e.target.value; drawRecipients(); };
    $('#name-col').onchange = (e) => { f.nameCol = e.target.value; drawRecipients(); };
    $('#save-list').onchange = (e) => { s.saveList = e.target.checked; $('#list-name').disabled = !s.saveList; };
    $('#list-name').oninput = (e) => { s.listName = e.target.value; };
  }

  function drawListsTab(tb) {
    if (!lists.length) {
      mount(tb, html`<div class="empty">${icon('contacts')}<p>No saved contact lists yet.</p><p><a href="#/contacts">Create one under Contacts</a> or upload a file here.</p></div>`);
      return;
    }
    mount(tb, html`<div class="list-pick">${lists.map((l) => html`
      <label><input type="checkbox" value="${l.id}" ${s.listIds.has(l.id) ? 'checked' : ''}>
        <span class="grow"><b class="ellipsis" style="display:block">${l.name}</b><span class="small muted">${fmtNum(l.count)} contacts</span></span></label>`)}</div>
      <p class="tiny muted" style="margin-top:10px">People who appear in more than one list get the email only once. Unsubscribed people are skipped automatically.</p>`);
    $$('input[type="checkbox"]', tb).forEach((c) => {
      c.onchange = async () => {
        const id = Number(c.value);
        if (c.checked) {
          s.listIds.add(id);
          await loadListSample(id).catch((err) => toast(err.message, 'error'));
        } else s.listIds.delete(id);
        drawRecipients();
      };
    });
  }

  function drawPasteTab(tb) {
    mount(tb, html`<label class="field">One person per line
      <textarea id="paste" rows="10" placeholder="ravi@example.com&#10;Priya Sharma &lt;priya@example.com&gt;&#10;amit@example.com, Amit Kumar">${s.pasted}</textarea>
      <span class="hint">You can paste a column straight from Excel. Formats: <code>email</code>, <code>Name &lt;email&gt;</code> or <code>email, Name</code>.</span></label>`);
    const ta = $('#paste');
    ta.focus();
    const update = debounce(drawSummary, 250);
    ta.oninput = () => { s.pasted = ta.value; update(); };
  }

  // ---- step 2: message ----
  function drawMessage() {
    const body = $('#step-body');
    const tplHidden = store.get('bulk:tplHidden', false);
    mount(body, html`
      <div class="card tpl-strip ${tplHidden ? 'hidden' : ''}" id="tpl-strip">
        <div class="card-title" style="margin-bottom:10px"><div><h2>Start from a template</h2>
          <p class="small muted">Pick a design, then change the text. Fields like {{first_name}} are filled in for each person.</p></div>
          <div class="row"><a class="btn sm ghost" href="#/templates">${icon('template')} Manage templates</a>
            <button class="icon-btn" id="tpl-hide" title="Hide templates">${icon('x')}</button></div></div>
        <div class="tpl-row" id="tpl-row"><div class="loading-block" style="padding:20px"><span class="spinner"></span></div></div>
      </div>
      <div class="compose">
        <div class="card stack">
          <label class="field">Subject<input id="b-subject" value="${s.subject}" maxlength="300" placeholder="e.g. Hello {{first_name}}, your invoice for October"></label>
          <div><div class="row between wrap" style="margin-bottom:8px"><span class="section-title">Message</span>
            <div class="row"><button class="btn sm secondary" id="b-tpl">${icon('template')} Templates</button><button class="btn sm ghost" id="b-save-tpl">Save as template</button></div></div>
            <div id="b-editor"></div></div>
          <div id="b-attach"></div>
        </div>
        <div class="stack">
          <div class="card stack">
            <div class="section-title">Personalise</div>
            <p class="small muted">Click a field to insert it where your cursor is. Each person sees their own value.</p>
            <div class="var-chips" id="vars"></div>
            <p class="tiny muted">Add a fallback for empty values: <code>{{first_name|there}}</code> → "Hi there".</p>
          </div>
          <div class="card stack">
            <div class="section-title">Sender</div>
            <label class="field">From name<input id="b-from" value="${s.fromName}" placeholder="${state.app.fromName || state.user.name}" maxlength="100">
              <span class="hint">Sent from <b>${state.app.fromEmail || '(not set)'}</b></span></label>
            <label class="field">Replies go to<input id="b-reply" type="email" value="${s.replyTo}"></label>
            <label class="check"><input type="checkbox" id="b-unsub" ${s.addUnsubscribe ? 'checked' : ''}><span>Add an unsubscribe link<br><span class="hint">Recommended for newsletters and offers. Keeps you out of spam folders.</span></span></label>
            <label class="check"><input type="checkbox" id="b-track" ${s.trackOpens ? 'checked' : ''}><span>Track opens<br><span class="hint">See who opened the email in <b>Sent &amp; reports</b>.</span></span></label>
          </div>
        </div>
      </div>
      <div class="sticky-actions">
        <button class="btn secondary" id="back2">${icon('left')} Recipients</button>
        <button class="btn lg" id="next2">Next: review ${icon('right')}</button>
      </div>`);
    editor = createEditor($('#b-editor'), { value: s.html, placeholder: 'Hi {{first_name}}, write your message…', tall: true });
    if (!att) att = attachments(attachEl, { kept: s.keepAttachments });
    $('#b-attach').append(attachEl);
    const subj = $('#b-subject');
    let lastFocus = 'body';
    subj.addEventListener('focus', () => { lastFocus = 'subject'; });
    editor.root.addEventListener('focusin', () => { lastFocus = 'body'; });
    const drawVars = () => mount($('#vars'), html`${fieldNames().map((k) => html`<button type="button" data-v="${k}">{{${k}}}</button>`)}`);
    drawVars();
    $('#b-unsub').onchange = () => { s.addUnsubscribe = $('#b-unsub').checked; drawVars(); };
    $('#vars').addEventListener('mousedown', (e) => { if (e.target.closest('[data-v]')) e.preventDefault(); });
    $('#vars').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const tag = `{{${b.dataset.v}}}`;
      if (lastFocus === 'subject') {
        subj.setRangeText(tag, subj.selectionStart, subj.selectionEnd, 'end');
        subj.focus();
      } else if (b.dataset.v === 'unsubscribe_url') {
        editor.insertHTML('<a href="{{unsubscribe_url}}">Unsubscribe</a>');
      } else editor.insertText(tag);
    });
    const applyTemplate = async (t, key) => {
      const current = editor.getHTML();
      if (!editor.isEmpty() && current !== t.html
        && !await confirmBox(t.blank ? 'Clear the message?' : 'Replace the message?', t.blank ? 'What you have written will be removed.' : 'The template will replace what you have written.', { ok: t.blank ? 'Clear' : 'Use template' })) return;
      if (t.subject || t.blank) subj.value = t.subject || '';
      editor.setHTML(t.html);
      s.templateKey = key;
      $$('[data-tk]', body).forEach((c) => c.classList.toggle('on', c.dataset.tk === key));
      if (!t.blank) toast(`Template "${t.name}" added. Change the text as you like.`, 'ok');
      editor.focus();
    };
    const drawTemplates = async () => {
      const row = $('#tpl-row');
      if (!row) return;
      try { s.templates ||= await api('/templates'); } catch { s.templates = []; }
      const items = [
        ['blank', { name: 'Blank', subject: '', html: '', blank: true }],
        ...s.templates.map((t) => [`t${t.id}`, t]),
        ...STARTERS.map((t, i) => [`s${i}`, { ...t, starter: true }]),
      ];
      mount(row, html`${items.map(([k, t]) => html`<button type="button" class="tpl-card ${s.templateKey === k ? 'on' : ''}" data-tk="${k}" title="${t.subject || t.name}">
        <span class="tpl-thumb">${t.blank ? html`<span class="tpl-blank">${icon('plus')}</span>` : ''}</span>
        <span class="tpl-meta"><b class="ellipsis">${t.name}</b><span class="tiny muted ellipsis">${t.blank ? 'Write your own' : t.starter ? 'Ready-made' : t.subject || 'Saved template'}</span></span>
      </button>`)}`);
      for (const [k, t] of items) {
        const card = row.querySelector(`[data-tk="${k}"]`);
        if (!t.blank) card.querySelector('.tpl-thumb').append(previewFrame(t.html, 'tpl-frame'));
        card.onclick = () => applyTemplate(t, k);
      }
    };
    drawTemplates();
    $('#tpl-hide').onclick = () => { $('#tpl-strip').classList.add('hidden'); store.set('bulk:tplHidden', true); };
    $('#b-tpl').onclick = async () => {
      if ($('#tpl-strip').classList.contains('hidden')) {
        $('#tpl-strip').classList.remove('hidden');
        store.set('bulk:tplHidden', false);
        $('#tpl-strip').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      const t = await pickTemplate();
      if (t) applyTemplate(t, `t${t.id}`);
    };
    $('#b-save-tpl').onclick = (e) => busy(e.currentTarget, async () => {
      await saveAsTemplate(subj.value, editor.getHTML());
      s.templates = null; // reload the strip so the new template shows up
      drawTemplates();
    });
    $('#back2').onclick = () => goStep(1);
    $('#next2').onclick = () => goStep(3);
    if (!s.subject) subj.focus();
  }

  // ---- step 3: review & send ----
  function drawReview() {
    const loc = localRecipients();
    const samples = sampleRecipients();
    const used = variablesUsed(s.subject, s.html).filter((v) => v !== 'unsubscribe_url');
    const known = new Set(fieldNames());
    const unknown = used.filter((v) => !known.has(v));
    const missing = used.filter((v) => known.has(v)).map((v) => {
      const n = loc.valid.filter((r) => !buildVars(r)[v]).length;
      return { v, n };
    }).filter((x) => x.n > 0);
    const hasFallback = (v) => new RegExp(`\\{\\{\\s*${v}\\s*\\|`, 'i').test(s.subject + s.html);
    s.previewIndex = Math.min(s.previewIndex, samples.length - 1);

    const body = $('#step-body');
    mount(body, html`
      <div class="compose">
        <div class="card stack">
          <div class="row between wrap">
            <div class="section-title">Preview as each person will see it</div>
            <div class="row"><button class="icon-btn" id="pv-prev" aria-label="Previous recipient">${icon('left')}</button>
              <span class="small mono" id="pv-n"></span>
              <button class="icon-btn" id="pv-next" aria-label="Next recipient">${icon('right')}</button></div>
          </div>
          <div><div class="mail-head" id="pv-head"></div><iframe class="preview-frame" id="pv-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Email preview"></iframe></div>
        </div>
        <div class="stack">
          <div class="card stack">
            <div class="section-title">Summary</div>
            <dl class="kv">
              <dt>Recipients</dt><dd>${fmtNum(totalEstimate())}${s.listIds.size ? html` <span class="tiny muted">(before removing duplicates)</span>` : ''}</dd>
              ${s.file ? html`<dt>File</dt><dd>${s.file.name}</dd>` : ''}
              ${s.listIds.size ? html`<dt>Lists</dt><dd>${selectedLists().map((l) => l.name).join(', ')}</dd>` : ''}
              <dt>From</dt><dd>${s.fromName || state.app.fromName || state.user.name}<br><span class="small muted">${state.app.fromEmail}</span></dd>
              <dt>Replies to</dt><dd>${s.replyTo || '—'}</dd>
              <dt>Attachments</dt><dd>${att?.count() || 0}</dd>
              <dt>Unsubscribe link</dt><dd>${s.addUnsubscribe ? 'Yes' : 'No'}</dd>
              <dt>Track opens</dt><dd>${s.trackOpens ? 'Yes' : 'No'}</dd>
            </dl>
          </div>
          ${unknown.length ? html`<div class="alert error">${icon('alert')}<div>These fields don't exist in your recipients and will be empty: <b>${unknown.map((v) => `{{${v}}}`).join(', ')}</b></div></div>` : ''}
          ${missing.filter((m) => !hasFallback(m.v)).map((m) => html`<div class="alert warn">${icon('alert')}<div><b>{{${m.v}}}</b> is empty for ${fmtNum(m.n)} people. Add a fallback like <code>{{${m.v}|there}}</code>.</div></div>`)}
          ${!s.addUnsubscribe && totalEstimate() > 50 ? html`<div class="alert info">${icon('shield')}<div>Tip: an unsubscribe link helps bulk emails avoid the spam folder.</div></div>` : ''}
          <div class="card stack">
            <div class="section-title">Test first</div>
            <p class="small muted">Sends this preview to <b>${state.user.email}</b> so you can check how it looks in your inbox.</p>
            <button class="btn secondary" id="test-btn" data-busy="Sending test…">${icon('mail')} Send me a test</button>
          </div>
        </div>
      </div>
      <div class="sticky-actions">
        <button class="btn secondary" id="back3">${icon('left')} Edit message</button>
        <button class="btn lg success" id="send-all" data-busy="Starting…">${icon('send')} Send to ${fmtNum(totalEstimate())} people</button>
      </div>`);

    const drawPreview = () => {
      const r = samples[s.previewIndex];
      const vars = buildVars(r);
      if (s.addUnsubscribe) vars.unsubscribe_url = '#unsubscribe-link';
      let bodyHtml = merge(s.html, vars, { html: true });
      if (s.addUnsubscribe && !/unsubscribe_url/i.test(s.html)) {
        bodyHtml += '<p style="margin-top:28px;font-size:12px;color:#6b7280">Don\'t want to receive these emails? <a href="#unsubscribe-link" style="color:#6b7280">Unsubscribe</a></p>';
      }
      mount($('#pv-head'), html`<b>${merge(s.subject, vars)}</b><div class="muted">To: ${r.name ? `${r.name} <${r.email}>` : r.email}</div>`);
      $('#pv-frame').srcdoc = previewDoc(bodyHtml);
      $('#pv-n').textContent = `${s.previewIndex + 1} / ${samples.length}`;
    };
    drawPreview();
    $('#pv-prev').onclick = () => { s.previewIndex = (s.previewIndex - 1 + samples.length) % samples.length; drawPreview(); };
    $('#pv-next').onclick = () => { s.previewIndex = (s.previewIndex + 1) % samples.length; drawPreview(); };
    $('#back3').onclick = () => goStep(2);

    $('#test-btn').onclick = (e) => busy(e.currentTarget, async () => {
      const r = await api('/messages/test', {
        method: 'POST',
        timeout: 120000,
        body: {
          subject: s.subject, html: s.html, fromName: s.fromName, addUnsubscribe: s.addUnsubscribe,
          sample: samples[s.previewIndex], attachments: att?.payload() || [], keepAttachments: att?.keepIds() || [], fromMessageId: s.fromMessageId,
        },
      });
      toast(`Test email sent to ${r.to}. Check your inbox.`, 'ok');
    });

    $('#send-all').onclick = async (e) => {
      const n = totalEstimate();
      if (!await confirmBox(`Send to ${fmtNum(n)} people?`, 'Sending starts right away and runs in this browser tab. You can keep using the app, but leave this tab open until it finishes. You can pause at any time.', { ok: 'Start sending' })) return;
      await busy(e.currentTarget, startSending);
    };
  }

  async function startSending() {
    const loc = localRecipients();
    let recipients = loc.valid;
    const listIds = [...s.listIds];
    const big = JSON.stringify(recipients).length > BIG_PAYLOAD;
    if (recipients.length && (s.saveList || big)) {
      const name = (s.listName || s.file?.name || 'Bulk upload').trim() + (s.saveList ? '' : ` (bulk ${new Date().toLocaleDateString('en-IN')})`);
      const first = await api('/lists', { method: 'POST', body: { name, contacts: recipients.slice(0, 2000) }, timeout: 120000 });
      for (let i = 2000; i < recipients.length; i += 2000) {
        await api(`/lists/${first.id}/contacts`, { method: 'POST', body: { contacts: recipients.slice(i, i + 2000) }, timeout: 120000 });
      }
      listIds.push(first.id);
      recipients = [];
      if (big && !s.saveList) toast(`The recipients were saved as the contact list "${name}" because the file is large.`);
    }
    const r = await api('/messages/bulk', {
      method: 'POST',
      timeout: 120000,
      body: {
        subject: s.subject, html: s.html, fromName: s.fromName, replyTo: s.replyTo, addUnsubscribe: s.addUnsubscribe, trackOpens: s.trackOpens,
        source: [s.file?.name, ...selectedLists().map((l) => l.name), s.pasted.trim() ? 'pasted addresses' : ''].filter(Boolean).join(', ').slice(0, 200),
        recipients, listIds,
        attachments: att?.payload() || [], keepAttachments: att?.keepIds() || [], fromMessageId: s.fromMessageId,
      },
    });
    sending = true;
    const notes = [];
    if (r.suppressed) notes.push(`${fmtNum(r.suppressed)} unsubscribed skipped`);
    if (r.invalid) notes.push(`${fmtNum(r.invalid)} invalid skipped`);
    toast(`Sending to ${fmtNum(r.total - r.suppressed)} people${notes.length ? ` (${notes.join(', ')})` : ''}.`, 'ok');
    run(r.id, s.subject);
    go(`#/history/${r.id}`);
  }

  drawSteps();
  drawRecipients();
  return () => { if (s.step === 2) captureMessage(); };
}
