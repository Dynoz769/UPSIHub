import {
  state, api, esc, rm, toSen, senToInput, icon, page, actions, forms, changes, onPage, refresh, openModal, closeOverlay,
  toast, confirmDialog, emptyState, imageField, thumb, statusBadge, fmtDate, hooks
} from '../core.js';
import { orderCard } from './orders.js';

const TABS = [
  ['overview', 'Ringkasan', 'grid'],
  ['orders', 'Pesanan', 'receipt'],
  ['menu', 'Menu', 'list'],
  ['shop', 'Profil kedai', 'store'],
  ['license', 'Lesen', 'shield']
];

page('/seller', () => sellerPage('overview'), { auth: true });
page('/seller/:tab', ({ tab }, query) => sellerPage(tab, query), { auth: true });

async function sellerPage(tab, query) {
  if (state.me.role === 'admin') return emptyState('shield', 'Akaun pentadbir', 'Akaun pentadbir tidak boleh membuka kedai. Gunakan Panel Admin untuk mengurus peniaga.', '<a class="btn btn-primary" href="#/admin">Ke Panel Admin</a>');
  const data = await api('GET', '/api/seller');
  if (!data.shop) return applyWizard(null);
  const s = data.shop;
  if (s.status === 'REJECTED') return applyWizard(s);

  const notice = {
    PENDING: `<div class="alert warn">${icon('clock')}<div><b>Permohonan sedang disemak</b><div class="small">Yuran lesen ${rm(s.license_fee)} telah dibayar melalui dompet. Sementara menunggu kelulusan admin, anda boleh menyediakan menu & profil kedai.</div></div></div>`,
    SUSPENDED: `<div class="alert danger">${icon('ban')}<div><b>Kedai anda digantung</b><div class="small">${esc(s.reject_reason || 'Hubungi pentadbir untuk maklumat lanjut.')}</div></div><button class="btn btn-sm btn-ghost" data-act="openSupport">Hubungi admin</button></div>`
  }[s.status] || '';
  const expiring = s.status === 'APPROVED' && s.license_until && s.license_until - Date.now() < 7 * 864e5;
  const expired = s.status === 'APPROVED' && s.license_until && s.license_until < Date.now();

  onPage('uh:order', () => refresh());
  const body = {
    overview: () => overview(data),
    orders: () => ordersTab(query),
    menu: () => menuTab(data.items),
    shop: () => shopTab(s),
    license: () => licenseTab(s)
  }[tab] || (() => overview(data));
  const content = await body();

  return `
    <div class="stack">
      <div class="page-head">
        <div class="row">
          <div class="thumb" style="width:56px;height:56px;border-radius:16px">${s.image ? `<img src="${esc(s.image)}" alt="">` : icon('store')}</div>
          <div><h1>${esc(s.name)}</h1><p class="row-wrap">${statusBadge(s.status)} <span>${esc(s.category)} · ${esc(s.campus)}</span></p></div>
        </div>
        <div class="row">
          ${s.status === 'APPROVED' ? `<label class="row small bold" style="cursor:pointer">${s.is_open ? 'Kedai BUKA' : 'Kedai TUTUP'}<span class="switch"><input type="checkbox" ${s.is_open ? 'checked' : ''} data-change="toggleOpen"><span></span></span></label>` : ''}
          <a class="btn btn-ghost btn-sm" href="#/shop/${s.id}">${icon('eye')} Lihat kedai</a>
        </div>
      </div>
      ${notice}
      ${expired ? `<div class="alert danger">${icon('alert')}<div><b>Lesen telah tamat</b> – kedai anda tidak dipaparkan kepada pelajar. <a class="bold" href="#/seller/license">Perbaharui sekarang</a></div></div>`
        : expiring ? `<div class="alert warn">${icon('clock')}<div>Lesen tamat pada <b>${fmtDate(s.license_until)}</b>. <a class="bold" href="#/seller/license">Perbaharui</a> untuk terus menerima pesanan.</div></div>` : ''}
      <nav class="tabs">
        ${TABS.map(([k, label, ic]) => `<a href="#/seller/${k}" class="${tab === k ? 'active' : ''}">${icon(ic)} ${label}${k === 'orders' && data.stats.pending ? ` <span class="badge red">${data.stats.pending}</span>` : ''}</a>`).join('')}
      </nav>
      <div>${content}</div>
    </div>`;
}

