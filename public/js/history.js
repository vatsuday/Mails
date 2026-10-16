// Sent emails: list with filters, and a detail page with delivery report.
import { go } from './app.js';
import {
  $, $$, api, busy, confirmBox, debounce, download, fmtDateTime, fmtNum, fmtSize, html, icon, mount, previewFrame, progressBar, qs,
  statusBadge, timeAgo, toast,
} from './common.js';
import { control, getJob, isRunning, run, subscribe } from './runner.js';
import { isAdmin, state } from './state.js';

const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');

export async function renderList(main) {
  const p = hashParams();
  const f = { q: p.get('q') || '', kind: p.get('kind') || '', status: p.get('status') || '', scope: p.get('scope') || '', page: Number(p.get('page')) || 1 };

  mount(main, html`
    <div class="page-head"><div><h1>Sent & reports</h1><p>${isAdmin() ? 'All emails sent by your team.' : 'Emails you have sent.'} Click one to see who received it.</p></div>
      <div class="actions"><a class="btn secondary" href="#/bulk">${icon('bulk')} Bulk send</a><a class="btn" href="#/compose">${icon('plus')} New email</a></div></div>
    <div class="toolbar-row">
      <input type="search" id="h-q" placeholder="Search subject, recipient or file…" value="${f.q}">
      <select id="h-kind"><option value="">All types</option><option value="single" ${f.kind === 'single' ? 'selected' : ''}>Single emails</option><option value="bulk" ${f.kind === 'bulk' ? 'selected' : ''}>Bulk sends</option></select>
      <select id="h-status"><option value="">Any status</option>${[['done', 'Sent'], ['sending', 'Sending'], ['paused', 'Paused'], ['failed', 'Failed'], ['cancelled', 'Cancelled']].map(([v, l]) => html`<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`)}</select>
      ${isAdmin() ? html`<select id="h-scope"><option value="">Everyone</option><option value="mine" ${f.scope === 'mine' ? 'selected' : ''}>Only mine</option></select>` : ''}
    </div>
    <div id="h-table"><div class="loading-block"><span class="spinner"></span></div></div>`);

  const load = async () => {
    const limit = 25;
    const d = await api(`/messages${qs({ ...f, limit })}`);
    const pages = Math.max(1, Math.ceil(d.total / limit));
    const box = $('#h-table');
    if (!box) return;
    if (!d.rows.length) {
      mount(box, html`<div class="card empty">${icon('mail')}<p>${f.q || f.kind || f.status ? 'No emails match your filters.' : 'Nothing sent yet.'}</p>
        ${!f.q && !f.kind && !f.status ? html`<p style="margin-top:10px"><a class="btn" href="#/compose">Send your first email</a></p>` : ''}</div>`);
      return;
    }
    mount(box, html`
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Subject</th><th>To</th><th>Status</th>${isAdmin() ? html`<th>Sent by</th>` : ''}</tr></thead>
        <tbody>${d.rows.map((m) => html`<tr class="clickable" data-id="${m.id}">
          <td class="nowrap small" title="${fmtDateTime(m.created_at)}">${timeAgo(m.created_at)}</td>
          <td class="subject"><div class="row"><span class="ellipsis"><b>${m.subject || '(no subject)'}</b></span>${m.attachments ? icon('clip') : ''}</div>
            ${m.kind === 'bulk' ? html`<span class="badge primary tiny">Bulk</span> <span class="tiny muted">${m.source}</span>` : ''}</td>
          <td class="small">${m.kind === 'bulk' ? html`<b>${fmtNum(m.total)}</b> people` : html`<span class="ellipsis" style="display:block;max-width:240px">${m.first_email}</span>`}</td>
          <td>${m.kind === 'bulk' && m.total ? html`<div class="stack tight">${statusBadge(m.status)}${progressBar(m, 'mini-progress')}
            <span class="tiny muted">${fmtNum(m.sent)} sent${m.failed ? html` · <span style="color:var(--danger)">${fmtNum(m.failed)} failed</span>` : ''}</span></div>` : statusBadge(m.status)}</td>
          ${isAdmin() ? html`<td class="small nowrap">${m.user_name || '—'}</td>` : ''}
        </tr>`)}</tbody></table></div>
      <div class="pager"><span>${fmtNum(d.total)} emails</span>
        <div class="row"><button class="btn sm secondary" id="pg-prev" ${f.page <= 1 ? 'disabled' : ''}>${icon('left')} Newer</button>
        <span>Page ${f.page} of ${pages}</span>
        <button class="btn sm secondary" id="pg-next" ${f.page >= pages ? 'disabled' : ''}>Older ${icon('right')}</button></div></div>`);
    $$('tr[data-id]', box).forEach((tr) => { tr.onclick = () => go(`#/history/${tr.dataset.id}`); });
    $('#pg-prev').onclick = () => { f.page -= 1; sync(); };
    $('#pg-next').onclick = () => { f.page += 1; sync(); };
  };
  const sync = () => {
    history.replaceState(null, '', `#/history${qs({ ...f, page: f.page > 1 ? f.page : '' })}`);
    load().catch((err) => toast(err.message, 'error'));
  };
  $('#h-q').oninput = debounce(() => { f.q = $('#h-q').value.trim(); f.page = 1; sync(); }, 350);
  $('#h-kind').onchange = (e) => { f.kind = e.target.value; f.page = 1; sync(); };
  $('#h-status').onchange = (e) => { f.status = e.target.value; f.page = 1; sync(); };
  if ($('#h-scope')) $('#h-scope').onchange = (e) => { f.scope = e.target.value; f.page = 1; sync(); };
  await load();
  // Keep progress bars fresh while bulk sends are running.
  const timer = setInterval(() => { if ($('#h-table') && $$('.badge.primary', $('#h-table')).length) load().catch(() => {}); }, 8000);
  return () => clearInterval(timer);
}

