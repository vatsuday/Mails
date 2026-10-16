// App shell: login, sidebar, hash router, dashboard.
import {
  $, api, busy, fmtNum, fmtDay, html, icon, initials, mount, progressBar, setUnauthorizedHandler, statusBadge, store, timeAgo
} from './common.js';
import { resumeSaved } from './runner.js';
import { isAdmin, state } from './state.js';

const root = $('#root');
let cleanup = null;
let leaveGuard = null; // returns a message when the current page has unsaved work

// Theme: follows the system unless the user picked one.
const theme = store.get('theme');
if (theme) document.documentElement.dataset.theme = theme;

setUnauthorizedHandler((msg) => {
  if (state.user) {
    state.user = null;
    showLogin(msg || 'Your session has ended. Please log in again.');
  }
});

/** Lets a page warn before leaving with unsaved changes. */
export function setLeaveGuard(fn) { leaveGuard = fn; }

// ---- Login ----

function showLogin(message = '') {
  cleanup?.(); cleanup = null;
  document.title = 'Log in · Company Mail';
  mount(root, html`
    <div class="auth-screen">
      <div class="auth-card card">
        <div class="brand"><div class="brand-mark">${icon('mail')}</div><div><b>Company Mail</b><span>Sign in to send emails</span></div></div>
        <form class="stack" id="login-form" novalidate>
          ${message ? html`<div class="alert info">${message}</div>` : ''}
          <div class="alert error hidden" id="login-error"></div>
          <label class="field">Email<input name="email" type="email" autocomplete="username" required autofocus></label>
          <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
          <button class="btn lg" type="submit" data-busy="Signing in…">Log in</button>
          <p class="tiny muted" style="text-align:center">Forgot your password? Ask your admin to reset it.</p>
        </form>
      </div>
    </div>`);
  const form = $('#login-form');
  form.email.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.classList.add('hidden');
    const btn = form.querySelector('button');
    try {
      await busy(btn, () => api('/auth/login', { method: 'POST', body: { email: form.email.value, password: form.password.value } }), { quiet: true });
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      form.password.select();
    }
  };
}

// ---- Shell ----

const NAV = [
  ['Dashboard', '#/', 'home'],
  ['Compose', '#/compose', 'send'],
  ['Bulk send', '#/bulk', 'bulk'],
  ['Sent & reports', '#/history', 'history'],
  ['Contacts', '#/contacts', 'contacts'],
  ['Templates', '#/templates', 'template'],
];
const ADMIN_NAV = [
  ['Staff users', '#/admin/users', 'users'],
  ['Email settings', '#/admin/settings', 'settings'],
];

function renderShell() {
  const u = state.user;
  mount(root, html`
    <div class="layout">
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark">${icon('mail')}</div><div><b>${state.app.name}</b><span>${state.app.fromEmail || 'Email not set up yet'}</span></div></div>
        <a class="btn compose-btn" href="#/compose">${icon('plus')} New email</a>
        <nav class="nav" aria-label="Main">
          ${NAV.map(([label, href, ic]) => html`<a href="${href}" data-nav>${icon(ic)}${label}</a>`)}
          ${isAdmin() ? html`<div class="nav-group">Admin</div>${ADMIN_NAV.map(([label, href, ic]) => html`<a href="${href}" data-nav>${icon(ic)}${label}</a>`)}` : ''}
        </nav>
        <div class="sidebar-foot">
          <a class="avatar" href="#/profile" title="My profile" style="text-decoration:none">${initials(u.name)}</a>
          <div class="who"><b class="ellipsis">${u.name}</b><span>${u.role === 'admin' ? 'Admin' : 'Staff'}</span></div>
          <button class="icon-btn" id="theme-btn" title="Switch light / dark">${icon('moon')}</button>
          <button class="icon-btn" id="logout-btn" title="Log out">${icon('logout')}</button>
        </div>
      </aside>
      <div>
        <div class="topbar"><button class="icon-btn" id="menu-btn" aria-label="Menu">${icon('menu')}</button><b>${state.app.name}</b>
          <a class="btn sm" href="#/compose">${icon('plus')} New</a></div>
        <main class="main" id="main"></main>
      </div>
    </div>`);
  $('#menu-btn').onclick = () => document.body.classList.toggle('nav-open');
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('#menu-btn')) document.body.classList.remove('nav-open');
  });
  $('#logout-btn').onclick = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    state.user = null;
    showLogin('You have been logged out.');
  };
  $('#theme-btn').onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
  };
}

// ---- Router ----

