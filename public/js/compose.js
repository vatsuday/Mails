// Compose a single email (To / Cc / Bcc, rich text, attachments).
import { go, setLeaveGuard } from './app.js';
import {
  $, api, avatar, busy, confirmBox, debounce, fmtSize, html, icon, modal, mount, popMenu, previewFrame, readBase64, store, toast,
} from './common.js';
import { createEditor } from './editor.js';
import { state } from './state.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Address field with avatar chips and contact suggestions. Names picked from contacts are shown on the chips. */
export function chipInput(el, { value = [], placeholder = '', names = {}, onChange = () => {} } = {}) {
  let items = [...value];
  const known = new Map(Object.entries(names)); // email -> name
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
      const ok = EMAIL_RE.test(addr);
      const name = known.get(addr) || '';
      const c = document.createElement('span');
      c.className = `chip${ok ? '' : ' bad'}`;
      c.title = ok ? (name ? `${name} <${addr}>` : addr) : `"${addr}" is not a valid email address`;
      mount(c, html`${avatar(name || addr, addr)}<span class="ellipsis">${name || addr}</span><button type="button" aria-label="Remove ${addr}">${icon('x')}</button>`);
      c.querySelector('button').onclick = (e) => { e.stopPropagation(); items.splice(i, 1); draw(); onChange(items); };
      el.insertBefore(c, input);
    }
    input.placeholder = items.length ? '' : placeholder;
  };
  const add = (text, name = '') => {
    // "Priya Sharma <priya@x.com>, ravi@x.com amit@x.com" -> three addresses, Priya's name kept.
    const found = [];
    for (const part of String(text).split(/[,;\n]+/)) {
      const angle = part.match(/^(.*?)<([^>]+)>/);
      if (angle) found.push([angle[2], angle[1].replace(/["']/g, '')]);
      else for (const w of part.split(/\s+/)) found.push([w, '']);
    }
    for (const [a, n] of found) {
      const addr = a.trim().toLowerCase();
      if (!addr) continue;
      const label = (name || n).trim();
      if (label) known.set(addr, label);
      if (!items.includes(addr)) items.push(addr);
    }
    input.value = '';
    hide();
    draw();
    onChange(items);
  };
  const hide = () => { sug.classList.add('hidden'); options = []; sel = -1; };
  const showSug = () => {
    if (!options.length) return hide();
    mount(sug, html`${options.map((o, i) => html`<button type="button" data-i="${i}" class="${i === sel ? 'on' : ''}">${avatar(o.name || o.email, o.email)}
      <span class="grow"><b>${o.name || o.email}</b>${o.name ? html`<br><span class="muted small">${o.email}</span>` : ''}</span></button>`)}`);
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
    if (b) { e.preventDefault(); const o = options[Number(b.dataset.i)]; add(o.email, o.name); }
  });
  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) return add(input.value);
    return search(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); sel = (sel + 1) % options.length; showSug(); }
    else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); sel = (sel - 1 + options.length) % options.length; showSug(); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (sel >= 0 && options[sel]) { e.preventDefault(); add(options[sel].email, options[sel].name); }
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
    names: () => Object.fromEntries([...known].filter(([k]) => items.includes(k))),
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
    pick,
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

  const wide = store.get('compose:wide', false);
  mount(main, html`
    ${!state.app.smtpConfigured ? html`<div class="alert warn" style="margin-bottom:14px">${icon('alert')} Email sending is not set up yet, so sending will fail.</div>` : ''}
    ${draft ? html`<div class="alert info" style="margin-bottom:14px" id="draft-note">${icon('file')}<div class="grow">Your unsent draft was restored.</div><button class="btn sm secondary" id="discard-draft">Discard draft</button></div>` : ''}
    <section class="mail-window ${wide ? 'wide' : ''}" aria-label="New message">
      <header class="mw-head"><b>New Message</b>
        <div class="row" style="gap:2px">
          <a class="mw-head-btn" href="#/bulk" title="Personalised email to many people">${icon('bulk')}<span>Bulk send</span></a>
          <button class="mw-head-btn" id="mw-wide" type="button" title="${wide ? 'Smaller window' : 'Bigger window'}">${icon(wide ? 'shrink' : 'expand')}</button>
          <a class="mw-head-btn" href="#/" title="Close (your draft is kept)">${icon('x')}</a>
        </div></header>
      <div class="mw-body">
        <div class="mw-row"><span class="mw-label">To</span><div id="to" class="grow"></div>
          <div class="mw-links"><button type="button" id="show-cc">Cc</button><button type="button" id="show-bcc">Bcc</button></div></div>
        <div class="mw-row hidden" id="cc-row"><span class="mw-label">Cc</span><div id="cc" class="grow"></div></div>
        <div class="mw-row hidden" id="bcc-row"><span class="mw-label">Bcc</span><div id="bcc" class="grow"></div></div>
        <input class="mw-subject" id="subject" placeholder="Subject" maxlength="300" value="${start.subject || ''}" aria-label="Subject">
        <div id="editor" class="mw-editor"></div>
        <div id="attach" class="mw-attach"></div>
        <div class="mw-options hidden" id="mw-options">
          <div class="form-grid">
            <label class="field">From name<input id="from-name" placeholder="${state.app.fromName || state.user.name}" value="${start.fromName || ''}" maxlength="100">
              <span class="hint">Sent from <b>${state.app.fromEmail || '(not set)'}</b></span></label>
            <label class="field">Replies go to<input id="reply-to" type="email" placeholder="${state.user.email}" value="${start.replyTo ?? state.user.email}">
              <span class="hint">Where answers will arrive</span></label>
          </div>
        </div>
      </div>
      <footer class="mw-foot">
        <div class="send-split">
          <button class="btn send-main" id="send-btn" data-busy="Sending…">Send</button>
          <button class="btn send-more" id="send-more" type="button" aria-label="More send options" title="More send options">${icon('down')}</button>
        </div>
        <div class="mw-tools">
          <button type="button" class="icon-btn on" id="fmt-btn" title="Formatting options">${icon('type')}</button>
          <button type="button" class="icon-btn" id="att-btn" title="Attach files (or drop them here)">${icon('clip')}</button>
          <button type="button" class="icon-btn" id="link-btn" title="Insert link">${icon('link')}</button>
          <button type="button" class="icon-btn" id="img-btn" title="Insert image">${icon('image')}</button>
          <button type="button" class="icon-btn" id="tpl-btn" title="Use a template">${icon('template')}</button>
          <button type="button" class="icon-btn" id="preview-btn" title="Preview">${icon('eye')}</button>
          <label class="track-toggle" title="See when it is opened, in Sent &amp; reports"><input type="checkbox" id="track-opens" ${start.trackOpens === false ? '' : 'checked'}>${icon('eye')}<span>Track opens</span></label>
        </div>
        <div class="row" style="gap:2px;margin-left:auto">
          <button type="button" class="icon-btn" id="opts-btn" title="Sender options">${icon('dotsV')}</button>
          <button type="button" class="icon-btn" id="clear-btn" title="Discard">${icon('trash')}</button>
        </div>
      </footer>
    </section>
    <p class="tiny muted mw-hint">Type a name or email in <b>To</b> to pick from your contacts · Drop files anywhere to attach (up to ${fmtSize(state.app.maxAttachmentBytes)}) · Your signature is added from <a href="#/profile">My profile</a></p>`);

  let dirty = false;
  const subjectEl = $('#subject');
  const fromEl = $('#from-name');
  const replyEl = $('#reply-to');
  const writeDraft = () => {
    if (!dirty) return;
    store.set(`draft:${state.user.id}`, {
      to: to.get(), cc: cc.get(), bcc: bcc.get(), subject: subjectEl.value, html: editor.getHTML(),
      fromName: fromEl.value, replyTo: replyEl.value, names: { ...to.names(), ...cc.names(), ...bcc.names() },
      trackOpens: $('#track-opens').checked,
    });
  };
  const saveDraft = debounce(writeDraft, 800);
  const touch = () => { dirty = true; saveDraft(); };

  const names = start.names || {};
  const to = chipInput($('#to'), { value: start.to || [], names, placeholder: 'Recipients', onChange: touch });
  const cc = chipInput($('#cc'), { value: start.cc || [], names, onChange: touch });
  const bcc = chipInput($('#bcc'), { value: start.bcc || [], names, onChange: touch });
  const showRow = (row, input, btn) => { $(row).classList.remove('hidden'); $(btn).classList.add('hidden'); input.focus(); };
  if (start.cc?.length) { $('#cc-row').classList.remove('hidden'); $('#show-cc').classList.add('hidden'); }
  if (start.bcc?.length) { $('#bcc-row').classList.remove('hidden'); $('#show-bcc').classList.add('hidden'); }
  $('#show-cc').onclick = () => showRow('#cc-row', cc, '#show-cc');
  $('#show-bcc').onclick = () => showRow('#bcc-row', bcc, '#show-bcc');
  const editor = createEditor($('#editor'), { value: startHtml, onChange: touch });
  const att = attachments($('#attach'), { kept: start.keepAttachments || [], onChange: () => { dirty = true; } });
  ['#subject', '#from-name', '#reply-to'].forEach((s) => $(s).addEventListener('input', touch));
  $('#track-opens').addEventListener('change', touch);
  if (!(start.to || []).length) to.focus();

  // Footer tools (Gmail style)
  const win = $('.mail-window');
  const showTools = store.get('compose:tools', true);
  win.classList.toggle('no-tools', !showTools);
  $('#fmt-btn').classList.toggle('on', showTools);
  $('#fmt-btn').onclick = () => {
    const on = win.classList.toggle('no-tools') === false;
    $('#fmt-btn').classList.toggle('on', on);
    store.set('compose:tools', on);
  };
  $('#att-btn').onclick = () => att.pick();
  $('#link-btn').onclick = () => editor.root.querySelector('[data-cmd="link"]').click();
  $('#img-btn').onclick = () => editor.root.querySelector('[data-cmd="image"]').click();
  $('#opts-btn').onclick = () => {
    const open = $('#mw-options').classList.toggle('hidden') === false;
    $('#opts-btn').classList.toggle('on', open);
    if (open) $('#from-name').focus();
  };
  $('#mw-wide').onclick = () => {
    const on = win.classList.toggle('wide');
    store.set('compose:wide', on);
    mount($('#mw-wide'), icon(on ? 'shrink' : 'expand'));
    $('#mw-wide').title = on ? 'Smaller window' : 'Bigger window';
  };
  $('#send-more').onclick = (e) => popMenu(e.currentTarget, [
    { label: 'Preview', icon: 'eye', onClick: () => $('#preview-btn').click() },
    { label: 'Save as template', icon: 'template', onClick: () => saveAsTemplate($('#subject').value, editor.getHTML()).catch((err) => toast(err.message, 'error')) },
    { label: 'Send to many people instead (Bulk send)', icon: 'bulk', onClick: () => go('#/bulk') },
  ]);

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
      keepAttachments: att.keepIds(), fromMessageId: start.fromMessageId, trackOpens: $('#track-opens').checked,
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