export async function renderDetail(main, id) {
  let m = await api(`/messages/${id}`);
  const rf = { status: '', q: '', page: 1 };
  let timer = null;
  let lastRunning = false;

  const draw = () => {
    const active = ['queued', 'sending', 'paused'].includes(m.status);
    const running = isRunning(m.id);
    lastRunning = running;
    mount(main, html`
      <a class="crumb" href="#/history">${icon('left')} Sent & reports</a>
      <div class="page-head">
        <div class="grow"><h1 class="ellipsis">${m.subject || '(no subject)'}</h1>
          <p>${m.kind === 'bulk' ? 'Bulk send' : 'Email'} · ${fmtDateTime(m.created_at)}${m.user ? ` · by ${m.user.name}` : ''}</p></div>
        <div class="actions">
          ${m.kind === 'bulk' && m.status === 'sending' && running ? html`<button class="btn secondary" data-act="pause">${icon('pause')} Pause</button>` : ''}
          ${m.kind === 'bulk' && (m.status === 'paused' || m.status === 'queued' || (m.status === 'sending' && !running)) ? html`<button class="btn" data-act="resume">${icon('play')} ${m.status === 'paused' ? 'Resume' : 'Continue sending'}</button>` : ''}
          ${m.kind === 'bulk' && active ? html`<button class="btn danger-outline" data-act="cancel">${icon('stop')} Cancel</button>` : ''}
          ${m.failed && !active ? html`<button class="btn" data-act="retry" data-busy="Retrying…">${icon('refresh')} ${m.kind === 'bulk' ? `Retry ${fmtNum(m.failed)} failed` : 'Try again'}</button>` : ''}
          ${m.kind === 'bulk' ? html`<button class="btn secondary" id="export">${icon('download')} Report (CSV)</button>` : ''}
          <button class="btn secondary" id="again">${icon('copy')} ${m.kind === 'bulk' ? 'Duplicate' : 'Send again'}</button>
          ${!active || m.status === 'paused' ? html`<button class="icon-btn" id="del" title="Delete">${icon('trash')}</button>` : ''}
        </div>
      </div>
      <div class="stack">
        ${m.kind === 'bulk' ? html`<div class="card stack" id="progress-card"></div>` : html`
          <div class="alert ${m.status === 'failed' ? 'error' : m.status === 'done' ? 'ok' : 'info'}">${icon(m.status === 'failed' ? 'alert' : 'check')}
            <div>${m.status === 'done' ? html`<b>Sent</b> to ${m.to}` : m.status === 'failed' ? html`<b>Not sent.</b> ${m.error || ''}` : 'Sending…'}
            ${m.status === 'done' && m.error ? html`<br>${m.error}` : ''}</div></div>`}
        <div class="grid-2" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr)">
          <div class="card"><div class="card-title"><h2>Message</h2>${m.kind === 'bulk' ? html`<span class="tiny muted">{{fields}} are filled in per person</span>` : ''}</div><div id="msg-preview"></div></div>
          <div class="card"><dl class="kv">
            <dt>From</dt><dd>${m.from_name || state.app.fromName || '—'}<br><span class="small muted">${state.app.fromEmail}</span></dd>
            ${m.kind === 'single' ? html`<dt>To</dt><dd>${m.to}</dd>${m.cc ? html`<dt>Cc</dt><dd>${m.cc}</dd>` : ''}${m.bcc ? html`<dt>Bcc</dt><dd>${m.bcc}</dd>` : ''}` : html`<dt>Recipients</dt><dd>${fmtNum(m.total)}</dd><dt>Source</dt><dd>${m.source || '—'}</dd>`}
            ${m.reply_to ? html`<dt>Replies to</dt><dd>${m.reply_to}</dd>` : ''}
            ${m.kind === 'bulk' ? html`<dt>Unsubscribe link</dt><dd>${m.add_unsubscribe ? 'Yes' : 'No'}</dd>` : ''}
            <dt>Created</dt><dd>${fmtDateTime(m.created_at)}</dd>
            ${m.finished_at ? html`<dt>Finished</dt><dd>${fmtDateTime(m.finished_at)}</dd>` : ''}
            ${m.attachments.length ? html`<dt>Attachments</dt><dd class="stack tight">${m.attachments.map((a) => html`<a href="/api/messages/${m.id}/attachments/${a.id}" download>${icon('clip')} ${a.filename} <span class="tiny muted">${fmtSize(a.size)}</span></a>`)}</dd>` : ''}
          </dl></div>
        </div>
        ${m.kind === 'bulk' ? html`<div class="card"><div class="card-title"><h2>Recipients</h2></div>
          <div class="toolbar-row"><div class="tabs" style="margin:0;border:0" id="r-tabs"></div><input type="search" id="r-q" placeholder="Search email or name…" style="margin-left:auto"></div>
          <div id="r-table"></div></div>` : ''}
      </div>`);

    $('#msg-preview').append(previewFrame(m.html));
    $$('[data-act]', main).forEach((b) => { b.onclick = () => act(b, b.dataset.act); });
    $('#export')?.addEventListener('click', () => download(`/api/messages/${m.id}/export`));
    $('#again').onclick = () => {
      const keep = m.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size }));
      if (m.kind === 'bulk') {
        state.handoff = { mode: 'bulk', subject: m.subject, html: m.html, fromName: m.from_name, replyTo: m.reply_to, addUnsubscribe: m.add_unsubscribe, keepAttachments: keep, fromMessageId: m.id };
        go('#/bulk');
      } else {
        state.handoff = {
          mode: 'compose', to: m.to.split(/,\s*/).filter(Boolean), cc: m.cc ? m.cc.split(/,\s*/) : [], bcc: m.bcc ? m.bcc.split(/,\s*/) : [],
          subject: m.subject, html: m.html, fromName: m.from_name, replyTo: m.reply_to, keepAttachments: keep, fromMessageId: m.id,
        };
        go('#/compose');
      }
    };
    $('#del')?.addEventListener('click', async () => {
      if (!await confirmBox('Delete this email?', 'It will be removed from the history together with its delivery report. This cannot be undone.', { ok: 'Delete', danger: true })) return;
      await api(`/messages/${m.id}`, { method: 'DELETE' }).then(() => { toast('Deleted.'); go('#/history'); }).catch((err) => toast(err.message, 'error'));
    });
    if (m.kind === 'bulk') {
      drawProgress();
      drawRecipientTabs();
      $('#r-q').oninput = debounce(() => { rf.q = $('#r-q').value.trim(); rf.page = 1; loadRecipients(); }, 300);
      loadRecipients();
    }
  };

  const drawProgress = () => {
    const card = $('#progress-card');
    if (!card) return;
    const job = getJob(m.id);
    const done = Number(m.sent) + Number(m.failed) + Number(m.skipped);
    const pct = m.total ? Math.round((100 * done) / m.total) : 0;
    const running = isRunning(m.id);
    mount(card, html`
      <div class="row between wrap"><div class="row">${statusBadge(m.status)} ${running ? html`<span class="spinner"></span><span class="small muted">Sending from this browser — keep this tab open</span>` : ''}</div>
        <b class="mono">${pct}%</b></div>
      ${progressBar(m)}
      <div class="stats" style="margin:0">
        <div class="stat"><div class="label">Sent</div><div class="value" style="color:var(--ok)">${fmtNum(m.sent)}</div></div>
        <div class="stat"><div class="label">Failed</div><div class="value" style="color:${m.failed ? 'var(--danger)' : 'inherit'}">${fmtNum(m.failed)}</div></div>
        <div class="stat"><div class="label">Skipped</div><div class="value">${fmtNum(m.skipped)}</div><div class="sub">unsubscribed / cancelled</div></div>
        <div class="stat"><div class="label">Waiting</div><div class="value">${fmtNum(m.pending)}</div></div>
      </div>
      ${job?.notice ? html`<div class="alert warn">${icon('alert')}<div>${job.notice}</div></div>` : ''}
      ${job?.error ? html`<div class="alert error">${icon('alert')}<div>${job.error}</div></div>` : ''}
      ${m.status === 'sending' && !running ? html`<div class="alert info">${icon('alert')}<div>Sending stopped because the browser tab that was sending was closed. Click <b>Continue sending</b>.</div></div>` : ''}
      ${job?.results?.length ? html`<details ${running ? 'open' : ''}><summary class="small muted" style="cursor:pointer">Live log</summary>
        <div class="log" style="margin-top:8px">${job.results.slice(-60).reverse().map((r) => html`<div>${r.status === 'sent' ? html`<span style="color:var(--ok)">${icon('check')}</span>` : html`<span style="color:var(--danger)">${icon('x')}</span>`}
          <span class="grow ellipsis">${r.email}</span>${r.error ? html`<span class="tiny" style="color:var(--danger)">${r.error}</span>` : ''}</div>`)}</div></details>` : ''}`);
  };

  const drawRecipientTabs = () => {
    const tabs = [['', 'All', m.total], ['sent', 'Sent', m.sent], ['failed', 'Failed', m.failed], ['pending', 'Waiting', m.pending], ['skipped', 'Skipped', m.skipped]];
    mount($('#r-tabs'), html`${tabs.map(([v, l, n]) => html`<button data-s="${v}" class="${rf.status === v ? 'on' : ''}">${l} <span class="badge">${fmtNum(n)}</span></button>`)}`);
    $$('[data-s]', $('#r-tabs')).forEach((b) => { b.onclick = () => { rf.status = b.dataset.s; rf.page = 1; drawRecipientTabs(); loadRecipients(); }; });
  };

  const loadRecipients = async () => {
    const box = $('#r-table');
    if (!box) return;
    const limit = 50;
    const d = await api(`/messages/${m.id}/recipients${qs({ status: rf.status, q: rf.q, page: rf.page, limit })}`);
    const pages = Math.max(1, Math.ceil(d.total / limit));
    if (!d.rows.length) { mount(box, html`<div class="empty small">No recipients here.</div>`); return; }
    mount(box, html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Sent at</th><th>Details</th></tr></thead>
      <tbody>${d.rows.map((r) => html`<tr><td>${r.email}</td><td>${r.name}</td><td>${statusBadge(r.status)}</td>
        <td class="small nowrap">${r.sent_at ? fmtDateTime(r.sent_at) : ''}</td><td class="small" style="color:${r.status === 'failed' ? 'var(--danger)' : 'var(--muted)'}">${r.error || ''}</td></tr>`)}</tbody></table></div>
      <div class="pager"><span>${fmtNum(d.total)} people</span><div class="row">
        <button class="btn sm secondary" id="rp-prev" ${rf.page <= 1 ? 'disabled' : ''}>${icon('left')}</button><span>Page ${rf.page} of ${pages}</span>
        <button class="btn sm secondary" id="rp-next" ${rf.page >= pages ? 'disabled' : ''}>${icon('right')}</button></div></div>`);
    $('#rp-prev').onclick = () => { rf.page -= 1; loadRecipients(); };
    $('#rp-next').onclick = () => { rf.page += 1; loadRecipients(); };
  };

  const refresh = async () => {
    m = await api(`/messages/${id}`);
    draw();
  };

  async function act(btn, action) {
    if (action === 'cancel' && !await confirmBox('Cancel this bulk send?', `The ${fmtNum(m.pending)} people who have not received it yet will be skipped. This cannot be undone.`, { ok: 'Cancel sending', danger: true })) return;
    await busy(btn, async () => {
      if (m.kind === 'single' && action === 'retry') {
        try {
          await api(`/messages/${m.id}/retry`, { method: 'POST', body: {}, timeout: 120000 });
          toast('Email sent.', 'ok');
        } catch (err) { toast(err.message, 'error'); }
        return refresh();
      }
      if (action === 'resume' && m.status === 'sending') run(m.id, m.subject);
      else await control(m.id, action);
      return refresh();
    });
  }

  draw();

  // Live updates from the sender running in this tab; slow polling otherwise.
  const unsub = subscribe((job) => {
    if (job.id !== m.id || !job.progress) return;
    const changed = m.status !== job.progress.status || lastRunning !== job.running;
    Object.assign(m, job.progress);
    if (!$('#progress-card')) return;
    if (changed) { draw(); return; }
    drawProgress();
    drawRecipientTabs();
  });
  timer = setInterval(() => {
    if (m.kind === 'bulk' && ['sending', 'queued'].includes(m.status) && !isRunning(m.id)) refresh().catch(() => {});
  }, 10000);
  return () => { unsub(); clearInterval(timer); };
}
