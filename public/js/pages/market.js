import {
  state, api, esc, rm, icon, page, actions, forms, changes, inputs, cover, thumb, stars, avatar, campusName, emptyState,
  saveCart, cartCount, cartTotal, openModal, closeOverlay, toast, confirmDialog, timeAgo, CAT_EMOJI, hooks
} from '../core.js';

const filters = { q: '', campus: 'ALL', category: 'ALL', sort: 'popular' };
let searchTimer = null;

// =====================================================================
// HOME / MARKETPLACE
// =====================================================================
page('/', async () => {
  const c = state.config;
  c.stats = (await api('GET', '/api/config')).stats;
  const hello = state.me ? `Hai ${esc(state.me.name.split(' ')[0])} 👋 ` : '';
  const html = `
    <div class="stack-lg">
      <section class="hero">
        <span class="tag">${icon('sparkles')} Platform Rasmi Komuniti UPSI</span>
        <h1>${hello}Makanan, prebet & servis runner kampus – pesan & bayar terus di sini.</h1>
        <p>Tiada WhatsApp, tiada gateway luar. Pesan, bayar dengan Dompet UPSIHub, dan chat terus dengan peniaga dalam satu aplikasi.</p>
        <div class="hero-feats">
          <span>${icon('shield')} Peniaga disahkan admin</span>
          <span>${icon('wallet')} Bayaran dompet dalaman</span>
          <span>${icon('chat')} Chat masa nyata</span>
          <span>${icon('truck')} Jejak status pesanan</span>
        </div>
        <div class="hero-stats">
          <div><b>${c.stats.shops}</b><span>Peniaga aktif</span></div>
          <div><b>${c.stats.users}</b><span>Pengguna</span></div>
          <div><b>${c.stats.orders}</b><span>Pesanan selesai</span></div>
        </div>
      </section>

      <section class="card filters">
        <div class="filters-row">
          <div class="input-icon grow">${icon('search')}<input class="input" type="search" placeholder="Cari kedai, makanan (cth: nasi lemak), print, prebet…" value="${esc(filters.q)}" data-input="searchShops" aria-label="Cari"></div>
          <select class="input sel" data-change="filterCampus" aria-label="Kampus">
            <option value="ALL">Semua kampus & kawasan</option>
            ${Object.entries(c.campuses).map(([k, v]) => `<option value="${k}" ${filters.campus === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
          <select class="input sel" data-change="filterSort" aria-label="Susunan">
            ${[['popular', 'Paling popular'], ['rating', 'Penilaian tertinggi'], ['cheapest', 'Harga terendah'], ['newest', 'Terbaharu']].map(([k, v]) => `<option value="${k}" ${filters.sort === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="chips" role="tablist">
          <button class="chip ${filters.category === 'ALL' ? 'active' : ''}" data-act="filterCategory" data-cat="ALL">Semua</button>
          ${c.categories.map((cat) => `<button class="chip ${filters.category === cat ? 'active' : ''}" data-act="filterCategory" data-cat="${esc(cat)}">${CAT_EMOJI[cat] || ''} ${esc(cat)}</button>`).join('')}
        </div>
      </section>

      <section id="shopGrid" class="grid-3"></section>
    </div>`;
  return { html, after: loadShops };
});

async function loadShops() {
  const grid = document.getElementById('shopGrid');
  if (!grid) return;
  const qs = new URLSearchParams(filters).toString();
  const { shops } = await api('GET', `/api/shops?${qs}`);
  if (!document.body.contains(grid)) return;
  if (!shops.length) {
    grid.className = '';
    grid.innerHTML = `<div class="card">${emptyState('store', 'Tiada peniaga ditemui', 'Carian anda tidak sepadan dengan mana-mana kedai aktif. Cuba kata kunci atau kampus lain.')}</div>`;
    return;
  }
  grid.className = 'grid-3';
  grid.innerHTML = shops.map(shopCard).join('');
}

function shopCard(s) {
  return `
    <article class="card shop-card" data-act="openShop" data-id="${s.id}" tabindex="0">
      <div class="cover">
        ${cover(s)}
        <span class="badge b-left"><span class="bullet" style="color:${s.is_open ? '#34d399' : '#fb7185'}"></span>${s.is_open ? 'Buka' : 'Tutup'}</span>
        <span class="badge b-right">${esc(s.campus)}</span>
      </div>
      <div class="body">
        <div class="eyebrow">${esc(s.category)}</div>
        <h3 class="clamp-1">${esc(s.name)}</h3>
        <p class="small muted clamp-2">${esc(s.description)}</p>
        <div class="shop-meta">
          <span>${icon('star', 'star')} ${s.reviews ? `<b>${s.rating.toFixed(1)}</b> (${s.reviews})` : 'Baharu'}</span>
          <span>${icon('package')} ${s.item_count} item${s.from_price != null ? ` · dari ${rm(s.from_price)}` : ''}</span>
          <span>${icon('truck')} ${s.delivery_fee ? rm(s.delivery_fee) : 'Percuma'}</span>
        </div>
      </div>
    </article>`;
}

Object.assign(actions, {
  openShop: (el) => { location.hash = `#/shop/${el.dataset.id}`; },
  filterCategory(el) {
    filters.category = el.dataset.cat;
    document.querySelectorAll('[data-act="filterCategory"]').forEach((b) => b.classList.toggle('active', b === el));
    return loadShops();
  }
});
Object.assign(changes, {
  filterCampus: (el) => { filters.campus = el.value; return loadShops(); },
  filterSort: (el) => { filters.sort = el.value; return loadShops(); }
});
inputs.searchShops = (el) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = el.value.trim(); loadShops(); }, 250);
};

