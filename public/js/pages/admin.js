import {
  state, api, esc, rm, toSen, senToInput, icon, page, actions, forms, inputs, changes, refresh, openModal, closeOverlay, toast,
  confirmDialog, emptyState, statusBadge, fmtDateTime, fmtDate, imageField, avatar
} from '../core.js';

const TABS = [
  ['overview', 'Ringkasan', 'grid'],
  ['shops', 'Peniaga', 'store'],
  ['disputes', 'Pertikaian', 'alert'],
  ['topups', 'Tambah nilai', 'wallet'],
  ['withdrawals', 'Pengeluaran', 'bank'],
  ['users', 'Pengguna', 'users'],
  ['settings', 'Tetapan', 'sliders']
];

page('/admin', () => adminPage('overview'), { admin: true });
page('/admin/:tab', ({ tab }, query) => adminPage(tab, query), { admin: true });

async function adminPage(tab, query) {
  const ov = await api('GET', '/api/admin/overview');
  const counts = { shops: ov.pending.shops, topups: ov.pending.topups, withdrawals: ov.pending.withdrawals, disputes: ov.pending.disputes };
  const render = { overview, shops, disputes, topups, withdrawals, users, settings }[tab] || overview;
  const content = await render(ov, query);
  return `
    <div class="stack">
      <div class="page-head"><div><h1>Panel Pentadbir</h1><p>Urus peniaga, pengesahan bayaran, pengguna & tetapan platform.</p></div></div>
      <nav class="tabs">${TABS.map(([k, l, ic]) => `<a href="#/admin/${k}" class="${tab === k ? 'active' : ''}">${icon(ic)} ${l}${counts[k] ? ` <span class="badge red">${counts[k]}</span>` : ''}</a>`).join('')}</nav>
      <div>${content}</div>
    </div>`;
}

const stat = (ic, cls, label, value, sub) => `<div class="card stat"><div class="between"><span class="label">${label}</span><span class="stat-icon ${cls}">${icon(ic)}</span></div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

function overview(ov) {
  return `
    <div class="stack">
      <div class="grid-4">
        ${stat('trend', 'green', 'Hasil platform', rm(ov.revenue.total), `Lesen ${rm(ov.revenue.licence)} · Komisen ${rm(ov.revenue.commission)}`)}
        ${stat('bag', '', 'Nilai jualan (GMV)', rm(ov.orders.gmv), `${ov.orders.completed}/${ov.orders.total} pesanan selesai`)}
        ${stat('store', '', 'Peniaga aktif', ov.shops, `${ov.users} pengguna berdaftar`)}
        ${stat('wallet', 'amber', 'Baki dompet pengguna', rm(ov.float), 'Mesti sepadan dengan baki akaun bank platform')}
      </div>
      <div class="grid-4">
        ${todo('alert', ov.pending.disputes, 'pertikaian terbuka', '#/admin/disputes')}
        ${todo('store', ov.pending.shops, 'permohonan kedai', '#/admin/shops')}
        ${todo('wallet', ov.pending.topups, 'tambah nilai menunggu', '#/admin/topups')}
        ${todo('bank', ov.pending.withdrawals, 'pengeluaran menunggu', '#/admin/withdrawals')}
      </div>
      <section class="card">
        <div class="card-head"><h2 class="section-title">Pesanan terkini</h2></div>
        ${ov.recent.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Kod</th><th>Kedai</th><th>Pembeli</th><th>Jumlah</th><th>Bayaran</th><th>Status</th><th>Masa</th></tr></thead><tbody>
          ${ov.recent.map((o) => `<tr><td class="mono small">${esc(o.code)}</td><td>${esc(o.shop)}</td><td>${esc(o.buyer)}</td><td class="bold">${rm(o.total)}</td><td class="small">${o.payment === 'WALLET' ? 'Dompet' : 'Tunai'}</td><td>${statusBadge(o.status)}</td><td class="small faint">${fmtDateTime(o.created_at)}</td></tr>`).join('')}
        </tbody></table></div>` : emptyState('receipt', 'Belum ada pesanan', 'Pesanan pertama akan muncul di sini.')}
      </section>
    </div>`;
}
const todo = (ic, n, label, href) => `<a href="${href}" class="card pad row" style="${n ? 'border-color:var(--warn)' : ''}"><span class="stat-icon ${n ? 'amber' : 'green'}">${icon(n ? ic : 'check')}</span><div class="grow"><div class="bold" style="font-size:20px">${n}</div><div class="small muted">${label}</div></div>${icon('right')}</a>`;

