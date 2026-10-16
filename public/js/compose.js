// Compose a single email (To / Cc / Bcc, rich text, attachments).
import { go, setLeaveGuard } from './app.js';
import {
  $, api, busy, confirmBox, debounce, esc, fmtSize, html, icon, modal, mount, previewFrame, readBase64, store, toast,
} from './common.js';
import { createEditor } from './editor.js';
import { state } from './state.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Address field with chips and contact suggestions. */
export function chipInput(el, { value = [], placeholder = '', onChange = () => {} } = {}) {
  let items = [...value];
  el.className = 'chip-input';
  el.innerHTML = '<input type="text" autocomplete="off"><div class="suggest hidden"></div>';
  const input = el.querySelector('input');
  const sug = el.querySelector('.suggest');
  input.placeholder = items.length ? '' : placeholder;
  let options = [];
  let sel = -1;

  const draw = () => {
    el.querySelectorAll('.chip').forEach((c) => c.remove());
    for (const [i, addr] of items.entries()) {
      const c = document.createElement('span');
      c.className = `chip${EMAIL_RE.test(addr) ? '' : ' bad'}`;
      c.title = EMAIL_RE.test(addr) ? addr : `"${addr}" is not a valid email address`;
      c.innerHTML = `<span class="ellipsis">${esc(addr)}</span><button type="button" aria-label="Remove ${esc(addr)}">×</button>`;
      c.querySelector('button').onclick = (e) => { e.stopPropagation(); items.splice(i, 1); draw(); onChange(items); };
      el.insertBefore(c, input);
    }
    input.placeholder = items.length ? '' : placeholder;
  };
  const add = (text) => {
    const parts = String(text).split(/[,;\s]+/).map((p) => p.replace(/^.*<([^>]+)>.*$/, '$1').trim().toLowerCase()).filter(Boolean);
    for (const p of parts) if (!items.includes(p)) items.push(p);
    input.value = '';
    hide();
    draw();
    onChange(items);
  };
  const hide = () => { sug.classList.add('hidden'); options = []; sel = -1; };
  const showSug = () => {
    if (!options.length) return hide();
    sug.innerHTML = options.map((o, i) => `<button type="button" data-i="${i}" class="${i === sel ? 'on' : ''}"><b>${esc(o.name || o.email)}</b>${o.name ? ` <span class="muted small">${esc(o.email)}</span>` : ''}</button>`).join('');
    sug.classList.remove('hidden');
  };
  const search = debounce(async (q) => {
    if (q.length < 2) return hide();
    try {
      options = (await api(`/contacts/search?q=${encodeURIComponent(q)}`)).filter((o) => !items.includes(o.email));
      sel = options.length ? 0 : -1;
      if (input.value.trim() === q) showSug();
    } catch { hide(); }
  }, 200);

  el.addEventListener('click', () => input.focus());
  sug.addEventListener('mousedown', (e) => {
    const b = e.target.closest('button');
    if (b) { e.preventDefault(); add(options[Number(b.dataset.i)].email); }
  });
  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) return add(input.value);
    return search(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); sel = (sel + 1) % options.length; showSug(); }
    else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); sel = (sel - 1 + options.length) % options.length; showSug(); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (sel >= 0 && options[sel]) { e.preventDefault(); add(options[sel].email); }
      else if (input.value.trim()) { e.preventDefault(); add(input.value); }
    } else if (e.key === 'Backspace' && !input.value && items.length) { items.pop(); draw(); onChange(items); }
    else if (e.key === 'Escape') hide();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (input.value.trim()) add(input.value); hide(); }, 150));
  input.addEventListener('paste', (e) => {
    const t = e.clipboardData.getData('text');
    if (/[,;\s]/.test(t.trim())) { e.preventDefault(); add(t); }
  });
  draw();
  return {
    get: () => { if (input.value.trim()) add(input.value); return [...items]; },
    set: (v) => { items = [...v]; draw(); },
    invalid: () => items.filter((a) => !EMAIL_RE.test(a)),
    focus: () => input.focus(),
  };
}

