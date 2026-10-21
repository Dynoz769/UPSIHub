// One-stop-centre modules: bookings (trips, services, car rental), student listings
// (second-hand goods, rooms, jobs, events, lost & found), categories and the hub.
// Every purchase or booking becomes a normal order, so it shares the wallet,
// held payments, disputes, chat and notifications with the rest of the platform.
import { fail, text, sen, oneOf, uploadRef, uploadList, myDate, MY_OFFSET, rm } from './validate.js';
import { rateLimit } from './security.js';
import { isOnline } from './realtime.js';

const DAY = 864e5;
const ACTIVE_STATES = "('PENDING','ACCEPTED','READY','DISPUTED')";

export const LISTING_KINDS = {
  ITEM: 'Barang Terpakai',
  ROOM: 'Sewa Bilik & Rumah',
  JOB: 'Kerja Part-time',
  EVENT: 'Event & Tiket',
  LOST: 'Hilang & Jumpa'
};
export const LISTING_META = {
  conditions: { BARU: 'Baru', SEPERTI_BARU: 'Seperti baru', BAIK: 'Baik', SEDERHANA: 'Sederhana' },
  room_types: { BILIK_SINGLE: 'Bilik single', BILIK_SHARING: 'Bilik berkongsi', MASTER: 'Master bedroom', RUMAH: 'Seluruh rumah' },
  genders: { LELAKI: 'Lelaki', PEREMPUAN: 'Perempuan', CAMPUR: 'Tiada had' },
  facilities: { WIFI: 'WiFi', AIRCOND: 'Aircond', MESIN_BASUH: 'Mesin basuh', PERABOT: 'Berperabot', PARKING: 'Parking', BILIK_AIR_SENDIRI: 'Bilik air sendiri', DAPUR: 'Dapur' },
  pay_units: { JAM: 'sejam', HARI: 'sehari', TUGASAN: 'setugasan', BULAN: 'sebulan' },
  lost_types: { LOST: 'Hilang', FOUND: 'Dijumpai' }
};

