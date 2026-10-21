import { state, api, esc, rm, toSen, icon, page, actions, forms, changes, onPage, refresh, openModal, closeOverlay, toast, statusBadge, emptyState, fmtDateTime, imageField, hooks } from '../core.js';

const TX = {
  TOPUP: ['Tambah nilai', 'down', 'in'], TRANSFER_IN: ['Pindahan masuk', 'down', 'in'], TRANSFER_OUT: ['Pindahan keluar', 'up', 'out'],
  ORDER_PAY: ['Bayaran pesanan', 'bag', 'out'], ORDER_REFUND: ['Pulangan pesanan', 'refresh', 'in'], ORDER_EARN: ['Hasil jualan', 'trend', 'in'],
  LICENSE_FEE: ['Yuran lesen', 'store', 'out'], LICENSE_REFUND: ['Pulangan yuran', 'refresh', 'in'], WITHDRAW: ['Pengeluaran', 'bank', 'out'],
  WITHDRAW_REFUND: ['Pengeluaran dipulangkan', 'refresh', 'in'], ADJUST: ['Pelarasan', 'sliders', '']
};

page('/wallet', async (_, query) => {
  const w = await api('GET', '/api/wallet');
  state.me.balance = w.balance;
  onPage('uh:wallet', () => refresh());
  const pendingTopups = w.topups.filter((t) => t.status === 'PENDING');
  const pendingWd = w.withdrawals.filter((t) => t.status === 'PENDING');
  const html = `
    <div class="narrow stack-lg">
      <div class="page-head"><div><h1>Dompet UPSIHub</h1><p>Bayar pesanan, pindah wang kepada rakan & terima hasil jualan – tanpa aplikasi luar.</p></div></div>
      <section class="wallet-card">
        <div class="small" style="color:#c7d2fe;font-weight:600">Baki tersedia</div>
        <div class="bal" data-balance>${rm(w.balance)}</div>
        <div class="xs" style="color:#a5b4fc">${esc(state.me.name)}${state.me.matric ? ` · ${esc(state.me.matric)}` : ''}</div>
        <div class="wallet-actions">
          <button data-act="topupModal">${icon('plus')} Tambah nilai</button>
          <button data-act="transferModal">${icon('swap')} Pindah</button>
          <button data-act="withdrawModal">${icon('bank')} Keluarkan</button>
        </div>
      </section>

      ${pendingTopups.length || pendingWd.length ? `
        <section class="card">
          <div class="card-head"><h2 class="section-title">Menunggu pengesahan</h2></div>
          <div class="card-body stack-sm">
            ${pendingTopups.map((t) => `<div class="between small"><span>${icon('clock')} Tambah nilai ${rm(t.amount)} · ${t.method === 'BANK' ? 'Pindahan bank' : 'Kaunter'}</span><span class="faint">${fmtDateTime(t.created_at)}</span></div>`).join('')}
            ${pendingWd.map((t) => `<div class="between small"><span>${icon('clock')} Pengeluaran ${rm(t.amount)} ke ${esc(t.bank_name)}</span><span class="faint">${fmtDateTime(t.created_at)}</span></div>`).join('')}
          </div>
        </section>` : ''}

      <section class="card">
        <div class="card-head"><h2 class="section-title">Sejarah transaksi</h2><span class="small faint">${w.transactions.length} terkini</span></div>
        <div class="card-body" style="padding-top:4px;padding-bottom:4px">
          ${w.transactions.length ? w.transactions.map((t) => {
            const [label, ic, dir] = TX[t.type] || [t.type, 'info', ''];
            return `<div class="tx"><div class="tx-ic ${t.amount > 0 ? 'in' : dir}">${icon(ic)}</div>
              <div class="grow"><div class="small bold">${esc(label)}</div><div class="xs muted clamp-1">${esc(t.description)}</div><div class="xs faint">${fmtDateTime(t.created_at)}</div></div>
              <div class="right"><div class="${t.amount > 0 ? 'amt-in' : 'amt-out'}">${t.amount > 0 ? '+' : '−'}${rm(Math.abs(t.amount))}</div><div class="xs faint">Baki ${rm(t.balance_after)}</div></div></div>`;
          }).join('') : emptyState('wallet', 'Belum ada transaksi', 'Tambah nilai dompet untuk mula membayar pesanan tanpa tunai.')}
        </div>
      </section>

      ${w.topups.some((t) => t.status !== 'PENDING') ? `
        <section class="card">
          <div class="card-head"><h2 class="section-title">Permohonan tambah nilai</h2></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Tarikh</th><th>Jumlah</th><th>Kaedah</th><th>Status</th><th>Nota admin</th></tr></thead><tbody>
            ${w.topups.map((t) => `<tr><td class="small">${fmtDateTime(t.created_at)}</td><td class="bold">${rm(t.amount)}</td><td class="small">${t.method === 'BANK' ? 'Pindahan bank' : 'Kaunter'}</td><td>${statusBadge(t.status)}</td><td class="small muted">${esc(t.admin_note || '-')}</td></tr>`).join('')}
          </tbody></table></div>
        </section>` : ''}

      <div class="alert info small">${icon('shield')}<div>Semua wang dalam dompet direkodkan dalam lejar UPSIHub. Pembayaran pesanan dipegang sehingga pesanan selesai, dan dipulangkan secara automatik jika pesanan dibatalkan.</div></div>
    </div>`;
  return { html, after: () => { if (query.get('topup')) actions.topupModal(); } };
}, { auth: true });

