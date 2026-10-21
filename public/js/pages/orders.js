import { api, esc, rm, icon, page, actions, forms, onPage, refresh, statusBadge, emptyState, fmtDateTime, timeAgo, openModal, closeOverlay, confirmDialog, toast, hooks } from '../core.js';

const ACTIVE = ['PENDING', 'ACCEPTED', 'READY'];
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
  const idx = STEPS.findIndex(([s]) => s === o.status);
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
    if (o.status === 'COMPLETED' && !o.review) out.push(`<button class="btn btn-primary" data-act="reviewOrder" data-id="${o.id}">${icon('star')} Beri ulasan</button>`);
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
  const active = orders.filter((o) => ACTIVE.includes(o.status));
  const done = orders.filter((o) => !ACTIVE.includes(o.status));
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