const ROUTES = [
  [/^\/$/, () => ({ render: dashboard })],
  [/^\/compose$/, () => import('./compose.js')],
  [/^\/bulk$/, () => import('./bulk.js')],
  [/^\/history$/, () => import('./history.js').then((m) => ({ render: m.renderList }))],
  [/^\/history\/(\d+)$/, () => import('./history.js').then((m) => ({ render: m.renderDetail }))],
  [/^\/contacts$/, () => import('./contacts.js').then((m) => ({ render: m.renderLists }))],
  [/^\/contacts\/unsubscribed$/, () => import('./contacts.js').then((m) => ({ render: m.renderSuppressions }))],
  [/^\/contacts\/(\d+)$/, () => import('./contacts.js').then((m) => ({ render: m.renderList }))],
  [/^\/templates$/, () => import('./templates.js')],
  [/^\/profile$/, () => import('./admin.js').then((m) => ({ render: m.renderProfile }))],
  [/^\/admin\/users$/, () => import('./admin.js').then((m) => ({ render: m.renderUsers })), true],
  [/^\/admin\/settings$/, () => import('./admin.js').then((m) => ({ render: m.renderSettings })), true],
];

let currentHash = location.hash;
async function route() {
  if (!state.user) return;
  const msg = leaveGuard?.();
  if (msg && location.hash !== currentHash && !window.confirm(msg)) {
    history.replaceState(null, '', currentHash || '#/');
    return;
  }
  leaveGuard = null;
  currentHash = location.hash;
  document.body.classList.remove('nav-open');
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const main = $('#main');
  cleanup?.(); cleanup = null;
  for (const a of document.querySelectorAll('[data-nav]')) {
    const href = a.getAttribute('href').slice(1);
    a.classList.toggle('active', href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  }
  const hit = ROUTES.find(([re]) => re.test(path));
  if (!hit || (hit[2] && !isAdmin())) {
    mount(main, html`<div class="empty">${icon('alert')}<h2>Page not found</h2><p><a href="#/">Go to the dashboard</a></p></div>`);
    return;
  }
  mount(main, html`<div class="loading-block"><span class="spinner"></span></div>`);
  try {
    const mod = await hit[1]();
    const params = path.match(hit[0]).slice(1);
    if (currentHash !== location.hash) return; // navigated away while loading
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    cleanup = (await mod.render(main, ...params)) || null;
  } catch (err) {
    console.error(err);
    if (err.status === 401) return;
    mount(main, html`<div class="alert error">${err.message || 'Something went wrong.'}</div>`);
  }
}
window.addEventListener('hashchange', route);

export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/** Reloads /me (after profile or settings changes). */
export async function refreshMe() {
  const me = await api('/me');
  state.user = me.user;
  state.app = me.app;
}

async function boot() {
  try {
    await refreshMe();
  } catch (err) {
    if (err.status === 401) return showLogin();
    mount(root, html`<div class="auth-screen"><div class="card auth-card stack"><div class="alert error">${err.message}</div>
      <button class="btn">Try again</button></div></div>`);
    $('.auth-card button').onclick = () => location.reload();
    return undefined;
  }
  document.title = state.app.name;
  renderShell();
  await route();
  resumeSaved();
  return undefined;
}

// ---- Dashboard ----

async function dashboard(main) {
  const d = await api('/dashboard');
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const dt = new Date(Date.now() - i * 86400e3);
    const key = dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    days.push({ key, label: fmtDay(dt), n: Number(d.daily.find((x) => x.day === key)?.n || 0) });
  }
  const max = Math.max(1, ...days.map((x) => x.n));
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  mount(main, html`
    <div class="page-head"><div><h1>${greet}, ${state.user.name.split(' ')[0]}</h1>
      <p>${isAdmin() ? 'Company-wide email activity' : 'Your email activity'}</p></div></div>
    <div class="stack">
      ${!state.app.smtpConfigured ? html`<div class="alert warn">${icon('alert')}<div><b>Email sending is not set up yet.</b>
        ${isAdmin() ? html` <a href="#/admin/settings">Enter your SMTP details</a> to start sending.` : ' Ask your admin to set up the email settings.'}</div></div>` : ''}
      ${state.app.defaultPassword ? html`<div class="alert warn">${icon('key')}<div>You are still using the default admin password. <a href="#/profile">Change it now</a>.</div></div>` : ''}
      <div class="quick">
        <a href="#/compose"><span class="qi">${icon('send')}</span><span><b>Compose email</b><span>Send to one or a few people</span></span></a>
        <a href="#/bulk"><span class="qi">${icon('bulk')}</span><span><b>Bulk send</b><span>Personalised emails from Excel / CSV</span></span></a>
        <a href="#/contacts"><span class="qi">${icon('contacts')}</span><span><b>Contact lists</b><span>${fmtNum(d.contacts)} saved contacts</span></span></a>
        <a href="#/templates"><span class="qi">${icon('template')}</span><span><b>Templates</b><span>Reusable email designs</span></span></a>
      </div>
      <div class="stats">
        <div class="stat"><span class="stat-icon">${icon('send')}</span><div class="label">Sent today</div><div class="value">${fmtNum(d.sent_today)}</div>
          ${d.dailyLimit ? html`<div class="sub">${fmtNum(d.sentTodayAll)} of ${fmtNum(d.dailyLimit)} daily limit used</div>
            <div class="progress mini" style="margin-top:8px"><i class="p-sent" style="width:${Math.min(100, (100 * d.sentTodayAll) / d.dailyLimit)}%"></i></div>` : ''}</div>
        <div class="stat"><span class="stat-icon">${icon('chart')}</span><div class="label">Sent · 30 days</div><div class="value">${fmtNum(d.sent_30)}</div></div>
        <div class="stat stat-open"><span class="stat-icon">${icon('eye')}</span><div class="label">Opened · 30 days</div>
          <div class="value">${Number(d.tracked_30) ? `${Math.round((100 * d.opened_30) / d.tracked_30)}%` : '—'}</div>
          <div class="sub">${Number(d.tracked_30) ? `${fmtNum(d.opened_30)} of ${fmtNum(d.tracked_30)} tracked emails` : 'No tracked emails yet'}</div></div>
        <div class="stat"><span class="stat-icon danger">${icon('alertOff')}</span><div class="label">Failed · 30 days</div><div class="value" style="color:${d.failed_30 ? 'var(--danger)' : 'inherit'}">${fmtNum(d.failed_30)}</div>
          ${Number(d.queued) ? html`<div class="sub">${fmtNum(d.queued)} waiting to send</div>` : ''}</div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-title"><h2>Emails sent · last 14 days</h2></div>
          <div class="bars">${days.map((x) => html`<div class="bar" title="${x.label}: ${fmtNum(x.n)} sent"><i style="height:${(100 * x.n) / max}%"></i><span>${x.label.split(' ')[0]}</span></div>`)}</div>
        </div>
        <div class="card">
          <div class="card-title"><h2>Bulk sends in progress</h2><a class="btn sm ghost" href="#/history?kind=bulk">All bulk sends</a></div>
          <div id="active-list">${d.active.length ? '' : html`<div class="empty small">Nothing is sending right now.</div>`}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title"><h2>How your recent emails did</h2><a class="btn sm ghost" href="#/history">All reports</a></div>
        ${d.recent.length ? html`<div class="perf">${d.recent.map((m) => {
          const pct = Math.round((100 * Number(m.opened)) / Math.max(1, Number(m.sent)));
          return html`<a class="perf-row" href="#/history/${m.id}">
            <div class="grow"><div class="ellipsis"><b>${m.subject || '(no subject)'}</b></div>
              <div class="tiny muted">${timeAgo(m.created_at)} · ${m.kind === 'bulk' ? `${fmtNum(m.sent)} sent` : 'single email'}</div></div>
            <div class="perf-bar"><i style="width:${pct}%"></i></div>
            <div class="perf-num"><b>${pct}%</b><span class="tiny muted">${fmtNum(m.opened)} opened</span></div></a>`;
        })}</div>` : html`<div class="empty small">${icon('eye')}<p>Open rates appear here after you send emails with <b>Track opens</b> switched on.</p></div>`}
      </div>
    </div>`);

  const list = $('#active-list');
  if (d.active.length) {
    const rows = await Promise.all(d.active.map((m) => api(`/messages/${m.id}`).catch(() => null)));
    mount(list, html`<div class="stack tight">${rows.filter(Boolean).map((m) => html`
      <a href="#/history/${m.id}" class="row between" style="text-decoration:none;color:inherit;padding:8px 0;border-bottom:1px solid var(--border)">
        <div class="grow"><div class="ellipsis"><b>${m.subject}</b></div><div class="tiny muted">${timeAgo(m.created_at)} · ${fmtNum(m.sent)} of ${fmtNum(m.total)} sent</div></div>
        ${progressBar(m, 'mini-progress')} ${statusBadge(m.status)}
      </a>`)}</div>`);
  }
  return undefined;
}

boot();