// =====================================================================
// SHOP DETAIL
// =====================================================================
page('/shop/:id', async ({ id }) => {
  const { shop, items, reviews } = await api('GET', `/api/shops/${id}`);
  const inCart = state.cart.shopId === shop.id ? state.cart.items : {};
  const mine = state.me?.id === shop.owner_id;
  const html = `
    <div class="stack-lg">
      <a href="#/" class="btn btn-link small" style="align-self:flex-start">${icon('back')} Kembali ke Pasar</a>
      ${shop.status !== 'APPROVED' ? `<div class="alert warn">${icon('info')}<div>Pratonton – kedai ini belum dipaparkan kepada pelajar (status: ${esc(shop.status)}).</div></div>` : ''}
      <section class="card shop-hero">
        <div class="cover">${cover(shop)}
          <span class="badge b-left"><span class="bullet" style="color:${shop.is_open ? '#34d399' : '#fb7185'}"></span>${shop.is_open ? 'Buka sekarang' : 'Tutup'}</span>
          <span class="badge b-right">${esc(shop.campus)}</span>
        </div>
        <div class="info">
          <div class="between" style="align-items:flex-start;flex-wrap:wrap">
            <div class="stack-sm grow">
              <div class="eyebrow">${esc(shop.category)}</div>
              <h1 style="font-size:26px;font-weight:850">${esc(shop.name)}</h1>
              <div class="row-wrap small muted">
                <span>${stars(shop.rating)} ${shop.reviews ? `<b>${shop.rating.toFixed(1)}</b> · ${shop.reviews} ulasan` : 'Belum ada ulasan'}</span>
                <span>· ${shop.orders} pesanan selesai</span>
              </div>
            </div>
            ${mine ? `<a class="btn btn-ghost" href="#/seller">${icon('grid')} Urus kedai</a>` : `<button class="btn btn-primary" data-act="chatShop" data-id="${shop.id}">${icon('chat')} Chat peniaga</button>`}
          </div>
          <p class="muted">${esc(shop.description)}</p>
          <div class="row-wrap small">
            <span class="badge">${icon('pin')} ${esc(campusName(shop.campus))}</span>
            ${shop.hours ? `<span class="badge">${icon('clock')} ${esc(shop.hours)}</span>` : ''}
            <span class="badge">${icon('truck')} Penghantaran ${shop.delivery_fee ? rm(shop.delivery_fee) : 'percuma'}</span>
            ${shop.min_order ? `<span class="badge">Min. pesanan ${rm(shop.min_order)}</span>` : ''}
            <span class="badge ${shop.allow_cash ? '' : 'blue'}">${icon('wallet')} ${shop.allow_cash ? 'Dompet / Tunai' : 'Dompet sahaja'}</span>
          </div>
          <div class="row small faint">${avatar(shop.owner, 'sm')} Dikendalikan oleh <b class="muted">${esc(shop.owner.name)}</b>${shop.owner.online ? ' · <span style="color:var(--accent-600)">dalam talian</span>' : ''}</div>
        </div>
      </section>

      <div class="grid" style="grid-template-columns:minmax(0,1fr)">
        <section class="stack">
          <h2 class="section-title">Menu & Perkhidmatan</h2>
          ${!shop.is_open ? `<div class="alert warn">${icon('clock')}<div>Kedai sedang tutup. Anda boleh melihat menu tetapi pesanan hanya boleh dibuat semasa kedai dibuka.</div></div>` : ''}
          <div class="stack-sm">
            ${items.length ? items.map((it) => menuRow(it, shop, inCart[it.id]?.qty || 0, mine)).join('') : `<div class="card">${emptyState('package', 'Tiada menu lagi', 'Peniaga belum menambah sebarang item.')}</div>`}
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2 class="section-title">Ulasan Pelanggan</h2><span class="small muted">${shop.reviews} ulasan</span></div>
          <div class="card-body" style="padding-top:4px;padding-bottom:4px">
            ${reviews.length ? reviews.map((r) => `
              <div class="review">
                <div class="between"><div class="row">${avatar({ name: r.name }, 'sm')}<b class="small">${esc(r.name)}</b></div><span class="xs faint">${timeAgo(r.created_at)}</span></div>
                <div style="margin:6px 0 2px">${stars(r.rating)}</div>
                ${r.comment ? `<p class="small muted">${esc(r.comment)}</p>` : ''}
              </div>`).join('') : `<p class="small faint" style="padding:16px 0">Jadilah yang pertama memberi ulasan selepas pesanan anda selesai.</p>`}
          </div>
        </section>
      </div>
    </div>`;
  return { html, after: () => { currentShop = shop; renderCartFab(); } };
});

