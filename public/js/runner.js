// Drives bulk sends from the browser: calls /messages/:id/batch until everything is sent.
// It keeps running while you move around the app; a small bar at the bottom shows progress.
import { api, esc, fmtNum, icon, progressBar, store, toast } from './common.js';

const jobs = new Map(); // id -> { id, subject, progress, running, results[], notice, error }
const listeners = new Set();

export const getJob = (id) => jobs.get(Number(id));
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(job) {
  for (const fn of listeners) { try { fn(job); } catch { /* listener error */ } }
  renderBar();
  saveIds();
}
function saveIds() {
  store.set('running', [...jobs.values()].filter((j) => j.running).map((j) => j.id));
}

export function isRunning(id) { return Boolean(jobs.get(Number(id))?.running); }

/** Starts (or continues) sending a bulk email. Safe to call twice. */
export function run(id, subject = '') {
  id = Number(id);
  let job = jobs.get(id);
  if (job?.running) return job;
  if (!job) {
    job = { id, subject, progress: null, results: [], running: false, notice: null, error: null };
    jobs.set(id, job);
  }
  if (subject) job.subject = subject;
  job.running = true;
  job.notice = null;
  job.error = null;
  emit(job);
  loop(job);
  return job;
}

async function loop(job) {
  let failures = 0;
  while (job.running) {
    try {
      const p = await api(`/messages/${job.id}/batch`, { method: 'POST', body: {}, timeout: 120000 });
      failures = 0;
      job.progress = p;
      if (p.results?.length) job.results = job.results.concat(p.results).slice(-300);
      if (p.notice) job.notice = p.notice;
      if (!['queued', 'sending'].includes(p.status) || Number(p.pending) === 0) {
        job.running = false;
        if (p.status === 'done') toast(`"${job.subject || 'Bulk email'}" finished: ${fmtNum(p.sent)} sent${p.failed ? `, ${fmtNum(p.failed)} failed` : ''}.`, p.failed ? '' : 'ok');
        else if (p.status === 'paused' && job.notice) toast(job.notice, 'error');
      }
      emit(job);
    } catch (err) {
      failures += 1;
      // Network blips: retry a few times before giving up.
      if (failures >= 4 || [401, 403, 404, 400].includes(err.status)) {
        job.running = false;
        job.error = err.message;
        toast(`Sending stopped: ${err.message}`, 'error');
        emit(job);
        return;
      }
      await new Promise((r) => { setTimeout(r, 2000 * failures); });
    }
  }
}

export async function control(id, action) {
  id = Number(id);
  const p = await api(`/messages/${id}/${action}`, { method: 'POST', body: {} });
  const job = jobs.get(id) || { id, subject: '', results: [] };
  job.progress = p;
  jobs.set(id, job);
  if (action === 'pause' || action === 'cancel') job.running = false;
  emit(job);
  if ((action === 'resume' || action === 'retry') && p.kind === 'bulk' && Number(p.pending) > 0) run(id);
  return p;
}

/** After a page reload, keep sending the emails that were running in this browser. */
export async function resumeSaved() {
  for (const id of store.get('running', [])) {
    try {
      const m = await api(`/messages/${id}`);
      if (['sending', 'queued'].includes(m.status) && Number(m.pending) > 0) run(id, m.subject);
    } catch { /* deleted or not accessible */ }
  }
  saveIds();
}

let bar;
function renderBar() {
  const active = [...jobs.values()].filter((j) => j.running);
  if (!active.length) { bar?.remove(); bar = null; return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'runner';
    document.body.append(bar);
  }
  const j = active[0];
  const p = j.progress || { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
  const done = Number(p.sent) + Number(p.failed) + Number(p.skipped);
  bar.innerHTML = `<span class="spinner"></span>
    <span class="ellipsis" style="max-width:220px"><b>Sending</b> ${esc(j.subject || '')}</span>
    ${progressBar(p).s}
    <span class="mono nowrap">${fmtNum(done)} / ${fmtNum(p.total || '…')}</span>
    ${active.length > 1 ? `<span class="badge">+${active.length - 1} more</span>` : ''}
    <a class="btn sm secondary" href="#/history/${j.id}">${icon('eye').s} View</a>`;
}

window.addEventListener('beforeunload', (e) => {
  if ([...jobs.values()].some((j) => j.running)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