// ---------------------------------------------------------------------
function overview({ shop: s, stats, items }) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = stats.last7.find((r) => r.day === key);
    days.push({ label: d.toLocaleDateString('ms-MY', { weekday: 'short' }), total: row?.total || 0, n: row?.n || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.total));
  return `
    <div class="stack">
      <div class="grid-4">
        ${stat('trend', 'green', 'Jualan hari ini', rm(stats.today.total), `${stats.today.n} pesanan selesai`)}
        ${stat('wallet', '', 'Jumlah jualan', rm(stats.all.total), `${stats.all.n} pesanan sepanjang masa`)}
        ${stat('clock', 'amber', 'Pesanan aktif', stats.active, `${stats.pending} menunggu tindakan`)}
        ${stat('star', '', 'Penilaian', s.reviews ? s.rating.toFixed(1) : '—', `${s.reviews} ulasan`)}
      </div>
      <div class="grid-2">
        <section class="card pad">
          <div class="between"><h2 class="section-title">Jualan 7 hari</h2><span class="small faint">Pesanan dompet & tunai</span></div>
          <div class="bars">${days.map((d) => `<div title="${rm(d.total)} · ${d.n} pesanan"><div class="b" style="height:${(d.total / max) * 100}%"></div><span>${d.label}</span></div>`).join('')}</div>
        </section>
        <section class="card pad stack-sm">
          <h2 class="section-title">Senarai semak</h2>
          ${check(items.length > 0, 'Tambah sekurang-kurangnya satu item menu', '#/seller/menu')}
          ${check(!!s.image, 'Muat naik gambar kedai', '#/seller/shop')}
          ${check(!!s.hours, 'Tetapkan waktu operasi', '#/seller/shop')}
          ${check(s.status === 'APPROVED', 'Kelulusan admin', '#/seller/license')}
          ${check(s.reviews > 0, 'Dapatkan ulasan pertama', '#/seller/orders')}
        </section>
      </div>
      <a class="btn btn-primary btn-lg" href="#/seller/orders">${icon('receipt')} Urus pesanan masuk</a>
    </div>`;
}
const stat = (ic, cls, label, value, sub) => `<div class="card stat"><div class="between"><span class="label">${label}</span><span class="stat-icon ${cls}">${icon(ic)}</span></div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
const check = (ok, label, href) => `<a href="${href}" class="row small" style="padding:6px 0"><span class="stat-icon ${ok ? 'green' : ''}" style="width:28px;height:28px;border-radius:50%">${icon(ok ? 'check' : 'right')}</span><span class="${ok ? 'faint' : 'bold'}" style="${ok ? 'text-decoration:line-through' : ''}">${label}</span></a>`;

// ---------------------------------------------------------------------
async function ordersTab(query) {
  const filter = query?.get('f') || 'ACTIVE';
  const { orders } = await api('GET', `/api/seller/orders?status=${filter}`);
  return `
    <div class="stack">
      <div class="chips">
        ${[['ACTIVE', 'Aktif'], ['DONE', 'Selesai / Batal'], ['ALL', 'Semua']].map(([k, l]) => `<a class="chip ${filter === k ? 'active' : ''}" href="#/seller/orders?f=${k}">${l}</a>`).join('')}
      </div>
      <div class="stack-sm">
        ${orders.length ? orders.map((o) => orderCard(o, 'seller')).join('') : `<div class="card">${emptyState('receipt', 'Tiada pesanan', filter === 'ACTIVE' ? 'Pesanan baharu akan muncul di sini secara automatik – anda juga akan menerima notifikasi.' : 'Belum ada rekod.')}</div>`}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
function menuTab(items) {
  return `
    <section class="card">
      <div class="card-head"><div><h2 class="section-title">Menu / Perkhidmatan</h2><p class="xs faint">${items.length} item · pelajar melihat senarai ini di halaman kedai anda</p></div>
        <button class="btn btn-primary" data-act="itemModal">${icon('plus')} Tambah item</button></div>
      ${items.length ? `<div class="table-wrap"><table class="table"><thead><tr><th></th><th>Item</th><th>Harga</th><th>Tersedia</th><th class="right">Tindakan</th></tr></thead><tbody>
        ${items.map((it) => `<tr>
          <td style="width:60px">${thumb(it, 'sm')}</td>
          <td><div class="bold">${esc(it.title)}</div><div class="xs muted clamp-1">${esc(it.description || '')}</div></td>
          <td class="price">${rm(it.price)}</td>
          <td><label class="switch"><input type="checkbox" ${it.available ? 'checked' : ''} data-change="toggleItem" data-id="${it.id}"><span></span></label></td>
          <td class="right nowrap">
            <button class="btn btn-ghost btn-icon" data-act="itemModal" data-item='${esc(JSON.stringify(it))}' aria-label="Sunting">${icon('edit')}</button>
            <button class="btn btn-danger btn-icon" data-act="deleteItem" data-id="${it.id}" aria-label="Padam">${icon('trash')}</button>
          </td></tr>`).join('')}
      </tbody></table></div>` : emptyState('package', 'Belum ada item', 'Tambah menu makanan, laluan prebet atau senarai servis anda.', `<button class="btn btn-primary" data-act="itemModal">${icon('plus')} Tambah item pertama</button>`)}
    </section>`;
}

