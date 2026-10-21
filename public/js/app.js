import {
  state, api, esc, rm, icon, avatar, toast, timeAgo, actions, forms, changes, inputs, routes, emit, onPage,
  clearPageListeners, closeOverlay, overlayOpen, setBusy, uploadImage, skeletonView, cartCount, emptyState, hooks,
  openGallery, redrawImagesField, GAS
} from './core.js';
import './pages/market.js';
import './pages/explore.js';
import './pages/listings.js';
import './pages/account.js';
import './pages/orders.js';
import './pages/wallet.js';
import './pages/chat.js';
import './pages/seller.js';
import './pages/admin.js';

const view = document.getElementById('view');

// =====================================================================
// SHELL: navigation & top actions
// =====================================================================
function navItems() {
  const items = [
    { href: '#/', ic: 'home', label: 'Utama', match: /^\/(shops?(\/.*)?|search|market|rooms|jobs|events|lost|transport|services|listing\/.*|post|my|u\/.*)?$/ },
    { href: '#/orders', ic: 'receipt', label: 'Pesanan', match: /^\/orders/ },
    { href: '#/chat', ic: 'chat', label: 'Chat', match: /^\/chat/, badge: state.unread.chat },
    { href: '#/wallet', ic: 'wallet', label: 'Dompet', match: /^\/wallet/ },
    { href: '#/seller', ic: 'grid', label: 'Peniaga', match: /^\/seller/ }
  ];
  if (state.me?.role === 'admin') {
    items.splice(items.length - 1, 1, { href: '#/admin', ic: 'shield', label: 'Admin', match: /^\/admin/ });
  }
  return items;
}

function renderShell() {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const items = navItems();
  const link = (i, mobile) => `<a href="${i.href}" class="${i.match.test(path) ? 'active' : ''}">${icon(i.ic)}<span>${i.label}</span>${i.badge ? `<span class="dot" data-n="${i.badge}">${i.badge > 99 ? '99+' : i.badge}</span>` : ''}</a>`;
  document.getElementById('navDesktop').innerHTML = items.map((i) => link(i)).join('');
  document.getElementById('navMobile').innerHTML = items.map((i) => link(i, true)).join('');

  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const n = cartCount();
  document.getElementById('topActions').innerHTML = `
    <button class="icon-btn hide-sm" data-act="toggleTheme" aria-label="Tukar tema">${icon(dark ? 'sun' : 'moon')}</button>
    <a class="btn btn-ghost hide-sm" href="#/post">${icon('plus')} Iklan</a>
    <button class="icon-btn" data-act="openCart" aria-label="Troli">${icon('bag')}<span class="dot" data-n="${n}">${n}</span></button>
    ${state.me ? `
      <button class="icon-btn" data-act="openNotifications" aria-label="Notifikasi">${icon('bell')}<span class="dot" data-n="${state.unread.notifications}">${state.unread.notifications > 99 ? '99+' : state.unread.notifications}</span></button>
      <button class="btn btn-ghost" style="padding:4px 10px 4px 4px;border-radius:99px" data-act="openUserMenu" aria-label="Akaun">
        ${avatar(state.me, 'sm')}<span class="small bold hide-sm" data-balance>${rm(state.me.balance)}</span>
      </button>` : `
      <a class="btn btn-primary" href="#/login">${icon('user')}<span>Log Masuk</span></a>`}`;
}

