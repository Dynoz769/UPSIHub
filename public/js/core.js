import { icon } from './icons.js';
export { icon };

export const state = {
  me: null,
  shop: null,
  unread: { chat: 0, notifications: 0 },
  config: null,
  cart: loadCart(),
  activeChat: null
};

// ---------- formatting ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const rm = (sen) => 'RM' + (Number(sen || 0) / 100).toLocaleString('ms-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const toSen = (v) => Math.round(parseFloat(String(v).replace(',', '.')) * 100);
export const senToInput = (sen) => (Number(sen || 0) / 100).toFixed(2);
export const fmtDate = (ms, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(ms).toLocaleDateString('ms-MY', opts);
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (ms) => `${fmtDate(ms)}, ${fmtTime(ms)}`;
export const fmtDay = (ms) => new Date(ms).toLocaleDateString('ms-MY', { weekday: 'short', day: 'numeric', month: 'short' });
export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'baru sahaja';
  if (s < 3600) return `${Math.floor(s / 60)} min lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  if (s < 604800) return `${Math.floor(s / 86400)} hari lalu`;
  return fmtDate(ms);
}
export const initials = (name) => esc(String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase());
export function avatar(u, cls = '') {
  const online = u?.online ? ' online' : '';
  return `<span class="avatar ${cls}${online}">${u?.avatar ? `<img src="${esc(u.avatar)}" alt="">` : initials(u?.name)}</span>`;
}
export function stars(n, max = 5) {
  let out = '<span class="stars" aria-label="' + n + ' bintang">';
  for (let i = 1; i <= max; i++) out += icon('star', i <= Math.round(n) ? '' : 'off');
  return out + '</span>';
}
export const catEmoji = (name) => state.config?.category_emoji?.[name] || '🏪';
const hashIdx = (s, n = 4) => [...String(s || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % n;
export function cover(shop) {
  if (shop.image) return `<img src="${esc(shop.image)}" alt="" loading="lazy">`;
  return `<div class="cover-art c${hashIdx(shop.category)}">${catEmoji(shop.category)}</div>`;
}
export const LISTING_EMOJI = { ITEM: '📦', ROOM: '🏠', JOB: '💼', EVENT: '🎟️', LOST: '🔎' };
export function listingCover(l) {
  if (l.images?.[0]) return `<img src="${esc(l.images[0])}" alt="" loading="lazy">`;
  const emoji = l.kind === 'ITEM' ? catEmoji(l.category) : LISTING_EMOJI[l.kind];
  return `<div class="cover-art c${hashIdx(l.category || l.kind)}">${emoji}</div>`;
}

// How each order kind is described to buyers and sellers.
export const ORDER_KINDS = {
  ORDER: { label: 'Pesanan kedai', ic: 'bag', steps: ['Dipesan', 'Disediakan', 'Sedia', 'Selesai'], ready: 'Sedia diambil', done: 'Tandakan selesai' },
  RIDE: { label: 'Trip prebet', ic: 'car', steps: ['Ditempah', 'Disahkan', 'Dalam perjalanan', 'Selesai'], ready: 'Mula perjalanan', done: 'Trip selesai' },
  SERVICE: { label: 'Tempahan servis', ic: 'calendar', steps: ['Ditempah', 'Disahkan', 'Sedang berjalan', 'Selesai'], ready: 'Mula sesi', done: 'Sesi selesai' },
  RENTAL: { label: 'Sewa kereta', ic: 'key', steps: ['Ditempah', 'Disahkan', 'Kereta diserahkan', 'Dipulangkan'], ready: 'Serah kereta', done: 'Kereta dipulangkan' },
  ITEM: { label: 'Barang terpakai', ic: 'package', steps: ['Dibeli', 'Disahkan', 'Diserahkan', 'Selesai'], ready: 'Barang diserahkan', done: 'Tandakan selesai' },
  TICKET: { label: 'Tiket event', ic: 'ticket', steps: ['Dibeli', 'Disahkan', 'Tiket dikeluarkan', 'Selesai'], ready: 'Keluarkan tiket', done: 'Tandakan selesai' },
  ROOM: { label: 'Deposit bilik', ic: 'home', steps: ['Deposit dibayar', 'Diterima', 'Kunci diserahkan', 'Selesai'], ready: 'Serah kunci', done: 'Penyewa sudah masuk' }
};
export const isBooking = (o) => ['RIDE', 'SERVICE', 'RENTAL'].includes(o.kind);
// Local calendar date as YYYY-MM-DD.
export const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (s, n) => { const d = new Date(`${s}T00:00`); d.setDate(d.getDate() + n); return ymd(d); };
export function thumb(item, cls = '') {
  return `<div class="thumb ${cls}">${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy">` : initials(item.title)}</div>`;
}
export const campusName = (c) => state.config?.campuses?.[c] || c;

// ---------- API ----------
export async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error('Tiada sambungan internet. Sila cuba lagi.'); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || `Ralat ${res.status}`);
    err.status = res.status;
    if (res.status === 401 && state.me) { state.me = null; emit('uh:auth'); }
    throw err;
  }
  return data;
}