// ---------------------------------------------------------------------
function shopFormFields(s = {}) {
  const c = state.config;
  return `
    <div class="field"><label>Nama kedai / perkhidmatan *</label><input class="input" name="name" required minlength="3" maxlength="80" value="${esc(s.name || '')}" placeholder="Cth: Nasi Lemak Royale KSAB / Prebet Abang Farhan"></div>
    <div class="grid-2">
      <div class="field"><label>Kategori *</label><select class="input" name="category">${c.categories.map((k) => `<option ${s.category === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div>
      <div class="field"><label>Kawasan utama *</label><select class="input" name="campus">${Object.entries(c.campuses).map(([k, v]) => `<option value="${k}" ${s.campus === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Penerangan *</label><textarea class="input" name="description" required minlength="10" maxlength="600" rows="3" placeholder="Cth: Prebet selesa ke Stesen KTM, KSAS & KSAB. Kereta Alza bersih & berhawa dingin.">${esc(s.description || '')}</textarea></div>
    <div class="field"><label>Waktu operasi</label><input class="input" name="hours" maxlength="80" value="${esc(s.hours || '')}" placeholder="Cth: Isnin – Jumaat, 8:00 pagi – 10:00 malam"></div>
    <div class="grid-2">
      <div class="field"><label>Caj penghantaran (RM)</label><div class="input-prefix"><span>RM</span><input class="input" name="delivery_fee" type="number" min="0" max="50" step="0.10" value="${senToInput(s.delivery_fee || 0)}"></div></div>
      <div class="field"><label>Pesanan minimum (RM)</label><div class="input-prefix"><span>RM</span><input class="input" name="min_order" type="number" min="0" max="1000" step="0.10" value="${senToInput(s.min_order || 0)}"></div></div>
    </div>
    <label class="check"><input type="checkbox" name="allow_cash" ${s.allow_cash === false ? '' : 'checked'}> Terima bayaran tunai semasa terima (selain Dompet UPSIHub)</label>
    ${imageField('image', s.image, 'Gambar / logo kedai', 'Gambar mendatar (landskap) paling cantik di kad kedai.')}`;
}
const shopPayload = (d) => ({
  name: d.name, category: d.category, campus: d.campus, description: d.description, hours: d.hours,
  delivery_fee: toSen(d.delivery_fee || 0), min_order: toSen(d.min_order || 0), allow_cash: d.allow_cash === 'on', image: d.image || null
});

function shopTab(s) {
  return `
    <form data-form="saveShop" class="card pad stack narrow" style="margin:0">
      ${shopFormFields(s)}
      <div><button class="btn btn-primary" type="submit">${icon('check')} Simpan perubahan</button></div>
    </form>`;
}

// ---------------------------------------------------------------------
function packageCards(selected) {
  return `<div class="grid-3">${state.config.packages.map((p) => `
    <label class="pkg ${p.id === selected ? 'on' : ''}" data-act="pickPkg">
      <input type="radio" name="package" value="${esc(p.id)}" ${p.id === selected ? 'checked' : ''} hidden>
      ${p.tag ? `<span class="badge ${p.id === 'Semester' ? 'green' : 'blue'}">${esc(p.tag)}</span>` : ''}
      <b>${esc(p.label)}</b>
      <div class="amt">${rm(p.price)}</div>
      <div class="xs faint">${p.days} hari</div>
      <p class="xs muted">${esc(p.blurb || '')}</p>
    </label>`).join('')}</div>`;
}

function licenseTab(s) {
  const pkg = state.config.packages.find((p) => p.id === s.package);
  const left = s.license_until ? Math.ceil((s.license_until - Date.now()) / 864e5) : null;
  return `
    <div class="stack narrow" style="margin:0">
      <section class="card pad">
        <dl class="kv">
          <dt>Status</dt><dd>${statusBadge(s.status)}</dd>
          <dt>Pakej semasa</dt><dd>${esc(pkg?.label || s.package || '-')}</dd>
          <dt>Sah sehingga</dt><dd>${s.license_until ? `${fmtDate(s.license_until)} (${left > 0 ? `${left} hari lagi` : 'tamat'})` : 'Selepas kelulusan admin'}</dd>
          <dt>Jumlah yuran dibayar</dt><dd>${rm(s.license_fee)}</dd>
        </dl>
      </section>
      ${s.status === 'APPROVED' ? `
        <form data-form="renew" class="card pad stack">
          <h2 class="section-title">Perbaharui / lanjutkan lesen</h2>
          <p class="small muted">Tempoh baharu ditambah selepas tarikh tamat semasa. Bayaran ditolak daripada Dompet UPSIHub (baki: <b data-balance>${rm(state.me.balance)}</b>).</p>
          ${packageCards(s.package)}
          <div class="row-wrap"><button class="btn btn-primary" type="submit">${icon('wallet')} Bayar dengan dompet</button><a class="btn btn-ghost" href="#/wallet?topup=1">Tambah nilai</a></div>
        </form>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------
function applyWizard(rejected) {
  const pkgDefault = rejected?.package || 'Semester';
  return `
    <div class="narrow stack">
      <div class="page-head center" style="justify-content:center;text-align:center">
        <div><span class="badge blue">Program Lesen Peniaga UPSIHub</span><h1 style="margin-top:8px">Buka kedai anda di UPSIHub</h1><p>3 langkah mudah untuk mula menerima pesanan & bayaran daripada ribuan pelajar UPSI.</p></div>
      </div>
      ${rejected ? `<div class="alert danger">${icon('alert')}<div><b>Permohonan sebelum ini ditolak</b><div class="small">Sebab: ${esc(rejected.reject_reason || '-')}. Yuran telah dipulangkan ke dompet. Kemas kini maklumat dan mohon semula.</div></div></div>` : ''}
      <form class="card pad-lg" data-form="applyShop" id="applyForm">
        <div class="steps" id="steps">
          <div class="s on" data-step="1"><i>1</i><span>Profil</span></div><div class="bar"></div>
          <div class="s" data-step="2"><i>2</i><span>Pakej</span></div><div class="bar"></div>
          <div class="s" data-step="3"><i>3</i><span>Bayaran</span></div>
        </div>
        <div class="stack" data-pane="1">
          ${shopFormFields(rejected || { campus: state.me.campus })}
          <button type="button" class="btn btn-primary btn-lg" data-act="wizStep" data-to="2">Seterusnya: Pilih pakej ${icon('right')}</button>
        </div>
        <div class="stack hidden" data-pane="2">
          ${packageCards(pkgDefault)}
          <div class="alert info small">${icon('info')}<div>Tiada komisen tersembunyi${state.config.commission_pct ? ` – hanya ${state.config.commission_pct}% bagi pesanan berbayar dompet` : ''}. Hasil jualan masuk terus ke dompet anda dan boleh dikeluarkan ke bank pada bila-bila masa.</div></div>
          <div class="row"><button type="button" class="btn btn-ghost" data-act="wizStep" data-to="1">Kembali</button><button type="button" class="btn btn-primary grow" data-act="wizStep" data-to="3">Seterusnya: Bayaran ${icon('right')}</button></div>
        </div>
        <div class="stack hidden" data-pane="3">
          <div class="bank-box" id="paySummary"></div>
          <div class="row"><button type="button" class="btn btn-ghost" data-act="wizStep" data-to="2">Kembali</button><button type="submit" class="btn btn-success grow">${icon('check')} Bayar & hantar permohonan</button></div>
          <p class="xs faint center">Yuran dipulangkan sepenuhnya ke dompet jika permohonan ditolak.</p>
        </div>
      </form>
    </div>`;
}

function paySummary() {
  const form = document.getElementById('applyForm');
  const id = form.querySelector('[name=package]:checked')?.value;
  const p = state.config.packages.find((x) => x.id === id);
  const bal = state.me.balance;
  document.getElementById('paySummary').innerHTML = `
    <div><span class="faint">Kedai</span><b>${esc(form.name.value)}</b></div>
    <div><span class="faint">Pakej</span><b>${esc(p.label)} · ${p.days} hari</b></div>
    <div><span class="faint">Yuran</span><b class="price">${rm(p.price)}</b></div>
    <div><span class="faint">Baki dompet</span><b data-balance>${rm(bal)}</b></div>
    ${bal < p.price ? `<div class="alert danger small" style="display:flex">${icon('wallet')}<div>Baki tidak mencukupi. <a class="bold" href="#/wallet?topup=1">Tambah nilai ${rm(p.price - bal)}</a> dahulu – maklumat borang akan hilang, jadi tambah nilai sebelum mengisi.</div></div>` : `<div class="xs faint">Baki selepas bayaran: ${rm(bal - p.price)}</div>`}`;
}

Object.assign(actions, {
  wizStep(el) {
    const form = document.getElementById('applyForm');
    const to = Number(el.dataset.to);
    const current = Number(form.querySelector('[data-pane]:not(.hidden)').dataset.pane);
    if (to > current) {
      const fields = form.querySelectorAll(`[data-pane="${current}"] input, [data-pane="${current}"] select, [data-pane="${current}"] textarea`);
      for (const f of fields) if (!f.reportValidity()) return;
    }
    form.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', Number(p.dataset.pane) !== to));
    form.querySelectorAll('.steps .s').forEach((s) => {
      const n = Number(s.dataset.step);
      s.classList.toggle('on', n === to);
      s.classList.toggle('done', n < to);
      s.querySelector('i').innerHTML = n < to ? icon('check') : n;
    });
    if (to === 3) paySummary();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  pickPkg(el) {
    el.closest('.grid-3').querySelectorAll('.pkg').forEach((p) => p.classList.toggle('on', p === el));
    el.querySelector('input').checked = true;
  },
  itemModal(el) {
    const it = el.dataset.item ? JSON.parse(el.dataset.item) : null;
    openModal({
      title: it ? 'Sunting item' : 'Tambah item / servis',
      body: `
        <form id="itemForm" data-form="saveItem" data-id="${it?.id || ''}" class="stack">
          <div class="field"><label>Nama item / servis *</label><input class="input" name="title" required minlength="2" maxlength="100" value="${esc(it?.title || '')}" placeholder="Cth: Nasi Lemak Ayam Goreng / Print A4 Warna"></div>
          <div class="field"><label>Harga (RM) *</label><div class="input-prefix"><span>RM</span><input class="input" name="price" type="number" min="0.01" step="0.01" required value="${it ? senToInput(it.price) : ''}" placeholder="6.00"></div></div>
          <div class="field"><label>Penerangan ringkas</label><input class="input" name="description" maxlength="300" value="${esc(it?.description || '')}" placeholder="Cth: Termasuk sambal lebih & telur rebus"></div>
          ${imageField('image', it?.image, 'Gambar item')}
          <label class="check"><input type="checkbox" name="available" ${!it || it.available ? 'checked' : ''}> Tersedia untuk dipesan</label>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="itemForm">Simpan item</button>`
    });
  },
  async deleteItem(el) {
    if (!(await confirmDialog('Padam item menu ini secara kekal?', { danger: true, ok: 'Padam' }))) return;
    await api('DELETE', `/api/seller/items/${el.dataset.id}`);
    toast('Item dipadam.', 'success');
    refresh();
  }
});

Object.assign(changes, {
  async toggleOpen(el) {
    await api('PATCH', '/api/seller/shop', { is_open: el.checked });
    toast(el.checked ? 'Kedai kini BUKA untuk pesanan.' : 'Kedai kini TUTUP.', 'success');
    refresh();
  },
  async toggleItem(el) {
    try {
      await api('PATCH', `/api/seller/items/${el.dataset.id}`, { available: el.checked });
      toast(el.checked ? 'Item tersedia.' : 'Item ditanda habis.', 'success', { timeout: 1500 });
    } catch (err) { el.checked = !el.checked; throw err; }
  }
});

Object.assign(forms, {
  async applyShop(data) {
    await api('POST', '/api/seller/apply', { ...shopPayload(data), package: data.package });
    await hooks.loadMe();
    toast('Permohonan dihantar! Admin akan menyemak dalam masa terdekat.', 'success', { title: 'Berjaya' });
    location.hash = '#/seller';
    refresh();
  },
  async saveShop(data) {
    await api('PATCH', '/api/seller/shop', shopPayload(data));
    toast('Profil kedai disimpan.', 'success');
    refresh();
  },
  async saveItem(data, form) {
    const payload = { title: data.title, price: toSen(data.price), description: data.description, image: data.image || null, available: data.available === 'on' };
    const id = form.dataset.id;
    await api(id ? 'PATCH' : 'POST', id ? `/api/seller/items/${id}` : '/api/seller/items', payload);
    closeOverlay();
    toast(id ? 'Item dikemas kini.' : 'Item ditambah.', 'success');
    refresh();
  },
  async renew(data) {
    const p = state.config.packages.find((x) => x.id === data.package);
    if (!(await confirmDialog(`Bayar ${rm(p.price)} daripada dompet untuk pakej ${p.label}?`, { ok: 'Bayar' }))) return;
    await api('POST', '/api/seller/renew', { package: data.package });
    await hooks.loadMe();
    toast('Lesen berjaya diperbaharui.', 'success');
    refresh();
  }
});
