// Booking dialogs for prebet trips, service slots and car rentals.
import { state, api, esc, rm, icon, actions, forms, changes, inputs, openModal, closeOverlay, toast, hooks, ymd, addDays, fmtDay, photoStrip } from '../core.js';

// Pages put the shops/items/vehicles they render here so dialogs can open instantly.
export const cache = { shops: {}, items: {}, vehicles: {} };
export function remember(shop, items = [], vehicles = []) {
  cache.shops[shop.id] = shop;
  for (const it of items) cache.items[it.id] = { ...it, shop_id: shop.id };
  for (const v of vehicles) cache.vehicles[v.id] = { ...v, shop_id: shop.id, shop_name: shop.name };
}

function needLogin() {
  if (state.me) return false;
  closeOverlay();
  toast('Sila log masuk untuk membuat tempahan.', 'info');
  location.hash = `#/login?next=${encodeURIComponent(location.hash.slice(1) || '/')}`;
  return true;
}

const paymentChoice = (shop, walletOnly = false) => `
  <div class="field"><label>Bayaran</label>
    <label class="radio-card"><input type="radio" name="payment" value="WALLET" checked>
      <div class="grow"><div class="bold small">${icon('wallet')} Dompet UPSIHub</div><div class="xs muted">Baki <b data-balance>${rm(state.me?.balance)}</b> · dipegang sehingga selesai, dilindungi</div></div></label>
    ${!walletOnly && shop.allow_cash ? `<label class="radio-card"><input type="radio" name="payment" value="CASH"><div class="grow"><div class="bold small">${icon('banknote')} Tunai</div><div class="xs muted">Bayar terus kepada penyedia</div></div></label>` : ''}
  </div>`;

function localDateTimeMin(minutesAhead = 20) {
  const d = new Date(Date.now() + minutesAhead * 60e3);
  d.setSeconds(0, 0);
  return `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function submitBooking(payload) {
  const { order } = await api('POST', '/api/bookings', payload);
  closeOverlay();
  await hooks.loadMe();
  toast(`Tempahan ${order.code} dihantar. Anda akan dimaklumkan apabila disahkan.`, 'success', { title: 'Tempahan berjaya!' });
  location.hash = `#/orders/${order.id}`;
}

