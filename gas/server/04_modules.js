// One-stop-centre modules (port of src/modules.js).

function myDow(ms) { return new Date(ms + MY_OFFSET).getUTCDay(); }
function hhmmToMin(s) { return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)); }
function minToHhmm(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }

function listedShop(id) {
  var s = T('shops').get(Number(id));
  if (!isListed(s)) fail(404, 'Kedai tidak aktif.');
  return s;
}
function futureTime(v, label) {
  var t = Number(v);
  if (!isFinite(t) || t < Date.now() + 15 * 60e3) fail(400, label + ' mesti sekurang-kurangnya 15 minit dari sekarang.');
  if (t > Date.now() + 90 * DAY_MS) fail(400, label + ' mesti dalam tempoh 90 hari.');
  return t;
}
function paymentFor(shop, v, walletOnly) {
  var p = oneOf(v || 'WALLET', ['WALLET', 'CASH'], 'Kaedah bayaran');
  if (p === 'CASH' && (walletOnly || !shop.allow_cash)) fail(400, 'Tempahan ini hanya boleh dibayar melalui Dompet UPSIHub.');
  return p;
}
function listingRows(pred, sorter, limit) {
  return T('listings').all(pred).sort(sorter || byDesc('created_at')).slice(0, limit || 60).map(function (l) { return listingOut(l); });
}

// =====================================================================
// HUB
// =====================================================================
route('GET', '/api/hub', function () {
  var now = Date.now();
  var listed = {};
  T('shops').all(function (s) { return s.status === 'APPROVED' && s.license_until > now; }).forEach(function (s) { listed[s.id] = 1; });
  var shopsWith = function (kind) {
    var ids = {};
    T('items').all(function (i) { return listed[i.shop_id] && i.kind === kind && i.available; }).forEach(function (i) { ids[i.shop_id] = 1; });
    return Object.keys(ids).length;
  };
  var lcount = function (kind) { return T('listings').count(function (l) { return l.kind === kind && l.status === 'ACTIVE'; }); };
  return {
    counts: {
      shops: Object.keys(listed).length,
      rides: shopsWith('ROUTE'),
      vehicles: T('vehicles').count(function (v) { return v.active && listed[v.shop_id]; }),
      services: shopsWith('SERVICE'),
      ITEM: lcount('ITEM'), ROOM: lcount('ROOM'), JOB: lcount('JOB'), EVENT: lcount('EVENT'), LOST: lcount('LOST')
    },
    latest: listingRows(function (l) { return l.kind === 'ITEM' && l.status === 'ACTIVE'; }, null, 8),
    rooms: listingRows(function (l) { return l.kind === 'ROOM' && l.status === 'ACTIVE'; }, null, 4),
    events: listingRows(function (l) { return l.kind === 'EVENT' && (l.status === 'ACTIVE' || l.status === 'SOLD'); }, null, 20)
      .filter(function (l) { return l.meta.event_at > now; }).sort(function (a, b) { return a.meta.event_at - b.meta.event_at; }).slice(0, 4)
  };
});

// =====================================================================
// RIDES & SERVICES
// =====================================================================
function shopsWithItemKind(kind, campus) {
  var now = Date.now();
  var ids = {};
  T('items').all(function (i) { return i.kind === kind && i.available; }).forEach(function (i) { ids[i.shop_id] = 1; });
  var shops = T('shops').all(function (s) { return ids[s.id] && s.status === 'APPROVED' && s.license_until > now; });
  if (campus && campus !== 'ALL') shops = shops.filter(function (s) { return s.campus === campus; });
  return shops.map(function (s) {
    return shopOut(s, {
      offers: T('items').all(function (i) { return i.shop_id === s.id && i.kind === kind && i.available; }).sort(byAsc('price'))
        .map(function (i) { return pick(i, ['id', 'title', 'description', 'price', 'duration_min']); })
    });
  }).sort(function (a, b) { return (b.is_open - a.is_open) || (b.rating - a.rating); });
}
route('GET', '/api/rides', function (c) { return { shops: shopsWithItemKind('ROUTE', c.query.get('campus')) }; });
route('GET', '/api/services', function (c) { return { shops: shopsWithItemKind('SERVICE', c.query.get('campus')) }; });