let currentShop = null;

function menuRow(it, shop, qty, mine) {
  const canOrder = !mine && shop.is_open && it.available && shop.status === 'APPROVED';
  return `
    <div class="menu-item ${it.available ? '' : 'off'}">
      ${thumb(it)}
      <div class="grow">
        <div class="bold">${esc(it.title)}</div>
        ${it.description ? `<div class="small muted clamp-2">${esc(it.description)}</div>` : ''}
        <div class="price" style="margin-top:4px">${rm(it.price)}</div>
        ${!it.available ? '<span class="badge red" style="margin-top:4px">Habis</span>' : ''}
      </div>
      <div data-qty-for="${it.id}">${canOrder ? qtyControl(it, qty) : ''}</div>
    </div>`;
}
function qtyControl(it, qty) {
  const data = `data-id="${it.id}" data-title="${esc(it.title)}" data-price="${it.price}"`;
  if (!qty) return `<button class="btn btn-primary btn-sm" data-act="cartAdd" ${data}>${icon('plus')} Tambah</button>`;
  return `<div class="qty"><button data-act="cartDec" ${data} aria-label="Kurang">${icon('minus')}</button><span>${qty}</span><button data-act="cartAdd" ${data} aria-label="Tambah">${icon('plus')}</button></div>`;
}

// =====================================================================
// CART
// =====================================================================
async function ensureCartShop() {
  const s = currentShop;
  if (state.cart.shopId && state.cart.shopId !== s.id && cartCount() > 0) {
    const ok = await confirmDialog(`Troli anda mengandungi item daripada "${state.cart.shopName}". Kosongkan troli dan mula pesanan baharu di kedai ini?`, { ok: 'Kosongkan & tambah' });
    if (!ok) return false;
    state.cart.items = {};
  }
  state.cart.shopId = s.id;
  state.cart.shopName = s.name;
  state.cart.shop = { delivery_fee: s.delivery_fee, min_order: s.min_order, allow_cash: s.allow_cash };
  return true;
}
function refreshQty(id) {
  const box = document.querySelector(`[data-qty-for="${id}"]`);
  const line = state.cart.items[id];
  const btn = document.querySelector(`[data-act="cartAdd"][data-id="${id}"]`);
  if (box && btn) box.innerHTML = qtyControl({ id, title: btn.dataset.title, price: Number(btn.dataset.price) }, line?.qty || 0);
  renderCartFab();
}
function renderCartFab() {
  document.querySelector('.cart-fab')?.remove();
  const n = cartCount();
  if (!n || !location.hash.startsWith('#/shop/')) return;
  const fab = document.createElement('button');
  fab.className = 'cart-fab fade-in';
  fab.dataset.act = 'openCart';
  fab.innerHTML = `<span class="row">${icon('bag')} ${n} item · ${esc(state.cart.shopName)}</span><span>${rm(cartTotal())} ${icon('right')}</span>`;
  document.getElementById('view').appendChild(fab);
}