// ---------------------------------------------------------------------
Object.assign(actions, {
  bookRide(el) {
    if (needLogin()) return;
    const item = cache.items[el.dataset.item];
    const shop = cache.shops[item.shop_id];
    openModal({
      title: 'Tempah trip prebet',
      body: `
        <form id="rideForm" data-form="bookRide" data-shop="${shop.id}" data-item="${item.id}" data-price="${item.price}" class="stack">
          <div class="bank-box"><div><span class="faint">Laluan</span><b>${esc(item.title)}</b></div><div><span class="faint">Pemandu</span><b>${esc(shop.name)}</b></div><div><span class="faint">Harga seorang</span><b class="price">${rm(item.price)}</b></div></div>
          <div class="grid-2">
            <div class="field"><label>Tarikh & masa ambil *</label><input class="input" type="datetime-local" name="start" required min="${localDateTimeMin()}" value="${localDateTimeMin(60)}"></div>
            <div class="field"><label>Bilangan penumpang *</label><input class="input" type="number" name="pax" min="1" max="14" value="1" required data-input="ridePax"></div>
          </div>
          <div class="field"><label>Lokasi ambil *</label><input class="input" name="pickup" required minlength="3" maxlength="150" placeholder="Cth: Kolej Za'ba, Blok B (depan pondok pengawal)"></div>
          <div class="field"><label>Destinasi (jika berbeza)</label><input class="input" name="dropoff" maxlength="150" placeholder="${esc(item.title)}"></div>
          <div class="field"><label>Nota</label><input class="input" name="note" maxlength="300" placeholder="Cth: Ada 2 bagasi besar"></div>
          ${paymentChoice(shop)}
          <div class="total-row between"><span>Jumlah</span><span class="price" id="rideTotal">${rm(item.price)}</span></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="rideForm">${icon('check')} Tempah</button>`
    });
  },

  bookService(el) {
    if (needLogin()) return;
    const item = cache.items[el.dataset.item];
    const shop = cache.shops[item.shop_id];
    const first = ymd(new Date());
    openModal({
      title: 'Tempah slot servis',
      body: `
        <form id="serviceForm" data-form="bookService" data-shop="${shop.id}" data-item="${item.id}" class="stack">
          <div class="bank-box"><div><span class="faint">Servis</span><b>${esc(item.title)}</b></div><div><span class="faint">Penyedia</span><b>${esc(shop.name)}</b></div><div><span class="faint">Tempoh · Harga</span><b>${item.duration_min} min · <span class="price">${rm(item.price)}</span></b></div></div>
          <div class="field"><label>Pilih tarikh</label><input class="input" type="date" name="date" min="${first}" max="${addDays(first, 60)}" value="${first}" data-change="loadSlots"></div>
          <div class="field"><label>Pilih masa</label><div class="slots" id="slotGrid"><div class="skeleton" style="height:40px"></div></div><input type="hidden" name="start_at"></div>
          <div class="field"><label>Lokasi / platform</label><input class="input" name="address" maxlength="150" placeholder="Cth: Perpustakaan Tuanku Bainun / Google Meet"></div>
          <div class="field"><label>Nota</label><input class="input" name="note" maxlength="300" placeholder="Cth: Topik yang ingin difokuskan"></div>
          ${paymentChoice(shop)}
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="serviceForm">${icon('check')} Tempah slot</button>`
    });
    changes.loadSlots(document.querySelector('#serviceForm [name=date]'));
  },

  pickSlot(el) {
    document.querySelectorAll('#slotGrid button').forEach((b) => b.classList.toggle('on', b === el));
    document.querySelector('#serviceForm [name=start_at]').value = el.dataset.at;
  },

  async bookRental(el) {
    if (needLogin()) return;
    const { vehicle: v, shop, booked } = await api('GET', `/api/vehicles/${el.dataset.vehicle}`);
    const start = addDays(ymd(new Date()), 1);
    openModal({
      title: 'Sewa kereta',
      body: `
        <form id="rentalForm" data-form="bookRental" data-vehicle="${v.id}" data-rate="${v.daily_rate}" data-deposit="${v.deposit}" data-booked='${esc(JSON.stringify(booked))}' class="stack">
          <div class="row">
            <div class="thumb" style="width:84px;height:64px">${v.image ? `<img src="${esc(v.image)}" alt="">` : '🚗'}</div>
            <div class="grow"><b>${esc(v.model)}</b><div class="xs muted">${esc(v.plate)} · ${v.seats} tempat duduk · ${v.transmission === 'AUTO' ? 'Auto' : 'Manual'}</div><div class="xs muted">${esc(shop.name)}</div></div>
          </div>
          ${v.images.length > 1 ? photoStrip(v.images, 64) : ''}
          ${v.notes ? `<div class="alert info small">${icon('info')}<div>${esc(v.notes)}</div></div>` : ''}
          <div class="grid-2">
            <div class="field"><label>Tarikh ambil *</label><input class="input" type="date" name="start_date" required min="${ymd(new Date())}" value="${start}" data-change="rentalCalc"></div>
            <div class="field" id="endField"><label>Tarikh pulang</label><input class="input" type="date" name="end_date" min="${addDays(start, 1)}" value="${addDays(start, 1)}" data-change="rentalCalc"></div>
          </div>
          <label class="check"><input type="checkbox" name="open_end" data-change="rentalCalc"> Belum pasti tarikh pulang</label>
          ${booked.length ? `<div class="small"><div class="label" style="margin-bottom:4px">Tarikh sudah ditempah</div><div class="row-wrap">${booked.map((b) => `<span class="badge red">${fmtDay(b.start_at)} – ${b.end_at ? fmtDay(b.end_at) : 'belum dipulangkan'}</span>`).join('')}</div></div>` : '<div class="xs faint">Tiada tempahan lain buat masa ini.</div>'}
          <div class="field"><label>Lokasi & masa ambil kereta</label><input class="input" name="pickup" maxlength="150" placeholder="Cth: Depan Kolej Harun Aminurrashid, 9 pagi"></div>
          <div class="field"><label>Nota</label><input class="input" name="note" maxlength="300" placeholder="Cth: Perlu car seat bayi"></div>
          <div class="line-items" id="rentalCalc"></div>
          <div class="alert info small">${icon('shield')}<div>Sewa kereta dibayar melalui Dompet sahaja. Deposit dipulangkan secara automatik selepas kereta dipulangkan. Jika ada kerosakan, pemilik boleh membuat tuntutan melalui admin.</div></div>
        </form>`,
      foot: `<button class="btn btn-ghost" data-act="closeOverlay">Batal</button><button class="btn btn-primary" type="submit" form="rentalForm">${icon('key')} Tempah & bayar</button>`
    });
    changes.rentalCalc(document.querySelector('#rentalForm [name=start_date]'));
  }
});

inputs.ridePax = (el) => {
  const form = el.closest('form');
  document.getElementById('rideTotal').textContent = rm(Number(form.dataset.price) * Math.max(1, Number(el.value) || 1));
};