async function shops() {
  const { shops: list } = await api('GET', '/api/admin/shops');
  if (!list.length) return `<div class="card">${emptyState('store', 'Tiada peniaga', 'Permohonan peniaga akan muncul di sini.')}</div>`;
  return `
    <section class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Kedai</th><th>Pemilik</th><th>Pakej</th><th>Yuran</th><th>Lesen</th><th>Status</th><th class="right">Tindakan</th></tr></thead>
      <tbody>${list.map((s) => `
        <tr>
          <td><a class="bold" href="#/shop/${s.id}">${esc(s.name)}</a><div class="xs faint">${esc(s.category)} · ${esc(s.campus)}${s.reviews ? ` · ★ ${s.rating}` : ''}</div></td>
          <td class="small">${esc(s.owner_name)}<div class="xs faint">${esc(s.owner_email)}${s.owner_phone ? ` · ${esc(s.owner_phone)}` : ''}</div></td>
          <td class="small">${esc(s.package || '-')}</td>
          <td class="bold small">${rm(s.license_fee)}</td>
          <td class="small">${s.license_until ? fmtDate(s.license_until) : '-'}</td>
          <td>${statusBadge(s.status)}${s.reject_reason ? `<div class="xs faint">${esc(s.reject_reason)}</div>` : ''}</td>
          <td class="right nowrap">
            ${s.status === 'PENDING' ? `<button class="btn btn-success btn-sm" data-act="shopAction" data-id="${s.id}" data-action="approve">Lulus</button> <button class="btn btn-danger btn-sm" data-act="shopAction" data-id="${s.id}" data-action="reject">Tolak</button>` : ''}
            ${s.status === 'APPROVED' ? `<button class="btn btn-danger btn-sm" data-act="shopAction" data-id="${s.id}" data-action="suspend">Gantung</button>` : ''}
            ${s.status === 'SUSPENDED' ? `<button class="btn btn-ghost btn-sm" data-act="shopAction" data-id="${s.id}" data-action="restore">Aktifkan</button>` : ''}
            <button class="btn btn-ghost btn-sm btn-icon" data-act="adminChat" data-user="${s.owner_id}" aria-label="Chat">${icon('chat')}</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div></section>`;
}

async function disputes(_, query) {
  const status = query?.get('s') || 'OPEN';
  const { disputes: list, reasons } = await api('GET', `/api/admin/disputes?status=${status}`);
  const img = (src) => src ? `<img src="${esc(src)}" alt="Bukti" data-act="zoom" data-src="${esc(src)}" style="width:72px;height:72px;object-fit:cover;border-radius:10px;cursor:zoom-in">` : '';
  const outcomeText = (d) => ({ REFUND: `Pulangan penuh kepada pembeli`, RELEASE: 'Dilepaskan kepada peniaga', SPLIT: `${rm(d.refund)} kepada pembeli, baki kepada peniaga` }[d.outcome] || '');
  return `
    <div class="stack">
      ${filterChips('disputes', status, ['OPEN', 'RESOLVED', 'ALL'])}
      <div class="alert info small">${icon('info')}<div>Wang pesanan yang dipertikaikan dibekukan sehingga anda membuat keputusan. Baca kedua-dua penjelasan, semak chat jika perlu, kemudian pilih: pulangan penuh, lepaskan kepada peniaga, atau bahagikan.</div></div>
      ${list.length ? list.map((d) => {
        const o = d.order;
        return `
          <section class="card pad stack">
            <div class="between" style="flex-wrap:wrap">
              <div><a class="bold" href="#/orders/${o.id}">#${esc(o.code)} · ${esc(o.shop.name)}</a><div class="xs faint">Pembeli: ${esc(o.buyer.name)} · Dilaporkan ${fmtDateTime(d.created_at)} · status sebelum: ${esc(d.prev_status)}</div></div>
              <div class="row">${statusBadge(d.status)}<span class="price">${rm(o.total)}</span></div>
            </div>
            <div class="small muted">${o.items.map((i) => `${i.qty}× ${esc(i.title)}`).join(', ')} · ${o.fulfilment === 'DELIVERY' ? `Hantar ke ${esc(o.address)}` : 'Ambil sendiri'}</div>
            <div class="grid-2">
              <div class="stack-sm" style="background:var(--danger-50);padding:14px;border-radius:12px">
                <div class="eyebrow" style="color:var(--danger)">Aduan pembeli</div>
                <b class="small">${esc(reasons[d.reason] || d.reason)}</b>
                <p class="small" style="white-space:pre-wrap">${esc(d.details)}</p>${img(d.evidence)}
              </div>
              <div class="stack-sm" style="background:var(--surface-2);padding:14px;border-radius:12px">
                <div class="eyebrow">Penjelasan peniaga</div>
                ${d.seller_response ? `<p class="small" style="white-space:pre-wrap">${esc(d.seller_response)}</p>${img(d.seller_evidence)}` : '<p class="small faint">Peniaga belum memberi penjelasan.</p>'}
              </div>
            </div>
            ${d.status === 'OPEN' ? `
              <div class="row-wrap">
                <button class="btn btn-primary" data-act="resolveDispute" data-id="${d.id}" data-total="${o.total}" data-code="${esc(o.code)}">${icon('shield')} Buat keputusan</button>
                <button class="btn btn-ghost" data-act="adminChat" data-user="${o.buyer.id}">${icon('chat')} Chat pembeli</button>
                <button class="btn btn-ghost" data-act="adminChat" data-user="${o.shop.owner_id}">${icon('chat')} Chat peniaga</button>
              </div>` : `<div class="alert success small">${icon('checkCircle')}<div><b>${outcomeText(d)}</b> – ${esc(d.admin_note || '')}<div class="xs faint">${fmtDateTime(d.resolved_at)}</div></div></div>`}
          </section>`;
      }).join('') : `<div class="card">${emptyState('shield', 'Tiada pertikaian', status === 'OPEN' ? 'Tiada laporan masalah yang perlu disemak.' : 'Tiada rekod.')}</div>`}
    </div>`;
}

async function topups(_, query) {
  const status = query?.get('s') || 'PENDING';
  const { topups: list } = await api('GET', `/api/admin/topups?status=${status}`);
  return `
    <div class="stack">
      ${filterChips('topups', status)}
      <div class="alert info small">${icon('info')}<div>Sahkan hanya selepas wang <b>benar-benar diterima</b> dalam akaun bank platform atau tunai di kaunter. Untuk tunai di kaunter tanpa permohonan, gunakan <a class="bold" href="#/admin/users">Pengguna › Kredit</a>.</div></div>
      ${list.length ? `<section class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Pengguna</th><th>Jumlah</th><th>Kaedah</th><th>Rujukan</th><th>Resit</th><th>Tarikh</th><th>Status</th><th class="right">Tindakan</th></tr></thead>
        <tbody>${list.map((t) => `
          <tr>
            <td class="small"><b>${esc(t.name)}</b><div class="xs faint">${esc(t.email)}${t.matric ? ` · ${esc(t.matric)}` : ''}</div></td>
            <td class="bold">${rm(t.amount)}</td>
            <td class="small">${t.method === 'BANK' ? 'Pindahan bank' : 'Tunai kaunter'}</td>
            <td class="mono small">${esc(t.reference || '-')}</td>
            <td>${t.receipt ? `<img src="${esc(t.receipt)}" alt="Resit" data-act="zoom" data-src="${esc(t.receipt)}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;cursor:zoom-in">` : '<span class="faint">-</span>'}</td>
            <td class="small faint">${fmtDateTime(t.created_at)}</td>
            <td>${statusBadge(t.status)}${t.admin_note ? `<div class="xs faint">${esc(t.admin_note)}</div>` : ''}</td>
            <td class="right nowrap">${t.status === 'PENDING' ? `<button class="btn btn-success btn-sm" data-act="topupAction" data-id="${t.id}" data-action="approve" data-amt="${t.amount}">Sahkan</button> <button class="btn btn-danger btn-sm" data-act="topupAction" data-id="${t.id}" data-action="reject">Tolak</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div></section>` : `<div class="card">${emptyState('wallet', 'Tiada permohonan', status === 'PENDING' ? 'Semua permohonan tambah nilai telah diproses.' : 'Tiada rekod.')}</div>`}
    </div>`;
}

async function withdrawals(_, query) {
  const status = query?.get('s') || 'PENDING';
  const { withdrawals: list } = await api('GET', `/api/admin/withdrawals?status=${status}`);
  return `
    <div class="stack">
      ${filterChips('withdrawals', status, ['PENDING', 'PAID', 'REJECTED', 'ALL'])}
      ${list.length ? `<section class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Pengguna</th><th>Jumlah</th><th>Bank</th><th>No. akaun</th><th>Nama akaun</th><th>Tarikh</th><th>Status</th><th class="right">Tindakan</th></tr></thead>
        <tbody>${list.map((w) => `
          <tr>
            <td class="small"><b>${esc(w.name)}</b><div class="xs faint">${esc(w.email)}</div></td>
            <td class="bold">${rm(w.amount)}</td>
            <td class="small">${esc(w.bank_name)}</td>
            <td class="mono small">${esc(w.account_no)} <button class="btn btn-link xs" data-act="copyText" data-text="${esc(w.account_no)}">${icon('copy')}</button></td>
            <td class="small">${esc(w.account_name)}</td>
            <td class="small faint">${fmtDateTime(w.created_at)}</td>
            <td>${statusBadge(w.status)}${w.admin_note ? `<div class="xs faint">${esc(w.admin_note)}</div>` : ''}</td>
            <td class="right nowrap">${w.status === 'PENDING' ? `<button class="btn btn-success btn-sm" data-act="wdAction" data-id="${w.id}" data-action="paid">Tanda dibayar</button> <button class="btn btn-danger btn-sm" data-act="wdAction" data-id="${w.id}" data-action="reject">Tolak</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div></section>` : `<div class="card">${emptyState('bank', 'Tiada permohonan', 'Permohonan pengeluaran baki akan muncul di sini.')}</div>`}
    </div>`;
}

const filterChips = (tab, current, list = ['PENDING', 'APPROVED', 'REJECTED', 'ALL']) => {
  const label = { PENDING: 'Menunggu', APPROVED: 'Disahkan', PAID: 'Dibayar', REJECTED: 'Ditolak', ALL: 'Semua', OPEN: 'Terbuka', RESOLVED: 'Selesai' };
  return `<div class="chips">${list.map((s) => `<a class="chip ${current === s ? 'active' : ''}" href="#/admin/${tab}?s=${s}">${label[s]}</a>`).join('')}</div>`;
};

let userQuery = '';
async function users() {
  const html = await userRows();
  return `
    <section class="card">
      <div class="card-head"><div class="input-icon grow" style="max-width:420px">${icon('search')}<input class="input" type="search" placeholder="Cari nama, e-mel atau no. matrik" value="${esc(userQuery)}" data-input="searchUsers"></div></div>
      <div class="table-wrap" id="userTable">${html}</div>
    </section>`;
}
async function userRows() {
  const { users: list } = await api('GET', `/api/admin/users?q=${encodeURIComponent(userQuery)}`);
  if (!list.length) return emptyState('users', 'Tiada pengguna ditemui', 'Cuba kata kunci lain.');
  return `<table class="table">
    <thead><tr><th>Pengguna</th><th>Matrik</th><th>Kedai</th><th>Baki</th><th>Status</th><th>Daftar</th><th class="right">Tindakan</th></tr></thead>
    <tbody>${list.map((u) => `
      <tr>
        <td><div class="row">${avatar(u, 'sm')}<div><b class="small">${esc(u.name)}</b>${u.role === 'admin' ? ' <span class="badge blue">Admin</span>' : ''}<div class="xs faint">${esc(u.email)}${u.phone ? ` · ${esc(u.phone)}` : ''}</div></div></div></td>
        <td class="mono small">${esc(u.matric || '-')}</td>
        <td class="small">${esc(u.shop_name || '-')}</td>
        <td class="bold small">${rm(u.balance)}</td>
        <td>${statusBadge(u.status)}</td>
        <td class="small faint">${fmtDate(u.created_at)}</td>
        <td class="right nowrap">
          <button class="btn btn-ghost btn-sm" data-act="creditUser" data-id="${u.id}" data-name="${esc(u.name)}">${icon('wallet')} Kredit</button>
          ${u.id !== state.me.id ? `<button class="btn btn-ghost btn-sm btn-icon" data-act="adminChat" data-user="${u.id}" aria-label="Chat">${icon('chat')}</button>
          <button class="btn ${u.status === 'active' ? 'btn-danger' : 'btn-ghost'} btn-sm" data-act="userStatus" data-id="${u.id}" data-status="${u.status === 'active' ? 'suspended' : 'active'}">${u.status === 'active' ? 'Gantung' : 'Aktifkan'}</button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table>`;
}
let userTimer;
inputs.searchUsers = (el) => {
  clearTimeout(userTimer);
  userTimer = setTimeout(async () => { userQuery = el.value.trim(); document.getElementById('userTable').innerHTML = await userRows(); }, 250);
};

async function settings() {
  const s = await api('GET', '/api/admin/settings');
  return `
    <form data-form="saveSettings" class="stack narrow" style="margin:0">
      <section class="card pad stack">
        <h2 class="section-title">Pakej lesen peniaga</h2>
        ${s.packages.map((p, i) => `
          <div class="grid-4" style="align-items:end">
            <div class="field"><label>Nama</label><input class="input" name="pkg_label_${i}" value="${esc(p.label)}" required><input type="hidden" name="pkg_id_${i}" value="${esc(p.id)}"></div>
            <div class="field"><label>Harga (RM)</label><input class="input" type="number" min="0" step="0.01" name="pkg_price_${i}" value="${senToInput(p.price)}" required></div>
            <div class="field"><label>Tempoh (hari)</label><input class="input" type="number" min="1" name="pkg_days_${i}" value="${p.days}" required></div>
            <div class="field"><label>Tag</label><input class="input" name="pkg_tag_${i}" value="${esc(p.tag || '')}"><input type="hidden" name="pkg_blurb_${i}" value="${esc(p.blurb || '')}"></div>
          </div>`).join('')}
        <div class="field"><label>Komisen platform bagi pesanan dompet (%)</label><input class="input" type="number" min="0" max="30" step="0.5" name="commission_pct" value="${s.commission_pct}" style="max-width:160px"><span class="hint">0% = tiada komisen. Komisen tidak dikenakan pada pesanan tunai.</span></div>
      </section>
      <section class="card pad stack">
        <h2 class="section-title">Akaun penerimaan tambah nilai</h2>
        <div class="grid-2">
          <div class="field"><label>Nama bank</label><input class="input" name="bank" value="${esc(s.topup_bank.bank)}" required></div>
          <div class="field"><label>No. akaun</label><input class="input" name="account" value="${esc(s.topup_bank.account)}" required></div>
        </div>
        <div class="field"><label>Nama penerima</label><input class="input" name="bank_holder" value="${esc(s.topup_bank.name)}" required></div>
        ${imageField('topup_qr', s.topup_qr, 'Kod QR bank (pilihan)', 'Muat naik kod QR DuitNow/bank anda sendiri – dipaparkan di skrin tambah nilai.')}
        <div class="field"><label>Lokasi & waktu kaunter tunai</label><input class="input" name="counter_info" value="${esc(s.counter_info || '')}" maxlength="200"></div>
      </section>
      <section class="card pad stack">
        <h2 class="section-title">Pengumuman</h2>
        <div class="field"><label>Teks bar pengumuman (kosongkan untuk sembunyi)</label><input class="input" name="announcement" value="${esc(s.announcement || '')}" maxlength="200"></div>
      </section>
      <div><button class="btn btn-primary btn-lg" type="submit">${icon('check')} Simpan tetapan</button></div>
    </form>`;
}

Object.assign(actions, {
  async shopAction(el) {
    const { id, action } = el.dataset;
    const msg = { approve: 'Luluskan kedai ini? Ia akan terus dipaparkan di Pasar Kampus.', reject: 'Tolak permohonan ini? Yuran akan dipulangkan ke dompet pemohon.', suspend: 'Gantung kedai ini? Ia akan disembunyikan daripada pelajar.', restore: 'Aktifkan semula kedai ini?' }[action];
    const ok = await confirmDialog(msg, { danger: action === 'reject' || action === 'suspend', input: action === 'reject' || action === 'suspend' ? 'Sebab (dimaklumkan kepada peniaga)' : null });
    if (!ok) return;
    await api('POST', `/api/admin/shops/${id}/${action}`, { reason: ok.value || '' });
    toast('Status kedai dikemas kini.', 'success');
    refresh();
  },
  async topupAction(el) {
    const { id, action, amt } = el.dataset;
    const ok = await confirmDialog(action === 'approve' ? `Sahkan ${rm(Number(amt))} telah diterima? Dompet pengguna akan dikreditkan.` : 'Tolak permohonan tambah nilai ini?', { danger: action !== 'approve', input: 'Nota (pilihan)', ok: action === 'approve' ? 'Sahkan & kredit' : 'Tolak' });
    if (!ok) return;
    await api('POST', `/api/admin/topups/${id}/${action}`, { note: ok.value || '' });
    toast(action === 'approve' ? 'Dompet dikreditkan.' : 'Permohonan ditolak.', 'success');
    refresh();
  },
  async wdAction(el) {
    const { id, action } = el.dataset;
    const ok = await confirmDialog(action === 'paid' ? 'Sahkan wang telah dipindahkan ke akaun bank pengguna?' : 'Tolak pengeluaran ini? Wang akan dipulangkan ke dompet pengguna.', { danger: action !== 'paid', input: action === 'paid' ? 'No. rujukan pindahan' : 'Sebab', ok: action === 'paid' ? 'Tanda dibayar' : 'Tolak' });
    if (!ok) return;
    await api('POST', `/api/admin/withdrawals/${id}/${action}`, { note: ok.value || '' });
    toast('Permohonan dikemas kini.', 'success');
    refresh();
  },
  async userStatus(el) {
    const { id, status } = el.dataset;
    if (!(await confirmDialog(status === 'suspended' ? 'Gantung akaun ini? Pengguna akan dilog keluar serta-merta.' : 'Aktifkan semula akaun ini?', { danger: status === 'suspended' }))) return;
    await api('POST', `/api/admin/users/${id}/status`, { status });
    toast('Status pengguna dikemas kini.', 'success');
    document.getElementById('userTable').innerHTML = await userRows();
  },
  creditUser(el) {
    openModal({
      title: `Kredit / pelarasan dompet – ${el.dataset.name}`,
      body: `
        <form id="creditForm" data-form="creditUser" data-id="${el.dataset.id}" class="stack">
          <div class="alert info small">${icon('info')}<div>Gunakan untuk tunai yang diterima di kaunter. Masukkan nilai negatif untuk pelarasan (tolak).</div></div>
          <div class="field"><label>Jumlah (RM)</label><div class="input-prefix"><span>RM</span><input class="input" name="amount" type="number" step="0.01" required placeholder="20.00"></div></div>
          <div class="field"><label>Nota / rujukan *</label><input class="input" name="note" required minlength="3" maxlength="120" placeholder="Cth: Tunai kaunter, resit #0012"></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="creditForm">Simpan</button>`
    });
  },
  resolveDispute(el) {
    const total = Number(el.dataset.total);
    openModal({
      title: `Keputusan pertikaian #${el.dataset.code}`,
      body: `
        <form id="resolveForm" data-form="resolveDispute" data-id="${el.dataset.id}" data-total="${total}" class="stack">
          <p class="small muted">Jumlah dibekukan: <b>${rm(total)}</b>. Keputusan ini muktamad dan wang akan dipindahkan serta-merta.</p>
          <label class="radio-card"><input type="radio" name="outcome" value="REFUND" checked data-change="resolveOutcome"><div><div class="bold small">Pulangan penuh kepada pembeli</div><div class="xs muted">${rm(total)} kembali ke dompet pembeli · pesanan dibatalkan</div></div></label>
          <label class="radio-card"><input type="radio" name="outcome" value="RELEASE" data-change="resolveOutcome"><div><div class="bold small">Lepaskan kepada peniaga</div><div class="xs muted">Aduan tidak disokong · peniaga menerima bayaran penuh</div></div></label>
          <label class="radio-card"><input type="radio" name="outcome" value="SPLIT" data-change="resolveOutcome"><div><div class="bold small">Bahagikan</div><div class="xs muted">Sebahagian dipulangkan kepada pembeli, baki kepada peniaga</div></div></label>
          <div class="field hidden" id="splitField"><label>Jumlah dipulangkan kepada pembeli (RM)</label><div class="input-prefix"><span>RM</span><input class="input" name="refund" type="number" min="0.01" max="${(total - 1) / 100}" step="0.01"></div></div>
          <div class="field"><label>Sebab keputusan (dimaklumkan kepada kedua-dua pihak) *</label><textarea class="input" name="note" required minlength="5" maxlength="500" rows="3"></textarea></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="resolveForm">Sahkan keputusan</button>`
    });
  },
  async adminChat(el) {
    const { chat } = await api('POST', '/api/chats', { userId: Number(el.dataset.user) });
    location.hash = `#/chat/${chat.id}`;
  }
});

