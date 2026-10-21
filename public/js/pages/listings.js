// Student listings: second-hand goods, rooms, part-time jobs, events and lost & found.
import {
  state, api, esc, rm, toSen, senToInput, icon, page, actions, forms, changes, inputs, refresh, openModal, closeOverlay, toast,
  confirmDialog, emptyState, avatar, statusBadge, fmtDate, fmtDateTime, timeAgo, catEmoji, hooks, ymd, stars, imagesField, photoStrip
} from '../core.js';
import { listingCard, listingPrice, listingSubtitle } from './cards.js';
import { orderCard } from './orders.js';

const KINDS = {
  ITEM: { path: '/market', title: 'Barang Terpakai', sub: 'Jual beli antara pelajar – buku, gajet, perabot & macam-macam lagi.', cta: 'Jual barang', ic: 'package' },
  ROOM: { path: '/rooms', title: 'Sewa Bilik & Rumah', sub: 'Bilik & rumah sewa sekitar KSAB, KSAS & Tanjung Malim.', cta: 'Iklankan bilik', ic: 'home' },
  JOB: { path: '/jobs', title: 'Kerja Part-time', sub: 'Kerja sambilan & tugasan freelance untuk pelajar.', cta: 'Iklankan kerja', ic: 'briefcase' },
  EVENT: { path: '/events', title: 'Event & Tiket', sub: 'Program kampus, konsert & bengkel – beli tiket terus dengan dompet.', cta: 'Iklankan event', ic: 'ticket' },
  LOST: { path: '/lost', title: 'Hilang & Jumpa', sub: 'Kehilangan sesuatu atau terjumpa barang orang? Kongsi di sini.', cta: 'Lapor barang', ic: 'search' }
};
const M = () => state.config.listing_meta;
const opts = (map, current, all) => `${all ? `<option value="ALL">${all}</option>` : ''}${Object.entries(map).map(([k, v]) => `<option value="${k}" ${current === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;

// =====================================================================
// LIST PAGES
// =====================================================================
const filters = {};
for (const kind of Object.keys(KINDS)) {
  filters[kind] = { q: '', campus: 'ALL', category: 'ALL', sort: 'newest', max: '', room_type: 'ALL', gender: 'ALL', pay_unit: 'ALL', type: 'ALL' };
  page(KINDS[kind].path, () => listPage(kind));
}

function listPage(kind) {
  const k = KINDS[kind];
  const f = filters[kind];
  const c = state.config;
  const extra = {
    ITEM: `
      <select class="input sel" data-change="lf" data-k="sort">${opts({ newest: 'Terbaharu', cheap: 'Harga terendah', expensive: 'Harga tertinggi' }, f.sort)}</select>
      <div class="input-prefix sel"><span>≤RM</span><input class="input" type="number" min="1" placeholder="Harga maks" value="${esc(f.max)}" data-input="lfMax"></div>`,
    ROOM: `
      <select class="input sel" data-change="lf" data-k="room_type">${opts(M().room_types, f.room_type, 'Semua jenis bilik')}</select>
      <select class="input sel" data-change="lf" data-k="gender">${opts({ LELAKI: 'Untuk lelaki', PEREMPUAN: 'Untuk perempuan' }, f.gender, 'Lelaki & perempuan')}</select>
      <div class="input-prefix sel"><span>≤RM</span><input class="input" type="number" min="1" placeholder="Sewa maks" value="${esc(f.max)}" data-input="lfMax"></div>`,
    JOB: `<select class="input sel" data-change="lf" data-k="pay_unit">${opts(Object.fromEntries(Object.entries(M().pay_units).map(([k2, v]) => [k2, `Bayaran ${v}`])), f.pay_unit, 'Semua jenis bayaran')}</select>`,
    EVENT: '',
    LOST: `<select class="input sel" data-change="lf" data-k="type">${opts({ LOST: 'Barang hilang', FOUND: 'Barang dijumpai' }, f.type, 'Hilang & dijumpai')}</select>`
  }[kind];
  return {
    after: () => loadListings(kind),
    html: `
      <div class="stack">
        <div class="page-head"><div><h1>${k.title}</h1><p>${k.sub}</p></div><a class="btn btn-primary" href="#/post?kind=${kind}">${icon('plus')} ${k.cta}</a></div>
        <section class="card filters">
          <div class="filters-row">
            <div class="input-icon grow">${icon('search')}<input class="input" type="search" placeholder="Cari…" value="${esc(f.q)}" data-input="lfSearch" aria-label="Cari"></div>
            <select class="input sel" data-change="lf" data-k="campus">${opts(c.campuses, f.campus, 'Semua kampus & kawasan')}</select>
          </div>
          ${extra ? `<div class="filters-row">${extra}</div>` : ''}
          ${kind === 'ITEM' ? `<div class="chips">
            <button class="chip ${f.category === 'ALL' ? 'active' : ''}" data-act="lfCat" data-cat="ALL">Semua</button>
            ${c.market_categories.map((cat) => `<button class="chip ${f.category === cat ? 'active' : ''}" data-act="lfCat" data-cat="${esc(cat)}">${catEmoji(cat)} ${esc(cat)}</button>`).join('')}
          </div>` : ''}
        </section>
        <section id="listingGrid" class="grid-4" data-kind="${kind}"></section>
      </div>`
  };
}

async function loadListings(kind) {
  const grid = document.getElementById('listingGrid');
  if (!grid) return;
  const f = filters[kind];
  const qs = new URLSearchParams({ kind, ...f, max: f.max ? String(toSen(f.max)) : '' }).toString();
  const { listings } = await api('GET', `/api/listings?${qs}`);
  if (!document.body.contains(grid)) return;
  grid.className = listings.length ? 'grid-4' : '';
  grid.innerHTML = listings.length ? listings.map(listingCard).join('')
    : `<div class="card">${emptyState(KINDS[kind].ic, 'Tiada iklan ditemui', 'Cuba tukar penapis, atau jadi yang pertama memasang iklan.', `<a class="btn btn-primary" href="#/post?kind=${kind}">${KINDS[kind].cta}</a>`)}</div>`;
}
const currentKind = () => document.getElementById('listingGrid')?.dataset.kind;
changes.lf = (el) => { filters[currentKind()][el.dataset.k] = el.value; return loadListings(currentKind()); };
let lfTimer;
inputs.lfSearch = (el) => { clearTimeout(lfTimer); lfTimer = setTimeout(() => { filters[currentKind()].q = el.value.trim(); loadListings(currentKind()); }, 250); };
inputs.lfMax = (el) => { clearTimeout(lfTimer); lfTimer = setTimeout(() => { filters[currentKind()].max = el.value; loadListings(currentKind()); }, 350); };
actions.lfCat = (el) => {
  filters.ITEM.category = el.dataset.cat;
  document.querySelectorAll('[data-act="lfCat"]').forEach((b) => b.classList.toggle('active', b === el));
  return loadListings('ITEM');
};

// =====================================================================
// DETAIL
// =====================================================================
function detailRows(l) {
  const m = l.meta;
  const rows = [];
  if (l.kind === 'ITEM') rows.push(['Kategori', `${catEmoji(l.category)} ${esc(l.category)}`], ['Keadaan', esc(M().conditions[l.condition])], ...(l.stock > 1 ? [['Kuantiti', l.stock]] : []));
  if (l.kind === 'ROOM') {
    rows.push(['Jenis', esc(M().room_types[m.room_type])], ['Penyewa', esc(M().genders[m.gender])], ['Boleh masuk', esc(fmtDate(new Date(`${m.available_from}T00:00`).getTime()))]);
    if (m.deposit_note) rows.push(['Deposit', esc(m.deposit_note)]);
    if (m.booking_fee) rows.push(['Yuran tempahan dalam talian', rm(m.booking_fee)]);
  }
  if (l.kind === 'JOB') rows.push(['Majikan', esc(m.employer)], ['Bayaran', `${rm(l.price)} ${esc(M().pay_units[m.pay_unit])}`], ...(m.schedule ? [['Waktu kerja', esc(m.schedule)]] : []));
  if (l.kind === 'EVENT') rows.push(['Tarikh & masa', fmtDateTime(m.event_at)], ['Tempat', esc(m.venue)], ...(l.price ? [['Tiket tinggal', l.stock]] : [['Masuk', 'Percuma']]));
  if (l.kind === 'LOST') rows.push(['Jenis', esc(M().lost_types[m.type])], ['Tarikh', esc(m.date)]);
  rows.push(['Lokasi', `${esc(l.location || '-')} · ${esc(l.campus)}`]);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function primaryActions(l, mine) {
  if (mine) {
    return `
      <a class="btn btn-primary" href="#/listing/${l.id}/edit">${icon('edit')} Sunting</a>
      ${l.status === 'ACTIVE' && ['ITEM', 'ROOM'].includes(l.kind) ? `<button class="btn btn-ghost" data-act="listingStatus" data-id="${l.id}" data-status="SOLD">${icon('check')} Tanda ${l.kind === 'ROOM' ? 'sudah disewa' : 'terjual'}</button>` : ''}
      ${l.status === 'ACTIVE' ? `<button class="btn btn-ghost" data-act="listingStatus" data-id="${l.id}" data-status="CLOSED">${icon('lock')} Tutup iklan</button>` : ''}
      ${['CLOSED', 'SOLD'].includes(l.status) ? `<button class="btn btn-ghost" data-act="listingStatus" data-id="${l.id}" data-status="ACTIVE">${icon('refresh')} Aktifkan semula</button>` : ''}
      <button class="btn btn-danger" data-act="deleteListing" data-id="${l.id}">${icon('trash')} Padam</button>`;
  }
  const chat = (label) => `<button class="btn btn-ghost btn-lg" data-act="chatListing" data-id="${l.id}">${icon('chat')} ${label}</button>`;
  if (l.status !== 'ACTIVE') return chat('Chat pemilik');
  if (l.kind === 'ITEM') return `${l.price ? `<button class="btn btn-primary btn-lg" data-act="buyListing" data-id="${l.id}">${icon('bag')} Beli sekarang</button>` : ''}${chat(l.negotiable ? 'Chat & tawar harga' : 'Chat penjual')}`;
  if (l.kind === 'ROOM') return `${l.meta.booking_fee ? `<button class="btn btn-primary btn-lg" data-act="buyListing" data-id="${l.id}">${icon('home')} Bayar deposit tempahan ${rm(l.meta.booking_fee)}</button>` : ''}${chat('Chat & atur lawatan')}`;
  if (l.kind === 'EVENT') return `${l.price ? `<button class="btn btn-primary btn-lg" data-act="buyListing" data-id="${l.id}">${icon('ticket')} Beli tiket</button>` : ''}${chat('Tanya penganjur')}`;
  if (l.kind === 'JOB') return chat('Mohon melalui chat');
  return chat(l.meta.type === 'LOST' ? 'Saya jumpa barang ini' : 'Ini barang saya');
}

let currentListing = null;
page('/listing/:id', async ({ id }) => {
  const { listing: l, mine } = await api('GET', `/api/listings/${id}`);
  currentListing = l;
  const k = KINDS[l.kind];
  const imgs = l.images;
  return `
    <div class="stack-lg">
      <a href="#${k.path}" class="btn btn-link small" style="align-self:flex-start">${icon('back')} ${k.title}</a>
      ${l.status === 'REMOVED' ? `<div class="alert danger">${icon('ban')}<div><b>Iklan ini dipadam oleh admin.</b> ${esc(l.removed_reason || '')}</div></div>` : ''}
      <div class="listing-layout">
        <section class="card gallery">
          <div class="gallery-main" id="galleryMain">${imgs[0] ? `<img src="${esc(imgs[0])}" alt="" data-act="gallery" data-images='${esc(JSON.stringify(imgs))}' data-index="0">` : `<div class="cover-art c1" style="height:100%">${l.kind === 'ITEM' ? catEmoji(l.category) : { ROOM: '🏠', JOB: '💼', EVENT: '🎟️', LOST: '🔎' }[l.kind]}</div>`}</div>
          ${imgs.length > 1 ? `<div class="gallery-thumbs">${imgs.map((src, i) => `<button class="thumb ${i ? '' : 'on'}" data-act="galleryPick" data-src="${esc(src)}"><img src="${esc(src)}" alt=""></button>`).join('')}</div>` : ''}
        </section>
        <section class="stack">
          <div class="card pad stack">
            <div class="row-wrap"><span class="badge blue">${esc(k.title)}</span>${l.status !== 'ACTIVE' ? statusBadge(l.status) : ''}${l.negotiable ? '<span class="badge green">Boleh runding</span>' : ''}</div>
            <h1 style="font-size:24px;font-weight:850">${esc(l.title)}</h1>
            <div style="font-size:24px">${listingPrice(l)}</div>
            <div class="xs faint">${listingSubtitle(l)} · Disiarkan ${timeAgo(l.created_at)} · ${l.views} paparan</div>
            <div class="row-wrap">${primaryActions(l, mine)}</div>
            ${!mine && l.kind !== 'JOB' && l.kind !== 'LOST' && l.status === 'ACTIVE' && (l.price || l.meta.booking_fee) ? `<div class="alert info small">${icon('shield')}<div>Bayar melalui Dompet UPSIHub – wang dipegang sehingga anda sahkan terima, dan anda boleh <b>Laporkan masalah</b> jika ada apa-apa yang tidak kena.</div></div>` : ''}
          </div>
          <div class="card pad stack-sm">
            <h2 class="section-title">Butiran</h2>
            ${detailRows(l)}
            <hr class="sep">
            <p class="small" style="white-space:pre-wrap">${esc(l.description)}</p>
          </div>
          <a class="card pad row" href="#/u/${l.owner.id}">
            ${avatar(l.owner, 'lg')}
            <div class="grow"><b>${esc(l.owner.name)}</b>
              <div class="small">${l.owner.reviews ? `${stars(l.owner.rating)} <b>${l.owner.rating.toFixed(1)}</b> <span class="muted">(${l.owner.reviews} ulasan)</span>` : '<span class="faint">Belum ada ulasan</span>'}</div>
              <div class="xs muted">Ahli sejak ${fmtDate(l.owner.created_at)} · ${l.owner.listings} iklan aktif · ${l.owner.sold} jualan selesai</div>
              ${l.owner.online ? '<div class="xs" style="color:var(--accent-600)">● Dalam talian</div>' : ''}</div>
            ${icon('right')}
          </a>
          ${!mine && state.me ? `<button class="btn btn-link small" style="align-self:flex-start;color:var(--text-3)" data-act="reportListing" data-id="${l.id}">${icon('flag')} Laporkan iklan ini</button>` : ''}
        </section>
      </div>
    </div>`;
});

Object.assign(actions, {
  galleryPick(el) {
    const all = [...document.querySelectorAll('.gallery-thumbs .thumb')].map((b) => b.dataset.src);
    document.getElementById('galleryMain').innerHTML = `<img src="${esc(el.dataset.src)}" alt="" data-act="gallery" data-images='${esc(JSON.stringify(all))}' data-index="${all.indexOf(el.dataset.src)}">`;
    document.querySelectorAll('.gallery-thumbs .thumb').forEach((b) => b.classList.toggle('on', b === el));
  },
  async chatListing(el) {
    if (!state.me) { location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1))}`; return; }
    const { chat } = await api('POST', '/api/chats', { listingId: Number(el.dataset.id) });
    location.hash = `#/chat/${chat.id}`;
  },
  buyListing() {
    if (!state.me) { location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1))}`; return; }
    const l = currentListing;
    const price = l.kind === 'ROOM' ? l.meta.booking_fee : l.price;
    const multi = (l.kind === 'ITEM' && l.stock > 1) || l.kind === 'EVENT';
    const title = { ITEM: 'Beli barang', EVENT: 'Beli tiket', ROOM: 'Bayar deposit tempahan' }[l.kind];
    openModal({
      title,
      body: `
        <form id="buyForm" data-form="buyListing" data-id="${l.id}" data-price="${price}" class="stack">
          <div class="bank-box"><div><span class="faint">${l.kind === 'ROOM' ? 'Bilik' : 'Item'}</span><b class="clamp-1">${esc(l.title)}</b></div><div><span class="faint">${l.kind === 'ROOM' ? 'Yuran tempahan' : 'Harga seunit'}</span><b class="price">${rm(price)}</b></div><div><span class="faint">${l.kind === 'ROOM' ? 'Tuan rumah' : 'Penjual'}</span><b>${esc(l.owner.name)}</b></div></div>
          ${multi ? `<div class="field"><label>${l.kind === 'EVENT' ? 'Bilangan tiket' : 'Kuantiti'}</label><input class="input" type="number" name="qty" min="1" max="${Math.min(l.kind === 'EVENT' ? 10 : 50, l.stock || 1)}" value="1" data-input="buyQty"></div>` : ''}
          ${l.kind === 'ITEM' ? `
            <div class="field"><label>Tempat berjumpa / serahan</label><input class="input" name="meet" maxlength="150" value="${esc(l.location)}"></div>
            <div class="field"><label>Bayaran</label>
              <label class="radio-card"><input type="radio" name="payment" value="WALLET" checked><div class="grow"><div class="bold small">${icon('shield')} Dompet UPSIHub (dilindungi)</div><div class="xs muted">Wang dipegang sehingga anda sahkan terima barang</div></div></label>
              <label class="radio-card"><input type="radio" name="payment" value="CASH"><div class="grow"><div class="bold small">${icon('banknote')} Tunai semasa berjumpa</div><div class="xs muted">Tidak dilindungi oleh sistem laporan masalah</div></div></label>
            </div>` : ''}
          ${l.kind === 'ROOM' ? `<div class="alert info small">${icon('info')}<div>Yuran ini menempah bilik untuk anda dan dipegang oleh UPSIHub. Ia dilepaskan kepada tuan rumah selepas anda masuk, atau dipulangkan jika tuan rumah membatalkan. Sewa bulanan & deposit penuh diuruskan terus dengan tuan rumah.</div></div>` : ''}
          <div class="field"><label>Nota kepada ${l.kind === 'ROOM' ? 'tuan rumah' : 'penjual'}</label><input class="input" name="note" maxlength="300"></div>
          <div class="total-row between"><span>Jumlah</span><span class="price" id="buyTotal">${rm(price)}</span></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="buyForm">${icon('check')} Sahkan</button>`
    });
  },
  reportListing(el) {
    openModal({
      title: 'Laporkan iklan',
      body: `<form id="reportForm" data-form="reportListing" data-id="${el.dataset.id}" class="stack">
        <p class="small muted">Admin akan menyemak iklan ini. Laporan anda adalah sulit.</p>
        <div class="field"><label>Sebab *</label><textarea class="input" name="reason" required minlength="5" maxlength="300" placeholder="Cth: Penipuan, barang tiruan, harga mengelirukan, kandungan tidak sesuai"></textarea></div>
      </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-danger" type="submit" form="reportForm">Hantar laporan</button>`
    });
  },
  async listingStatus(el) {
    await api('PATCH', `/api/listings/${el.dataset.id}`, { status: el.dataset.status });
    toast('Status iklan dikemas kini.', 'success');
    refresh();
  },
  async deleteListing(el) {
    if (!(await confirmDialog('Padam iklan ini? Tindakan ini tidak boleh dibatalkan.', { danger: true, ok: 'Padam' }))) return;
    await api('DELETE', `/api/listings/${el.dataset.id}`);
    toast('Iklan dipadam.', 'success');
    location.hash = '#/my';
  }
});
inputs.buyQty = (el) => {
  const form = el.closest('form');
  document.getElementById('buyTotal').textContent = rm(Number(form.dataset.price) * Math.max(1, Number(el.value) || 1));
};
Object.assign(forms, {
  async buyListing(d, form) {
    const { order } = await api('POST', `/api/listings/${form.dataset.id}/buy`, { qty: Number(d.qty || 1), payment: d.payment || 'WALLET', meet: d.meet, note: d.note });
    closeOverlay();
    await hooks.loadMe();
    toast(`${order.code} dihantar kepada ${order.seller.name}.`, 'success', { title: 'Berjaya!' });
    location.hash = `#/orders/${order.id}`;
  },
  async reportListing(d, form) {
    await api('POST', `/api/listings/${form.dataset.id}/report`, { reason: d.reason });
    closeOverlay();
    toast('Terima kasih. Admin akan menyemak iklan ini.', 'success');
  }
});