// =====================================================================
// ROUTER
// =====================================================================
let renderSeq = 0;
let lastPath = null;
async function router() {
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const query = new URLSearchParams(qs || '');
  closeOverlay();
  document.querySelector('.popover')?.remove();
  clearPageListeners();
  state.activeChat = null;

  let match = null;
  let r = null;
  for (const candidate of routes) {
    match = candidate.re.exec(path);
    if (match) { r = candidate; break; }
  }
  renderShell();
  if (!r) { view.innerHTML = emptyState('help', 'Halaman tidak dijumpai', 'Pautan ini mungkin telah berubah.', '<a class="btn btn-primary" href="#/">Ke Pasar Kampus</a>'); return; }
  if ((r.auth || r.admin) && !state.me) { location.replace(`#/login?next=${encodeURIComponent(hash)}`); return; }
  if (r.admin && state.me.role !== 'admin') { view.innerHTML = emptyState('lock', 'Akses ditolak', 'Halaman ini untuk pentadbir sahaja.'); return; }

  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
  const seq = ++renderSeq;
  const samePage = lastPath && lastPath.split('/')[1] === path.split('/')[1];
  if (!samePage) view.innerHTML = skeletonView();
  try {
    const out = await r.render(params, query);
    if (seq !== renderSeq) return;
    const { html, after } = typeof out === 'string' ? { html: out } : out;
    view.innerHTML = `<div class="fade-in">${html}</div>`;
    after?.(view);
    if (!samePage) window.scrollTo(0, 0);
    lastPath = path;
  } catch (err) {
    if (seq !== renderSeq) return;
    view.innerHTML = emptyState('alert', 'Ralat memuatkan halaman', err.message, '<button class="btn btn-primary" data-act="reload">Cuba lagi</button>');
  }
}

// =====================================================================
// SESSION & REALTIME
// =====================================================================
let stream = null;
async function loadMe() {
  const data = await api('GET', '/api/me');
  state.me = data.user;
  state.shop = data.shop || null;
  state.unread = data.unread || { chat: 0, notifications: 0 };
  if (state.me) connectStream(); else disconnectStream();
}
function disconnectStream() { stream?.close(); stream = null; }

function onMessage(msg) {
  if (msg.sender_id !== state.me?.id && state.activeChat !== msg.conversation_id) {
    state.unread.chat += 1;
    renderShell();
    toast(msg.body || '📷 Gambar', 'info', { title: 'Mesej baharu', link: `#/chat/${msg.conversation_id}` });
  }
  emit('uh:message', msg);
}
function onNotification(n) {
  if (n.link?.startsWith('#/chat/')) return; // chat already has its own toast
  state.unread.notifications += 1;
  renderShell();
  toast(n.body || '', 'info', { title: n.title, link: n.link, timeout: 6000 });
}
function onWallet(balance) {
  if (state.me) state.me.balance = balance;
  document.querySelectorAll('[data-balance]').forEach((el) => { el.textContent = rm(balance); });
  emit('uh:wallet', { balance });
}

function connectStream() {
  if (stream) return;
  if (GAS) { stream = pollStream(); return; }
  stream = new EventSource('/api/stream');
  stream.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
  stream.addEventListener('notification', (e) => onNotification(JSON.parse(e.data)));
  stream.addEventListener('order', (e) => emit('uh:order', JSON.parse(e.data)));
  stream.addEventListener('read', (e) => emit('uh:read', JSON.parse(e.data)));
  stream.addEventListener('wallet', (e) => onWallet(JSON.parse(e.data).balance));
}

// Apps Script has no server push, so ask for changes every few seconds (slower in a
// background tab). Windows overlap a little to tolerate clock drift; ids are de-duplicated.
function pollStream() {
  let closed = false, busy = false, timer = null, since = 0, balance = state.me?.balance;
  const seen = { m: new Set(), n: new Set(), o: new Map(), r: new Map() };
  const once = (set, id) => (set.has(id) ? false : (set.add(id), true));
  async function tick() {
    if (closed || busy) return;
    busy = true;
    try {
      const d = await api('GET', `/api/poll?since=${since ? since - 30000 : 0}`);
      if (closed) return;
      if (d.changed && since) {
        d.messages.forEach((m) => { if (once(seen.m, m.id)) onMessage(m); });
        d.notifications.forEach((n) => { if (once(seen.n, n.id)) onNotification(n); });
        d.orders.forEach((o) => { if (seen.o.get(o.id) !== o.updated_at) { seen.o.set(o.id, o.updated_at); emit('uh:order', o); } });
        d.reads.forEach((r) => { if (seen.r.get(r.conversation_id) !== r.at) { seen.r.set(r.conversation_id, r.at); emit('uh:read', r); } });
        if (d.balance !== balance) { balance = d.balance; onWallet(balance); }
      }
      since = d.now;
    } catch {}
    busy = false;
    clearTimeout(timer);
    if (!closed) timer = setTimeout(tick, document.hidden ? 60000 : 6000);
  }
  const wake = () => { if (!document.hidden && !closed) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', wake);
  tick();
  return { close() { closed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); } };
}