// ---------- events / delegation registries ----------
export const actions = {};
export const forms = {};
export const changes = {};
export const inputs = {};
const pageListeners = [];
export function onPage(evt, fn) { window.addEventListener(evt, fn); pageListeners.push([evt, fn]); }
export function clearPageListeners() { while (pageListeners.length) { const [e, f] = pageListeners.pop(); window.removeEventListener(e, f); } }
export const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

// ---------- cart (per-device convenience) ----------
function loadCart() {
  try { return JSON.parse(localStorage.getItem('uh_cart')) || { shopId: null, shopName: '', items: {} }; } catch { return { shopId: null, shopName: '', items: {} }; }
}
export function saveCart() {
  try { localStorage.setItem('uh_cart', JSON.stringify(state.cart)); } catch {}
  emit('uh:cart');
}
export const cartCount = () => Object.values(state.cart.items).reduce((s, i) => s + i.qty, 0);
export const cartTotal = () => Object.values(state.cart.items).reduce((s, i) => s + i.qty * i.price, 0);

// ---------- toasts ----------
export function toast(message, type = 'info', { title, link, timeout = 4000 } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'success' ? 'checkCircle' : type === 'error' ? 'alert' : 'bell')}<div>${title ? `<b>${esc(title)}</b>` : ''}${esc(message)}</div>`;
  el.addEventListener('click', () => { if (link) location.hash = link; el.remove(); });
  root.appendChild(el);
  while (root.children.length > 2) root.firstChild.remove();
  setTimeout(() => el.remove(), timeout);
}

// ---------- overlays ----------
export function openModal({ title, body, foot = '', wide = false, drawer = false }) {
  const root = document.getElementById('overlay-root');
  root.innerHTML = `
    <div class="overlay ${drawer ? 'drawer-overlay' : ''}" data-overlay>
      <div class="${drawer ? 'drawer' : `modal ${wide ? 'wide' : ''}`}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="btn btn-ghost btn-icon" data-act="closeOverlay" aria-label="Tutup">${icon('x')}</button></div>
        <div class="modal-body" style="${drawer ? 'flex:1' : ''}">${body}</div>
        ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
      </div>
    </div>`;
  document.body.style.overflow = 'hidden';
  const first = root.querySelector('input:not([type=hidden]), textarea, select');
  if (first && !drawer && window.matchMedia('(min-width: 640px)').matches) first.focus();
  return root.firstElementChild;
}
export function closeOverlay() {
  document.getElementById('overlay-root').innerHTML = '';
  document.body.style.overflow = '';
}
export const overlayOpen = () => !!document.querySelector('#overlay-root .overlay');

export function confirmDialog(message, { title = 'Pengesahan', ok = 'Ya, teruskan', danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="muted">${esc(message)}</p>${input ? `<div class="field"><label>${esc(input)}</label><input class="input" id="confirmInput" maxlength="200"></div>` : ''}`,
      foot: `<button class="btn btn-ghost" id="cfNo">Batal</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cfYes">${esc(ok)}</button>`
    });
    const done = (v) => { closeOverlay(); resolve(v); };
    document.getElementById('cfNo').onclick = () => done(false);
    document.getElementById('cfYes').onclick = () => done(input ? { value: document.getElementById('confirmInput').value } : true);
  });
}

export function setBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  } else if (btn.dataset.label) {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label;
    delete btn.dataset.label;
  }
}