function serviceSlots(shop, item, dateStr) {
  var hours = shop.booking_hours ? JSON.parse(shop.booking_hours) : null;
  if (!hours) return [];
  var dayStart = myDate(dateStr, 'Tarikh');
  if (hours.days.indexOf(myDow(dayStart)) < 0) return [];
  var busy = T('orders').all(function (o) {
    return o.shop_id === shop.id && o.kind === 'SERVICE' && isActive(o.status) && o.start_at < dayStart + DAY_MS && o.end_at > dayStart;
  });
  var out = [];
  var dur = item.duration_min;
  for (var m = hhmmToMin(hours.start); m + dur <= hhmmToMin(hours.end); m += 30) {
    var start = dayStart + m * 60e3;
    var end = start + dur * 60e3;
    var free = start > Date.now() + 30 * 60e3 && !busy.some(function (b) { return b.start_at < end && b.end_at > start; });
    out.push({ start_at: start, label: minToHhmm(m), free: free });
  }
  return out;
}
route('GET', '/api/shops/:id/slots', function (c) {
  var shop = listedShop(c.params.id);
  var item = T('items').get(Number(c.query.get('item')));
  if (!item || item.shop_id !== shop.id || item.kind !== 'SERVICE') fail(404, 'Servis tidak dijumpai.');
  return { slots: serviceSlots(shop, item, c.query.get('date')), hours: shop.booking_hours ? JSON.parse(shop.booking_hours) : null };
});

// =====================================================================
// VEHICLES
// =====================================================================
function vehicleOut(v, extra) {
  return assign({
    id: v.id, shop_id: v.shop_id, model: v.model, plate: v.plate, seats: v.seats, transmission: v.transmission, image: v.image,
    images: JSON.parse(v.images || '[]'), daily_rate: v.daily_rate, deposit: v.deposit, notes: v.notes || '', active: !!v.active
  }, extra);
}
// end_at is empty for a rental with no planned return date: the car stays blocked until returned.
function bookedRanges(vehicleId) {
  var from = Date.now() - DAY_MS;
  return T('orders').all(function (o) { return o.vehicle_id === vehicleId && isActive(o.status) && (o.end_at == null || o.end_at > from); })
    .sort(byAsc('start_at')).map(function (o) { return { start_at: o.start_at, end_at: o.end_at }; });
}
route('GET', '/api/vehicles', function (c) {
  var campus = c.query.get('campus');
  var now = Date.now();
  var rows = T('vehicles').all(function (v) { var s = T('shops').get(v.shop_id); return v.active && s && s.status === 'APPROVED' && s.license_until > now; })
    .sort(byAsc('daily_rate'))
    .map(function (v) { var s = T('shops').get(v.shop_id); return vehicleOut(v, { shop_name: s.name, campus: s.campus }); });
  if (campus && campus !== 'ALL') rows = rows.filter(function (v) { return v.campus === campus; });
  return { vehicles: rows };
});
route('GET', '/api/vehicles/:id', function (c) {
  var v = T('vehicles').get(Number(c.params.id));
  if (!v || !v.active) fail(404, 'Kenderaan tidak dijumpai.');
  return { vehicle: vehicleOut(v), shop: shopOut(listedShop(v.shop_id)), booked: bookedRanges(v.id) };
});