/** Attachment picker shared by compose and bulk. `kept` are attachments re-used from an earlier email. */
export function attachments(el, { kept = [], onChange = () => {} } = {}) {
  let files = []; // { name, size, type, data(base64) }
  let keep = [...kept]; // { id, filename, size }
  const limit = state.app.maxAttachmentBytes;
  const total = () => files.reduce((a, f) => a + f.size, 0) + keep.reduce((a, f) => a + f.size, 0);
  const draw = () => {
    mount(el, html`
      <div class="attach-list">
        ${keep.map((f, i) => html`<span class="attach">${icon('clip')}<span class="ellipsis">${f.filename}</span><span class="muted tiny">${fmtSize(f.size)}</span>
          <button type="button" class="icon-btn" style="width:24px;height:24px" data-k="${i}" aria-label="Remove">${icon('x')}</button></span>`)}
        ${files.map((f, i) => html`<span class="attach">${icon('clip')}<span class="ellipsis">${f.name}</span><span class="muted tiny">${fmtSize(f.size)}</span>
          <button type="button" class="icon-btn" style="width:24px;height:24px" data-f="${i}" aria-label="Remove">${icon('x')}</button></span>`)}
        <button type="button" class="btn sm secondary" data-add>${icon('clip')} Attach files</button>
      </div>
      ${files.length || keep.length ? html`<p class="tiny muted" style="margin-top:6px">${fmtSize(total())} of ${fmtSize(limit)} used</p>` : ''}`);
    el.querySelector('[data-add]').onclick = () => pick();
    el.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => { files.splice(Number(b.dataset.f), 1); draw(); onChange(); }; });
    el.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { keep.splice(Number(b.dataset.k), 1); draw(); onChange(); }; });
  };
  const addFiles = async (list) => {
    for (const f of list) {
      if (total() + f.size > limit) {
        toast(`"${f.name}" is too large. Attachments can be up to ${fmtSize(limit)} in total. For bigger files, share a Google Drive / OneDrive link in the message.`, 'error');
        continue;
      }
      files.push({ name: f.name, size: f.size, type: f.type || 'application/octet-stream', data: await readBase64(f) });
    }
    draw();
    onChange();
  };
  const pick = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => addFiles([...input.files]);
    input.click();
  };
  draw();
  return {
    addFiles,
    payload: () => files.map((f) => ({ filename: f.name, contentType: f.type, data: f.data })),
    keepIds: () => keep.map((k) => k.id),
    count: () => files.length + keep.length,
    clear: () => { files = []; keep = []; draw(); },
  };
}

/** Template picker modal; resolves with the chosen template. */
export async function pickTemplate() {
  const list = await api('/templates');
  if (!list.length) {
    toast('There are no templates yet. Create one under Templates.');
    return null;
  }
  return modal((box, close) => {
    mount(box, html`
      <div class="modal-head"><h2>Use a template</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <input type="search" placeholder="Search templates…" style="margin-bottom:12px">
      <div class="stack tight" data-items style="max-height:60vh;overflow:auto">
        ${list.map((t, i) => html`<button type="button" class="btn secondary" style="justify-content:flex-start;text-align:left;height:auto;padding:10px 12px" data-i="${i}">
          <span class="grow"><b>${t.name}</b><br><span class="small muted ellipsis">${t.subject || '(no subject)'}</span></span></button>`)}
      </div>`, { wide: false });
    const q = box.querySelector('input');
    q.oninput = () => box.querySelectorAll('[data-i]').forEach((b) => {
      b.classList.toggle('hidden', !b.textContent.toLowerCase().includes(q.value.toLowerCase()));
    });
    box.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => close(list[Number(b.dataset.i)]); });
  });
}

/** Saves the current subject + body as a new template. */
export async function saveAsTemplate(subject, body) {
  const name = await modal((box, close) => {
    mount(box, html`<div class="modal-head"><h2>Save as template</h2></div>
      <form class="stack"><label class="field">Template name<input name="name" required autofocus value="${subject}"></label>
      <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Save template</button></div></form>`);
    box.querySelector('form').onsubmit = (e) => { e.preventDefault(); close(e.target.name.value.trim()); };
  });
  if (!name) return;
  await api('/templates', { method: 'POST', body: { name, subject, html: body } });
  toast('Template saved.', 'ok');
}

const sigBlock = (sig) => (sig ? `<p></p><div class="signature">${sig}</div>` : '');

