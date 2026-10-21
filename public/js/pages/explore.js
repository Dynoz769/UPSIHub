// Transport (prebet trips & car rental) and bookable services.
import { state, api, esc, rm, icon, page, changes, emptyState, catEmoji } from '../core.js';
import { remember } from './booking.js';
import { vehicleCard } from './market.js';

let campus = 'ALL';
const campusSelect = () => `
  <select class="input" data-change="exploreCampus" style="max-width:260px" aria-label="Kampus">
    <option value="ALL">Semua kampus & kawasan</option>
    ${Object.entries(state.config.campuses).map(([k, v]) => `<option value="${k}" ${campus === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
  </select>`;
changes.exploreCampus = (el) => { campus = el.value; window.dispatchEvent(new CustomEvent('uh:refresh')); };

// A provider card listing its bookable offers.
function providerCard(s, kind) {
  remember(s, s.offers.map((o) => ({ ...o, kind })));
  return `
    <article class="card">
      <a class="row" href="#/shop/${s.id}" style="padding:16px;border-bottom:1px solid var(--border)">
        <div class="thumb" style="width:52px;height:52px">${s.image ? `<img src="${esc(s.image)}" alt="">` : `<span style="font-size:26px">${catEmoji(s.category)}</span>`}</div>
        <div class="grow"><b class="clamp-1">${esc(s.name)}</b>
          <div class="xs muted">${esc(s.campus)} · ${s.reviews ? `★ ${s.rating.toFixed(1)} (${s.reviews})` : 'Baharu'}${s.hours ? ` · ${esc(s.hours)}` : ''}</div></div>
        ${icon('right')}
      </a>
      <div class="stack-sm" style="padding:12px 16px 16px">
        ${s.offers.map((o) => `
          <div class="between">
            <div class="grow"><div class="small bold">${esc(o.title)}</div><div class="xs muted">${kind === 'ROUTE' ? 'Harga seorang' : `${o.duration_min} minit`}${o.description ? ` · ${esc(o.description)}` : ''}</div></div>
            <span class="price small">${rm(o.price)}</span>
            ${state.me?.id === s.owner_id ? '' : `<button class="btn btn-primary btn-sm" data-act="${kind === 'ROUTE' ? 'bookRide' : 'bookService'}" data-item="${o.id}">Tempah</button>`}
          </div>`).join('')}
      </div>
    </article>`;
}

page('/transport', async (_, query) => {
  const tab = query.get('tab') === 'rent' ? 'rent' : 'trip';
  const qs = `?campus=${campus}`;
  let body;
  if (tab === 'trip') {
    const { shops } = await api('GET', `/api/rides${qs}`);
    body = shops.length ? `<div class="grid-2">${shops.map((s) => providerCard(s, 'ROUTE')).join('')}</div>`
      : `<div class="card">${emptyState('car', 'Tiada pemandu prebet', 'Belum ada pemandu menawarkan trip di kawasan ini.')}</div>`;
  } else {
    const { vehicles } = await api('GET', `/api/vehicles${qs}`);
    body = vehicles.length ? `<div class="grid-3">${vehicles.map((v) => vehicleCard(v, state.me && state.shop?.id === v.shop_id)).join('')}</div>`
      : `<div class="card">${emptyState('key', 'Tiada kereta untuk disewa', 'Belum ada kereta sewa di kawasan ini.')}</div>`;
  }
  return `
    <div class="stack">
      <div class="page-head"><div><h1>Prebet & Sewa Kereta</h1><p>Tempah trip ikut masa anda atau sewa kereta harian – dibayar & dilindungi melalui dompet.</p></div>${campusSelect()}</div>
      <nav class="tabs">
        <a href="#/transport" class="${tab === 'trip' ? 'active' : ''}">${icon('car')} Trip prebet</a>
        <a href="#/transport?tab=rent" class="${tab === 'rent' ? 'active' : ''}">${icon('key')} Sewa kereta</a>
      </nav>
      ${body}
      <div class="alert info small">${icon('info')}<div>Anda pemandu atau ada kereta untuk disewa? Buka kedai kategori <b>Prebet & Transport</b> di <a class="bold" href="#/seller">Pusat Peniaga</a>, kemudian tambah laluan trip atau kenderaan.</div></div>
    </div>`;
});

page('/services', async () => {
  const { shops } = await api('GET', `/api/services?campus=${campus}`);
  return `
    <div class="stack">
      <div class="page-head"><div><h1>Servis & Tutor</h1><p>Tutor, gunting rambut, repair, jurugambar & lain-lain – pilih slot masa yang kosong dan tempah terus.</p></div>${campusSelect()}</div>
      ${shops.length ? `<div class="grid-2">${shops.map((s) => providerCard(s, 'SERVICE')).join('')}</div>`
        : `<div class="card">${emptyState('calendar', 'Tiada servis bertempah', 'Belum ada penyedia servis di kawasan ini.')}</div>`}
      <div class="alert info small">${icon('info')}<div>Tawarkan servis anda: buka kedai di <a class="bold" href="#/seller">Pusat Peniaga</a>, tetapkan <b>waktu tempahan</b>, dan tambah item jenis <b>Servis bertempah</b>.</div></div>
    </div>`;
});