function vehicleFields(b, base) {
  base = base || {};
  var images = b.images !== undefined ? uploadList(b.images) : base.images ? JSON.parse(base.images) : (base.image ? [base.image] : []);
  return {
    model: text(val(b.model, base.model), 'Model kenderaan', { min: 3, max: 80 }),
    plate: text(val(b.plate, base.plate), 'No. plat', { min: 2, max: 15 }).toUpperCase(),
    seats: sen(val(b.seats, val(base.seats, 4)), 'Bilangan tempat duduk', { min: 1, max: 15 }),
    transmission: oneOf(val(b.transmission, val(base.transmission, 'AUTO')), ['AUTO', 'MANUAL'], 'Transmisi'),
    images: JSON.stringify(images),
    image: images[0] || null,
    daily_rate: sen(val(b.daily_rate, base.daily_rate), 'Kadar sewa sehari', { min: 100, max: 100000 }),
    deposit: sen(val(b.deposit, val(base.deposit, 0)), 'Deposit', { max: 200000 }),
    notes: text(val(b.notes, base.notes), 'Syarat', { max: 500, optional: true }),
    active: b.active !== undefined ? (b.active ? 1 : 0) : val(base.active, 1)
  };
}
route('POST', '/api/seller/vehicles', function (c) {
  need(c.user);
  var s = needShop(c.user);
  if (T('vehicles').count(function (v) { return v.shop_id === s.id; }) >= 30) fail(400, 'Had maksimum 30 kenderaan.');
  var v = T('vehicles').insert(assign(vehicleFields(c.body), { shop_id: s.id, created_at: Date.now() }));
  return { vehicle: vehicleOut(v) };
});
route('PATCH', '/api/seller/vehicles/:id', function (c) {
  need(c.user);
  var s = needShop(c.user);
  var v = T('vehicles').get(Number(c.params.id));
  if (!v || v.shop_id !== s.id) fail(404, 'Kenderaan tidak dijumpai.');
  T('vehicles').update(v, vehicleFields(c.body, v));
  return { vehicle: vehicleOut(v) };
});
route('DELETE', '/api/seller/vehicles/:id', function (c) {
  need(c.user);
  var s = needShop(c.user);
  var v = T('vehicles').get(Number(c.params.id));
  if (!v || v.shop_id !== s.id) fail(404, 'Kenderaan tidak dijumpai.');
  if (T('orders').count(function (o) { return o.vehicle_id === v.id && isActive(o.status); })) fail(400, 'Kenderaan ini ada tempahan aktif. Nyahaktifkan sahaja.');
  if (T('orders').count(function (o) { return o.vehicle_id === v.id; })) T('vehicles').update(v, { active: 0 });
  else T('vehicles').remove(function (x) { return x.id === v.id; });
  return { ok: true };
});