// =====================================================================
// GLOBAL ACTIONS
// =====================================================================
Object.assign(actions, {
  closeOverlay,
  reload: () => router(),
  gallery(el, e) {
    e.stopPropagation();
    openGallery(JSON.parse(el.dataset.images), Number(el.dataset.index) || 0);
  },
  removeImg(el) {
    const scope = el.closest('form') || document;
    const input = scope.querySelector(`input[name="${el.dataset.name}"]`);
    redrawImagesField(scope, el.dataset.name, JSON.parse(input.value).filter((s) => s !== el.dataset.src));
  },
  zoom(el) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `<img src="${esc(el.dataset.src || el.src)}" alt="">`;
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  },
  toggleTheme() {
    const root = document.documentElement;
    const isDark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = isDark ? 'light' : 'dark';
    try { localStorage.setItem('uh_theme', root.dataset.theme); } catch {}
    renderShell();
  },
  clearImage(el) {
    const name = el.dataset.target;
    const form = el.closest('form') || document;
    form.querySelector(`input[name="${name}"]`).value = '';
    form.querySelector(`[data-preview="${name}"]`).innerHTML = icon('image');
    el.classList.add('hidden');
  },
  async openNotifications(el) {
    const existing = document.querySelector('.popover');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div');
    pop.className = 'popover card';
    pop.innerHTML = `<div class="card-head"><b>Notifikasi</b><button class="btn btn-link small" data-act="readAllNotif">Tandakan semua dibaca</button></div><div class="list"><div class="card-body"><div class="skeleton" style="height:60px"></div></div></div>`;
    document.body.appendChild(pop);
    const { notifications } = await api('GET', '/api/notifications');
    pop.querySelector('.list').innerHTML = notifications.length
      ? notifications.map((n) => `
          <div class="notif ${n.read ? '' : 'unread'}" data-act="openNotif" data-id="${n.id}" data-link="${esc(n.link || '')}">
            <span class="n-dot"></span>
            <div class="grow"><div class="bold small">${esc(n.title)}</div>${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ''}<div class="xs faint" style="margin-top:2px">${timeAgo(n.created_at)}</div></div>
          </div>`).join('')
      : emptyState('bell', 'Tiada notifikasi', 'Kemas kini pesanan, dompet & mesej akan muncul di sini.');
  },
  async openNotif(el) {
    document.querySelector('.popover')?.remove();
    if (el.classList.contains('unread')) {
      api('POST', '/api/notifications/read', { id: Number(el.dataset.id) }).catch(() => {});
      state.unread.notifications = Math.max(0, state.unread.notifications - 1);
      renderShell();
    }
    if (el.dataset.link) location.hash = el.dataset.link;
  },
  async readAllNotif() {
    await api('POST', '/api/notifications/read');
    state.unread.notifications = 0;
    document.querySelectorAll('.notif.unread').forEach((n) => n.classList.remove('unread'));
    renderShell();
  },
  openUserMenu() {
    const existing = document.querySelector('.popover');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div');
    pop.className = 'popover card menu-pop';
    pop.style.width = '260px';
    pop.innerHTML = `
      <div class="card-head" style="justify-content:flex-start">${avatar(state.me)}<div class="grow"><div class="bold clamp-1">${esc(state.me.name)}</div><div class="xs faint clamp-1">${esc(state.me.email)}</div></div></div>
      <a href="#/profile">${icon('user')} Profil & Tetapan</a>
      <a href="#/wallet">${icon('wallet')} Dompet <span class="grow"></span><b data-balance>${rm(state.me.balance)}</b></a>
      <a href="#/orders">${icon('receipt')} Pesanan & Tempahan</a>
      <a href="#/my">${icon('tag')} Iklan Saya</a>
      <a href="#/seller">${icon('grid')} Pusat Peniaga</a>
      <button data-act="toggleTheme">${icon('moon')} Tukar tema gelap / cerah</button>
      ${state.me.role === 'admin' ? `<a href="#/admin">${icon('shield')} Panel Admin</a>` : `<button data-act="openSupport">${icon('headset')} Hubungi Sokongan</button>`}
      <hr class="sep">
      <button data-act="logout" style="color:var(--danger)">${icon('logout')} Log Keluar</button>`;
    document.body.appendChild(pop);
  },
  async openSupport() {
    document.querySelector('.popover')?.remove();
    const { chat } = await api('POST', '/api/chats', { support: true });
    location.hash = `#/chat/${chat.id}`;
  },
  async logout() {
    document.querySelector('.popover')?.remove();
    await api('POST', '/api/auth/logout');
    state.me = null;
    disconnectStream();
    toast('Anda telah log keluar.', 'success');
    location.hash = '#/';
    router();
  }
});