export async function render(main) {
  const handoff = state.handoff?.mode === 'compose' ? state.handoff : null;
  state.handoff = null;
  const draft = handoff ? null : store.get(`draft:${state.user.id}`);
  const start = handoff || draft || {};
  const startHtml = start.html ?? sigBlock(state.user.signature_html);

  mount(main, html`
    <div class="page-head"><div><h1>New email</h1><p>Send to one person or a small group. For personalised emails to many people use <a href="#/bulk">Bulk send</a>.</p></div>
      <div class="actions"><button class="btn secondary" id="tpl-btn">${icon('template')} Use template</button></div></div>
    ${!state.app.smtpConfigured ? html`<div class="alert warn" style="margin-bottom:14px">${icon('alert')} Email sending is not set up yet, so sending will fail.</div>` : ''}
    ${draft ? html`<div class="alert info" style="margin-bottom:14px" id="draft-note">${icon('file')}<div class="grow">Your unsent draft was restored.</div><button class="btn sm secondary" id="discard-draft">Discard draft</button></div>` : ''}
    <div class="compose">
      <div class="card">
        <div class="addr-row"><span>To</span><div id="to"></div>
          <div class="row"><button class="btn sm ghost" id="show-cc" type="button">Cc</button><button class="btn sm ghost" id="show-bcc" type="button">Bcc</button></div></div>
        <div class="addr-row hidden" id="cc-row"><span>Cc</span><div id="cc"></div><span></span></div>
        <div class="addr-row hidden" id="bcc-row"><span>Bcc</span><div id="bcc"></div><span></span></div>
        <input class="subject-input" id="subject" placeholder="Subject" maxlength="300" value="${start.subject || ''}">
        <div style="margin-top:14px" id="editor"></div>
        <div style="margin-top:14px" id="attach"></div>
        <div class="sticky-actions">
          <div class="row wrap">
            <button class="btn lg" id="send-btn" data-busy="Sending…">${icon('send')} Send</button>
            <button class="btn secondary" id="preview-btn">${icon('eye')} Preview</button>
          </div>
          <div class="row wrap">
            <button class="btn ghost" id="save-tpl">Save as template</button>
            <button class="btn ghost" id="clear-btn">${icon('trash')} Clear</button>
          </div>
        </div>
      </div>
      <div class="stack">
        <div class="card stack">
          <div class="section-title">Sender</div>
          <label class="field">From name<input id="from-name" placeholder="${state.app.fromName || state.user.name}" value="${start.fromName || ''}" maxlength="100">
            <span class="hint">Sent from <b>${state.app.fromEmail || '(not set)'}</b>. Leave empty to use the default name.</span></label>
          <label class="field">Replies go to<input id="reply-to" type="email" placeholder="${state.user.email}" value="${start.replyTo ?? state.user.email}">
            <span class="hint">Where answers to this email will arrive.</span></label>
        </div>
        <div class="card stack small">
          <div class="section-title">Tips</div>
          <p>Type a name or email in <b>To</b> to pick from your contacts. Press <b>Enter</b> or <b>comma</b> after each address.</p>
          <p>Drop files anywhere on this page to attach them (up to ${fmtSize(state.app.maxAttachmentBytes)}).</p>
          <p>Your signature is added automatically. Change it in <a href="#/profile">My profile</a>.</p>
        </div>
      </div>
    </div>`);

  let dirty = false;
  const subjectEl = $('#subject');
  const fromEl = $('#from-name');
  const replyEl = $('#reply-to');
  const writeDraft = () => {
    if (!dirty) return;
    store.set(`draft:${state.user.id}`, {
      to: to.get(), cc: cc.get(), bcc: bcc.get(), subject: subjectEl.value, html: editor.getHTML(),
      fromName: fromEl.value, replyTo: replyEl.value,
    });
  };
  const saveDraft = debounce(writeDraft, 800);
  const touch = () => { dirty = true; saveDraft(); };

  const to = chipInput($('#to'), { value: start.to || [], placeholder: 'Recipients', onChange: touch });
  const cc = chipInput($('#cc'), { value: start.cc || [], onChange: touch });
  const bcc = chipInput($('#bcc'), { value: start.bcc || [], onChange: touch });
  if (start.cc?.length) $('#cc-row').classList.remove('hidden');
  if (start.bcc?.length) $('#bcc-row').classList.remove('hidden');
  $('#show-cc').onclick = () => { $('#cc-row').classList.remove('hidden'); cc.focus(); };
  $('#show-bcc').onclick = () => { $('#bcc-row').classList.remove('hidden'); bcc.focus(); };
  const editor = createEditor($('#editor'), { value: startHtml, onChange: touch });
  const att = attachments($('#attach'), { kept: start.keepAttachments || [], onChange: () => { dirty = true; } });
  ['#subject', '#from-name', '#reply-to'].forEach((s) => $(s).addEventListener('input', touch));
  if (!(start.to || []).length) to.focus();

  $('#discard-draft')?.addEventListener('click', () => {
    store.del(`draft:${state.user.id}`);
    dirty = false;
    go('#/compose');
  });

  // Drop files anywhere on the page.
  const onDragOver = (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); };
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    att.addFiles([...e.dataTransfer.files]);
  };
  main.addEventListener('dragover', onDragOver);
  main.addEventListener('drop', onDrop);

  setLeaveGuard(() => (dirty && (to.get().length || $('#subject').value || att.count())
    ? 'Leave this email? Your text is kept as a draft, but attachments will be removed.' : null));

  $('#tpl-btn').onclick = async () => {
    const t = await pickTemplate();
    if (!t) return;
    if (!editor.isEmpty() && editor.getHTML() !== sigBlock(state.user.signature_html).trim()
      && !await confirmBox('Replace the message?', 'The template will replace what you have written so far.', { ok: 'Use template' })) return;
    if (t.subject) $('#subject').value = t.subject;
    editor.setHTML(t.html + sigBlock(state.user.signature_html));
    if (/\{\{/.test(t.html + t.subject)) toast('This template has {{fields}}. They are only filled in for Bulk send.');
  };

  $('#save-tpl').onclick = (e) => busy(e.currentTarget, () => saveAsTemplate($('#subject').value, editor.getHTML()));

  $('#clear-btn').onclick = async () => {
    if (!await confirmBox('Clear this email?', 'Recipients, subject, message and attachments will be removed.', { ok: 'Clear', danger: true })) return;
    store.del(`draft:${state.user.id}`);
    dirty = false;
    go('#/compose');
  };

  $('#preview-btn').onclick = () => modal((box) => {
    mount(box, html`<div class="modal-head"><h2>Preview</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="mail-head"><b>${$('#subject').value || '(no subject)'}</b><div class="muted">From: ${$('#from-name').value || state.app.fromName || state.user.name} &lt;${state.app.fromEmail}&gt;</div>
      <div class="muted">To: ${to.get().join(', ') || '—'}</div>${att.count() ? html`<div class="muted">${icon('clip')} ${att.count()} attachment(s)</div>` : ''}</div>`);
    box.append(previewFrame(editor.getHTML()));
  }, { wide: true });

  $('#send-btn').onclick = async (e) => {
    const btn = e.currentTarget;
    const bad = [...to.invalid(), ...cc.invalid(), ...bcc.invalid()];
    if (bad.length) return toast(`Fix these addresses first: ${bad.join(', ')}`, 'error');
    if (!to.get().length) { toast('Add at least one recipient.', 'error'); return to.focus(); }
    if (!$('#subject').value.trim()) {
      if (!await confirmBox('Send without a subject?', 'Emails without a subject often go unread or to spam.', { ok: 'Add subject' })) return undefined;
      return $('#subject').focus();
    }
    if (editor.isEmpty()) return toast('The message is empty.', 'error');
    if (/\battach(ed|ment)/i.test(editor.getHTML()) && !att.count()
      && !await confirmBox('Forgot the attachment?', 'Your message mentions an attachment, but no file is attached.', { ok: 'Send anyway' })) return undefined;
    const body = {
      to: to.get(), cc: cc.get(), bcc: bcc.get(), subject: $('#subject').value, html: editor.getHTML(),
      fromName: $('#from-name').value, replyTo: $('#reply-to').value, attachments: att.payload(),
      keepAttachments: att.keepIds(), fromMessageId: start.fromMessageId,
    };
    try {
      const r = await busy(btn, () => api('/messages/send', { method: 'POST', body, timeout: 120000 }), { quiet: true });
      store.del(`draft:${state.user.id}`);
      dirty = false;
      toast(r.rejected?.length ? `Sent, but the server rejected: ${r.rejected.join(', ')}` : 'Email sent.', r.rejected?.length ? 'error' : 'ok');
      go(`#/history/${r.id}`);
    } catch (err) {
      toast(err.message, 'error');
      if (err.data?.id) {
        store.del(`draft:${state.user.id}`);
        dirty = false;
        go(`#/history/${err.data.id}`);
      }
    }
    return undefined;
  };

  return () => {
    writeDraft();
    dirty = false;
    main.removeEventListener('dragover', onDragOver);
    main.removeEventListener('drop', onDrop);
  };
}