// =====================================================================
// BOOKINGS
// =====================================================================
route('POST', '/api/bookings', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  var type = oneOf(b.type, ['RIDE', 'SERVICE', 'RENTAL'], 'Jenis tempahan');
  var note = text(b.note, 'Nota', { max: 300, optional: true });

  if (type === 'RENTAL') {
    var v = T('vehicles').get(Number(b.vehicleId));
    if (!v || !v.active) fail(404, 'Kenderaan tidak dijumpai.');
    var vshop = listedShop(v.shop_id);
    if (vshop.owner_id === user.id) fail(400, 'Anda tidak boleh menyewa kenderaan sendiri.');
    var start = myDate(b.start_date, 'Tarikh ambil');
    var end = b.end_date ? myDate(b.end_date, 'Tarikh pulang') : null;
    var today = myToday();
    if (start < today) fail(400, 'Tarikh ambil sudah lepas.');
    if (start > today + 90 * DAY_MS) fail(400, 'Tempahan hanya boleh dibuat 90 hari lebih awal.');
    var days = end == null ? 1 : Math.round((end - start) / DAY_MS);
    if (days < 1 || days > 30) fail(400, 'Tempoh sewa mesti antara 1 hingga 30 hari.');
    var pickup = text(b.pickup, 'Lokasi & masa ambil', { max: 150, optional: true });
    var o = createOrder({
      buyer: user, sellerId: vshop.owner_id, shopId: vshop.id, vehicleId: v.id, kind: 'RENTAL', payment: paymentFor(vshop, b.payment, true),
      lines: [{ title: 'Sewa ' + v.model + ' (' + v.plate + ')', price: v.daily_rate, qty: days }], deposit: v.deposit,
      startAt: start, endAt: end, pickup: pickup, note: note, label: 'Sewa ' + v.model,
      inTx: function () {
        var endAt = end == null ? Number.MAX_SAFE_INTEGER : end;
        var clash = T('orders').find(function (x) { return x.vehicle_id === v.id && isActive(x.status) && x.start_at < endAt && (x.end_at == null || x.end_at > start); });
        if (clash) fail(409, 'Kenderaan ini sudah ditempah untuk sebahagian tarikh tersebut. Pilih tarikh lain.');
      }
    });
    return { order: orderOut(o) };
  }

  var shop = listedShop(b.shopId);
  if (shop.owner_id === user.id) fail(400, 'Anda tidak boleh menempah servis sendiri.');
  var item = T('items').get(Number(b.itemId));
  if (!item || item.shop_id !== shop.id || !item.available) fail(404, 'Pilihan tidak tersedia.');
  var startAt = futureTime(b.start_at, 'Masa tempahan');
  var payment = paymentFor(shop, b.payment);

  if (type === 'RIDE') {
    if (item.kind !== 'ROUTE') fail(400, 'Item ini bukan trip.');
    var pax = sen(val(b.pax, 1), 'Bilangan penumpang', { min: 1, max: 14 });
    var rp = text(b.pickup, 'Lokasi ambil', { min: 3, max: 150 });
    var dropoff = text(b.dropoff, 'Destinasi', { max: 150, optional: true }) || item.title;
    var ro = createOrder({
      buyer: user, sellerId: shop.owner_id, shopId: shop.id, kind: 'RIDE', payment: payment, fulfilment: 'DELIVERY',
      lines: [{ item_id: item.id, title: item.title, price: item.price, qty: pax }], startAt: startAt, pickup: rp, dropoff: dropoff, pax: pax, note: note, label: shop.name
    });
    return { order: orderOut(ro) };
  }

  if (item.kind !== 'SERVICE') fail(400, 'Item ini bukan servis.');
  var endAt2 = startAt + item.duration_min * 60e3;
  var slot = serviceSlots(shop, item, myYmd(startAt)).filter(function (s) { return s.start_at === startAt; })[0];
  if (!slot) fail(400, 'Masa ini di luar waktu tempahan penyedia servis.');
  var address = text(b.address, 'Lokasi', { max: 150, optional: true });
  var so = createOrder({
    buyer: user, sellerId: shop.owner_id, shopId: shop.id, kind: 'SERVICE', payment: payment, address: address,
    lines: [{ item_id: item.id, title: item.title, price: item.price, qty: 1 }], startAt: startAt, endAt: endAt2, note: note, label: shop.name,
    inTx: function () {
      var clash = T('orders').find(function (x) { return x.shop_id === shop.id && x.kind === 'SERVICE' && isActive(x.status) && x.start_at < endAt2 && x.end_at > startAt; });
      if (clash) fail(409, 'Slot ini baru sahaja ditempah orang lain. Pilih masa lain.');
    }
  });
  return { order: orderOut(so) };
});