// ---------- images: downscale on device, then upload to our own server ----------
export async function uploadImage(file, maxSize = 1280) {
  if (!file.type.startsWith('image/')) throw new Error('Sila pilih fail gambar.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL('image/jpeg', 0.85);
  const { url } = await api('POST', '/api/upload', { data });
  return url;
}

// Reusable image picker field. The hidden input carries the uploaded URL.
export function imageField(name, value, label = 'Gambar', hint = 'JPG/PNG, akan dimampatkan secara automatik.') {
  return `
    <div class="field">
      <label>${esc(label)}</label>
      <div class="upload-box">
        <div class="thumb" data-preview="${name}">${value ? `<img src="${esc(value)}" alt="">` : icon('image')}</div>
        <div class="grow stack-sm">
          <div class="row-wrap">
            <label class="btn btn-ghost btn-sm">${icon('upload')} Pilih gambar<input type="file" accept="image/*" hidden data-change="pickImage" data-target="${name}"></label>
            <button type="button" class="btn btn-link small ${value ? '' : 'hidden'}" data-act="clearImage" data-target="${name}">Buang</button>
          </div>
          <span class="hint">${esc(hint)}</span>
        </div>
        <input type="hidden" name="${name}" value="${esc(value || '')}">
      </div>
    </div>`;
}

export function statusBadge(status) {
  const map = {
    PENDING: ['amber', 'Menunggu'], ACCEPTED: ['blue', 'Disediakan'], READY: ['blue', 'Sedia'], COMPLETED: ['green', 'Selesai'],
    CANCELLED: ['red', 'Dibatalkan'], REJECTED: ['red', 'Ditolak'], APPROVED: ['green', 'Lulus'], SUSPENDED: ['red', 'Digantung'],
    PAID: ['green', 'Dibayar'], active: ['green', 'Aktif'], suspended: ['red', 'Digantung'],
    DISPUTED: ['amber', 'Dilaporkan'], OPEN: ['amber', 'Dalam semakan'], RESOLVED: ['green', 'Selesai'],
    ACTIVE: ['green', 'Aktif'], RESERVED: ['amber', 'Ditempah'], SOLD: ['red', 'Terjual'], CLOSED: ['', 'Ditutup'], REMOVED: ['red', 'Dipadam admin']
  };
  const [c, l] = map[status] || ['', status];
  return `<span class="badge ${c}"><span class="bullet"></span>${esc(l)}</span>`;
}

export function emptyState(ic, title, text, cta = '') {
  return `<div class="empty"><div class="em-ic">${icon(ic)}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${cta ? `<div style="margin-top:16px">${cta}</div>` : ''}</div>`;
}

export const skeletonView = () => `
  <div class="stack fade-in">
    <div class="skeleton" style="height:42px;width:40%"></div>
    <div class="grid-3">${'<div class="skeleton" style="height:240px"></div>'.repeat(3)}</div>
  </div>`;

// ---------- page registry (used by the router in app.js) ----------
export const routes = [];
export function page(pattern, render, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, render, ...opts });
}
export const go = (hash) => { if (location.hash === hash) emit('uh:refresh'); else location.hash = hash; };
export const refresh = () => emit('uh:refresh');
// Filled in by app.js so pages can reload the session without a circular import.
export const hooks = { loadMe: async () => {}, renderShell: () => {} };

// ---------- photo galleries ----------
// Multi-photo picker. The hidden input `name` holds a JSON array of uploaded URLs.
export function imagesField(name, values = [], { max = 5, label = 'Gambar', hint = 'Gambar pertama dijadikan gambar utama.' } = {}) {
  return `
    <div class="field" data-images-field="${name}" data-max="${max}">
      <label>${esc(label)} <span class="faint">(maks ${max})</span></label>
      <div class="multi-images">
        ${values.map((src) => `<div class="thumb"><img src="${esc(src)}" alt=""><button type="button" class="thumb-x" data-act="removeImg" data-name="${name}" data-src="${esc(src)}" aria-label="Buang">${icon('x')}</button></div>`).join('')}
        ${values.length < max ? `<label class="thumb thumb-add">${icon('plus')}<input type="file" accept="image/*" multiple hidden data-change="pickImages" data-name="${name}"></label>` : ''}
      </div>
      <input type="hidden" name="${name}" value="${esc(JSON.stringify(values))}">
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    </div>`;
}
export function redrawImagesField(scope, name, list) {
  const field = scope.querySelector(`[data-images-field="${name}"]`);
  const label = field.querySelector('label').firstChild.textContent.trim();
  const hint = field.querySelector('.hint')?.textContent || '';
  field.outerHTML = imagesField(name, list, { max: Number(field.dataset.max), label, hint });
}

// Small clickable photo strip (reviews, items) that opens the full-screen gallery.
export function photoStrip(images = [], size = 56) {
  if (!images.length) return '';
  const data = esc(JSON.stringify(images));
  return `<div class="photo-strip">${images.map((src, i) => `<button type="button" class="thumb" style="width:${size}px;height:${size}px" data-act="gallery" data-images='${data}' data-index="${i}"><img src="${esc(src)}" alt="" loading="lazy"></button>`).join('')}</div>`;
}

export function openGallery(images, start = 0) {
  let i = start;
  const box = document.createElement('div');
  box.className = 'lightbox gallery-box';
  const draw = () => {
    box.innerHTML = `
      <img src="${esc(images[i])}" alt="">
      ${images.length > 1 ? `
        <button class="gal-nav prev" aria-label="Sebelum">${icon('back')}</button>
        <button class="gal-nav next" aria-label="Seterusnya">${icon('right')}</button>
        <div class="gal-count">${i + 1} / ${images.length}</div>` : ''}
      <button class="gal-close" aria-label="Tutup">${icon('x')}</button>`;
  };
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.prev')) { i = (i - 1 + images.length) % images.length; draw(); }
    else if (e.target.closest('.next')) { i = (i + 1) % images.length; draw(); }
    else if (e.target.closest('.gal-close') || e.target === box) box.remove();
  });
  const onKey = (e) => {
    if (!document.body.contains(box)) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'ArrowLeft') { i = (i - 1 + images.length) % images.length; draw(); }
    if (e.key === 'ArrowRight') { i = (i + 1) % images.length; draw(); }
  };
  document.addEventListener('keydown', onKey);
  draw();
  document.body.appendChild(box);
}