changes.loadSlots = async (el) => {
  const form = el.closest('form');
  const grid = document.getElementById('slotGrid');
  form.start_at.value = '';
  grid.innerHTML = '<div class="skeleton" style="height:40px"></div>';
  const { slots } = await api('GET', `/api/shops/${form.dataset.shop}/slots?item=${form.dataset.item}&date=${el.value}`);
  if (!document.body.contains(grid)) return;
  grid.innerHTML = slots.length
    ? slots.map((s) => `<button type="button" class="slot" ${s.free ? '' : 'disabled'} data-act="pickSlot" data-at="${s.start_at}">${s.label}</button>`).join('')
    : '<p class="small faint">Tiada slot pada hari ini (hari cuti penyedia). Pilih tarikh lain.</p>';
};

changes.rentalCalc = (el) => {
  const form = el.closest('form');
  const start = form.start_date.value;
  const open = form.open_end?.checked;
  document.getElementById('endField').classList.toggle('hidden', !!open);
  form.end_date.required = !open;
  if (open) {
    const rate = Number(form.dataset.rate);
    const deposit = Number(form.dataset.deposit);
    const s0 = new Date(`${start}T00:00`).getTime();
    const blocked = JSON.parse(form.dataset.booked).some((b) => b.end_at == null || b.end_at > s0);
    document.getElementById('rentalCalc').innerHTML = `
      <div><span class="muted">Sewa hari pertama</span><span>${rm(rate)}</span></div>
      <div><span class="muted">Deposit</span><span>${rm(deposit)}</span></div>
      <div class="total-row"><span>Jumlah dibayar sekarang</span><span class="price">${rm(rate + deposit)}</span></div>
      <div class="alert info small">${icon('info')}<div>Sewa dikira ${rm(rate)} sehari sehingga kereta dipulangkan. Bila dipulangkan, baki sewa ditolak dari dompet anda (atau deposit jika baki tidak cukup), dan baki deposit dipulangkan.</div></div>
      ${blocked ? `<div class="alert danger small">${icon('alert')}<div>Kereta ini ada tempahan lain selepas tarikh ini. Sila pilih tarikh pulang.</div></div>` : ''}`;
    return;
  }
  if (start && (!form.end_date.value || form.end_date.value <= start)) form.end_date.value = addDays(start, 1);
  form.end_date.min = start ? addDays(start, 1) : '';
  const days = Math.round((new Date(`${form.end_date.value}T00:00`) - new Date(`${start}T00:00`)) / 864e5);
  const rate = Number(form.dataset.rate);
  const deposit = Number(form.dataset.deposit);
  const booked = JSON.parse(form.dataset.booked);
  const s = new Date(`${start}T00:00`).getTime();
  const e = new Date(`${form.end_date.value}T00:00`).getTime();
  const clash = booked.some((b) => b.start_at < e && b.end_at > s);
  document.getElementById('rentalCalc').innerHTML = `
    <div><span class="muted">${rm(rate)} × ${days} hari</span><span>${rm(rate * days)}</span></div>
    <div><span class="muted">Deposit (dipulangkan)</span><span>${rm(deposit)}</span></div>
    <div class="total-row"><span>Jumlah dibayar sekarang</span><span class="price">${rm(rate * days + deposit)}</span></div>
    ${clash ? `<div class="alert danger small">${icon('alert')}<div>Tarikh ini bertindih dengan tempahan lain.</div></div>` : ''}
    ${days > 30 ? `<div class="alert danger small">${icon('alert')}<div>Maksimum 30 hari setiap tempahan.</div></div>` : ''}`;
};

Object.assign(forms, {
  bookRide: (d, form) => submitBooking({
    type: 'RIDE', shopId: Number(form.dataset.shop), itemId: Number(form.dataset.item), start_at: new Date(d.start).getTime(),
    pax: Number(d.pax), pickup: d.pickup, dropoff: d.dropoff, note: d.note, payment: d.payment
  }),
  bookService(d, form) {
    if (!d.start_at) throw new Error('Sila pilih masa slot.');
    return submitBooking({ type: 'SERVICE', shopId: Number(form.dataset.shop), itemId: Number(form.dataset.item), start_at: Number(d.start_at), address: d.address, note: d.note, payment: d.payment });
  },
  bookRental: (d, form) => submitBooking({
    type: 'RENTAL', vehicleId: Number(form.dataset.vehicle), start_date: d.start_date, end_date: d.open_end === 'on' ? null : d.end_date, pickup: d.pickup, note: d.note, payment: 'WALLET'
  })
});