// =====================================================================
// LISTINGS
// =====================================================================
function listingFields(kind, b, base) {
  base = base || {};
  var meta = {};
  var m = b.meta || {};
  var bm = base.meta ? JSON.parse(base.meta) : {};
  var mp = function (k) { return m[k] !== undefined ? m[k] : bm[k]; };
  var f = {
    title: text(val(b.title, base.title), 'Tajuk', { min: 5, max: 100 }),
    description: text(val(b.description, base.description), 'Penerangan', { min: 10, max: 2000 }),
    campus: oneOf(val(b.campus, base.campus), Object.keys(CAMPUSES), 'Kampus'),
    location: text(val(b.location, base.location), 'Lokasi', { max: 120, optional: kind !== 'ROOM' }),
    images: JSON.stringify(b.images !== undefined ? uploadList(b.images) : base.images ? JSON.parse(base.images) : []),
    category: null, price: null, negotiable: 0, condition: null, stock: null
  };
  if (kind === 'ITEM') {
    f.category = oneOf(val(b.category, base.category), cats('market'), 'Kategori');
    f.price = sen(val(b.price, base.price), 'Harga', { min: 0, max: 1000000 });
    f.negotiable = val(b.negotiable, base.negotiable) ? 1 : 0;
    f.condition = oneOf(val(b.condition, base.condition), Object.keys(LISTING_META.conditions), 'Keadaan');
    f.stock = sen(val(b.stock, val(base.stock, 1)), 'Kuantiti', { min: 0, max: 50 });
  } else if (kind === 'ROOM') {
    f.price = sen(val(b.price, base.price), 'Sewa sebulan', { min: 100, max: 1000000 });
    meta.room_type = oneOf(mp('room_type'), Object.keys(LISTING_META.room_types), 'Jenis bilik');
    meta.gender = oneOf(mp('gender'), Object.keys(LISTING_META.genders), 'Jantina penyewa');
    meta.available_from = myYmd(myDate(mp('available_from'), 'Tarikh masuk'));
    meta.deposit_note = text(mp('deposit_note'), 'Deposit', { max: 100, optional: true });
    meta.booking_fee = sen(val(mp('booking_fee'), 0), 'Yuran tempahan', { max: 200000 });
    var fac = mp('facilities') || [];
    if (!Array.isArray(fac)) fail(400, 'Kemudahan tidak sah.');
    meta.facilities = fac.filter(function (x) { return LISTING_META.facilities[x]; });
  } else if (kind === 'JOB') {
    f.price = sen(val(b.price, base.price), 'Bayaran', { min: 0, max: 1000000 });
    meta.pay_unit = oneOf(mp('pay_unit'), Object.keys(LISTING_META.pay_units), 'Unit bayaran');
    meta.employer = text(mp('employer'), 'Majikan', { min: 2, max: 80 });
    meta.schedule = text(mp('schedule'), 'Waktu kerja', { max: 120, optional: true });
  } else if (kind === 'EVENT') {
    f.price = sen(val(b.price, val(base.price, 0)), 'Harga tiket', { min: 0, max: 100000 });
    meta.event_at = Number(mp('event_at'));
    if (!isFinite(meta.event_at) || meta.event_at < Date.now()) fail(400, 'Tarikh & masa event mesti pada masa hadapan.');
    meta.venue = text(mp('venue'), 'Tempat', { min: 3, max: 120 });
    f.stock = f.price > 0 ? sen(val(b.stock, base.stock), 'Bilangan tiket', { min: 0, max: 5000 }) : null;
  } else if (kind === 'LOST') {
    meta.type = oneOf(mp('type'), Object.keys(LISTING_META.lost_types), 'Jenis');
    meta.date = myYmd(myDate(mp('date'), 'Tarikh'));
  }
  f.meta = JSON.stringify(meta);
  return f;
}
function loadListing(id) { return T('listings').get(Number(id)) || fail(404, 'Iklan tidak dijumpai.'); }

route('GET', '/api/listings', function (c) {
  var qv = c.query;
  var kind = oneOf(qv.get('kind') || 'ITEM', Object.keys(LISTING_KINDS), 'Jenis');
  var q = String(qv.get('q') || '').trim().toLowerCase();
  var campus = qv.get('campus');
  var category = qv.get('category');
  var max = Number(qv.get('max'));
  var availableOnly = qv.get('available') === '1';
  var pred = function (l) {
    if (l.kind !== kind || ['ACTIVE', 'RESERVED', 'SOLD'].indexOf(l.status) < 0) return false;
    if (q && ((l.title || '') + ' ' + (l.description || '') + ' ' + (l.location || '')).toLowerCase().indexOf(q) < 0) return false;
    if (campus && campus !== 'ALL' && l.campus !== campus) return false;
    if (category && category !== 'ALL' && l.category !== category) return false;
    if (max > 0 && !(l.price <= max)) return false;
    if (availableOnly && l.status !== 'ACTIVE') return false;
    return true;
  };
  var sorter = { cheap: byAsc('price'), expensive: byDesc('price'), newest: byDesc('created_at') }[qv.get('sort')] || byDesc('created_at');
  var rows = listingRows(pred, sorter, 120);
  var dayAgo = Date.now() - DAY_MS;
  rows = rows.filter(function (l) { return l.status !== 'SOLD' || l.updated_at > dayAgo || kind === 'EVENT'; });
  ['room_type', 'gender', 'type', 'pay_unit'].forEach(function (key) {
    var v = qv.get(key);
    if (v && v !== 'ALL') rows = rows.filter(function (l) { return l.meta[key] === v || (key === 'gender' && l.meta.gender === 'CAMPUR'); });
  });
  if (kind === 'EVENT') {
    var now = Date.now();
    rows = rows.filter(function (l) { return l.meta.event_at > now; }).sort(function (a, b) { return a.meta.event_at - b.meta.event_at; });
  }
  return { listings: rows };
});