Object.assign(actions, {
  topupModal() {
    const { topup_bank: bank, topup_qr: qr, counter_info: counter } = state.config;
    openModal({
      title: 'Tambah nilai dompet',
      body: `
        <form id="topupForm" data-form="topup" class="stack">
          <div class="field"><label>Jumlah (RM)</label>
            <div class="input-prefix"><span>RM</span><input class="input" name="amount" type="number" min="1" max="1000" step="0.01" required placeholder="50.00" id="topupAmt"></div>
            <div class="amount-chips">${[10, 20, 50, 100].map((v) => `<button type="button" data-act="setAmount" data-v="${v}">RM${v}</button>`).join('')}</div>
          </div>
          <div class="field"><label>Kaedah</label>
            <div class="seg">
              <label><input type="radio" name="method" value="BANK" checked data-change="topupMethod">${icon('bank')} Pindahan bank</label>
              <label><input type="radio" name="method" value="COUNTER" data-change="topupMethod">${icon('banknote')} Tunai di kaunter</label>
            </div>
          </div>
          <div id="topupBank" class="stack">
            ${qr ? `<div class="center"><img src="${esc(qr)}" alt="Kod QR pembayaran" style="width:180px;margin:0 auto;border-radius:12px;border:1px solid var(--border)"><div class="xs faint" style="margin-top:4px">Imbas dengan aplikasi bank anda</div></div>` : ''}
            <div class="bank-box">
              <div><span class="faint">Bank</span><b>${esc(bank.bank)}</b></div>
              <div><span class="faint">No. akaun</span><span class="row"><b class="mono">${esc(bank.account)}</b><button type="button" class="btn btn-link xs" data-act="copyText" data-text="${esc(bank.account)}">${icon('copy')}</button></span></div>
              <div><span class="faint">Nama penerima</span><b>${esc(bank.name)}</b></div>
            </div>
            <div class="field"><label>No. rujukan transaksi</label><input class="input" name="reference" maxlength="60" placeholder="Cth: 20261021981"></div>
            ${imageField('receipt', null, 'Resit pindahan', 'Tangkap layar resit daripada aplikasi bank anda.')}
          </div>
          <div id="topupCounter" class="alert info small hidden">${icon('pin')}<div>Hantar permohonan, kemudian bayar tunai di <b>${esc(counter)}</b>. Kakitangan akan mengesahkan dan dompet anda dikreditkan serta-merta.</div></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="topupForm">Hantar permohonan</button>`
    });
  },
  setAmount(el) { document.getElementById('topupAmt').value = el.dataset.v; },
  async copyText(el) {
    try { await navigator.clipboard.writeText(el.dataset.text); toast('Disalin ke papan klip.', 'success', { timeout: 1500 }); } catch { toast(el.dataset.text, 'info'); }
  },
  transferModal() {
    openModal({
      title: 'Pindah wang',
      body: `
        <form id="transferForm" data-form="transfer" class="stack">
          <div class="field"><label>Penerima (e-mel atau no. matrik)</label><input class="input" name="to" required placeholder="rakan@siswa.upsi.edu.my / D2023…"></div>
          <div class="field"><label>Jumlah (RM)</label><div class="input-prefix"><span>RM</span><input class="input" name="amount" type="number" min="0.10" step="0.01" required></div><span class="hint">Baki: <b data-balance>${rm(state.me.balance)}</b></span></div>
          <div class="field"><label>Nota</label><input class="input" name="note" maxlength="100" placeholder="Cth: Kongsi bayar prebet"></div>
          <div class="field"><label>Sahkan dengan kata laluan</label><input class="input" type="password" name="password" required autocomplete="current-password"></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="transferForm">${icon('send')} Pindah</button>`
    });
  },
  withdrawModal() {
    openModal({
      title: 'Keluarkan ke akaun bank',
      body: `
        <form id="withdrawForm" data-form="withdraw" class="stack">
          <div class="alert info small">${icon('info')}<div>Untuk peniaga & pengguna yang ingin mengeluarkan baki. Diproses oleh admin dalam 1–3 hari bekerja. Minimum RM10.</div></div>
          <div class="field"><label>Jumlah (RM)</label><div class="input-prefix"><span>RM</span><input class="input" name="amount" type="number" min="10" step="0.01" required></div><span class="hint">Baki: <b data-balance>${rm(state.me.balance)}</b></span></div>
          <div class="grid-2">
            <div class="field"><label>Nama bank</label><input class="input" name="bank_name" required maxlength="60" placeholder="Maybank"></div>
            <div class="field"><label>No. akaun</label><input class="input" name="account_no" required maxlength="30" inputmode="numeric"></div>
          </div>
          <div class="field"><label>Nama pemegang akaun</label><input class="input" name="account_name" required maxlength="80" value="${esc(state.me.name)}"></div>
          <div class="field"><label>Sahkan dengan kata laluan</label><input class="input" type="password" name="password" required autocomplete="current-password"></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="withdrawForm">Hantar permohonan</button>`
    });
  }
});

changes.topupMethod = (el) => {
  document.getElementById('topupBank').classList.toggle('hidden', el.value !== 'BANK');
  document.getElementById('topupCounter').classList.toggle('hidden', el.value !== 'COUNTER');
};

forms.topup = async (data) => {
  await api('POST', '/api/wallet/topup', { amount: toSen(data.amount), method: data.method, reference: data.reference, receipt: data.receipt || null });
  closeOverlay();
  toast('Permohonan dihantar. Anda akan dimaklumkan sebaik sahaja disahkan.', 'success', { title: 'Tambah nilai' });
  refresh();
};
forms.transfer = async (data) => {
  const r = await api('POST', '/api/wallet/transfer', { ...data, amount: toSen(data.amount) });
  closeOverlay();
  toast(`${rm(toSen(data.amount))} dipindahkan kepada ${r.to}.`, 'success');
  await hooks.loadMe();
  refresh();
};
forms.withdraw = async (data) => {
  await api('POST', '/api/wallet/withdraw', { ...data, amount: toSen(data.amount) });
  closeOverlay();
  toast('Permohonan pengeluaran dihantar kepada admin.', 'success');
  await hooks.loadMe();
  refresh();
};