Object.assign(actions, {
  async cartAdd(el) {
    if (!(await ensureCartShop())) return;
    const id = el.dataset.id;
    const line = state.cart.items[id] || { id: Number(id), title: el.dataset.title, price: Number(el.dataset.price), qty: 0 };
    line.qty = Math.min(99, line.qty + 1);
    state.cart.items[id] = line;
    saveCart();
    refreshQty(id);
  },
  cartDec(el) {
    const id = el.dataset.id;
    const line = state.cart.items[id];
    if (!line) return;
    line.qty -= 1;
    if (line.qty <= 0) delete state.cart.items[id];
    saveCart();
    refreshQty(id);
    if (document.querySelector('.drawer')) actions.openCart();
  },
  cartInc(el) {
    const line = state.cart.items[el.dataset.id];
    if (!line) return;
    line.qty = Math.min(99, line.qty + 1);
    saveCart();
    actions.openCart();
  },
  cartClear() {
    state.cart = { shopId: null, shopName: '', items: {} };
    saveCart();
    closeOverlay();
    renderCartFab();
    if (location.hash.startsWith('#/shop/')) window.dispatchEvent(new CustomEvent('uh:refresh'));
  },
  async chatShop(el) {
    if (!state.me) { location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1))}`; return; }
    const { chat } = await api('POST', '/api/chats', { shopId: Number(el.dataset.id) });
    location.hash = `#/chat/${chat.id}`;
  },
  openCart() {
    const lines = Object.values(state.cart.items);
    const scroll = document.querySelector('.drawer .modal-body')?.scrollTop || 0;
    if (!lines.length) {
      openModal({ title: 'Troli', drawer: true, body: emptyState('bag', 'Troli anda kosong', 'Pilih kedai di Pasar Kampus dan tambah item untuk mula memesan.', '<a class="btn btn-primary" href="#/">Lihat Pasar</a>') });
      return;
    }
    const shop = state.cart.shop || { delivery_fee: 0, min_order: 0, allow_cash: true };
    const draft = cartDraft;
    const body = `
      <form id="checkoutForm" data-form="checkout" class="stack">
        <div class="between"><div><div class="eyebrow">Pesanan daripada</div><a class="bold" href="#/shop/${state.cart.shopId}">${esc(state.cart.shopName)}</a></div><button type="button" class="btn btn-link small" data-act="cartClear">Kosongkan</button></div>
        <div class="stack-sm">
          ${lines.map((l) => `
            <div class="row">
              <div class="grow"><div class="small bold">${esc(l.title)}</div><div class="xs muted">${rm(l.price)} seunit</div></div>
              <div class="qty"><button type="button" data-act="cartDec" data-id="${l.id}">${icon('minus')}</button><span>${l.qty}</span><button type="button" data-act="cartInc" data-id="${l.id}">${icon('plus')}</button></div>
              <div class="bold small right" style="width:72px">${rm(l.price * l.qty)}</div>
            </div>`).join('')}
        </div>
        <hr class="sep">
        <div class="field"><label>Kaedah penerimaan</label>
          <div class="seg">
            <label><input type="radio" name="fulfilment" value="DELIVERY" ${draft.fulfilment !== 'PICKUP' ? 'checked' : ''} data-change="cartDraft">${icon('truck')} Hantar</label>
            <label><input type="radio" name="fulfilment" value="PICKUP" ${draft.fulfilment === 'PICKUP' ? 'checked' : ''} data-change="cartDraft">${icon('store')} Ambil sendiri</label>
          </div>
        </div>
        <div class="field ${draft.fulfilment === 'PICKUP' ? 'hidden' : ''}" id="addrField"><label>Lokasi penghantaran *</label>
          <input class="input" name="address" maxlength="200" placeholder="Cth: Kolej Za'ba, Blok B, Bilik 2-14" value="${esc(draft.address || '')}" data-input="cartDraft"></div>
        <div class="field"><label>Nota kepada peniaga</label>
          <textarea class="input" name="note" rows="2" maxlength="300" placeholder="Cth: Kurang pedas, sambal asing" data-input="cartDraft">${esc(draft.note || '')}</textarea></div>
        <div class="field"><label>Kaedah bayaran</label>
          <label class="radio-card"><input type="radio" name="payment" value="WALLET" ${draft.payment !== 'CASH' ? 'checked' : ''} data-change="cartDraft">
            <div class="grow"><div class="bold small">${icon('wallet')} Dompet UPSIHub</div><div class="xs muted">Baki: <b data-balance>${state.me ? rm(state.me.balance) : '—'}</b> · Wang dipegang sehingga pesanan selesai</div></div></label>
          <label class="radio-card ${shop.allow_cash ? '' : 'disabled'}"><input type="radio" name="payment" value="CASH" ${draft.payment === 'CASH' && shop.allow_cash ? 'checked' : ''} ${shop.allow_cash ? '' : 'disabled'} data-change="cartDraft">
            <div class="grow"><div class="bold small">${icon('banknote')} Tunai semasa terima</div><div class="xs muted">${shop.allow_cash ? 'Bayar terus kepada peniaga' : 'Tidak diterima oleh kedai ini'}</div></div></label>
        </div>
        <div class="line-items" id="cartSummary">${summary(shop)}</div>
      </form>`;
    openModal({
      title: 'Troli & Checkout', drawer: true, body,
      foot: `<button class="btn btn-primary btn-lg btn-block" type="submit" form="checkoutForm">${icon('check')} Buat pesanan</button>`
    });
    document.querySelector('.drawer .modal-body').scrollTop = scroll;
  }
});