route('GET', '/api/listings/:id', function (c) {
  var l = loadListing(c.params.id);
  var user = c.user;
  var mine = user && (user.id === l.user_id || user.role === 'admin');
  if (['REMOVED', 'DELETED'].indexOf(l.status) >= 0 && !mine) fail(404, 'Iklan ini telah dipadam.');
  if (!user || user.id !== l.user_id) T('listings').update(l, { views: (l.views || 0) + 1 });
  return { listing: listingOut(l, true), mine: !!(user && user.id === l.user_id) };
}, { write: true });

route('POST', '/api/listings', function (c) {
  var user = c.user;
  need(user);
  if (!rateLimit('post:' + user.id, 20, DAY_MS)) fail(429, 'Had 20 iklan sehari dicapai.');
  if (T('listings').count(function (l) { return l.user_id === user.id && (l.status === 'ACTIVE' || l.status === 'RESERVED'); }) >= 50) fail(400, 'Had maksimum 50 iklan aktif.');
  var kind = oneOf(c.body.kind, Object.keys(LISTING_KINDS), 'Jenis iklan');
  var now = Date.now();
  var l = T('listings').insert(assign(listingFields(kind, c.body), { user_id: user.id, kind: kind, status: 'ACTIVE', views: 0, reports: 0, created_at: now, updated_at: now }));
  return { listing: listingOut(l, true) };
});

route('PATCH', '/api/listings/:id', function (c) {
  need(c.user);
  var l = loadListing(c.params.id);
  if (l.user_id !== c.user.id) fail(403, 'Ini bukan iklan anda.');
  if (['REMOVED', 'DELETED'].indexOf(l.status) >= 0) fail(400, 'Iklan ini tidak boleh disunting.');
  if (c.body.status !== undefined && Object.keys(c.body).length === 1) {
    var status = oneOf(c.body.status, ['ACTIVE', 'CLOSED', 'SOLD'], 'Status');
    if (l.status === 'RESERVED') fail(400, 'Iklan ini sedang ditempah. Selesaikan atau batalkan pesanan dahulu.');
    T('listings').update(l, { status: status, updated_at: Date.now() });
    return { ok: true };
  }
  var f = listingFields(l.kind, c.body, l);
  if (l.status === 'SOLD' && (f.stock || 0) > 0) f.status = 'ACTIVE';
  f.updated_at = Date.now();
  T('listings').update(l, f);
  return { listing: listingOut(l, true) };
});

route('DELETE', '/api/listings/:id', function (c) {
  need(c.user);
  var l = loadListing(c.params.id);
  if (l.user_id !== c.user.id) fail(403, 'Ini bukan iklan anda.');
  if (T('orders').count(function (o) { return o.listing_id === l.id && isActive(o.status); })) fail(400, 'Iklan ini ada pesanan aktif.');
  T('listings').update(l, { status: 'DELETED', updated_at: Date.now() });
  return { ok: true };
});

