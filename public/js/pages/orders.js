import { state, api, esc, rm, icon, page, actions, forms, onPage, refresh, statusBadge, emptyState, fmtDateTime, timeAgo, openModal, closeOverlay, confirmDialog, toast, hooks, imageField } from '../core.js';

const ACTIVE = ['PENDING', 'ACCEPTED', 'READY'];
// Still needs attention: in progress, under dispute, or completed but money not yet released.
const isOpen = (o) => ACTIVE.includes(o.status) || o.status === 'DISPUTED' || (o.status === 'COMPLETED' && o.payout === 'HELD');
const canDispute = (o) => o.payment === 'WALLET' && o.payout === 'HELD' && !o.dispute && ['ACCEPTED', 'READY', 'COMPLETED'].includes(o.status);
const hoursLeft = (ms) => Math.max(1, Math.ceil((ms - Date.now()) / 3600e3));
const STEPS = [
  ['PENDING', 'Dipesan', 'receipt'],
  ['ACCEPTED', 'Disediakan', 'package'],
  ['READY', 'Sedia', 'truck'],
  ['COMPLETED', 'Selesai', 'check']
];

export function timeline(o) {
  if (o.status === 'CANCELLED' || o.status === 'REJECTED') {
    const ev = o.events.at(-1);
    return `<div class="alert danger">${icon('ban')}<div><b>Pesanan ${o.status === 'REJECTED' ? 'ditolak oleh peniaga' : 'dibatalkan'}</b>${o.cancel_reason ? `<div class="small">Sebab: ${esc(o.cancel_reason)}</div>` : ''}${o.payment === 'WALLET' ? `<div class="small">${rm(o.total)} telah dipulangkan ke dompet pembeli.</div>` : ''}<div class="xs faint">${ev ? fmtDateTime(ev.at) : ''}</div></div></div>`;
  }
  const idx = STEPS.findIndex(([s]) => s === (o.status === 'DISPUTED' ? o.dispute?.prev_status : o.status));
  const pct = (idx / (STEPS.length - 1)) * 100;
  return `
    <div class="timeline">
      <div class="fill" style="width:calc(${pct}% - ${pct ? 28 * pct / 100 : 0}px)"></div>
      ${STEPS.map(([s, label, ic], i) => {
        const ev = o.events.find((e) => e.status === s);
        const lbl = s === 'READY' ? (o.fulfilment === 'DELIVERY' ? 'Dihantar' : 'Sedia diambil') : label;
        return `<div class="t ${i <= idx ? 'done' : ''} ${i === idx ? 'now' : ''}"><i>${icon(ic)}</i><span>${lbl}</span>${ev ? `<span class="xs faint">${new Date(ev.at).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}</div>`;
      }).join('')}
    </div>`;
}

// Buttons the current viewer may press for this order.
export function orderButtons(o, role) {
  const b = (status, label, cls = 'btn-primary', ic = 'check') => `<button class="btn ${cls}" data-act="orderStatus" data-id="${o.id}" data-status="${status}">${icon(ic)} ${label}</button>`;
  const out = [];
  if (role === 'seller') {
    if (o.status === 'PENDING') out.push(b('ACCEPTED', 'Terima pesanan', 'btn-success'), b('REJECTED', 'Tolak', 'btn-danger', 'x'));
    if (o.status === 'ACCEPTED') out.push(b('READY', o.fulfilment === 'DELIVERY' ? 'Sedang dihantar' : 'Sedia diambil', 'btn-primary', 'truck'), b('CANCELLED', 'Batal', 'btn-danger', 'x'));
    if (o.status === 'READY') out.push(b('COMPLETED', 'Tandakan selesai', 'btn-success'));
  }
  if (role === 'buyer') {
    if (o.status === 'PENDING') out.push(b('CANCELLED', 'Batalkan pesanan', 'btn-danger', 'x'));
    if (o.status === 'READY') out.push(b('COMPLETED', 'Sahkan telah terima', 'btn-success'));
    if (o.status === 'COMPLETED' && o.payout === 'HELD' && !o.dispute) out.push(`<button class="btn btn-success" data-act="confirmOrder" data-id="${o.id}">${icon('check')} Sahkan telah terima</button>`);
    if (o.status === 'COMPLETED' && !o.review) out.push(`<button class="btn btn-primary" data-act="reviewOrder" data-id="${o.id}">${icon('star')} Beri ulasan</button>`);
    if (canDispute(o)) out.push(`<button class="btn btn-danger" data-act="disputeModal" data-id="${o.id}">${icon('alert')} Laporkan masalah</button>`);
  }
  if (role === 'seller' && o.dispute?.status === 'OPEN') {
    out.push(`<button class="btn btn-primary" data-act="respondModal" data-id="${o.id}">${icon('edit')} ${o.dispute.seller_response ? 'Kemas kini penjelasan' : 'Beri penjelasan'}</button>`);
  }
  if (role === 'admin' && ACTIVE.includes(o.status)) out.push(b('CANCELLED', 'Batal (admin)', 'btn-danger', 'x'));
  if (role !== 'admin') out.push(`<button class="btn btn-ghost" data-act="chatOrder" data-id="${o.id}">${icon('chat')} Chat ${role === 'seller' ? 'pembeli' : 'peniaga'}</button>`);
  return out.join('');
}

export function orderCard(o, role = 'buyer') {
  const count = o.items.reduce((s, i) => s + i.qty, 0);
  return `
    <article class="card order-card" data-act="openOrder" data-id="${o.id}">
      <div class="between">
        <div class="row"><b>${esc(role === 'seller' ? o.buyer.name : o.shop.name)}</b>${statusBadge(o.status)}</div>
        <span class="xs faint nowrap">${timeAgo(o.created_at)}</span>
      </div>
      <div class="small muted clamp-1">${o.items.map((i) => `${i.qty}× ${esc(i.title)}`).join(', ')}</div>
      <div class="between small">
        <span class="faint">#${esc(o.code)} · ${count} item · ${o.fulfilment === 'DELIVERY' ? 'Hantar' : 'Ambil sendiri'} · ${o.payment === 'WALLET' ? 'Dompet' : 'Tunai'}</span>
        <span class="price">${rm(o.total)}</span>
      </div>
      ${role === 'seller' && ACTIVE.includes(o.status) ? `<div class="row-wrap" style="padding-top:6px">${orderButtons(o, 'seller')}</div>` : ''}
    </article>`;
}

// =====================================================================
// LIST
// =====================================================================
page('/orders', async (_, query) => {
  const tab = query.get('tab') === 'done' ? 'done' : 'active';
  const { orders } = await api('GET', '/api/orders');
  const active = orders.filter(isOpen);
  const done = orders.filter((o) => !isOpen(o));
  const list = tab === 'active' ? active : done;
  onPage('uh:order', () => refresh());
  return `
    <div class="narrow">
      <div class="page-head"><div><h1>Pesanan Saya</h1><p>Jejak status pesanan anda secara masa nyata.</p></div></div>
      <nav class="tabs" style="margin-bottom:16px">
        <a href="#/orders" class="${tab === 'active' ? 'active' : ''}">Sedang berjalan <span class="badge blue">${active.length}</span></a>
        <a href="#/orders?tab=done" class="${tab === 'done' ? 'active' : ''}">Sejarah <span class="badge">${done.length}</span></a>
      </nav>
      <div class="stack-sm">
        ${list.length ? list.map((o) => orderCard(o)).join('') : `<div class="card">${emptyState('receipt', tab === 'active' ? 'Tiada pesanan aktif' : 'Tiada sejarah pesanan', 'Pesanan yang anda buat di Pasar Kampus akan muncul di sini.', '<a class="btn btn-primary" href="#/">Mula memesan</a>')}</div>`}
      </div>
    </div>`;
}, { auth: true });

// =====================================================================
// DETAIL
// =====================================================================
page('/orders/:id', async ({ id }) => {
  const { order: o, role } = await api('GET', `/api/orders/${id}`);
  onPage('uh:order', (e) => { if (e.detail.id === o.id) refresh(); });
  const back = role === 'seller' ? '#/seller/orders' : role === 'admin' ? '#/admin' : '#/orders';
  return `
    <div class="narrow stack">
      <a href="${back}" class="btn btn-link small" style="align-self:flex-start">${icon('back')} Kembali</a>
      <section class="card pad stack">
        <div class="between" style="flex-wrap:wrap">
          <div><div class="eyebrow">Pesanan #${esc(o.code)}</div><h1 style="font-size:22px;font-weight:850;margin-top:2px">${esc(o.shop.name)}</h1><div class="small faint">${fmtDateTime(o.created_at)}</div></div>
          ${statusBadge(o.status)}
        </div>
        ${timeline(o)}
        ${heldNotice(o, role)}
        ${o.status === 'PENDING' ? `<div class="alert info small">${icon('clock')}<div>${role === 'seller' ? 'Pelanggan sedang menunggu – terima atau tolak pesanan ini secepat mungkin.' : 'Menunggu peniaga menerima pesanan anda. Anda boleh membatalkan sebelum diterima.'}</div></div>` : ''}
        <div class="row-wrap">${orderButtons(o, role)}</div>
      </section>

      <section class="card pad stack">
        <h2 class="section-title">Butiran</h2>
        <div class="line-items">
          ${o.items.map((i) => `<div><span>${i.qty}× ${esc(i.title)}</span><span>${rm(i.price * i.qty)}</span></div>`).join('')}
          <hr class="sep">
          <div><span class="muted">Jumlah kecil</span><span>${rm(o.subtotal)}</span></div>
          <div><span class="muted">Caj penghantaran</span><span>${o.delivery_fee ? rm(o.delivery_fee) : 'Percuma'}</span></div>
          ${role !== 'buyer' && o.commission ? `<div><span class="muted">Komisen platform</span><span>−${rm(o.commission)}</span></div>` : ''}
          <div class="total-row"><span>Jumlah</span><span class="price">${rm(o.total)}</span></div>
        </div>
        <dl class="kv">
          <dt>Pembayaran</dt><dd>${o.payment === 'WALLET' ? `${icon('wallet')} Dompet UPSIHub` : `${icon('banknote')} Tunai semasa terima`}</dd>
          <dt>Penerimaan</dt><dd>${o.fulfilment === 'DELIVERY' ? 'Penghantaran' : 'Ambil sendiri'}</dd>
          ${o.address ? `<dt>Lokasi</dt><dd>${esc(o.address)}</dd>` : ''}
          ${o.note ? `<dt>Nota</dt><dd>${esc(o.note)}</dd>` : ''}
          ${role !== 'buyer' ? `<dt>Pembeli</dt><dd>${esc(o.buyer.name)}${o.buyer.matric ? ` · ${esc(o.buyer.matric)}` : ''}</dd>` : ''}
          ${role !== 'buyer' && o.buyer.phone ? `<dt>Telefon</dt><dd>${esc(o.buyer.phone)}</dd>` : ''}
        </dl>
        ${o.payment === 'WALLET' && ACTIVE.includes(o.status) ? `<div class="alert info small">${icon('shield')}<div>Bayaran ${rm(o.total)} dipegang dengan selamat oleh UPSIHub dan hanya dilepaskan kepada peniaga apabila pesanan selesai.</div></div>` : ''}
      </section>

      ${o.dispute ? disputeCard(o, role) : ''}
      ${o.review ? `<section class="card pad stack-sm"><h2 class="section-title">Ulasan</h2><div class="stars">${Array.from({ length: 5 }, (_, i) => icon('star', i < o.review.rating ? '' : 'off')).join('')}</div>${o.review.comment ? `<p class="muted small">${esc(o.review.comment)}</p>` : ''}</section>` : ''}
    </div>`;
}, { auth: true });

Object.assign(actions, {
  openOrder: (el, e) => { if (!e.target.closest('button')) location.hash = `#/orders/${el.dataset.id}`; },
  async orderStatus(el, e) {
    e.stopPropagation();
    const { id, status } = el.dataset;
    const needsReason = status === 'REJECTED' || status === 'CANCELLED';
    const prompts = {
      REJECTED: 'Tolak pesanan ini? Pembeli akan dimaklumkan dan bayaran dompet dipulangkan.',
      CANCELLED: 'Batalkan pesanan ini? Bayaran dompet akan dipulangkan sepenuhnya.',
      COMPLETED: 'Sahkan pesanan ini telah selesai? Bayaran dompet akan dilepaskan kepada peniaga.'
    };
    let reason = '';
    if (prompts[status]) {
      const ok = await confirmDialog(prompts[status], { danger: needsReason, input: needsReason ? 'Sebab (pilihan)' : null, ok: needsReason ? 'Ya, teruskan' : 'Sahkan' });
      if (!ok) return;
      reason = ok.value || '';
    }
    await api('POST', `/api/orders/${id}/status`, { status, reason });
    toast('Status pesanan dikemas kini.', 'success');
    hooks.loadMe().then(hooks.renderShell);
    refresh();
  },
  async chatOrder(el, e) {
    e.stopPropagation();
    const { chat } = await api('POST', '/api/chats', { orderId: Number(el.dataset.id) });
    location.hash = `#/chat/${chat.id}`;
  },
  reviewOrder(el) {
    const id = el.dataset.id;
    openModal({
      title: 'Nilai pesanan anda',
      body: `
        <form id="reviewForm" data-form="review" data-id="${id}" class="stack">
          <p class="small muted center">Bagaimana pengalaman anda dengan peniaga ini?</p>
          <div class="star-input" id="starInput">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-act="pickStar" data-n="${n}" class="${n <= 5 ? 'on' : ''}" aria-label="${n} bintang">${icon('star')}</button>`).join('')}</div>
          <input type="hidden" name="rating" value="5">
          <div class="field"><label>Ulasan (pilihan)</label><textarea class="input" name="comment" maxlength="500" placeholder="Makanan sedap, penghantaran pantas…"></textarea></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="reviewForm">Hantar ulasan</button>`
    });
  },
  pickStar(el) {
    const n = Number(el.dataset.n);
    document.querySelectorAll('#starInput button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= n));
    document.querySelector('#reviewForm [name=rating]').value = n;
  }
});

forms.review = async (data, form) => {
  await api('POST', `/api/orders/${form.dataset.id}/review`, { rating: Number(data.rating), comment: data.comment });
  closeOverlay();
  toast('Terima kasih atas ulasan anda!', 'success');
  refresh();
};


// ---------------------------------------------------------------------
// Held payment & disputes
// ---------------------------------------------------------------------
function heldNotice(o, role) {
  if (o.status !== 'COMPLETED' || o.payout !== 'HELD' || !o.release_at) return '';
  const when = fmtDateTime(o.release_at);
  if (role === 'buyer') {
    return `<div class="alert warn small">${icon('clock')}<div><b>Peniaga telah menandakan pesanan ini selesai.</b> Bayaran ${rm(o.total)} akan dilepaskan kepada peniaga pada <b>${when}</b> (${hoursLeft(o.release_at)} jam lagi). Jika anda belum menerima pesanan atau ada masalah, tekan <b>Laporkan masalah</b> sebelum itu – bayaran akan dibekukan sehingga admin membuat keputusan.</div></div>`;
  }
  return `<div class="alert info small">${icon('clock')}<div>Bayaran ${rm(o.total - o.commission)} akan dikreditkan ke dompet ${role === 'seller' ? 'anda' : 'peniaga'} pada <b>${when}</b>, atau lebih awal jika pembeli mengesahkan penerimaan.</div></div>`;
}

function disputeCard(o, role) {
  const d = o.dispute;
  const reasons = state.config.dispute_reasons || {};
  const outcome = { REFUND: `Pulangan penuh ${rm(o.total)} kepada pembeli`, RELEASE: 'Bayaran dilepaskan kepada peniaga', SPLIT: `${rm(d.refund)} dipulangkan kepada pembeli, baki kepada peniaga` }[d.outcome];
  const img = (src) => src ? `<img src="${esc(src)}" alt="Bukti" data-act="zoom" data-src="${esc(src)}" style="width:96px;height:96px;object-fit:cover;border-radius:10px;cursor:zoom-in;margin-top:6px">` : '';
  return `
    <section class="card pad stack" style="border-color:var(--warn)">
      <div class="between"><h2 class="section-title">${icon('alert')} Laporan masalah</h2>${statusBadge(d.status)}</div>
      ${d.status === 'OPEN' ? `<div class="alert warn small">${icon('lock')}<div>Bayaran ${rm(o.total)} <b>dibekukan</b> sehingga admin menyemak kedua-dua pihak. ${role === 'seller' && !d.seller_response ? 'Sila beri penjelasan anda supaya admin boleh membuat keputusan yang adil.' : 'Admin akan memaklumkan keputusan melalui notifikasi.'}</div></div>` : ''}
      <div class="stack-sm">
        <div class="eyebrow">Pembeli · ${fmtDateTime(d.created_at)}</div>
        <div class="bold">${esc(reasons[d.reason] || d.reason)}</div>
        <p class="small muted" style="white-space:pre-wrap">${esc(d.details)}</p>
        ${img(d.evidence)}
      </div>
      <hr class="sep">
      <div class="stack-sm">
        <div class="eyebrow">Penjelasan peniaga</div>
        ${d.seller_response ? `<p class="small muted" style="white-space:pre-wrap">${esc(d.seller_response)}</p>${img(d.seller_evidence)}` : '<p class="small faint">Belum ada penjelasan.</p>'}
      </div>
      ${d.status === 'RESOLVED' ? `<div class="alert success small">${icon('checkCircle')}<div><b>Keputusan admin:</b> ${esc(outcome || d.outcome)}${d.admin_note ? `<div>${esc(d.admin_note)}</div>` : ''}<div class="xs faint">${fmtDateTime(d.resolved_at)}</div></div></div>` : ''}
    </section>`;
}

Object.assign(actions, {
  async confirmOrder(el, e) {
    e.stopPropagation();
    if (!(await confirmDialog('Sahkan anda telah menerima pesanan ini dengan baik? Bayaran akan dilepaskan kepada peniaga serta-merta dan tidak boleh dipertikaikan lagi.', { ok: 'Ya, sudah terima' }))) return;
    await api('POST', `/api/orders/${el.dataset.id}/confirm`);
    toast('Terima kasih! Bayaran telah dilepaskan kepada peniaga.', 'success');
    refresh();
  },
  disputeModal(el) {
    const reasons = state.config.dispute_reasons || {};
    openModal({
      title: 'Laporkan masalah pesanan',
      body: `
        <form id="disputeForm" data-form="dispute" data-id="${el.dataset.id}" class="stack">
          <div class="alert info small">${icon('shield')}<div>Bayaran anda akan <b>dibekukan</b> – peniaga tidak akan menerimanya sehingga admin menyemak laporan ini dan penjelasan peniaga. Cuba chat dengan peniaga dahulu; banyak masalah boleh diselesaikan dengan cepat.</div></div>
          <div class="field"><label>Apa masalahnya? *</label>
            <select class="input" name="reason" required>${Object.entries(reasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
          <div class="field"><label>Terangkan apa yang berlaku *</label>
            <textarea class="input" name="details" required minlength="10" maxlength="1000" rows="4" placeholder="Cth: Peniaga tandakan selesai tetapi saya tidak menerima apa-apa. Saya menunggu di lobi Kolej Za'ba dari jam 1 hingga 2 petang."></textarea></div>
          ${imageField('evidence', null, 'Bukti gambar (pilihan)', 'Cth: gambar makanan yang rosak atau tangkap layar chat.')}
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-danger" type="submit" form="disputeForm">${icon('alert')} Hantar laporan</button>`
    });
  },
  respondModal(el) {
    openModal({
      title: 'Penjelasan kepada admin',
      body: `
        <form id="respondForm" data-form="disputeRespond" data-id="${el.dataset.id}" class="stack">
          <p class="small muted">Terangkan apa yang berlaku dari pihak anda. Admin akan menimbang kedua-dua penjelasan sebelum memutuskan ke mana bayaran pergi.</p>
          <div class="field"><label>Penjelasan anda *</label>
            <textarea class="input" name="response" required minlength="10" maxlength="1000" rows="4" placeholder="Cth: Pesanan dihantar jam 1:15 petang dan diserahkan kepada rakan sebilik pembeli. Gambar bukti dilampirkan."></textarea></div>
          ${imageField('evidence', null, 'Bukti gambar (pilihan)', 'Cth: gambar penghantaran atau resit.')}
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="respondForm">Hantar penjelasan</button>`
    });
  }
});

Object.assign(forms, {
  async dispute(data, form) {
    await api('POST', `/api/orders/${form.dataset.id}/dispute`, { reason: data.reason, details: data.details, evidence: data.evidence || null });
    closeOverlay();
    toast('Laporan dihantar. Bayaran dibekukan sehingga admin membuat keputusan.', 'success', { title: 'Laporan diterima' });
    refresh();
  },
  async disputeRespond(data, form) {
    await api('POST', `/api/orders/${form.dataset.id}/dispute/respond`, { response: data.response, evidence: data.evidence || null });
    closeOverlay();
    toast('Penjelasan dihantar kepada admin.', 'success');
    refresh();
  }
});