const cartDraft = { fulfilment: 'DELIVERY', payment: 'WALLET', address: '', note: '' };
function summary(shop) {
  const sub = cartTotal();
  const fee = cartDraft.fulfilment === 'PICKUP' ? 0 : shop.delivery_fee;
  const short = shop.min_order && sub < shop.min_order;
  return `
    <div><span class="muted">Jumlah kecil</span><span>${rm(sub)}</span></div>
    <div><span class="muted">Caj penghantaran</span><span>${fee ? rm(fee) : 'Percuma'}</span></div>
    <div class="total-row"><span>Jumlah</span><span class="price">${rm(sub + fee)}</span></div>
    ${short ? `<div class="alert warn small">${icon('info')}<div>Pesanan minimum ${rm(shop.min_order)}. Tambah ${rm(shop.min_order - sub)} lagi.</div></div>` : ''}
    ${cartDraft.payment === 'WALLET' && state.me && state.me.balance < sub + fee ? `<div class="alert danger small">${icon('wallet')}<div>Baki tidak mencukupi. <a class="bold" href="#/wallet?topup=1">Tambah nilai dompet</a></div></div>` : ''}`;
}
changes.cartDraft = inputs.cartDraft = (el) => {
  cartDraft[el.name] = el.value;
  if (el.name === 'fulfilment') document.getElementById('addrField')?.classList.toggle('hidden', el.value === 'PICKUP');
  const box = document.getElementById('cartSummary');
  if (box && el.type === 'radio') box.innerHTML = summary(state.cart.shop || { delivery_fee: 0, min_order: 0 });
};

forms.checkout = async (data) => {
  if (!state.me) {
    closeOverlay();
    toast('Sila log masuk untuk membuat pesanan.', 'info');
    location.hash = `#/login?next=${encodeURIComponent(`/shop/${state.cart.shopId}`)}`;
    return;
  }
  const { order } = await api('POST', '/api/orders', {
    shopId: state.cart.shopId,
    items: Object.values(state.cart.items).map((l) => ({ id: l.id, qty: l.qty })),
    fulfilment: data.fulfilment, address: data.address, note: data.note, payment: data.payment
  });
  state.cart = { shopId: null, shopName: '', items: {} };
  saveCart();
  cartDraft.note = '';
  if (order.payment === 'WALLET') await hooks.loadMe();
  closeOverlay();
  toast(`Pesanan ${order.code} dihantar kepada peniaga.`, 'success', { title: 'Pesanan berjaya!' });
  location.hash = `#/orders/${order.id}`;
};

window.addEventListener('uh:cart', renderCartFab);