route('POST', '/api/listings/:id/buy', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  var l = loadListing(c.params.id);
  if (l.user_id === user.id) fail(400, 'Anda tidak boleh membeli iklan sendiri.');
  if (l.status !== 'ACTIVE') fail(400, l.status === 'RESERVED' ? 'Iklan ini sedang ditempah oleh orang lain.' : 'Iklan ini tidak lagi tersedia.');
  var meta = JSON.parse(l.meta || '{}');
  var note = text(b.note, 'Nota', { max: 300, optional: true });
  var kind; var lines; var payment = 'WALLET'; var address = '';
  if (l.kind === 'ITEM') {
    if (!l.price) fail(400, 'Barang percuma – sila chat dengan pemilik untuk mengambilnya.');
    kind = 'ITEM';
    lines = [{ title: l.title, price: l.price, qty: sen(val(b.qty, 1), 'Kuantiti', { min: 1, max: 50 }) }];
    payment = oneOf(b.payment || 'WALLET', ['WALLET', 'CASH'], 'Kaedah bayaran');
    address = text(b.meet, 'Tempat berjumpa', { max: 150, optional: true }) || l.location || '';
  } else if (l.kind === 'EVENT') {
    if (!l.price) fail(400, 'Event ini percuma – tiada tiket diperlukan.');
    if (meta.event_at < Date.now()) fail(400, 'Event ini sudah berlalu.');
    kind = 'TICKET';
    lines = [{ title: 'Tiket: ' + l.title, price: l.price, qty: sen(val(b.qty, 1), 'Bilangan tiket', { min: 1, max: 10 }) }];
  } else if (l.kind === 'ROOM') {
    if (!meta.booking_fee) fail(400, 'Tuan rumah tidak menerima deposit dalam talian. Sila chat untuk berurusan.');
    kind = 'ROOM';
    lines = [{ title: 'Deposit tempahan: ' + l.title, price: meta.booking_fee, qty: 1 }];
  } else {
    fail(400, 'Iklan ini tidak boleh dibeli.');
  }
  var qty = lines[0].qty;
  var o = createOrder({
    buyer: user, sellerId: l.user_id, listingId: l.id, kind: kind, payment: payment, address: address, note: note, lines: lines, label: l.title,
    inTx: function () {
      if (l.stock != null) {
        if (l.stock < qty) fail(400, 'Hanya ' + l.stock + ' tinggal.');
        var left = l.stock - qty;
        T('listings').update(l, { stock: left, status: left === 0 ? (kind === 'TICKET' ? 'SOLD' : 'RESERVED') : 'ACTIVE', updated_at: Date.now() });
      } else if (kind === 'ROOM') {
        T('listings').update(l, { status: 'RESERVED', updated_at: Date.now() });
      }
    }
  });
  return { order: orderOut(o) };
});

route('POST', '/api/listings/:id/report', function (c) {
  need(c.user);
  var l = loadListing(c.params.id);
  if (!rateLimit('report:' + c.user.id + ':' + l.id, 1, 30 * DAY_MS)) fail(409, 'Anda sudah melaporkan iklan ini.');
  var reason = text(c.body.reason, 'Sebab', { min: 5, max: 300 });
  T('listings').update(l, { reports: (l.reports || 0) + 1 });
  notifyAdmins('Iklan dilaporkan', '"' + l.title + '" – ' + reason, '#/admin/listings');
  return { ok: true };
});

route('GET', '/api/users/:id/listings', function (c) {
  var uid = Number(c.params.id);
  return { listings: listingRows(function (l) { return l.user_id === uid && (l.status === 'ACTIVE' || l.status === 'RESERVED'); }, null, 60) };
});

route('GET', '/api/my/listings', function (c) {
  need(c.user);
  var uid = c.user.id;
  return {
    listings: T('listings').all(function (l) { return l.user_id === uid && l.status !== 'DELETED'; }).sort(byDesc('updated_at')).map(function (l) { return listingOut(l, true); }),
    sales: T('orders').all(function (o) { return o.seller_id === uid && o.listing_id != null; }).sort(byDesc('created_at')).slice(0, 50).map(orderOut),
    rating: sellerRating(uid)
  };
});