// =====================================================================
// POST / EDIT
// =====================================================================
function kindFields(kind, l) {
  const m = l?.meta || {};
  const c = state.config;
  const money = (name, label, val, req = true, hint = '') => `<div class="field"><label>${label}${req ? ' *' : ''}</label><div class="input-prefix"><span>RM</span><input class="input" type="number" name="${name}" min="0" step="0.01" ${req ? 'required' : ''} value="${val != null ? senToInput(val) : ''}"></div>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  if (kind === 'ITEM') {
    return `
      <div class="grid-2">
        <div class="field"><label>Kategori *</label><select class="input" name="category">${c.market_categories.map((x) => `<option ${l?.category === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="field"><label>Keadaan *</label><select class="input" name="condition">${opts(M().conditions, l?.condition || 'BAIK')}</select></div>
        ${money('price', 'Harga', l?.price, true, 'Letak 0 untuk barang percuma.')}
        <div class="field"><label>Kuantiti</label><input class="input" type="number" name="stock" min="1" max="50" value="${l?.stock ?? 1}"></div>
      </div>
      <label class="check"><input type="checkbox" name="negotiable" ${l?.negotiable ? 'checked' : ''}> Harga boleh dirunding</label>`;
  }
  if (kind === 'ROOM') {
    return `
      <div class="grid-2">
        ${money('price', 'Sewa sebulan', l?.price)}
        <div class="field"><label>Boleh masuk mulai *</label><input class="input" type="date" name="available_from" required value="${esc(m.available_from || ymd())}"></div>
        <div class="field"><label>Jenis *</label><select class="input" name="room_type">${opts(M().room_types, m.room_type)}</select></div>
        <div class="field"><label>Penyewa *</label><select class="input" name="gender">${opts(M().genders, m.gender || 'CAMPUR')}</select></div>
        <div class="field"><label>Deposit</label><input class="input" name="deposit_note" maxlength="100" placeholder="Cth: 1 bulan + RM100 utiliti" value="${esc(m.deposit_note || '')}"></div>
        ${money('booking_fee', 'Yuran tempahan dalam talian', m.booking_fee ?? 0, false, 'Pelajar boleh membayar ini melalui dompet untuk menempah bilik. Letak 0 jika tidak mahu.')}
      </div>
      <div class="field"><label>Kemudahan</label><div class="row-wrap">${Object.entries(M().facilities).map(([k, v]) => `<label class="chip check-chip"><input type="checkbox" name="fac_${k}" ${(m.facilities || []).includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></div>`;
  }
  if (kind === 'JOB') {
    return `
      <div class="grid-2">
        <div class="field"><label>Majikan / syarikat *</label><input class="input" name="employer" required minlength="2" maxlength="80" value="${esc(m.employer || '')}"></div>
        <div class="field"><label>Waktu kerja</label><input class="input" name="schedule" maxlength="120" placeholder="Cth: Sabtu & Ahad, 10 pagi – 6 petang" value="${esc(m.schedule || '')}"></div>
        ${money('price', 'Bayaran', l?.price)}
        <div class="field"><label>Per *</label><select class="input" name="pay_unit">${opts(Object.fromEntries(Object.entries(M().pay_units).map(([k, v]) => [k, v.replace(/^se/, '')])), m.pay_unit || 'JAM')}</select></div>
      </div>`;
  }
  if (kind === 'EVENT') {
    const dt = m.event_at ? new Date(m.event_at) : null;
    const local = dt ? `${ymd(dt)}T${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` : '';
    return `
      <div class="grid-2">
        <div class="field"><label>Tarikh & masa *</label><input class="input" type="datetime-local" name="event_at" required value="${local}"></div>
        <div class="field"><label>Tempat *</label><input class="input" name="venue" required minlength="3" maxlength="120" value="${esc(m.venue || '')}"></div>
        ${money('price', 'Harga tiket', l?.price ?? 0, false, 'Letak 0 untuk event percuma (tiada tiket).')}
        <div class="field"><label>Bilangan tiket</label><input class="input" type="number" name="stock" min="0" max="5000" value="${l?.stock ?? 100}"><span class="hint">Diperlukan jika tiket berbayar.</span></div>
      </div>`;
  }
  return `
    <div class="grid-2">
      <div class="field"><label>Jenis *</label><select class="input" name="type">${opts({ LOST: 'Saya kehilangan barang', FOUND: 'Saya terjumpa barang' }, m.type || 'LOST')}</select></div>
      <div class="field"><label>Tarikh *</label><input class="input" type="date" name="date" required max="${ymd()}" value="${esc(m.date || ymd())}"></div>
    </div>`;
}

function postForm(kind, l = null) {
  const c = state.config;
  return `
    <div class="narrow stack">
      <div class="page-head"><div><h1>${l ? 'Sunting iklan' : 'Pasang iklan'}</h1><p>${l ? esc(l.title) : 'Percuma untuk semua pelajar UPSI. Iklan terus dipaparkan selepas disiarkan.'}</p></div></div>
      ${l ? '' : `<div class="kind-picker">${Object.entries(KINDS).map(([k, v]) => `<a href="#/post?kind=${k}" class="card ${k === kind ? 'on' : ''}">${icon(v.ic)}<span>${v.title}</span></a>`).join('')}</div>`}
      <form class="card pad stack" data-form="saveListing" data-kind="${kind}" data-id="${l?.id || ''}">
        <div class="field"><label>Tajuk *</label><input class="input" name="title" required minlength="5" maxlength="100" value="${esc(l?.title || '')}" placeholder="${{ ITEM: 'Cth: Kalkulator Casio fx-570EX', ROOM: 'Cth: Bilik single Taman Bernam Jaya – perempuan', JOB: 'Cth: Pembantu kedai hujung minggu', EVENT: 'Cth: Konsert Amal Kolej 2026', LOST: 'Cth: Hilang dompet hitam di kafeteria' }[kind]}"></div>
        ${kindFields(kind, l)}
        <div class="field"><label>Penerangan *</label><textarea class="input" name="description" required minlength="10" maxlength="2000" rows="5">${esc(l?.description || '')}</textarea></div>
        <div class="grid-2">
          <div class="field"><label>Kampus / kawasan *</label><select class="input" name="campus">${opts(c.campuses, l?.campus || state.me.campus)}</select></div>
          <div class="field"><label>Lokasi${kind === 'ROOM' ? ' *' : ''}</label><input class="input" name="location" maxlength="120" ${kind === 'ROOM' ? 'required' : ''} value="${esc(l?.location || '')}" placeholder="Cth: Kolej Za'ba / Taman Bernam Jaya"></div>
        </div>
        ${imagesField('images', l?.images || [], { max: 5, label: 'Gambar' })}
        <div class="row"><a class="btn btn-ghost" href="${l ? `#/listing/${l.id}` : '#/'}">Batal</a><button class="btn btn-primary grow" type="submit">${icon('check')} ${l ? 'Simpan perubahan' : 'Siarkan iklan'}</button></div>
      </form>
    </div>`;
}

page('/post', (_, query) => {
  const kind = KINDS[query.get('kind')] ? query.get('kind') : 'ITEM';
  return postForm(kind);
}, { auth: true });
page('/listing/:id/edit', async ({ id }) => {
  const { listing, mine } = await api('GET', `/api/listings/${id}`);
  if (!mine) return emptyState('lock', 'Bukan iklan anda', 'Anda hanya boleh menyunting iklan sendiri.');
  return postForm(listing.kind, listing);
}, { auth: true });

forms.saveListing = async (d, form) => {
  const kind = form.dataset.kind;
  const body = { kind, title: d.title, description: d.description, campus: d.campus, location: d.location, images: JSON.parse(d.images || '[]'), meta: {} };
  if (kind === 'ITEM') Object.assign(body, { category: d.category, condition: d.condition, price: toSen(d.price), stock: Number(d.stock || 1), negotiable: d.negotiable === 'on' });
  if (kind === 'ROOM') {
    body.price = toSen(d.price);
    body.meta = {
      room_type: d.room_type, gender: d.gender, available_from: d.available_from, deposit_note: d.deposit_note,
      booking_fee: d.booking_fee ? toSen(d.booking_fee) : 0,
      facilities: Object.keys(M().facilities).filter((k) => d[`fac_${k}`] === 'on')
    };
  }
  if (kind === 'JOB') { body.price = toSen(d.price); body.meta = { employer: d.employer, schedule: d.schedule, pay_unit: d.pay_unit }; }
  if (kind === 'EVENT') { body.price = d.price ? toSen(d.price) : 0; body.stock = Number(d.stock || 0); body.meta = { event_at: new Date(d.event_at).getTime(), venue: d.venue }; }
  if (kind === 'LOST') body.meta = { type: d.type, date: d.date };
  const id = form.dataset.id;
  const { listing } = await api(id ? 'PATCH' : 'POST', id ? `/api/listings/${id}` : '/api/listings', body);
  toast(id ? 'Iklan dikemas kini.' : 'Iklan anda kini disiarkan!', 'success');
  location.hash = `#/listing/${listing.id}`;
};

// =====================================================================
// MY LISTINGS & SALES
// =====================================================================
page('/my', async (_, query) => {
  const tab = query.get('tab') === 'sales' ? 'sales' : 'listings';
  const { listings, sales, rating } = await api('GET', '/api/my/listings');
  const pending = sales.filter((o) => o.status === 'PENDING').length;
  const body = tab === 'listings'
    ? (listings.length ? `<div class="stack-sm">${listings.map((l) => `
        <a class="card my-listing" href="#/listing/${l.id}">
          <div class="thumb" style="width:72px;height:72px">${l.images[0] ? `<img src="${esc(l.images[0])}" alt="">` : `<span style="font-size:28px">${l.kind === 'ITEM' ? catEmoji(l.category) : { ROOM: '🏠', JOB: '💼', EVENT: '🎟️', LOST: '🔎' }[l.kind]}</span>`}</div>
          <div class="grow">
            <div class="row-wrap"><span class="badge blue">${esc(KINDS[l.kind].title)}</span>${statusBadge(l.status)}${l.reports ? `<span class="badge red">${l.reports} laporan</span>` : ''}</div>
            <b class="clamp-1" style="margin-top:4px">${esc(l.title)}</b>
            <div class="xs muted">${listingPrice(l)} · ${l.views} paparan · dikemas kini ${timeAgo(l.updated_at)}</div>
          </div>
          ${icon('right')}
        </a>`).join('')}</div>`
      : `<div class="card">${emptyState('tag', 'Belum ada iklan', 'Jual barang lama, iklankan bilik sewa atau kongsi event anda.', '<a class="btn btn-primary" href="#/post">Pasang iklan pertama</a>')}</div>`)
    : (sales.length ? `<div class="stack-sm">${sales.map((o) => orderCard(o, 'seller')).join('')}</div>`
      : `<div class="card">${emptyState('receipt', 'Tiada jualan lagi', 'Pembelian & tempahan daripada iklan anda akan muncul di sini.')}</div>`);
  return `
    <div class="narrow stack">
      <div class="page-head"><div><h1>Iklan Saya</h1><p>Urus iklan anda dan pembelian yang masuk. ${rating.reviews ? `Rating penjual anda: ${stars(rating.rating)} <b>${rating.rating.toFixed(1)}</b> (${rating.reviews} ulasan) · <a class="btn-link" href="#/u/${state.me.id}">Lihat profil</a>` : 'Belum ada ulasan penjual.'}</p></div><a class="btn btn-primary" href="#/post">${icon('plus')} Pasang iklan</a></div>
      <nav class="tabs">
        <a href="#/my" class="${tab === 'listings' ? 'active' : ''}">${icon('tag')} Iklan <span class="badge">${listings.length}</span></a>
        <a href="#/my?tab=sales" class="${tab === 'sales' ? 'active' : ''}">${icon('receipt')} Jualan & tempahan masuk${pending ? ` <span class="badge red">${pending}</span>` : ''}</a>
      </nav>
      ${body}
    </div>`;
}, { auth: true });

// =====================================================================
// SELLER PROFILE
// =====================================================================
page('/u/:id', async ({ id }) => {
  const [{ user: u, reviews }, { listings }] = await Promise.all([api('GET', `/api/users/${id}`), api('GET', `/api/users/${id}/listings`)]);
  const dist = [5, 4, 3, 2, 1].map((n) => [n, reviews.filter((r) => r.rating === n).length]);
  return `
    <div class="stack-lg">
      <section class="card pad row" style="flex-wrap:wrap">
        ${avatar(u, 'lg')}
        <div class="grow">
          <h1 style="font-size:22px;font-weight:850">${esc(u.name)}</h1>
          <div class="small">${u.reviews ? `${stars(u.rating)} <b>${u.rating.toFixed(1)}</b> <span class="muted">daripada ${u.reviews} ulasan</span>` : '<span class="faint">Belum ada ulasan</span>'}</div>
          <div class="xs muted">${esc(state.config.campuses[u.campus] || u.campus)} · Ahli sejak ${fmtDate(u.created_at)} · ${u.sold} jualan selesai${u.online ? ' · <span style="color:var(--accent-600)">● Dalam talian</span>' : ''}</div>
        </div>
      </section>
      <div class="grid-2" style="align-items:start">
        <section class="card">
          <div class="card-head"><h2 class="section-title">Ulasan pembeli</h2><span class="small muted">${u.reviews}</span></div>
          <div class="card-body" style="padding-top:4px;padding-bottom:4px">
            ${u.reviews ? `<div class="stack-sm" style="padding:12px 0">${dist.map(([n, c]) => `<div class="row xs"><span style="width:28px">${n}★</span><div class="rating-bar"><i style="width:${(c / u.reviews) * 100}%"></i></div><span class="faint" style="width:20px">${c}</span></div>`).join('')}</div>` : ''}
            ${reviews.length ? reviews.map((r) => `
              <div class="review">
                <div class="between"><div class="row">${avatar({ name: r.name }, 'sm')}<b class="small">${esc(r.name)}</b></div><span class="xs faint">${timeAgo(r.created_at)}</span></div>
                <div style="margin:6px 0 2px">${stars(r.rating)}</div>
                ${r.title ? `<div class="xs faint">Membeli: ${esc(r.title)}</div>` : ''}
                ${r.comment ? `<p class="small muted">${esc(r.comment)}</p>` : ''}
                ${photoStrip(r.images)}
              </div>`).join('') : '<p class="small faint" style="padding:16px 0">Ulasan muncul selepas pembeli menyelesaikan pembelian.</p>'}
          </div>
        </section>
        <section class="stack-sm">
          <h2 class="section-title">Iklan aktif (${listings.length})</h2>
          ${listings.length ? `<div class="grid-2">${listings.map(listingCard).join('')}</div>` : `<div class="card">${emptyState('tag', 'Tiada iklan aktif', 'Penjual ini tiada iklan buat masa ini.')}</div>`}
        </section>
      </div>
    </div>`;
});