const myDow = (ms) => new Date(ms + MY_OFFSET).getUTCDay();
const hhmmToMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const minToHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function registerModules(ctx) {
  const { db, route, need, needAdmin, notify, notifyAdmins, createOrder, orderOut, isListed, shopOut, cats, CAMPUSES, sellerRating } = ctx;

  const listedShop = (id) => {
    const s = db.one('SELECT * FROM shops WHERE id = ?', Number(id));
    if (!isListed(s)) fail(404, 'Kedai tidak aktif.');
    return s;
  };
  const futureTime = (v, label) => {
    const t = Number(v);
    if (!Number.isFinite(t) || t < Date.now() + 15 * 60e3) fail(400, `${label} mesti sekurang-kurangnya 15 minit dari sekarang.`);
    if (t > Date.now() + 90 * DAY) fail(400, `${label} mesti dalam tempoh 90 hari.`);
    return t;
  };
  const paymentFor = (shop, v, walletOnly = false) => {
    const p = oneOf(v || 'WALLET', ['WALLET', 'CASH'], 'Kaedah bayaran');
    if (p === 'CASH' && (walletOnly || !shop.allow_cash)) fail(400, 'Tempahan ini hanya boleh dibayar melalui Dompet UPSIHub.');
    return p;
  };

  // =====================================================================
  // HUB
  // =====================================================================
  route('GET', '/api/hub', () => {
    const now = Date.now();
    const n = (sql, ...p) => db.one(sql, ...p).n;
    const listed = "s.status = 'APPROVED' AND s.license_until > ?";
    const shopsWith = (kind) => n(`SELECT COUNT(DISTINCT s.id) AS n FROM shops s JOIN items i ON i.shop_id = s.id WHERE ${listed} AND i.kind = ? AND i.available = 1`, now, kind);
    const lcount = (kind) => n("SELECT COUNT(*) AS n FROM listings WHERE kind = ? AND status = 'ACTIVE'", kind);
    return {
      counts: {
        shops: n(`SELECT COUNT(*) AS n FROM shops s WHERE ${listed}`, now),
        rides: shopsWith('ROUTE'),
        vehicles: n(`SELECT COUNT(*) AS n FROM vehicles v JOIN shops s ON s.id = v.shop_id WHERE v.active = 1 AND ${listed}`, now),
        services: shopsWith('SERVICE'),
        ITEM: lcount('ITEM'), ROOM: lcount('ROOM'), JOB: lcount('JOB'), EVENT: lcount('EVENT'), LOST: lcount('LOST')
      },
      latest: listingRows("kind = 'ITEM' AND status = 'ACTIVE'", [], 'l.created_at DESC', 8),
      rooms: listingRows("kind = 'ROOM' AND status = 'ACTIVE'", [], 'l.created_at DESC', 4),
      events: listingRows("kind = 'EVENT' AND status IN ('ACTIVE','SOLD')", [], 'l.created_at DESC', 20)
        .filter((l) => l.meta.event_at > now).sort((a, b) => a.meta.event_at - b.meta.event_at).slice(0, 4)
    };
  });

  // =====================================================================
  // RIDES & SERVICES (shop items of kind ROUTE / SERVICE)
  // =====================================================================
  function shopsWithItemKind(kind, campus) {
    const now = Date.now();
    let shops = db.all(`SELECT DISTINCT s.* FROM shops s JOIN items i ON i.shop_id = s.id
                        WHERE s.status = 'APPROVED' AND s.license_until > ? AND i.kind = ? AND i.available = 1`, now, kind);
    if (campus && campus !== 'ALL') shops = shops.filter((s) => s.campus === campus);
    return shops.map((s) => shopOut(s, {
      offers: db.all('SELECT id, title, description, price, duration_min FROM items WHERE shop_id = ? AND kind = ? AND available = 1 ORDER BY price', s.id, kind)
    })).sort((a, b) => b.is_open - a.is_open || b.rating - a.rating);
  }
  route('GET', '/api/rides', ({ query }) => ({ shops: shopsWithItemKind('ROUTE', query.get('campus')) }));
  route('GET', '/api/services', ({ query }) => ({ shops: shopsWithItemKind('SERVICE', query.get('campus')) }));

  function serviceSlots(shop, item, dateStr) {
    const hours = shop.booking_hours ? JSON.parse(shop.booking_hours) : null;
    if (!hours) return [];
    const dayStart = myDate(dateStr, 'Tarikh');
    if (!hours.days.includes(myDow(dayStart))) return [];
    const busy = db.all(`SELECT start_at, end_at FROM orders WHERE shop_id = ? AND kind = 'SERVICE' AND status IN ${ACTIVE_STATES}
                         AND start_at < ? AND end_at > ?`, shop.id, dayStart + DAY, dayStart);
    const out = [];
    const dur = item.duration_min;
    for (let m = hhmmToMin(hours.start); m + dur <= hhmmToMin(hours.end); m += 30) {
      const start = dayStart + m * 60e3;
      const end = start + dur * 60e3;
      const free = start > Date.now() + 30 * 60e3 && !busy.some((b) => b.start_at < end && b.end_at > start);
      out.push({ start_at: start, label: minToHhmm(m), free });
    }
    return out;
  }
  route('GET', '/api/shops/:id/slots', ({ params, query }) => {
    const shop = listedShop(params.id);
    const item = db.one("SELECT * FROM items WHERE id = ? AND shop_id = ? AND kind = 'SERVICE'", Number(query.get('item')), shop.id) || fail(404, 'Servis tidak dijumpai.');
    return { slots: serviceSlots(shop, item, query.get('date')), hours: shop.booking_hours ? JSON.parse(shop.booking_hours) : null };
  });

  // =====================================================================
  // VEHICLES (car rental)
  // =====================================================================
  function vehicleOut(v, extra = {}) {
    return { id: v.id, shop_id: v.shop_id, model: v.model, plate: v.plate, seats: v.seats, transmission: v.transmission, image: v.image,
      daily_rate: v.daily_rate, deposit: v.deposit, notes: v.notes, active: !!v.active, ...extra };
  }
  // end_at is NULL for a rental with no planned return date: the car stays blocked until returned.
  const bookedRanges = (vehicleId) => db.all(`SELECT start_at, end_at FROM orders WHERE vehicle_id = ? AND status IN ${ACTIVE_STATES}
                                             AND (end_at IS NULL OR end_at > ?) ORDER BY start_at`, vehicleId, Date.now() - DAY);

  route('GET', '/api/vehicles', ({ query }) => {
    const campus = query.get('campus');
    let rows = db.all(`SELECT v.*, s.name AS shop_name, s.campus FROM vehicles v JOIN shops s ON s.id = v.shop_id
                       WHERE v.active = 1 AND s.status = 'APPROVED' AND s.license_until > ? ORDER BY v.daily_rate`, Date.now());
    if (campus && campus !== 'ALL') rows = rows.filter((v) => v.campus === campus);
    return { vehicles: rows.map((v) => vehicleOut(v, { shop_name: v.shop_name, campus: v.campus })) };
  });
  route('GET', '/api/vehicles/:id', ({ params }) => {
    const v = db.one('SELECT * FROM vehicles WHERE id = ? AND active = 1', Number(params.id)) || fail(404, 'Kenderaan tidak dijumpai.');
    const shop = listedShop(v.shop_id);
    return { vehicle: vehicleOut(v), shop: shopOut(shop), booked: bookedRanges(v.id) };
  });

  function vehicleFields(body, base = {}) {
    return {
      model: text(body.model ?? base.model, 'Model kenderaan', { min: 3, max: 80 }),
      plate: text(body.plate ?? base.plate, 'No. plat', { min: 2, max: 15 }).toUpperCase(),
      seats: sen(body.seats ?? base.seats ?? 4, 'Bilangan tempat duduk', { min: 1, max: 15 }),
      transmission: oneOf(body.transmission ?? base.transmission ?? 'AUTO', ['AUTO', 'MANUAL'], 'Transmisi'),
      image: body.image !== undefined ? uploadRef(body.image) : base.image ?? null,
      daily_rate: sen(body.daily_rate ?? base.daily_rate, 'Kadar sewa sehari', { min: 100, max: 100000 }),
      deposit: sen(body.deposit ?? base.deposit ?? 0, 'Deposit', { max: 200000 }),
      notes: text(body.notes ?? base.notes, 'Syarat', { max: 500, optional: true }),
      active: body.active !== undefined ? (body.active ? 1 : 0) : base.active ?? 1
    };
  }
  const myShopOrFail = (user) => db.one('SELECT * FROM shops WHERE owner_id = ?', user.id) || fail(404, 'Anda belum mendaftar kedai.');
  route('POST', '/api/seller/vehicles', ({ user, body }) => {
    need(user);
    const s = myShopOrFail(user);
    if (db.one('SELECT COUNT(*) AS n FROM vehicles WHERE shop_id = ?', s.id).n >= 30) fail(400, 'Had maksimum 30 kenderaan.');
    const f = vehicleFields(body);
    const id = Number(db.run('INSERT INTO vehicles (shop_id, model, plate, seats, transmission, image, daily_rate, deposit, notes, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      s.id, f.model, f.plate, f.seats, f.transmission, f.image, f.daily_rate, f.deposit, f.notes, f.active, Date.now()).lastInsertRowid);
    return { vehicle: db.one('SELECT * FROM vehicles WHERE id = ?', id) };
  });
  route('PATCH', '/api/seller/vehicles/:id', ({ user, params, body }) => {
    need(user);
    const s = myShopOrFail(user);
    const v = db.one('SELECT * FROM vehicles WHERE id = ? AND shop_id = ?', Number(params.id), s.id) || fail(404, 'Kenderaan tidak dijumpai.');
    const f = vehicleFields(body, v);
    db.run('UPDATE vehicles SET model=?, plate=?, seats=?, transmission=?, image=?, daily_rate=?, deposit=?, notes=?, active=? WHERE id = ?',
      f.model, f.plate, f.seats, f.transmission, f.image, f.daily_rate, f.deposit, f.notes, f.active, v.id);
    return { vehicle: db.one('SELECT * FROM vehicles WHERE id = ?', v.id) };
  });
  route('DELETE', '/api/seller/vehicles/:id', ({ user, params }) => {
    need(user);
    const s = myShopOrFail(user);
    const v = db.one('SELECT * FROM vehicles WHERE id = ? AND shop_id = ?', Number(params.id), s.id) || fail(404, 'Kenderaan tidak dijumpai.');
    if (db.one(`SELECT COUNT(*) AS n FROM orders WHERE vehicle_id = ? AND status IN ${ACTIVE_STATES}`, v.id).n) fail(400, 'Kenderaan ini ada tempahan aktif. Nyahaktifkan sahaja.');
    // Keep the row if past orders point at it.
    if (db.one('SELECT COUNT(*) AS n FROM orders WHERE vehicle_id = ?', v.id).n) db.run('UPDATE vehicles SET active = 0 WHERE id = ?', v.id);
    else db.run('DELETE FROM vehicles WHERE id = ?', v.id);
    return { ok: true };
  });

  // =====================================================================
  // BOOKINGS
  // =====================================================================
  route('POST', '/api/bookings', ({ user, body }) => {
    need(user);
    const type = oneOf(body.type, ['RIDE', 'SERVICE', 'RENTAL'], 'Jenis tempahan');
    const note = text(body.note, 'Nota', { max: 300, optional: true });

    if (type === 'RENTAL') {
      const v = db.one('SELECT * FROM vehicles WHERE id = ? AND active = 1', Number(body.vehicleId)) || fail(404, 'Kenderaan tidak dijumpai.');
      const shop = listedShop(v.shop_id);
      if (shop.owner_id === user.id) fail(400, 'Anda tidak boleh menyewa kenderaan sendiri.');
      const start = myDate(body.start_date, 'Tarikh ambil');
      // No return date = open-ended: pay 1 day + deposit now, the rest is settled on return.
      const end = body.end_date ? myDate(body.end_date, 'Tarikh pulang') : null;
      const today = myDate(new Date(Date.now() + MY_OFFSET).toISOString().slice(0, 10), 'Hari ini');
      if (start < today) fail(400, 'Tarikh ambil sudah lepas.');
      if (start > today + 90 * DAY) fail(400, 'Tempahan hanya boleh dibuat 90 hari lebih awal.');
      const days = end == null ? 1 : Math.round((end - start) / DAY);
      if (days < 1 || days > 30) fail(400, 'Tempoh sewa mesti antara 1 hingga 30 hari.');
      const pickup = text(body.pickup, 'Lokasi & masa ambil', { max: 150, optional: true });
      const order = createOrder({
        buyer: user, sellerId: shop.owner_id, shopId: shop.id, vehicleId: v.id, kind: 'RENTAL', payment: paymentFor(shop, body.payment, true),
        lines: [{ title: `Sewa ${v.model} (${v.plate})`, price: v.daily_rate, qty: days }], deposit: v.deposit,
        startAt: start, endAt: end, pickup, note, label: `Sewa ${v.model}`,
        inTx: () => {
          const clash = db.one(`SELECT id FROM orders WHERE vehicle_id = ? AND status IN ${ACTIVE_STATES} AND start_at < ? AND (end_at IS NULL OR end_at > ?)`,
            v.id, end ?? Number.MAX_SAFE_INTEGER, start);
          if (clash) fail(409, 'Kenderaan ini sudah ditempah untuk sebahagian tarikh tersebut. Pilih tarikh lain.');
        }
      });
      return { order: orderOut(order) };
    }

    const shop = listedShop(body.shopId);
    if (shop.owner_id === user.id) fail(400, 'Anda tidak boleh menempah servis sendiri.');
    const item = db.one('SELECT * FROM items WHERE id = ? AND shop_id = ? AND available = 1', Number(body.itemId), shop.id) || fail(404, 'Pilihan tidak tersedia.');
    const startAt = futureTime(body.start_at, 'Masa tempahan');
    const payment = paymentFor(shop, body.payment);

    if (type === 'RIDE') {
      if (item.kind !== 'ROUTE') fail(400, 'Item ini bukan trip.');
      const pax = sen(body.pax ?? 1, 'Bilangan penumpang', { min: 1, max: 14 });
      const pickup = text(body.pickup, 'Lokasi ambil', { min: 3, max: 150 });
      const dropoff = text(body.dropoff, 'Destinasi', { max: 150, optional: true }) || item.title;
      const order = createOrder({
        buyer: user, sellerId: shop.owner_id, shopId: shop.id, kind: 'RIDE', payment, fulfilment: 'DELIVERY',
        lines: [{ item_id: item.id, title: item.title, price: item.price, qty: pax }], startAt, pickup, dropoff, pax, note, label: shop.name
      });
      return { order: orderOut(order) };
    }

    if (item.kind !== 'SERVICE') fail(400, 'Item ini bukan servis.');
    const endAt = startAt + item.duration_min * 60e3;
    const dateStr = new Date(startAt + MY_OFFSET).toISOString().slice(0, 10);
    const slot = serviceSlots(shop, item, dateStr).find((s) => s.start_at === startAt);
    if (!slot) fail(400, 'Masa ini di luar waktu tempahan penyedia servis.');
    const address = text(body.address, 'Lokasi', { max: 150, optional: true });
    const order = createOrder({
      buyer: user, sellerId: shop.owner_id, shopId: shop.id, kind: 'SERVICE', payment, address,
      lines: [{ item_id: item.id, title: item.title, price: item.price, qty: 1 }], startAt, endAt, note, label: shop.name,
      inTx: () => {
        const clash = db.one(`SELECT id FROM orders WHERE shop_id = ? AND kind = 'SERVICE' AND status IN ${ACTIVE_STATES} AND start_at < ? AND end_at > ?`, shop.id, endAt, startAt);
        if (clash) fail(409, 'Slot ini baru sahaja ditempah orang lain. Pilih masa lain.');
      }
    });
    return { order: orderOut(order) };
  });

  // =====================================================================
  // LISTINGS (student to student)
  // =====================================================================
  function listingOut(l, full = false) {
    const owner = db.one('SELECT id, name, avatar, campus, created_at FROM users WHERE id = ?', l.user_id);
    const out = {
      id: l.id, kind: l.kind, category: l.category, title: l.title, price: l.price, negotiable: !!l.negotiable, condition: l.condition,
      campus: l.campus, location: l.location, images: JSON.parse(l.images), meta: JSON.parse(l.meta), stock: l.stock, status: l.status,
      views: l.views, created_at: l.created_at, updated_at: l.updated_at, owner: { id: owner.id, name: owner.name, avatar: owner.avatar, ...sellerRating(owner.id) }
    };
    if (full) {
      out.description = l.description;
      out.reports = l.reports;
      out.removed_reason = l.removed_reason;
      out.owner = {
        ...out.owner, campus: owner.campus, created_at: owner.created_at, online: isOnline(owner.id),
        listings: db.one("SELECT COUNT(*) AS n FROM listings WHERE user_id = ? AND status = 'ACTIVE'", owner.id).n,
        ...sellerRating(owner.id),
        sold: db.one("SELECT COUNT(*) AS n FROM orders WHERE seller_id = ? AND listing_id IS NOT NULL AND status = 'COMPLETED'", owner.id).n
      };
    }
    return out;
  }
  function listingRows(where, params, order = 'l.created_at DESC', limit = 60) {
    return db.all(`SELECT l.* FROM listings l WHERE ${where} ORDER BY ${order} LIMIT ${Number(limit)}`, ...params).map((l) => listingOut(l));
  }

  function listingFields(kind, body, base = {}) {
    const meta = {};
    const m = body.meta || {};
    const bm = base.meta ? JSON.parse(base.meta) : {};
    const pick = (k) => (m[k] !== undefined ? m[k] : bm[k]);
    const f = {
      title: text(body.title ?? base.title, 'Tajuk', { min: 5, max: 100 }),
      description: text(body.description ?? base.description, 'Penerangan', { min: 10, max: 2000 }),
      campus: oneOf(body.campus ?? base.campus, Object.keys(CAMPUSES), 'Kampus'),
      location: text(body.location ?? base.location, 'Lokasi', { max: 120, optional: kind !== 'ROOM' }),
      images: body.images !== undefined ? uploadList(body.images) : base.images ? JSON.parse(base.images) : [],
      category: null, price: null, negotiable: 0, condition: null, stock: null
    };
    if (kind === 'ITEM') {
      f.category = oneOf(body.category ?? base.category, cats('market'), 'Kategori');
      f.price = sen(body.price ?? base.price, 'Harga', { min: 0, max: 1000000 });
      f.negotiable = (body.negotiable ?? base.negotiable) ? 1 : 0;
      f.condition = oneOf(body.condition ?? base.condition, Object.keys(LISTING_META.conditions), 'Keadaan');
      f.stock = sen(body.stock ?? base.stock ?? 1, 'Kuantiti', { min: 0, max: 50 });
    } else if (kind === 'ROOM') {
      f.price = sen(body.price ?? base.price, 'Sewa sebulan', { min: 100, max: 1000000 });
      meta.room_type = oneOf(pick('room_type'), Object.keys(LISTING_META.room_types), 'Jenis bilik');
      meta.gender = oneOf(pick('gender'), Object.keys(LISTING_META.genders), 'Jantina penyewa');
      meta.available_from = new Date(myDate(pick('available_from'), 'Tarikh masuk') + MY_OFFSET).toISOString().slice(0, 10);
      meta.deposit_note = text(pick('deposit_note'), 'Deposit', { max: 100, optional: true });
      meta.booking_fee = sen(pick('booking_fee') ?? 0, 'Yuran tempahan', { max: 200000 });
      const fac = pick('facilities') || [];
      if (!Array.isArray(fac)) fail(400, 'Kemudahan tidak sah.');
      meta.facilities = fac.filter((x) => LISTING_META.facilities[x]);
    } else if (kind === 'JOB') {
      f.price = sen(body.price ?? base.price, 'Bayaran', { min: 0, max: 1000000 });
      meta.pay_unit = oneOf(pick('pay_unit'), Object.keys(LISTING_META.pay_units), 'Unit bayaran');
      meta.employer = text(pick('employer'), 'Majikan', { min: 2, max: 80 });
      meta.schedule = text(pick('schedule'), 'Waktu kerja', { max: 120, optional: true });
    } else if (kind === 'EVENT') {
      f.price = sen(body.price ?? base.price ?? 0, 'Harga tiket', { min: 0, max: 100000 });
      meta.event_at = Number(pick('event_at'));
      if (!Number.isFinite(meta.event_at) || meta.event_at < Date.now()) fail(400, 'Tarikh & masa event mesti pada masa hadapan.');
      meta.venue = text(pick('venue'), 'Tempat', { min: 3, max: 120 });
      f.stock = f.price > 0 ? sen(body.stock ?? base.stock, 'Bilangan tiket', { min: 0, max: 5000 }) : null;
    } else if (kind === 'LOST') {
      meta.type = oneOf(pick('type'), Object.keys(LISTING_META.lost_types), 'Jenis');
      meta.date = new Date(myDate(pick('date'), 'Tarikh') + MY_OFFSET).toISOString().slice(0, 10);
    }
    f.meta = JSON.stringify(meta);
    return f;
  }
  const loadListing = (id) => db.one('SELECT * FROM listings WHERE id = ?', Number(id)) || fail(404, 'Iklan tidak dijumpai.');

  route('GET', '/api/listings', ({ query }) => {
    const kind = oneOf(query.get('kind') || 'ITEM', Object.keys(LISTING_KINDS), 'Jenis');
    const where = ['l.kind = ?', "l.status IN ('ACTIVE','RESERVED','SOLD')"];
    const params = [kind];
    const q = String(query.get('q') || '').trim().toLowerCase();
    if (q) { where.push('(LOWER(l.title) LIKE ? OR LOWER(l.description) LIKE ? OR LOWER(l.location) LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const campus = query.get('campus');
    if (campus && campus !== 'ALL') { where.push('l.campus = ?'); params.push(campus); }
    const category = query.get('category');
    if (category && category !== 'ALL') { where.push('l.category = ?'); params.push(category); }
    const max = Number(query.get('max'));
    if (max > 0) { where.push('l.price <= ?'); params.push(max); }
    if (query.get('available') === '1') where.push("l.status = 'ACTIVE'");
    const order = { cheap: 'l.price ASC', expensive: 'l.price DESC', newest: 'l.created_at DESC' }[query.get('sort')] || 'l.created_at DESC';
    let rows = listingRows(where.join(' AND '), params, order, 120);
    // Sold items stay visible for a day so buyers know they went.
    rows = rows.filter((l) => l.status !== 'SOLD' || l.updated_at > Date.now() - DAY || kind === 'EVENT');
    for (const key of ['room_type', 'gender', 'type', 'pay_unit']) {
      const v = query.get(key);
      if (v && v !== 'ALL') rows = rows.filter((l) => l.meta[key] === v || (key === 'gender' && l.meta.gender === 'CAMPUR'));
    }
    if (kind === 'EVENT') rows = rows.filter((l) => l.meta.event_at > Date.now()).sort((a, b) => a.meta.event_at - b.meta.event_at);
    return { listings: rows };
  });

  route('GET', '/api/listings/:id', ({ params, user }) => {
    const l = loadListing(params.id);
    const mine = user && (user.id === l.user_id || user.role === 'admin');
    if (['REMOVED', 'DELETED'].includes(l.status) && !mine) fail(404, 'Iklan ini telah dipadam.');
    if (!user || user.id !== l.user_id) db.run('UPDATE listings SET views = views + 1 WHERE id = ?', l.id);
    return { listing: listingOut(l, true), mine: !!(user && user.id === l.user_id) };
  });

  route('POST', '/api/listings', ({ user, body }) => {
    need(user);
    if (!rateLimit(`post:${user.id}`, 20, DAY)) fail(429, 'Had 20 iklan sehari dicapai.');
    if (db.one("SELECT COUNT(*) AS n FROM listings WHERE user_id = ? AND status IN ('ACTIVE','RESERVED')", user.id).n >= 50) fail(400, 'Had maksimum 50 iklan aktif.');
    const kind = oneOf(body.kind, Object.keys(LISTING_KINDS), 'Jenis iklan');
    const f = listingFields(kind, body);
    const now = Date.now();
    const id = Number(db.run(`INSERT INTO listings (user_id, kind, category, title, description, price, negotiable, condition, campus, location, images, meta, stock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, kind, f.category, f.title, f.description, f.price, f.negotiable, f.condition, f.campus, f.location, JSON.stringify(f.images), f.meta, f.stock, now, now).lastInsertRowid);
    return { listing: listingOut(loadListing(id), true) };
  });

  route('PATCH', '/api/listings/:id', ({ user, params, body }) => {
    need(user);
    const l = loadListing(params.id);
    if (l.user_id !== user.id) fail(403, 'Ini bukan iklan anda.');
    if (['REMOVED', 'DELETED'].includes(l.status)) fail(400, 'Iklan ini tidak boleh disunting.');
    if (body.status !== undefined && Object.keys(body).length === 1) {
      const status = oneOf(body.status, ['ACTIVE', 'CLOSED', 'SOLD'], 'Status');
      if (l.status === 'RESERVED') fail(400, 'Iklan ini sedang ditempah. Selesaikan atau batalkan pesanan dahulu.');
      db.run('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), l.id);
      return { ok: true };
    }
    const f = listingFields(l.kind, body, l);
    db.run(`UPDATE listings SET category=?, title=?, description=?, price=?, negotiable=?, condition=?, campus=?, location=?, images=?, meta=?, stock=?, updated_at=?,
            status = CASE WHEN status = 'SOLD' AND ? > 0 THEN 'ACTIVE' ELSE status END WHERE id = ?`,
      f.category, f.title, f.description, f.price, f.negotiable, f.condition, f.campus, f.location, JSON.stringify(f.images), f.meta, f.stock, Date.now(), f.stock ?? 0, l.id);
    return { listing: listingOut(loadListing(l.id), true) };
  });

  route('DELETE', '/api/listings/:id', ({ user, params }) => {
    need(user);
    const l = loadListing(params.id);
    if (l.user_id !== user.id) fail(403, 'Ini bukan iklan anda.');
    if (db.one(`SELECT COUNT(*) AS n FROM orders WHERE listing_id = ? AND status IN ${ACTIVE_STATES}`, l.id).n) fail(400, 'Iklan ini ada pesanan aktif.');
    db.run("UPDATE listings SET status = 'DELETED', updated_at = ? WHERE id = ?", Date.now(), l.id);
    return { ok: true };
  });

  // Buy a second-hand item, buy event tickets, or pay a room booking deposit.
  route('POST', '/api/listings/:id/buy', ({ user, params, body }) => {
    need(user);
    const l = loadListing(params.id);
    if (l.user_id === user.id) fail(400, 'Anda tidak boleh membeli iklan sendiri.');
    if (l.status !== 'ACTIVE') fail(400, l.status === 'RESERVED' ? 'Iklan ini sedang ditempah oleh orang lain.' : 'Iklan ini tidak lagi tersedia.');
    const meta = JSON.parse(l.meta);
    const note = text(body.note, 'Nota', { max: 300, optional: true });
    let kind; let lines; let payment = 'WALLET'; let address = '';
    if (l.kind === 'ITEM') {
      if (!l.price) fail(400, 'Barang percuma – sila chat dengan pemilik untuk mengambilnya.');
      const qty = sen(body.qty ?? 1, 'Kuantiti', { min: 1, max: 50 });
      kind = 'ITEM';
      lines = [{ title: l.title, price: l.price, qty }];
      payment = oneOf(body.payment || 'WALLET', ['WALLET', 'CASH'], 'Kaedah bayaran');
      address = text(body.meet, 'Tempat berjumpa', { max: 150, optional: true }) || l.location;
    } else if (l.kind === 'EVENT') {
      if (!l.price) fail(400, 'Event ini percuma – tiada tiket diperlukan.');
      if (meta.event_at < Date.now()) fail(400, 'Event ini sudah berlalu.');
      kind = 'TICKET';
      lines = [{ title: `Tiket: ${l.title}`, price: l.price, qty: sen(body.qty ?? 1, 'Bilangan tiket', { min: 1, max: 10 }) }];
    } else if (l.kind === 'ROOM') {
      if (!meta.booking_fee) fail(400, 'Tuan rumah tidak menerima deposit dalam talian. Sila chat untuk berurusan.');
      kind = 'ROOM';
      lines = [{ title: `Deposit tempahan: ${l.title}`, price: meta.booking_fee, qty: 1 }];
    } else {
      fail(400, 'Iklan ini tidak boleh dibeli.');
    }
    const qty = lines[0].qty;
    const order = createOrder({
      buyer: user, sellerId: l.user_id, listingId: l.id, kind, payment, address, note, lines, label: l.title,
      inTx: () => {
        const fresh = db.one('SELECT stock, status FROM listings WHERE id = ?', l.id);
        if (fresh.status !== 'ACTIVE') fail(409, 'Iklan ini baru sahaja ditempah orang lain.');
        if (fresh.stock != null) {
          if (fresh.stock < qty) fail(400, `Hanya ${fresh.stock} tinggal.`);
          const left = fresh.stock - qty;
          db.run('UPDATE listings SET stock = ?, status = ?, updated_at = ? WHERE id = ?', left, left === 0 ? (kind === 'TICKET' ? 'SOLD' : 'RESERVED') : 'ACTIVE', Date.now(), l.id);
        } else if (kind === 'ROOM') {
          db.run("UPDATE listings SET status = 'RESERVED', updated_at = ? WHERE id = ?", Date.now(), l.id);
        }
      }
    });
    return { order: orderOut(order) };
  });

  route('POST', '/api/listings/:id/report', ({ user, params, body }) => {
    need(user);
    const l = loadListing(params.id);
    if (!rateLimit(`report:${user.id}:${l.id}`, 1, 30 * DAY)) fail(409, 'Anda sudah melaporkan iklan ini.');
    const reason = text(body.reason, 'Sebab', { min: 5, max: 300 });
    db.run('UPDATE listings SET reports = reports + 1 WHERE id = ?', l.id);
    notifyAdmins('Iklan dilaporkan', `"${l.title}" – ${reason}`, '#/admin/listings');
    return { ok: true };
  });

  route('GET', '/api/users/:id/listings', ({ params }) => ({
    listings: listingRows("l.user_id = ? AND l.status IN ('ACTIVE','RESERVED')", [Number(params.id)], 'l.created_at DESC', 60)
  }));

  route('GET', '/api/my/listings', ({ user }) => {
    need(user);
    return {
      listings: db.all("SELECT * FROM listings WHERE user_id = ? AND status != 'DELETED' ORDER BY updated_at DESC", user.id).map((l) => listingOut(l, true)),
      sales: db.all('SELECT * FROM orders WHERE seller_id = ? AND listing_id IS NOT NULL ORDER BY created_at DESC LIMIT 50', user.id).map(orderOut),
      rating: sellerRating(user.id)
    };
  });

  // =====================================================================
  // ADMIN: listings moderation & categories
  // =====================================================================
  route('GET', '/api/admin/listings', ({ user, query }) => {
    needAdmin(user);
    const filter = query.get('f') || 'reported';
    const where = filter === 'reported' ? "l.reports > 0 AND l.status != 'REMOVED' AND l.status != 'DELETED'" : filter === 'removed' ? "l.status = 'REMOVED'" : "l.status != 'DELETED'";
    return { listings: db.all(`SELECT l.* FROM listings l WHERE ${where} ORDER BY l.reports DESC, l.created_at DESC LIMIT 200`).map((l) => listingOut(l, true)) };
  });
  route('POST', '/api/admin/listings/:id/:action', ({ user, params, body }) => {
    needAdmin(user);
    const l = loadListing(params.id);
    const action = oneOf(params.action, ['remove', 'restore', 'dismiss'], 'Tindakan');
    if (action === 'remove') {
      const reason = text(body.reason, 'Sebab', { min: 3, max: 200 });
      db.run("UPDATE listings SET status = 'REMOVED', removed_reason = ?, updated_at = ? WHERE id = ?", reason, Date.now(), l.id);
      notify(l.user_id, 'Iklan anda telah dipadam oleh admin', `"${l.title}" – ${reason}`, '#/my');
    } else if (action === 'restore') {
      db.run("UPDATE listings SET status = 'ACTIVE', removed_reason = NULL, reports = 0, updated_at = ? WHERE id = ?", Date.now(), l.id);
    } else {
      db.run('UPDATE listings SET reports = 0 WHERE id = ?', l.id);
    }
    return { ok: true };
  });

  route('GET', '/api/admin/categories', ({ user }) => {
    needAdmin(user);
    const usage = (c) => c.kind === 'shop'
      ? db.one('SELECT COUNT(*) AS n FROM shops WHERE category = ?', c.name).n
      : db.one("SELECT COUNT(*) AS n FROM listings WHERE category = ? AND status != 'DELETED'", c.name).n;
    return { categories: db.all('SELECT * FROM categories ORDER BY kind, sort, id').map((c) => ({ ...c, used: usage(c) })) };
  });
  route('POST', '/api/admin/categories', ({ user, body }) => {
    needAdmin(user);
    const kind = oneOf(body.kind, ['shop', 'market'], 'Jenis kategori');
    const name = text(body.name, 'Nama kategori', { min: 2, max: 40 });
    const emoji = text(body.emoji, 'Emoji', { max: 8, optional: true });
    if (db.one('SELECT id FROM categories WHERE kind = ? AND name = ?', kind, name)) fail(409, 'Kategori ini sudah wujud.');
    const sort = db.one('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories WHERE kind = ?', kind).n;
    db.run('INSERT INTO categories (kind, name, emoji, sort) VALUES (?, ?, ?, ?)', kind, name, emoji, sort);
    return { ok: true };
  });
  route('PATCH', '/api/admin/categories/:id', ({ user, params, body }) => {
    needAdmin(user);
    const c = db.one('SELECT * FROM categories WHERE id = ?', Number(params.id)) || fail(404, 'Kategori tidak dijumpai.');
    const name = text(body.name ?? c.name, 'Nama kategori', { min: 2, max: 40 });
    const emoji = text(body.emoji ?? c.emoji, 'Emoji', { max: 8, optional: true });
    const active = body.active !== undefined ? (body.active ? 1 : 0) : c.active;
    const sort = body.sort !== undefined ? sen(body.sort, 'Susunan', { max: 999 }) : c.sort;
    if (name !== c.name && db.one('SELECT id FROM categories WHERE kind = ? AND name = ?', c.kind, name)) fail(409, 'Nama kategori sudah digunakan.');
    db.tx(() => {
      db.run('UPDATE categories SET name = ?, emoji = ?, active = ?, sort = ? WHERE id = ?', name, emoji, active, sort, c.id);
      // Renaming carries existing shops/listings along.
      if (name !== c.name) {
        if (c.kind === 'shop') db.run('UPDATE shops SET category = ? WHERE category = ?', name, c.name);
        else db.run('UPDATE listings SET category = ? WHERE category = ?', name, c.name);
      }
    });
    return { ok: true };
  });

  return { LISTING_KINDS, LISTING_META, rm };
}