Object.assign(changes, {
  async pickImages(el) {
    const scope = el.closest('form') || document;
    const name = el.dataset.name;
    const field = scope.querySelector(`[data-images-field="${name}"]`);
    const list = JSON.parse(scope.querySelector(`input[name="${name}"]`).value);
    const files = [...el.files].slice(0, Number(field.dataset.max) - list.length);
    el.closest('.thumb-add').innerHTML = '<span class="spinner"></span>';
    try {
      for (const f of files) list.push(await uploadImage(f));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      redrawImagesField(scope, name, list);
    }
  },
  async pickImage(el) {
    const file = el.files?.[0];
    if (!file) return;
    const name = el.dataset.target;
    const form = el.closest('form') || document;
    const preview = form.querySelector(`[data-preview="${name}"]`);
    preview.innerHTML = '<span class="spinner"></span>';
    try {
      const url = await uploadImage(file);
      form.querySelector(`input[name="${name}"]`).value = url;
      preview.innerHTML = `<img src="${esc(url)}" alt="">`;
      form.querySelector(`[data-act="clearImage"][data-target="${name}"]`)?.classList.remove('hidden');
    } catch (err) {
      preview.innerHTML = icon('image');
      toast(err.message, 'error');
    } finally {
      el.value = '';
    }
  }
});

// ---------- event delegation (CSP forbids inline handlers) ----------
const run = (fn, ...args) => Promise.resolve().then(() => fn(...args)).catch((err) => toast(err.message, 'error'));
document.addEventListener('click', (e) => {
  if (e.target.matches?.('[data-overlay]')) { closeOverlay(); return; }
  const el = e.target.closest('[data-act]');
  if (!el) {
    const pop = document.querySelector('.popover');
    if (pop && !pop.contains(e.target) && !e.target.closest('[data-act^="open"]')) pop.remove();
    return;
  }
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  run(fn, el, e);
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = forms[form.dataset.form];
  if (!fn) return;
  const btn = form.querySelector('[type=submit]') || document.querySelector(`[form="${form.id}"][type=submit]`);
  setBusy(btn, true);
  try { await fn(Object.fromEntries(new FormData(form)), form, e.submitter); } catch (err) { toast(err.message, 'error'); } finally { setBusy(btn, false); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && changes[el.dataset.change]) run(changes[el.dataset.change], el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el && inputs[el.dataset.input]) run(inputs[el.dataset.input], el, e);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('.lightbox')) document.querySelector('.lightbox').remove();
    else if (overlayOpen()) closeOverlay();
    else document.querySelector('.popover')?.remove();
  }
});

window.addEventListener('hashchange', router);
window.addEventListener('uh:refresh', router);
window.addEventListener('uh:shell', renderShell);
window.addEventListener('uh:cart', renderShell);
window.addEventListener('uh:auth', async () => { await loadMe().catch(() => {}); router(); });

hooks.loadMe = loadMe;
hooks.renderShell = renderShell;

// =====================================================================
// BOOT
// =====================================================================
(async function boot() {
  try {
    [state.config] = await Promise.all([api('GET', '/api/config'), loadMe()]);
    if (state.config.announcement) document.getElementById('announceText').textContent = state.config.announcement;
    else document.getElementById('announce').classList.add('hidden');
  } catch (err) {
    view.innerHTML = emptyState('alert', 'Tidak dapat menyambung ke pelayan', err.message, '<button class="btn btn-primary" data-act="reload">Cuba lagi</button>');
    return;
  }
  if (state.config.needs_admin && !state.me && !location.hash.startsWith('#/login')) location.replace('#/login');
  router();
  if (!GAS && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();

export { router, renderShell, loadMe, connectStream };