// =====================================================================
// ADMIN: listings & categories
// =====================================================================
route('GET', '/api/admin/listings', function (c) {
  needAdmin(c.user);
  var f = c.query.get('f') || 'reported';
  var pred = f === 'reported' ? function (l) { return l.reports > 0 && l.status !== 'REMOVED' && l.status !== 'DELETED'; }
    : f === 'removed' ? function (l) { return l.status === 'REMOVED'; } : function (l) { return l.status !== 'DELETED'; };
  return {
    listings: T('listings').all(pred).sort(function (a, b) { return (b.reports - a.reports) || (b.created_at - a.created_at); }).slice(0, 200)
      .map(function (l) { return listingOut(l, true); })
  };
});
route('POST', '/api/admin/listings/:id/:action', function (c) {
  needAdmin(c.user);
  var l = loadListing(c.params.id);
  var action = oneOf(c.params.action, ['remove', 'restore', 'dismiss'], 'Tindakan');
  if (action === 'remove') {
    var reason = text(c.body.reason, 'Sebab', { min: 3, max: 200 });
    T('listings').update(l, { status: 'REMOVED', removed_reason: reason, updated_at: Date.now() });
    notify(l.user_id, 'Iklan anda telah dipadam oleh admin', '"' + l.title + '" – ' + reason, '#/my');
  } else if (action === 'restore') {
    T('listings').update(l, { status: 'ACTIVE', removed_reason: null, reports: 0, updated_at: Date.now() });
  } else {
    T('listings').update(l, { reports: 0 });
  }
  return { ok: true };
});

route('GET', '/api/admin/categories', function (c) {
  needAdmin(c.user);
  var usage = function (cat) {
    return cat.kind === 'shop' ? T('shops').count(function (s) { return s.category === cat.name; })
      : T('listings').count(function (l) { return l.category === cat.name && l.status !== 'DELETED'; });
  };
  return {
    categories: T('categories').all().sort(function (a, b) { return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.sort - b.sort) || (a.id - b.id); })
      .map(function (cat) { return assign(cat, { used: usage(cat) }); })
  };
});
route('POST', '/api/admin/categories', function (c) {
  needAdmin(c.user);
  var kind = oneOf(c.body.kind, ['shop', 'market'], 'Jenis kategori');
  var name = text(c.body.name, 'Nama kategori', { min: 2, max: 40 });
  var emoji = text(c.body.emoji, 'Emoji', { max: 8, optional: true });
  if (T('categories').find(function (x) { return x.kind === kind && x.name === name; })) fail(409, 'Kategori ini sudah wujud.');
  var sort = T('categories').all(function (x) { return x.kind === kind; }).reduce(function (m, x) { return Math.max(m, x.sort); }, 0) + 1;
  T('categories').insert({ kind: kind, name: name, emoji: emoji, sort: sort, active: 1 });
  return { ok: true };
});
route('PATCH', '/api/admin/categories/:id', function (c) {
  needAdmin(c.user);
  var cat = T('categories').get(Number(c.params.id)) || fail(404, 'Kategori tidak dijumpai.');
  var b = c.body;
  var name = text(val(b.name, cat.name), 'Nama kategori', { min: 2, max: 40 });
  var emoji = text(val(b.emoji, cat.emoji), 'Emoji', { max: 8, optional: true });
  var active = b.active !== undefined ? (b.active ? 1 : 0) : cat.active;
  var sort = b.sort !== undefined ? sen(b.sort, 'Susunan', { max: 999 }) : cat.sort;
  if (name !== cat.name && T('categories').find(function (x) { return x.kind === cat.kind && x.name === name; })) fail(409, 'Nama kategori sudah digunakan.');
  var old = cat.name;
  T('categories').update(cat, { name: name, emoji: emoji, active: active, sort: sort });
  if (name !== old) {
    if (cat.kind === 'shop') T('shops').all(function (s) { return s.category === old; }).forEach(function (s) { T('shops').update(s, { category: name }); });
    else T('listings').all(function (l) { return l.category === old; }).forEach(function (l) { T('listings').update(l, { category: name }); });
  }
  return { ok: true };
});