changes.resolveOutcome = (el) => {
  const split = document.getElementById('splitField');
  split.classList.toggle('hidden', el.value !== 'SPLIT');
  split.querySelector('input').required = el.value === 'SPLIT';
};

Object.assign(forms, {
  async resolveDispute(data, form) {
    await api('POST', `/api/admin/disputes/${form.dataset.id}/resolve`, {
      outcome: data.outcome, note: data.note, refund: data.outcome === 'SPLIT' ? toSen(data.refund) : undefined
    });
    closeOverlay();
    toast('Keputusan direkodkan dan wang telah dipindahkan.', 'success');
    refresh();
  },
  async creditUser(data, form) {
    await api('POST', `/api/admin/users/${form.dataset.id}/credit`, { amount: toSen(data.amount), note: data.note });
    closeOverlay();
    toast('Dompet pengguna dikemas kini.', 'success');
    document.getElementById('userTable').innerHTML = await userRows();
  },
  async saveSettings(d) {
    const packages = [];
    for (let i = 0; d[`pkg_id_${i}`] !== undefined; i++) {
      packages.push({ id: d[`pkg_id_${i}`], label: d[`pkg_label_${i}`], price: toSen(d[`pkg_price_${i}`]), days: Number(d[`pkg_days_${i}`]), tag: d[`pkg_tag_${i}`], blurb: d[`pkg_blurb_${i}`] });
    }
    const out = await api('PUT', '/api/admin/settings', {
      packages, commission_pct: Number(d.commission_pct),
      topup_bank: { bank: d.bank, account: d.account, name: d.bank_holder },
      topup_qr: d.topup_qr || null, counter_info: d.counter_info, announcement: d.announcement
    });
    Object.assign(state.config, out);
    const bar = document.getElementById('announce');
    bar.classList.toggle('hidden', !out.announcement);
    document.getElementById('announceText').textContent = out.announcement || '';
    toast('Tetapan disimpan.', 'success');
  }
});
