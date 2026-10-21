import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashPassword, verifyPassword, randomToken, rateLimit } from './security.js';
import { subscribe, push, isOnline } from './realtime.js';
import { DEFAULT_SETTINGS } from './db.js';
import { HttpError, fail, text, sen, oneOf, uploadRef, rm, myDate, MY_OFFSET } from './validate.js';
import { registerModules, LISTING_KINDS, LISTING_META } from './modules.js';

export const CAMPUSES = {
  KSAB: 'Kampus Sultan Abdul Jalil (KSAB)',
  KSAS: 'Kampus Sultan Azlan Shah (KSAS)',
  TM: 'Tanjung Malim / Proton City'
};
const SESSION_DAYS = 30;
const MAX_TOPUP = 100000; // RM1,000 per request
const MAX_BALANCE = 500000; // RM5,000 wallet cap
const DISPUTE_WINDOW = 48 * 3600e3; // seller-completed orders stay held this long
export const DISPUTE_REASONS = {
  NOT_RECEIVED: 'Pesanan tidak diterima',
  WRONG_ITEM: 'Item salah atau tidak lengkap',
  QUALITY: 'Kualiti tidak memuaskan / rosak',
  OVERCHARGED: 'Dikenakan bayaran berlebihan',
  OTHER: 'Lain-lain'
};

export { HttpError };

export function createApi({ db, uploadsDir, demo }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  // ---------- shared domain helpers ----------
  const publicUser = (u) => u && ({
    id: u.id, name: u.name, email: u.email, matric: u.matric, phone: u.phone, campus: u.campus,
    avatar: u.avatar, role: u.role, status: u.status, balance: u.balance, created_at: u.created_at
  });

  function notify(userId, title, body, link) {
    const now = Date.now();
    const id = Number(db.run('INSERT INTO notifications (user_id, title, body, link, created_at) VALUES (?, ?, ?, ?, ?)', userId, title, body || '', link || null, now).lastInsertRowid);
    push(userId, 'notification', { id, title, body, link, created_at: now });
  }

  // Must be called inside db.tx(). Positive amount credits, negative debits.
  function moveMoney(userId, amount, type, description, ref) {
    const u = db.one('SELECT balance FROM users WHERE id = ?', userId);
    if (!u) fail(404, 'Pengguna tidak dijumpai.');
    const next = u.balance + amount;
    if (next < 0) fail(400, `Baki dompet tidak mencukupi. Baki semasa ${rm(u.balance)}.`);
    if (amount > 0 && next > MAX_BALANCE && type === 'TOPUP') fail(400, `Had baki dompet ialah ${rm(MAX_BALANCE)}.`);
    db.run('UPDATE users SET balance = ? WHERE id = ?', next, userId);
    db.run('INSERT INTO transactions (user_id, type, amount, balance_after, description, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      userId, type, amount, next, description, ref || null, Date.now());
    return next;
  }
  const pushBalance = (userId) => {
    const u = db.one('SELECT balance FROM users WHERE id = ?', userId);
    if (u) push(userId, 'wallet', { balance: u.balance });
  };

  const admins = () => db.all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").map((r) => r.id);
  const notifyAdmins = (title, body, link) => admins().forEach((id) => notify(id, title, body, link));

  const cats = (kind) => db.all('SELECT name FROM categories WHERE kind = ? AND active = 1 ORDER BY sort, id', kind).map((r) => r.name);
  const catEmoji = () => Object.fromEntries(db.all('SELECT name, emoji FROM categories').map((r) => [r.name, r.emoji]));

  function shopRating(shopId) {
    const r = db.one('SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM reviews WHERE shop_id = ?', shopId);
    return { rating: r.avg || 0, reviews: r.n };
  }
  function shopOut(s, extra = {}) {
    return {
      id: s.id, owner_id: s.owner_id, name: s.name, category: s.category, campus: s.campus, description: s.description,
      image: s.image, hours: s.hours, delivery_fee: s.delivery_fee, min_order: s.min_order, allow_cash: !!s.allow_cash,
      is_open: !!s.is_open, status: s.status, ...shopRating(s.id), ...extra
    };
  }
  const isListed = (s) => s && s.status === 'APPROVED' && s.license_until > Date.now();

  function orderOut(o) {
    const seller = db.one('SELECT id, name, phone FROM users WHERE id = ?', o.seller_id);
    const listing = o.listing_id ? db.one('SELECT id, kind, title, images FROM listings WHERE id = ?', o.listing_id) : null;
    // `shop` always has a display name & owner so the UI can treat every order alike.
    const shop = (o.shop_id && db.one('SELECT id, name, owner_id, campus FROM shops WHERE id = ?', o.shop_id))
      || { id: null, name: listing ? listing.title : seller.name, owner_id: o.seller_id, campus: null };
    const buyer = db.one('SELECT id, name, phone, matric FROM users WHERE id = ?', o.user_id);
    return {
      ...o,
      shop,
      seller,
      listing: listing && { id: listing.id, kind: listing.kind, title: listing.title, image: JSON.parse(listing.images)[0] || null },
      vehicle: o.vehicle_id ? db.one('SELECT id, model, plate, seats, image FROM vehicles WHERE id = ?', o.vehicle_id) : null,
      buyer,
      items: db.all('SELECT item_id, title, price, qty FROM order_items WHERE order_id = ?', o.id),
      events: db.all('SELECT status, at FROM order_events WHERE order_id = ? ORDER BY id', o.id),
      dispute: db.one('SELECT * FROM disputes WHERE order_id = ?', o.id) || null,
      review: db.one('SELECT rating, comment, created_at FROM reviews WHERE order_id = ?', o.id)
        || db.one('SELECT rating, comment, created_at FROM seller_reviews WHERE order_id = ?', o.id) || null
    };
  }

  function saveUpload(dataUrl) {
    const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) fail(400, 'Format gambar tidak disokong (PNG, JPG, WEBP, GIF sahaja).');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) fail(400, 'Saiz gambar melebihi 2MB.');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `${randomToken(12)}.${ext}`;
    writeFileSync(path.join(uploadsDir, name), buf);
    return `/uploads/${name}`;
  }

  function conversationFor(a, b, kind = 'direct') {
    const [x, y] = a < b ? [a, b] : [b, a];
    let c = db.one('SELECT * FROM conversations WHERE user_a = ? AND user_b = ? AND kind = ?', x, y, kind);
    if (!c) {
      const id = Number(db.run('INSERT INTO conversations (user_a, user_b, kind, last_at) VALUES (?, ?, ?, ?)', x, y, kind, Date.now()).lastInsertRowid);
      c = db.one('SELECT * FROM conversations WHERE id = ?', id);
    }
    return c;
  }
  function sendMessage(conv, senderId, body, image) {
    const now = Date.now();
    const id = Number(db.run('INSERT INTO messages (conversation_id, sender_id, body, image, created_at) VALUES (?, ?, ?, ?, ?)', conv.id, senderId, body, image, now).lastInsertRowid);
    db.run('UPDATE conversations SET last_at = ? WHERE id = ?', now, conv.id);
    const msg = { id, conversation_id: conv.id, sender_id: senderId, body, image, created_at: now, read_at: null };
    push(conv.user_a, 'message', msg);
    if (conv.user_b !== conv.user_a) push(conv.user_b, 'message', msg);
    return msg;
  }

  function settingsOut() {
    return {
      packages: db.getSetting('packages'),
      commission_pct: db.getSetting('commission_pct'),
      topup_bank: db.getSetting('topup_bank'),
      topup_qr: db.getSetting('topup_qr'),
      counter_info: db.getSetting('counter_info'),
      announcement: db.getSetting('announcement')
    };
  }

  // =====================================================================
  // CONFIG & AUTH
  // =====================================================================
  route('GET', '/api/config', () => ({
    categories: cats('shop'),
    market_categories: cats('market'),
    category_emoji: catEmoji(),
    listing_kinds: LISTING_KINDS,
    listing_meta: LISTING_META,
    campuses: CAMPUSES,
    dispute_reasons: DISPUTE_REASONS,
    demo,
    ...settingsOut(),
    stats: {
      shops: db.one("SELECT COUNT(*) AS n FROM shops WHERE status = 'APPROVED' AND license_until > ?", Date.now()).n,
      users: db.one('SELECT COUNT(*) AS n FROM users').n,
      orders: db.one("SELECT COUNT(*) AS n FROM orders WHERE status = 'COMPLETED'").n
    }
  }));

  function startSession(res, userId) {
    const token = randomToken();
    db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, Date.now() + SESSION_DAYS * 864e5);
    res.setHeader('Set-Cookie', `uh_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`);
  }

  route('POST', '/api/auth/register', ({ body, res, ip }) => {
    if (!rateLimit(`reg:${ip}`, 10, 3600e3)) fail(429, 'Terlalu banyak cubaan. Cuba lagi kemudian.');
    const name = text(body.name, 'Nama', { min: 2, max: 80 });
    const email = text(body.email, 'E-mel', { max: 120 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'E-mel tidak sah.');
    const password = String(body.password || '');
    if (password.length < 8) fail(400, 'Kata laluan mesti sekurang-kurangnya 8 aksara.');
    const matric = text(body.matric, 'No. Matrik', { max: 30, optional: true }).toUpperCase();
    const phone = text(body.phone, 'No. Telefon', { max: 20, optional: true });
    const campus = oneOf(body.campus || 'KSAB', Object.keys(CAMPUSES), 'Kampus');
    if (db.one('SELECT id FROM users WHERE email = ?', email)) fail(409, 'E-mel ini sudah didaftarkan.');
    const id = Number(db.run('INSERT INTO users (name, email, password, matric, phone, campus, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name, email, hashPassword(password), matric || null, phone || null, campus, Date.now()).lastInsertRowid);
    startSession(res, id);
    notify(id, 'Selamat datang ke UPSIHub! 🎉', 'Tambah nilai dompet anda untuk mula membuat pesanan tanpa tunai.', '#/wallet');
    return { user: publicUser(db.one('SELECT * FROM users WHERE id = ?', id)) };
  });

  route('POST', '/api/auth/login', ({ body, res, ip }) => {
    if (!rateLimit(`login:${ip}`, 20, 900e3)) fail(429, 'Terlalu banyak cubaan log masuk. Cuba lagi dalam 15 minit.');
    const email = String(body.email || '').trim().toLowerCase();
    const u = db.one('SELECT * FROM users WHERE email = ?', email);
    if (!u || !verifyPassword(String(body.password || ''), u.password)) fail(401, 'E-mel atau kata laluan salah.');
    if (u.status !== 'active') fail(403, 'Akaun anda telah digantung. Hubungi pentadbir.');
    startSession(res, u.id);
    return { user: publicUser(u) };
  });

  route('POST', '/api/auth/logout', ({ token, res }) => {
    if (token) db.run('DELETE FROM sessions WHERE token = ?', token);
    res.setHeader('Set-Cookie', 'uh_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/me', ({ user }) => {
    if (!user) return { user: null };
    const shop = db.one('SELECT id, name, status, is_open, license_until FROM shops WHERE owner_id = ?', user.id);
    return {
      user: publicUser(user),
      shop: shop || null,
      unread: {
        chat: db.one(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
                      WHERE (c.user_a = ? OR c.user_b = ?) AND m.sender_id != ? AND m.read_at IS NULL`, user.id, user.id, user.id).n,
        notifications: db.one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', user.id).n
      }
    };
  });

  route('PATCH', '/api/me', ({ user, body }) => {
    need(user);
    const name = text(body.name ?? user.name, 'Nama', { min: 2, max: 80 });
    const phone = text(body.phone ?? user.phone, 'No. Telefon', { max: 20, optional: true });
    const matric = text(body.matric ?? user.matric, 'No. Matrik', { max: 30, optional: true }).toUpperCase();
    const campus = oneOf(body.campus ?? user.campus, Object.keys(CAMPUSES), 'Kampus');
    const avatar = body.avatar !== undefined ? uploadRef(body.avatar) : user.avatar;
    db.run('UPDATE users SET name = ?, phone = ?, matric = ?, campus = ?, avatar = ? WHERE id = ?', name, phone || null, matric || null, campus, avatar, user.id);
    return { user: publicUser(db.one('SELECT * FROM users WHERE id = ?', user.id)) };
  });

  route('POST', '/api/me/password', ({ user, body, token }) => {
    need(user);
    if (!verifyPassword(String(body.current || ''), user.password)) fail(400, 'Kata laluan semasa salah.');
    const next = String(body.next || '');
    if (next.length < 8) fail(400, 'Kata laluan baharu mesti sekurang-kurangnya 8 aksara.');
    db.run('UPDATE users SET password = ? WHERE id = ?', hashPassword(next), user.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', user.id, token);
    return { ok: true };
  });

  route('POST', '/api/upload', ({ user, body, ip }) => {
    need(user);
    if (!rateLimit(`up:${ip}`, 60, 3600e3)) fail(429, 'Terlalu banyak muat naik. Cuba lagi kemudian.');
    return { url: saveUpload(body.data) };
  });

  route('GET', '/api/stream', ({ user, req, res }) => {
    need(user);
    subscribe(user.id, req, res);
    return STREAMING;
  });

  // =====================================================================
  // MARKETPLACE
  // =====================================================================
  route('GET', '/api/shops', ({ query }) => {
    const q = String(query.get('q') || '').trim().toLowerCase();
    const campus = query.get('campus');
    const category = query.get('category');
    const sort = query.get('sort') || 'popular';
    let rows = db.all("SELECT * FROM shops WHERE status = 'APPROVED' AND license_until > ?", Date.now());
    if (campus && campus !== 'ALL') rows = rows.filter((s) => s.campus === campus);
    if (category && category !== 'ALL') rows = rows.filter((s) => s.category === category);
    if (q) {
      const itemHits = new Set(db.all("SELECT DISTINCT shop_id FROM items WHERE available = 1 AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)", `%${q}%`, `%${q}%`).map((r) => r.shop_id));
      rows = rows.filter((s) => itemHits.has(s.id) || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q));
    }
    const out = rows.map((s) => {
      const orders = db.one("SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND status = 'COMPLETED'", s.id).n;
      const items = db.one('SELECT COUNT(*) AS n, MIN(price) AS min FROM items WHERE shop_id = ? AND available = 1', s.id);
      return shopOut(s, { orders, item_count: items.n, from_price: items.min, created_at: s.created_at });
    });
    const sorters = {
      popular: (a, b) => b.is_open - a.is_open || b.orders - a.orders,
      rating: (a, b) => b.rating - a.rating || b.reviews - a.reviews,
      newest: (a, b) => b.created_at - a.created_at,
      cheapest: (a, b) => (a.from_price ?? 1e9) - (b.from_price ?? 1e9)
    };
    out.sort(sorters[sort] || sorters.popular);
    return { shops: out };
  });

  route('GET', '/api/shops/:id', ({ params, user }) => {
    const s = db.one('SELECT * FROM shops WHERE id = ?', Number(params.id));
    const canPreview = s && user && (user.role === 'admin' || user.id === s.owner_id);
    if (!s || (!isListed(s) && !canPreview)) fail(404, 'Kedai tidak dijumpai atau belum aktif.');
    const owner = db.one('SELECT id, name, avatar FROM users WHERE id = ?', s.owner_id);
    return {
      shop: shopOut(s, {
        owner: { ...owner, online: isOnline(owner.id) },
        orders: db.one("SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND status = 'COMPLETED'", s.id).n
      }),
      items: db.all('SELECT id, title, description, price, image, available, kind, duration_min FROM items WHERE shop_id = ? ORDER BY available DESC, id', s.id),
      vehicles: db.all('SELECT id, model, plate, seats, transmission, image, daily_rate, deposit, notes FROM vehicles WHERE shop_id = ? AND active = 1 ORDER BY daily_rate', s.id),
      booking_hours: s.booking_hours ? JSON.parse(s.booking_hours) : null,
      reviews: db.all(`SELECT r.rating, r.comment, r.created_at, u.name FROM reviews r JOIN users u ON u.id = r.user_id
                       WHERE r.shop_id = ? ORDER BY r.created_at DESC LIMIT 30`, s.id)
    };
  });

  // =====================================================================
  // ORDERS
  // =====================================================================
  function setOrderStatus(o, status, extra = {}) {
    const now = Date.now();
    db.run('UPDATE orders SET status = ?, cancel_reason = COALESCE(?, cancel_reason), updated_at = ? WHERE id = ?', status, extra.reason || null, now, o.id);
    db.run('INSERT INTO order_events (order_id, status, at) VALUES (?, ?, ?)', o.id, status, now);
  }
  const ORDER_LABEL = {
    ACCEPTED: 'diterima & sedang disediakan', READY: 'sedia', COMPLETED: 'selesai',
    CANCELLED: 'dibatalkan', REJECTED: 'ditolak oleh peniaga'
  };
  const ownerOf = (o) => o.seller_id;
  const sellerShare = (o) => o.total - o.deposit - o.commission;

  // Held wallet money → seller (any refundable deposit goes back to the buyer). Must run inside db.tx().
  function releaseToSeller(o, note = '') {
    moveMoney(o.seller_id, sellerShare(o), 'ORDER_EARN',
      `Hasil jualan ${o.code}${o.commission ? ` (selepas komisen ${rm(o.commission)})` : ''}${note}`, o.code);
    if (o.deposit) moveMoney(o.user_id, o.deposit, 'ORDER_REFUND', `Pulangan deposit ${o.code}`, o.code);
    db.run("UPDATE orders SET payout = 'RELEASED', release_at = NULL WHERE id = ?", o.id);
  }
  // Held wallet money → buyer. Must run inside db.tx().
  function refundBuyer(o, amount = o.total, note = '') {
    moveMoney(o.user_id, amount, 'ORDER_REFUND', `Pulangan wang pesanan ${o.code}${note}`, o.code);
    db.run("UPDATE orders SET payout = 'REFUNDED', release_at = NULL WHERE id = ?", o.id);
  }

  // Releases seller-completed orders whose dispute window has passed.
  function sweepReleases() {
    const due = db.all("SELECT * FROM orders WHERE payout = 'HELD' AND status = 'COMPLETED' AND release_at IS NOT NULL AND release_at <= ?", Date.now());
    for (const o of due) {
      try {
        db.tx(() => releaseToSeller(o, ' – dilepaskan automatik'));
        pushBalance(o.seller_id); pushBalance(o.user_id);
        notify(o.seller_id, `Bayaran ${o.code} dilepaskan 💰`, `${rm(sellerShare(o))} dikreditkan ke dompet anda.`, `#/orders/${o.id}`);
        if (o.deposit) notify(o.user_id, `Deposit ${o.code} dipulangkan`, `${rm(o.deposit)} kembali ke dompet anda.`, `#/orders/${o.id}`);
      } catch (err) {
        console.error('auto-release failed', o.code, err);
      }
    }
  }
  sweepReleases();
  setInterval(sweepReleases, Number(process.env.RELEASE_SWEEP_MS) || 60e3).unref();
  function broadcastOrder(o) {
    const payload = { id: o.id, status: db.one('SELECT status FROM orders WHERE id = ?', o.id).status };
    push(o.user_id, 'order', payload);
    push(o.seller_id, 'order', payload);
  }

  // Creates any kind of order (cart, booking, listing purchase) and holds wallet payment.
  function createOrder({ buyer, sellerId, shopId = null, listingId = null, vehicleId = null, kind = 'ORDER', lines, deliveryFee = 0,
    deposit = 0, payment, fulfilment = 'PICKUP', address = '', note = '', startAt = null, endAt = null, pickup = null, dropoff = null, pax = null,
    label, inTx }) {
    const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
    const total = subtotal + deliveryFee + deposit;
    const commission = payment === 'WALLET' ? Math.round((subtotal + deliveryFee) * (Number(db.getSetting('commission_pct')) || 0) / 100) : 0;
    const order = db.tx(() => {
      inTx?.();
      const now = Date.now();
      const code = 'UH' + now.toString(36).toUpperCase().slice(-6) + randomToken(2).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase().slice(0, 2);
      const id = Number(db.run(`INSERT INTO orders (code, kind, user_id, seller_id, shop_id, listing_id, vehicle_id, status, payment, fulfilment, address, note,
          subtotal, delivery_fee, deposit, total, commission, payout, start_at, end_at, pickup, dropoff, pax, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        code, kind, buyer.id, sellerId, shopId, listingId, vehicleId, payment, fulfilment, address, note,
        subtotal, deliveryFee, deposit, total, commission, payment === 'WALLET' ? 'HELD' : 'NONE', startAt, endAt, pickup, dropoff, pax, now, now).lastInsertRowid);
      for (const l of lines) db.run('INSERT INTO order_items (order_id, item_id, title, price, qty) VALUES (?, ?, ?, ?, ?)', id, l.item_id ?? null, l.title, l.price, l.qty);
      db.run("INSERT INTO order_events (order_id, status, at) VALUES (?, 'PENDING', ?)", id, now);
      if (payment === 'WALLET') moveMoney(buyer.id, -total, 'ORDER_PAY', `Bayaran ${code} – ${label}`, code);
      return db.one('SELECT * FROM orders WHERE id = ?', id);
    });
    if (payment === 'WALLET') pushBalance(buyer.id);
    const what = { ORDER: 'Pesanan', RIDE: 'Tempahan trip', SERVICE: 'Tempahan servis', RENTAL: 'Tempahan sewa kereta', ITEM: 'Pembelian', TICKET: 'Pembelian tiket', ROOM: 'Deposit tempahan bilik' }[kind] || 'Pesanan';
    notify(sellerId, `${what} baharu ${order.code} 🛎️`, `${buyer.name} – ${rm(total)} (${payment === 'WALLET' ? 'Dompet' : 'Tunai'}).`, `#/orders/${order.id}`);
    broadcastOrder(order);
    return order;
  }

  // Listing stock follows its orders: reserved on purchase, restocked on cancel, sold on completion.
  function syncListing(o, next) {
    if (!o.listing_id) return;
    const qty = db.one('SELECT COALESCE(SUM(qty), 0) AS n FROM order_items WHERE order_id = ?', o.id).n;
    const l = db.one('SELECT * FROM listings WHERE id = ?', o.listing_id);
    if (!l) return;
    if (next === 'CANCELLED' || next === 'REJECTED') {
      const stock = l.stock == null ? null : l.stock + qty;
      db.run("UPDATE listings SET stock = ?, status = CASE WHEN status IN ('RESERVED','SOLD') THEN 'ACTIVE' ELSE status END, updated_at = ? WHERE id = ?", stock, Date.now(), l.id);
    } else if (next === 'COMPLETED' && l.stock === 0 && l.kind === 'ITEM') {
      db.run("UPDATE listings SET status = 'SOLD', updated_at = ? WHERE id = ?", Date.now(), l.id);
    } else if (next === 'COMPLETED' && l.kind === 'ROOM') {
      db.run("UPDATE listings SET status = 'CLOSED', updated_at = ? WHERE id = ?", Date.now(), l.id);
    }
  }

  route('POST', '/api/orders', ({ user, body }) => {
    need(user);
    const shop = db.one('SELECT * FROM shops WHERE id = ?', Number(body.shopId));
    if (!isListed(shop)) fail(404, 'Kedai tidak aktif.');
    if (!shop.is_open) fail(400, 'Kedai sedang tutup. Cuba lagi nanti.');
    if (shop.owner_id === user.id) fail(400, 'Anda tidak boleh membuat pesanan di kedai sendiri.');
    const payment = oneOf(body.payment, ['WALLET', 'CASH'], 'Kaedah bayaran');
    if (payment === 'CASH' && !shop.allow_cash) fail(400, 'Kedai ini hanya menerima bayaran Dompet UPSIHub.');
    const fulfilment = oneOf(body.fulfilment || 'DELIVERY', ['DELIVERY', 'PICKUP'], 'Kaedah penerimaan');
    const address = text(body.address, 'Lokasi penghantaran', { max: 200, optional: fulfilment === 'PICKUP' });
    const note = text(body.note, 'Nota', { max: 300, optional: true });
    const lines = Array.isArray(body.items) ? body.items : [];
    if (!lines.length || lines.length > 50) fail(400, 'Troli kosong.');

    const picked = lines.map((l) => {
      const item = db.one('SELECT * FROM items WHERE id = ? AND shop_id = ?', Number(l.id), shop.id);
      if (!item || !item.available) fail(400, 'Sebahagian item tidak lagi tersedia. Sila kemas kini troli.');
      return { item, qty: sen(l.qty, 'Kuantiti', { min: 1, max: 99 }) };
    });
    if (picked.some((p) => p.item.kind !== 'PRODUCT')) fail(400, 'Trip & servis perlu ditempah melalui butang Tempah.');
    const subtotal = picked.reduce((sum, p) => sum + p.item.price * p.qty, 0);
    if (subtotal < shop.min_order) fail(400, `Pesanan minimum kedai ini ialah ${rm(shop.min_order)}.`);
    const order = createOrder({
      buyer: user, sellerId: shop.owner_id, shopId: shop.id, kind: 'ORDER', payment, fulfilment, address, note,
      deliveryFee: fulfilment === 'DELIVERY' ? shop.delivery_fee : 0,
      lines: picked.map((p) => ({ item_id: p.item.id, title: p.item.title, price: p.item.price, qty: p.qty })),
      label: shop.name
    });
    return { order: orderOut(order) };
  });

  route('GET', '/api/orders', ({ user }) => {
    need(user);
    return { orders: db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', user.id).map(orderOut) };
  });

  function loadOrder(id, user) {
    const o = db.one('SELECT * FROM orders WHERE id = ?', Number(id));
    if (!o) fail(404, 'Pesanan tidak dijumpai.');
    const role = o.user_id === user.id ? 'buyer' : o.seller_id === user.id ? 'seller' : user.role === 'admin' ? 'admin' : null;
    if (!role) fail(404, 'Pesanan tidak dijumpai.');
    return { o, role, ownerId: o.seller_id };
  }

  route('GET', '/api/orders/:id', ({ user, params }) => {
    need(user);
    const { o, role } = loadOrder(params.id, user);
    return { order: orderOut(o), role };
  });

  route('POST', '/api/orders/:id/status', ({ user, params, body }) => {
    need(user);
    const { o, role, ownerId } = loadOrder(params.id, user);
    const next = String(body.status || '');
    const reason = text(body.reason, 'Sebab', { max: 200, optional: true });
    const allowed = {
      seller: { PENDING: ['ACCEPTED', 'REJECTED'], ACCEPTED: ['READY', 'CANCELLED'], READY: ['COMPLETED', 'CANCELLED'] },
      buyer: { PENDING: ['CANCELLED'], READY: ['COMPLETED'] },
      admin: { PENDING: ['CANCELLED'], ACCEPTED: ['CANCELLED'], READY: ['CANCELLED', 'COMPLETED'] }
    };
    if (!(allowed[role][o.status] || []).includes(next)) fail(400, 'Tindakan ini tidak dibenarkan untuk status pesanan semasa.');

    const wallet = o.payment === 'WALLET';
    // When the seller (not the buyer) marks it done, the buyer gets a window to report a problem.
    const holdForBuyer = wallet && next === 'COMPLETED' && role === 'seller';
    const openRental = o.kind === 'RENTAL' && o.end_at == null && next === 'COMPLETED';
    const returnAt = openRental ? rentalReturnDate(o, role === 'seller' ? body.return_date : null) : null;
    let settlement = null;
    let cur = o;
    db.tx(() => {
      if (openRental) {
        settlement = settleOpenRental(o, returnAt);
        cur = db.one('SELECT * FROM orders WHERE id = ?', o.id);
      }
      setOrderStatus(cur, next, { reason: reason || null });
      syncListing(cur, next);
      if (!wallet) return;
      if (next === 'COMPLETED') {
        if (holdForBuyer) db.run('UPDATE orders SET release_at = ? WHERE id = ?', Date.now() + DISPUTE_WINDOW, o.id);
        else releaseToSeller(cur);
      } else if (next === 'CANCELLED' || next === 'REJECTED') {
        refundBuyer(cur);
      }
    });
    if (settlement) {
      const s2 = settlement;
      notify(o.user_id, `Sewa ${o.code}: ${s2.days} hari`, `Jumlah sewa ${rm(s2.rent)}.${s2.fromWallet ? ` ${rm(s2.fromWallet)} ditolak dari dompet.` : ''}${s2.fromDeposit ? ` ${rm(s2.fromDeposit)} ditolak dari deposit.` : ''}${s2.unpaid ? ` Baki ${rm(s2.unpaid)} belum dibayar – sila selesaikan dengan pemilik.` : ''}`, `#/orders/${o.id}`);
      if (s2.unpaid) notify(ownerId, `Baki sewa ${o.code} belum dibayar`, `${rm(s2.unpaid)} melebihi baki dompet & deposit penyewa. Hubungi penyewa atau admin.`, `#/orders/${o.id}`);
    }
    if (wallet) { pushBalance(o.user_id); pushBalance(ownerId); }

    const link = `#/orders/${o.id}`;
    const label = ORDER_LABEL[next];
    const refundNote = wallet && (next === 'CANCELLED' || next === 'REJECTED') ? ` ${rm(o.total)} telah dipulangkan ke dompet.` : '';
    const buyerNote = holdForBuyer ? `Bayaran akan dilepaskan kepada peniaga dalam 48 jam. Ada masalah? Laporkan sebelum itu.` : '';
    if (role !== 'buyer') notify(o.user_id, `Pesanan ${o.code} ${label}`, (reason ? `Sebab: ${reason}. ` : '') + refundNote + buyerNote, link);
    if (role !== 'seller') notify(ownerId, `Pesanan ${o.code} ${label}`, next === 'COMPLETED' && wallet ? `${rm(sellerShare(cur))} dikreditkan ke dompet anda.` : (reason ? `Sebab: ${reason}` : ''), link);
    broadcastOrder(o);
    return { order: orderOut(db.one('SELECT * FROM orders WHERE id = ?', o.id)) };
  });

  route('POST', '/api/orders/:id/review', ({ user, params, body }) => {
    need(user);
    const { o, role, ownerId } = loadOrder(params.id, user);
    if (role !== 'buyer') fail(403, 'Hanya pembeli boleh memberi ulasan.');
    if (o.status !== 'COMPLETED') fail(400, 'Ulasan hanya boleh diberi selepas pesanan selesai.');
    if (db.one('SELECT id FROM reviews WHERE order_id = ?', o.id) || db.one('SELECT id FROM seller_reviews WHERE order_id = ?', o.id)) {
      fail(409, 'Anda sudah memberi ulasan untuk pesanan ini.');
    }
    const rating = sen(body.rating, 'Penilaian', { min: 1, max: 5 });
    const comment = text(body.comment, 'Ulasan', { max: 500, optional: true });
    // Shop orders rate the shop; student-to-student orders rate the seller personally.
    if (o.shop_id) db.run('INSERT INTO reviews (order_id, shop_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)', o.id, o.shop_id, user.id, rating, comment, Date.now());
    else db.run('INSERT INTO seller_reviews (order_id, seller_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)', o.id, o.seller_id, user.id, rating, comment, Date.now());
    notify(ownerId, `Ulasan baharu ${'★'.repeat(rating)}`, comment || `${user.name} memberi ${rating} bintang.`, o.shop_id ? '#/seller' : `#/u/${o.seller_id}`);
    return { ok: true };
  });

  // ---------- open-ended car rentals ----------
  // Return day for a rental with no planned end: the seller's stated date, else today (Malaysia time).
  function rentalReturnDate(o, v) {
    const today = myDate(new Date(Date.now() + MY_OFFSET).toISOString().slice(0, 10), 'Hari ini');
    const ret = v ? myDate(v, 'Tarikh pulang') : today;
    if (ret < o.start_at) fail(400, 'Tarikh pulang tidak boleh sebelum tarikh ambil.');
    if (ret > today) fail(400, 'Tarikh pulang tidak boleh pada masa hadapan.');
    return ret;
  }
  // Charges the actual days used. The renter prepaid one day; the rest comes from their
  // wallet, then from the deposit. Must run inside db.tx().
  function settleOpenRental(o, returnAt) {
    const line = db.one('SELECT * FROM order_items WHERE order_id = ? LIMIT 1', o.id);
    const days = Math.max(1, Math.round((returnAt - o.start_at) / 864e5));
    const rent = days * line.price;
    const extra = Math.max(0, rent - o.subtotal);
    const balance = db.one('SELECT balance FROM users WHERE id = ?', o.user_id).balance;
    const fromWallet = Math.min(balance, extra);
    if (fromWallet) moveMoney(o.user_id, -fromWallet, 'ORDER_PAY', `Caj sewa tambahan ${o.code} (${days} hari)`, o.code);
    const fromDeposit = Math.min(o.deposit, extra - fromWallet);
    const unpaid = extra - fromWallet - fromDeposit;
    const subtotal = o.subtotal + fromWallet + fromDeposit;
    const pct = Number(db.getSetting('commission_pct')) || 0;
    db.run('UPDATE order_items SET qty = ? WHERE id = ?', days, line.id);
    db.run(`UPDATE orders SET end_at = ?, subtotal = ?, deposit = ?, total = ?, commission = ?,
            note = CASE WHEN ? > 0 THEN TRIM(note || ' [Baki sewa belum dibayar: ' || ? || ']') ELSE note END WHERE id = ?`,
      returnAt, subtotal, o.deposit - fromDeposit, subtotal + o.deposit - fromDeposit, Math.round(subtotal * pct / 100), unpaid, rm(unpaid), o.id);
    return { days, rent, fromWallet, fromDeposit, unpaid };
  }

  function sellerRating(userId) {
    const r = db.one('SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM seller_reviews WHERE seller_id = ?', userId);
    return { rating: r.avg || 0, reviews: r.n };
  }
  // Public profile of an individual seller with their ratings & active listings.
  route('GET', '/api/users/:id', ({ params }) => {
    const u = db.one("SELECT id, name, avatar, campus, created_at FROM users WHERE id = ? AND status = 'active'", Number(params.id)) || fail(404, 'Pengguna tidak dijumpai.');
    return {
      user: { ...u, online: isOnline(u.id), ...sellerRating(u.id), sold: db.one("SELECT COUNT(*) AS n FROM orders WHERE seller_id = ? AND listing_id IS NOT NULL AND status = 'COMPLETED'", u.id).n },
      reviews: db.all(`SELECT r.rating, r.comment, r.created_at, b.name, l.title FROM seller_reviews r JOIN users b ON b.id = r.user_id
                       JOIN orders o ON o.id = r.order_id LEFT JOIN listings l ON l.id = o.listing_id
                       WHERE r.seller_id = ? ORDER BY r.created_at DESC LIMIT 30`, u.id)
    };
  });

  // Buyer confirms receipt of a seller-completed order → release now instead of waiting.
  route('POST', '/api/orders/:id/confirm', ({ user, params }) => {
    need(user);
    const { o, role, ownerId } = loadOrder(params.id, user);
    if (role !== 'buyer') fail(403, 'Hanya pembeli boleh mengesahkan penerimaan.');
    if (o.status !== 'COMPLETED' || o.payout !== 'HELD') fail(400, 'Tiada bayaran yang sedang dipegang untuk pesanan ini.');
    db.tx(() => releaseToSeller(o, ' – disahkan pembeli'));
    pushBalance(ownerId);
    pushBalance(o.user_id);
    notify(ownerId, `Pembeli mengesahkan pesanan ${o.code} ✅`, `${rm(sellerShare(o))} dikreditkan ke dompet anda.`, `#/orders/${o.id}`);
    broadcastOrder(o);
    return { order: orderOut(db.one('SELECT * FROM orders WHERE id = ?', o.id)) };
  });

  // =====================================================================
  // DISPUTES – buyer reports a problem, held money is frozen until admin decides
  // =====================================================================
  route('POST', '/api/orders/:id/dispute', ({ user, params, body }) => {
    need(user);
    const { o, role, ownerId } = loadOrder(params.id, user);
    if (role !== 'buyer') fail(403, 'Hanya pembeli boleh melaporkan masalah.');
    if (db.one('SELECT id FROM disputes WHERE order_id = ?', o.id)) fail(409, 'Laporan untuk pesanan ini sudah dihantar.');
    if (o.payment !== 'WALLET') fail(400, 'Pesanan tunai tidak dilindungi. Sila hubungi sokongan melalui chat.');
    if (o.payout !== 'HELD' || !['ACCEPTED', 'READY', 'COMPLETED'].includes(o.status)) {
      fail(400, o.payout === 'RELEASED' ? 'Bayaran telah dilepaskan kepada peniaga. Hubungi sokongan melalui chat.' : 'Pesanan ini tidak boleh dipertikaikan.');
    }
    const reason = oneOf(body.reason, Object.keys(DISPUTE_REASONS), 'Sebab');
    const details = text(body.details, 'Butiran', { min: 10, max: 1000 });
    const evidence = uploadRef(body.evidence);
    db.tx(() => {
      db.run('INSERT INTO disputes (order_id, user_id, reason, details, evidence, prev_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        o.id, user.id, reason, details, evidence, o.status, Date.now());
      setOrderStatus(o, 'DISPUTED');
      db.run('UPDATE orders SET release_at = NULL WHERE id = ?', o.id);
    });
    const link = `#/orders/${o.id}`;
    notify(ownerId, `⚠️ Pesanan ${o.code} dilaporkan`, `${DISPUTE_REASONS[reason]}. Bayaran ${rm(o.total)} dibekukan. Beri penjelasan anda kepada admin.`, link);
    notifyAdmins('Pertikaian baharu', `${o.code} – ${DISPUTE_REASONS[reason]} (${rm(o.total)})`, '#/admin/disputes');
    broadcastOrder(o);
    return { order: orderOut(db.one('SELECT * FROM orders WHERE id = ?', o.id)) };
  });

  route('POST', '/api/orders/:id/dispute/respond', ({ user, params, body }) => {
    need(user);
    const { o, role } = loadOrder(params.id, user);
    if (role !== 'seller') fail(403, 'Hanya peniaga boleh memberi penjelasan.');
    const d = db.one("SELECT * FROM disputes WHERE order_id = ? AND status = 'OPEN'", o.id) || fail(404, 'Tiada pertikaian aktif.');
    const response = text(body.response, 'Penjelasan', { min: 10, max: 1000 });
    const evidence = uploadRef(body.evidence);
    db.run('UPDATE disputes SET seller_response = ?, seller_evidence = COALESCE(?, seller_evidence) WHERE id = ?', response, evidence, d.id);
    notifyAdmins('Peniaga membalas pertikaian', `${o.code}: ${response.slice(0, 80)}`, '#/admin/disputes');
    notify(o.user_id, `Peniaga membalas laporan ${o.code}`, response.slice(0, 120), `#/orders/${o.id}`);
    broadcastOrder(o);
    return { ok: true };
  });

  // =====================================================================
  // SELLER CENTRE
  // =====================================================================
  const myShop = (user) => db.one('SELECT * FROM shops WHERE owner_id = ?', user.id);
  const needShop = (user) => myShop(user) || fail(404, 'Anda belum mendaftar kedai.');

  function shopFields(body, base = {}) {
    return {
      name: text(body.name ?? base.name, 'Nama kedai', { min: 3, max: 80 }),
      category: oneOf(body.category ?? base.category, cats('shop'), 'Kategori'),
      campus: oneOf(body.campus ?? base.campus, Object.keys(CAMPUSES), 'Kampus'),
      description: text(body.description ?? base.description, 'Penerangan', { min: 10, max: 600 }),
      image: body.image !== undefined ? uploadRef(body.image) : base.image ?? null,
      hours: text(body.hours ?? base.hours, 'Waktu operasi', { max: 80, optional: true }),
      delivery_fee: sen(body.delivery_fee ?? base.delivery_fee ?? 0, 'Caj penghantaran', { max: 5000 }),
      min_order: sen(body.min_order ?? base.min_order ?? 0, 'Pesanan minimum', { max: 100000 }),
      allow_cash: body.allow_cash !== undefined ? (body.allow_cash ? 1 : 0) : base.allow_cash ?? 1,
      booking_hours: body.booking_hours !== undefined ? bookingHours(body.booking_hours) : base.booking_hours ?? null
    };
  }
  function bookingHours(v) {
    if (v == null || v === '') return null;
    const days = Array.isArray(v.days) ? [...new Set(v.days.map(Number))].filter((d) => d >= 0 && d <= 6) : [];
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!days.length || !hhmm.test(v.start) || !hhmm.test(v.end) || v.start >= v.end) fail(400, 'Waktu tempahan tidak sah.');
    return JSON.stringify({ days: days.sort(), start: v.start, end: v.end });
  }
  const pkgById = (id) => db.getSetting('packages').find((p) => p.id === id) || fail(400, 'Pakej tidak sah.');

  route('GET', '/api/seller', ({ user }) => {
    need(user);
    const s = myShop(user);
    if (!s) return { shop: null };
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const sum = (where, ...p) => db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(total - commission), 0) AS total FROM orders WHERE shop_id = ? AND ${where}`, s.id, ...p);
    return {
      shop: { ...shopOut(s), package: s.package, license_until: s.license_until, license_fee: s.license_fee, reject_reason: s.reject_reason, created_at: s.created_at, booking_hours: s.booking_hours ? JSON.parse(s.booking_hours) : null },
      items: db.all('SELECT * FROM items WHERE shop_id = ? ORDER BY id', s.id),
      vehicles: db.all('SELECT * FROM vehicles WHERE shop_id = ? ORDER BY id', s.id),
      stats: {
        today: sum("status = 'COMPLETED' AND created_at >= ?", dayStart.getTime()),
        all: sum("status = 'COMPLETED'"),
        active: db.one("SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND status IN ('PENDING','ACCEPTED','READY','DISPUTED')", s.id).n,
        pending: db.one("SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND status = 'PENDING'", s.id).n,
        last7: db.all(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n, SUM(total - commission) AS total
                       FROM orders WHERE shop_id = ? AND status = 'COMPLETED' AND created_at >= ? GROUP BY day ORDER BY day`, s.id, Date.now() - 7 * 864e5)
      }
    };
  });

  route('POST', '/api/seller/apply', ({ user, body }) => {
    need(user);
    if (user.role === 'admin') fail(400, 'Akaun pentadbir tidak boleh membuka kedai.');
    const existing = myShop(user);
    if (existing && existing.status !== 'REJECTED') fail(409, 'Anda sudah mempunyai kedai berdaftar.');
    const f = shopFields(body, existing || {});
    const pkg = pkgById(body.package);
    db.tx(() => {
      const now = Date.now();
      if (existing) {
        db.run(`UPDATE shops SET name=?, category=?, campus=?, description=?, image=?, hours=?, delivery_fee=?, min_order=?, allow_cash=?,
                status='PENDING', reject_reason=NULL, package=?, license_fee=? WHERE id = ?`,
          f.name, f.category, f.campus, f.description, f.image, f.hours, f.delivery_fee, f.min_order, f.allow_cash, pkg.id, pkg.price, existing.id);
      } else {
        db.run(`INSERT INTO shops (owner_id, name, category, campus, description, image, hours, delivery_fee, min_order, allow_cash, status, package, license_fee, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
          user.id, f.name, f.category, f.campus, f.description, f.image, f.hours, f.delivery_fee, f.min_order, f.allow_cash, pkg.id, pkg.price, now);
      }
      if (pkg.price > 0) moveMoney(user.id, -pkg.price, 'LICENSE_FEE', `Yuran lesen peniaga – pakej ${pkg.label}`, pkg.id);
    });
    pushBalance(user.id);
    notifyAdmins('Permohonan kedai baharu', `${f.name} (${f.category}) – yuran ${rm(pkg.price)} telah dibayar melalui dompet.`, '#/admin/shops');
    return { ok: true };
  });

  route('POST', '/api/seller/renew', ({ user, body }) => {
    need(user);
    const s = needShop(user);
    if (s.status !== 'APPROVED') fail(400, 'Hanya kedai yang diluluskan boleh memperbaharui lesen.');
    const pkg = pkgById(body.package);
    db.tx(() => {
      moveMoney(user.id, -pkg.price, 'LICENSE_FEE', `Pembaharuan lesen – pakej ${pkg.label}`, pkg.id);
      const from = Math.max(Date.now(), s.license_until || 0);
      db.run('UPDATE shops SET package = ?, license_fee = license_fee + ?, license_until = ? WHERE id = ?', pkg.id, pkg.price, from + pkg.days * 864e5, s.id);
    });
    pushBalance(user.id);
    notify(user.id, 'Lesen diperbaharui ✅', `Pakej ${pkg.label} aktif sehingga ${new Date(Math.max(Date.now(), s.license_until || 0) + pkg.days * 864e5).toLocaleDateString('ms-MY')}.`, '#/seller/license');
    return { ok: true };
  });

  route('PATCH', '/api/seller/shop', ({ user, body }) => {
    need(user);
    const s = needShop(user);
    if (body.is_open !== undefined && Object.keys(body).length === 1) {
      db.run('UPDATE shops SET is_open = ? WHERE id = ?', body.is_open ? 1 : 0, s.id);
      return { ok: true };
    }
    const f = shopFields(body, s);
    db.run('UPDATE shops SET name=?, category=?, campus=?, description=?, image=?, hours=?, delivery_fee=?, min_order=?, allow_cash=?, booking_hours=?, is_open=? WHERE id = ?',
      f.name, f.category, f.campus, f.description, f.image, f.hours, f.delivery_fee, f.min_order, f.allow_cash, f.booking_hours, body.is_open !== undefined ? (body.is_open ? 1 : 0) : s.is_open, s.id);
    return { ok: true };
  });

  function itemFields(body, base = {}) {
    const f = {
      title: text(body.title ?? base.title, 'Nama item', { min: 2, max: 100 }),
      description: text(body.description ?? base.description, 'Penerangan', { max: 300, optional: true }),
      price: sen(body.price ?? base.price, 'Harga', { min: 1, max: 1000000 }),
      image: body.image !== undefined ? uploadRef(body.image) : base.image ?? null,
      available: body.available !== undefined ? (body.available ? 1 : 0) : base.available ?? 1,
      kind: oneOf(body.kind ?? base.kind ?? 'PRODUCT', ['PRODUCT', 'ROUTE', 'SERVICE'], 'Jenis item'),
      duration_min: null
    };
    if (f.kind === 'SERVICE') f.duration_min = sen(body.duration_min ?? base.duration_min, 'Tempoh servis (minit)', { min: 15, max: 480 });
    return f;
  }
  route('POST', '/api/seller/items', ({ user, body }) => {
    need(user);
    const s = needShop(user);
    if (db.one('SELECT COUNT(*) AS n FROM items WHERE shop_id = ?', s.id).n >= 200) fail(400, 'Had maksimum 200 item.');
    const f = itemFields(body);
    const id = Number(db.run('INSERT INTO items (shop_id, title, description, price, image, available, kind, duration_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      s.id, f.title, f.description, f.price, f.image, f.available, f.kind, f.duration_min, Date.now()).lastInsertRowid);
    return { item: db.one('SELECT * FROM items WHERE id = ?', id) };
  });
  route('PATCH', '/api/seller/items/:id', ({ user, params, body }) => {
    need(user);
    const s = needShop(user);
    const it = db.one('SELECT * FROM items WHERE id = ? AND shop_id = ?', Number(params.id), s.id) || fail(404, 'Item tidak dijumpai.');
    const f = itemFields(body, it);
    db.run('UPDATE items SET title=?, description=?, price=?, image=?, available=?, kind=?, duration_min=? WHERE id = ?', f.title, f.description, f.price, f.image, f.available, f.kind, f.duration_min, it.id);
    return { item: db.one('SELECT * FROM items WHERE id = ?', it.id) };
  });
  route('DELETE', '/api/seller/items/:id', ({ user, params }) => {
    need(user);
    const s = needShop(user);
    db.run('DELETE FROM items WHERE id = ? AND shop_id = ?', Number(params.id), s.id);
    return { ok: true };
  });

  route('GET', '/api/seller/orders', ({ user, query }) => {
    need(user);
    const s = needShop(user);
    const filter = query.get('status') || 'ACTIVE';
    const where = filter === 'ACTIVE' ? "status IN ('PENDING','ACCEPTED','READY','DISPUTED')" : filter === 'DONE' ? "status IN ('COMPLETED','CANCELLED','REJECTED')" : '1=1';
    return { orders: db.all(`SELECT * FROM orders WHERE shop_id = ? AND ${where} ORDER BY created_at DESC LIMIT 200`, s.id).map(orderOut) };
  });

  // =====================================================================
  // WALLET
  // =====================================================================
  route('GET', '/api/wallet', ({ user }) => {
    need(user);
    return {
      balance: db.one('SELECT balance FROM users WHERE id = ?', user.id).balance,
      transactions: db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100', user.id),
      topups: db.all('SELECT * FROM topups WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id),
      withdrawals: db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id)
    };
  });

  route('POST', '/api/wallet/topup', ({ user, body }) => {
    need(user);
    const amount = sen(body.amount, 'Jumlah tambah nilai', { min: 100, max: MAX_TOPUP });
    const method = oneOf(body.method, ['BANK', 'COUNTER'], 'Kaedah');
    const reference = text(body.reference, 'No. rujukan', { max: 60, optional: method === 'COUNTER' });
    const receipt = uploadRef(body.receipt);
    if (method === 'BANK' && !receipt && !reference) fail(400, 'Sila sertakan no. rujukan atau resit pindahan.');
    if (db.one("SELECT COUNT(*) AS n FROM topups WHERE user_id = ? AND status = 'PENDING'", user.id).n >= 3) fail(400, 'Anda mempunyai 3 permohonan tambah nilai yang belum disemak.');
    db.run('INSERT INTO topups (user_id, amount, method, reference, receipt, created_at) VALUES (?, ?, ?, ?, ?, ?)', user.id, amount, method, reference, receipt, Date.now());
    notifyAdmins('Permohonan tambah nilai', `${user.name} – ${rm(amount)} (${method === 'BANK' ? 'Pindahan bank' : 'Tunai di kaunter'})`, '#/admin/topups');
    return { ok: true };
  });

  route('POST', '/api/wallet/transfer', ({ user, body, ip }) => {
    need(user);
    if (!rateLimit(`xfer:${user.id}`, 20, 3600e3)) fail(429, 'Terlalu banyak pindahan. Cuba lagi kemudian.');
    const to = String(body.to || '').trim();
    const target = db.one("SELECT * FROM users WHERE (email = ? OR UPPER(matric) = UPPER(?)) AND status = 'active'", to.toLowerCase(), to);
    if (!target) fail(404, 'Penerima tidak dijumpai. Masukkan e-mel atau no. matrik yang tepat.');
    if (target.id === user.id) fail(400, 'Anda tidak boleh memindahkan wang kepada diri sendiri.');
    const amount = sen(body.amount, 'Jumlah', { min: 10, max: MAX_BALANCE });
    const note = text(body.note, 'Nota', { max: 100, optional: true });
    if (!verifyPassword(String(body.password || ''), user.password)) fail(400, 'Kata laluan salah. Pindahan dibatalkan.');
    const ref = 'TRF' + Date.now().toString(36).toUpperCase();
    db.tx(() => {
      moveMoney(user.id, -amount, 'TRANSFER_OUT', `Pindahan kepada ${target.name}${note ? ` – ${note}` : ''}`, ref);
      moveMoney(target.id, amount, 'TRANSFER_IN', `Diterima daripada ${user.name}${note ? ` – ${note}` : ''}`, ref);
    });
    pushBalance(user.id); pushBalance(target.id);
    notify(target.id, `Anda menerima ${rm(amount)} 💸`, `Daripada ${user.name}${note ? `: ${note}` : ''}`, '#/wallet');
    return { ok: true, to: target.name };
  });

  route('POST', '/api/wallet/withdraw', ({ user, body }) => {
    need(user);
    const amount = sen(body.amount, 'Jumlah', { min: 1000, max: MAX_BALANCE });
    const bank_name = text(body.bank_name, 'Nama bank', { max: 60 });
    const account_no = text(body.account_no, 'No. akaun', { min: 6, max: 30 });
    const account_name = text(body.account_name, 'Nama pemegang akaun', { max: 80 });
    if (!verifyPassword(String(body.password || ''), user.password)) fail(400, 'Kata laluan salah.');
    db.tx(() => {
      const id = Number(db.run('INSERT INTO withdrawals (user_id, amount, bank_name, account_no, account_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        user.id, amount, bank_name, account_no, account_name, Date.now()).lastInsertRowid);
      moveMoney(user.id, -amount, 'WITHDRAW', `Pengeluaran ke ${bank_name} ••${account_no.slice(-4)}`, `WD${id}`);
    });
    pushBalance(user.id);
    notifyAdmins('Permohonan pengeluaran', `${user.name} – ${rm(amount)} ke ${bank_name}`, '#/admin/withdrawals');
    return { ok: true };
  });

  // =====================================================================
  // CHAT
  // =====================================================================
  function convOut(c, me) {
    const otherId = c.user_a === me ? c.user_b : c.user_a;
    const other = db.one('SELECT id, name, avatar, role FROM users WHERE id = ?', otherId);
    const shop = db.one('SELECT id, name FROM shops WHERE owner_id = ?', otherId);
    const last = db.one('SELECT body, image, sender_id, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', c.id);
    const unread = db.one('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL', c.id, me).n;
    return { id: c.id, kind: c.kind, last_at: c.last_at, other: { ...other, online: isOnline(otherId) }, shop: shop || null, last: last || null, unread };
  }
  const loadConv = (id, user) => {
    const c = db.one('SELECT * FROM conversations WHERE id = ?', Number(id));
    if (!c || (c.user_a !== user.id && c.user_b !== user.id)) fail(404, 'Perbualan tidak dijumpai.');
    return c;
  };

  route('GET', '/api/chats', ({ user }) => {
    need(user);
    return { chats: db.all('SELECT * FROM conversations WHERE user_a = ? OR user_b = ? ORDER BY last_at DESC LIMIT 100', user.id, user.id).map((c) => convOut(c, user.id)) };
  });

  route('POST', '/api/chats', ({ user, body }) => {
    need(user);
    let otherId;
    let kind = 'direct';
    if (body.support) {
      const admin = db.one("SELECT id FROM users WHERE role = 'admin' AND status = 'active' AND id != ? ORDER BY id LIMIT 1", user.id);
      if (!admin) fail(404, 'Tiada pentadbir tersedia.');
      otherId = admin.id;
      kind = 'support';
    } else if (body.shopId) {
      const s = db.one('SELECT owner_id FROM shops WHERE id = ?', Number(body.shopId)) || fail(404, 'Kedai tidak dijumpai.');
      otherId = s.owner_id;
    } else if (body.listingId) {
      const l = db.one("SELECT id, user_id, title FROM listings WHERE id = ? AND status != 'REMOVED'", Number(body.listingId)) || fail(404, 'Iklan tidak dijumpai.');
      otherId = l.user_id;
    } else if (body.orderId) {
      const { o, ownerId } = loadOrder(body.orderId, user);
      otherId = o.user_id === user.id ? ownerId : o.user_id;
    } else if (body.userId && user.role === 'admin') {
      otherId = Number(body.userId);
      kind = 'support';
    } else fail(400, 'Penerima tidak dinyatakan.');
    if (otherId === user.id) fail(400, 'Anda tidak boleh berbual dengan diri sendiri.');
    if (!db.one('SELECT id FROM users WHERE id = ?', otherId)) fail(404, 'Pengguna tidak dijumpai.');
    const c = conversationFor(user.id, otherId, kind);
    if (body.listingId) {
      const l = db.one('SELECT title FROM listings WHERE id = ?', Number(body.listingId));
      const ref = `Berkenaan iklan: ${l.title}`;
      if (!db.one('SELECT id FROM messages WHERE conversation_id = ? AND body = ?', c.id, ref)) sendMessage(c, user.id, ref, null);
    }
    if (body.orderId) {
      const o = db.one('SELECT code FROM orders WHERE id = ?', Number(body.orderId));
      const hasRef = db.one('SELECT id FROM messages WHERE conversation_id = ? AND body LIKE ?', c.id, `%${o.code}%`);
      if (!hasRef) sendMessage(c, user.id, `Berkenaan pesanan #${o.code}`, null);
    }
    return { chat: convOut(c, user.id) };
  });

  route('GET', '/api/chats/:id/messages', ({ user, params, query }) => {
    need(user);
    const c = loadConv(params.id, user);
    const before = Number(query.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db.all('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 60', c.id, before).reverse();
    return { chat: convOut(c, user.id), messages: rows };
  });

  route('POST', '/api/chats/:id/messages', ({ user, params, body }) => {
    need(user);
    if (!rateLimit(`msg:${user.id}`, 60, 60e3)) fail(429, 'Anda menghantar mesej terlalu pantas.');
    const c = loadConv(params.id, user);
    const image = uploadRef(body.image);
    const msgBody = text(body.body, 'Mesej', { max: 2000, optional: !!image });
    const msg = sendMessage(c, user.id, msgBody, image);
    const otherId = c.user_a === user.id ? c.user_b : c.user_a;
    if (!isOnline(otherId)) {
      // Stored as a notification so the recipient sees it on next visit.
      const recent = db.one('SELECT id FROM notifications WHERE user_id = ? AND link = ? AND read = 0', otherId, `#/chat/${c.id}`);
      if (!recent) notify(otherId, `Mesej baharu daripada ${user.name}`, msgBody ? msgBody.slice(0, 80) : '📷 Gambar', `#/chat/${c.id}`);
    }
    return { message: msg };
  });

  route('POST', '/api/chats/:id/read', ({ user, params }) => {
    need(user);
    const c = loadConv(params.id, user);
    const now = Date.now();
    db.run('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL', now, c.id, user.id);
    const otherId = c.user_a === user.id ? c.user_b : c.user_a;
    push(otherId, 'read', { conversation_id: c.id, at: now });
    return { ok: true };
  });

  // =====================================================================
  // NOTIFICATIONS
  // =====================================================================
  route('GET', '/api/notifications', ({ user }) => {
    need(user);
    return { notifications: db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id) };
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    need(user);
    if (body.id) db.run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', Number(body.id), user.id);
    else db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', user.id);
    return { ok: true };
  });

  // =====================================================================
  // ADMIN
  // =====================================================================
  const needAdmin = (user) => { need(user); if (user.role !== 'admin') fail(403, 'Akses pentadbir sahaja.'); };

  route('GET', '/api/admin/overview', ({ user }) => {
    needAdmin(user);
    const n = (sql, ...p) => db.one(sql, ...p).n;
    const licence = db.one("SELECT COALESCE(SUM(-amount), 0) AS n FROM transactions WHERE type IN ('LICENSE_FEE','LICENSE_REFUND')").n;
    const commission = db.one("SELECT COALESCE(SUM(commission), 0) AS n FROM orders WHERE status = 'COMPLETED' AND payout = 'RELEASED'").n;
    return {
      revenue: { licence, commission, total: licence + commission },
      users: n('SELECT COUNT(*) AS n FROM users'),
      shops: n("SELECT COUNT(*) AS n FROM shops WHERE status = 'APPROVED'"),
      pending: {
        shops: n("SELECT COUNT(*) AS n FROM shops WHERE status = 'PENDING'"),
        topups: n("SELECT COUNT(*) AS n FROM topups WHERE status = 'PENDING'"),
        withdrawals: n("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'PENDING'"),
        disputes: n("SELECT COUNT(*) AS n FROM disputes WHERE status = 'OPEN'"),
        listings: n("SELECT COUNT(*) AS n FROM listings WHERE reports > 0 AND status != 'REMOVED'")
      },
      orders: {
        total: n('SELECT COUNT(*) AS n FROM orders'),
        completed: n("SELECT COUNT(*) AS n FROM orders WHERE status = 'COMPLETED'"),
        gmv: db.one("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status = 'COMPLETED'").n
      },
      // Money held in user wallets = liability that must match the platform bank balance.
      float: db.one('SELECT COALESCE(SUM(balance), 0) AS n FROM users').n,
      recent: db.all(`SELECT o.id, o.code, o.kind, o.total, o.status, o.payment, o.created_at, COALESCE(s.name, l.title, sv.name) AS shop, u.name AS buyer
                      FROM orders o LEFT JOIN shops s ON s.id = o.shop_id LEFT JOIN listings l ON l.id = o.listing_id
                      JOIN users sv ON sv.id = o.seller_id JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 8`)
    };
  });

  route('GET', '/api/admin/shops', ({ user }) => {
    needAdmin(user);
    return {
      shops: db.all(`SELECT s.*, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone FROM shops s JOIN users u ON u.id = s.owner_id
                     ORDER BY CASE s.status WHEN 'PENDING' THEN 0 ELSE 1 END, s.created_at DESC`).map((s) => ({ ...s, ...shopRating(s.id) }))
    };
  });
  route('POST', '/api/admin/shops/:id/:action', ({ user, params, body }) => {
    needAdmin(user);
    const s = db.one('SELECT * FROM shops WHERE id = ?', Number(params.id)) || fail(404, 'Kedai tidak dijumpai.');
    const action = oneOf(params.action, ['approve', 'reject', 'suspend', 'restore'], 'Tindakan');
    const reason = text(body.reason, 'Sebab', { max: 200, optional: true });
    if (action === 'approve') {
      if (s.status !== 'PENDING') fail(400, 'Hanya permohonan yang menunggu boleh diluluskan.');
      const pkg = db.getSetting('packages').find((p) => p.id === s.package) || { days: 30, label: s.package };
      db.run("UPDATE shops SET status = 'APPROVED', reject_reason = NULL, license_until = ? WHERE id = ?", Date.now() + pkg.days * 864e5, s.id);
      notify(s.owner_id, 'Kedai anda telah diluluskan! 🎉', `${s.name} kini dipaparkan di Pasar Kampus. Tambah menu anda sekarang.`, '#/seller');
    } else if (action === 'reject') {
      if (s.status !== 'PENDING') fail(400, 'Hanya permohonan yang menunggu boleh ditolak.');
      db.tx(() => {
        db.run("UPDATE shops SET status = 'REJECTED', reject_reason = ? WHERE id = ?", reason || 'Tidak memenuhi syarat', s.id);
        if (s.license_fee > 0) moveMoney(s.owner_id, s.license_fee, 'LICENSE_REFUND', `Pulangan yuran lesen – ${s.name}`, s.package);
        db.run('UPDATE shops SET license_fee = 0 WHERE id = ?', s.id);
      });
      pushBalance(s.owner_id);
      notify(s.owner_id, 'Permohonan kedai ditolak', `${reason || 'Tidak memenuhi syarat'}. Yuran ${rm(s.license_fee)} telah dipulangkan ke dompet.`, '#/seller');
    } else if (action === 'suspend') {
      db.run("UPDATE shops SET status = 'SUSPENDED', reject_reason = ? WHERE id = ?", reason || null, s.id);
      notify(s.owner_id, 'Kedai anda digantung', reason || 'Hubungi pentadbir untuk maklumat lanjut.', '#/seller');
    } else {
      if (s.status !== 'SUSPENDED') fail(400, 'Kedai tidak digantung.');
      db.run("UPDATE shops SET status = 'APPROVED', reject_reason = NULL WHERE id = ?", s.id);
      notify(s.owner_id, 'Kedai anda diaktifkan semula', '', '#/seller');
    }
    return { ok: true };
  });

  route('GET', '/api/admin/disputes', ({ user, query }) => {
    needAdmin(user);
    const status = query.get('status') || 'OPEN';
    const rows = db.all(`SELECT * FROM disputes ${status === 'ALL' ? '' : 'WHERE status = ?'} ORDER BY id DESC LIMIT 200`, ...(status === 'ALL' ? [] : [status]));
    return {
      reasons: DISPUTE_REASONS,
      disputes: rows.map((d) => ({ ...d, order: orderOut(db.one('SELECT * FROM orders WHERE id = ?', d.order_id)) }))
    };
  });

  route('POST', '/api/admin/disputes/:id/resolve', ({ user, params, body }) => {
    needAdmin(user);
    const d = db.one('SELECT * FROM disputes WHERE id = ?', Number(params.id)) || fail(404, 'Pertikaian tidak dijumpai.');
    if (d.status !== 'OPEN') fail(400, 'Pertikaian ini telah diselesaikan.');
    const o = db.one('SELECT * FROM orders WHERE id = ?', d.order_id);
    if (o.payout !== 'HELD') fail(409, 'Bayaran pesanan ini tidak lagi dipegang.');
    const outcome = oneOf(body.outcome, ['REFUND', 'RELEASE', 'SPLIT'], 'Keputusan');
    const note = text(body.note, 'Nota keputusan', { min: 5, max: 500 });
    const refund = outcome === 'REFUND' ? o.total : outcome === 'RELEASE' ? o.deposit : sen(body.refund, 'Jumlah pulangan', { min: 0, max: o.total - 1 });
    const ownerId = ownerOf(o);

    db.tx(() => {
      if (outcome === 'REFUND') {
        refundBuyer(o, o.total, ' – keputusan pertikaian');
        setOrderStatus(o, 'CANCELLED', { reason: `Pertikaian: ${note}` });
        syncListing(o, 'CANCELLED');
      } else if (outcome === 'RELEASE') {
        releaseToSeller(o, ' – keputusan pertikaian');
        setOrderStatus(o, 'COMPLETED');
      } else {
        // Commission only applies to the share the seller keeps.
        const sellerShare = o.total - refund;
        const commission = Math.round(o.commission * sellerShare / o.total);
        if (refund) moveMoney(o.user_id, refund, 'ORDER_REFUND', `Pulangan separa ${o.code} – keputusan pertikaian`, o.code);
        moveMoney(ownerId, sellerShare - commission, 'ORDER_EARN', `Hasil jualan ${o.code} – keputusan pertikaian`, o.code);
        db.run("UPDATE orders SET payout = 'RELEASED', release_at = NULL, commission = ? WHERE id = ?", commission, o.id);
        setOrderStatus(o, 'COMPLETED');
      }
      db.run("UPDATE disputes SET status = 'RESOLVED', outcome = ?, refund = ?, admin_note = ?, resolved_at = ? WHERE id = ?", outcome, refund, note, Date.now(), d.id);
    });
    pushBalance(o.user_id); pushBalance(ownerId);
    const link = `#/orders/${o.id}`;
    const toBuyer = { REFUND: `${rm(o.total)} dipulangkan sepenuhnya ke dompet anda.`, RELEASE: 'Bayaran dilepaskan kepada peniaga.', SPLIT: `${rm(refund)} dipulangkan ke dompet anda.` }[outcome];
    const toSeller = { REFUND: 'Bayaran dipulangkan kepada pembeli.', RELEASE: `${rm(sellerShare(o))} dikreditkan ke dompet anda.`, SPLIT: `Sebahagian bayaran (${rm(o.total - refund)}) dikreditkan kepada anda.` }[outcome];
    notify(o.user_id, `Keputusan laporan ${o.code}`, `${toBuyer} Nota admin: ${note}`, link);
    notify(ownerId, `Keputusan laporan ${o.code}`, `${toSeller} Nota admin: ${note}`, link);
    broadcastOrder(o);
    return { ok: true };
  });

  route('GET', '/api/admin/topups', ({ user, query }) => {
    needAdmin(user);
    const status = query.get('status') || 'PENDING';
    return { topups: db.all(`SELECT t.*, u.name, u.email, u.matric FROM topups t JOIN users u ON u.id = t.user_id ${status === 'ALL' ? '' : 'WHERE t.status = ?'} ORDER BY t.id DESC LIMIT 200`, ...(status === 'ALL' ? [] : [status])) };
  });
  route('POST', '/api/admin/topups/:id/:action', ({ user, params, body }) => {
    needAdmin(user);
    const t = db.one('SELECT * FROM topups WHERE id = ?', Number(params.id)) || fail(404, 'Permohonan tidak dijumpai.');
    if (t.status !== 'PENDING') fail(400, 'Permohonan ini telah disemak.');
    const action = oneOf(params.action, ['approve', 'reject'], 'Tindakan');
    const note = text(body.note, 'Nota', { max: 200, optional: true });
    if (action === 'approve') {
      db.tx(() => {
        db.run("UPDATE topups SET status = 'APPROVED', admin_note = ?, reviewed_at = ? WHERE id = ?", note, Date.now(), t.id);
        moveMoney(t.user_id, t.amount, 'TOPUP', `Tambah nilai (${t.method === 'BANK' ? 'pindahan bank' : 'tunai kaunter'})`, `TU${t.id}`);
      });
      pushBalance(t.user_id);
      notify(t.user_id, `Tambah nilai ${rm(t.amount)} berjaya ✅`, 'Baki dompet anda telah dikemas kini.', '#/wallet');
    } else {
      db.run("UPDATE topups SET status = 'REJECTED', admin_note = ?, reviewed_at = ? WHERE id = ?", note || 'Bayaran tidak dapat disahkan', Date.now(), t.id);
      notify(t.user_id, 'Tambah nilai ditolak', note || 'Bayaran tidak dapat disahkan. Hubungi sokongan melalui chat.', '#/wallet');
    }
    return { ok: true };
  });

  route('GET', '/api/admin/withdrawals', ({ user, query }) => {
    needAdmin(user);
    const status = query.get('status') || 'PENDING';
    return { withdrawals: db.all(`SELECT w.*, u.name, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id ${status === 'ALL' ? '' : 'WHERE w.status = ?'} ORDER BY w.id DESC LIMIT 200`, ...(status === 'ALL' ? [] : [status])) };
  });
  route('POST', '/api/admin/withdrawals/:id/:action', ({ user, params, body }) => {
    needAdmin(user);
    const w = db.one('SELECT * FROM withdrawals WHERE id = ?', Number(params.id)) || fail(404, 'Permohonan tidak dijumpai.');
    if (w.status !== 'PENDING') fail(400, 'Permohonan ini telah disemak.');
    const action = oneOf(params.action, ['paid', 'reject'], 'Tindakan');
    const note = text(body.note, 'Nota', { max: 200, optional: true });
    if (action === 'paid') {
      db.run("UPDATE withdrawals SET status = 'PAID', admin_note = ?, reviewed_at = ? WHERE id = ?", note, Date.now(), w.id);
      notify(w.user_id, `Pengeluaran ${rm(w.amount)} telah dibayar`, note ? `Rujukan: ${note}` : 'Semak akaun bank anda.', '#/wallet');
    } else {
      db.tx(() => {
        db.run("UPDATE withdrawals SET status = 'REJECTED', admin_note = ?, reviewed_at = ? WHERE id = ?", note, Date.now(), w.id);
        moveMoney(w.user_id, w.amount, 'WITHDRAW_REFUND', 'Pengeluaran ditolak – wang dipulangkan', `WD${w.id}`);
      });
      pushBalance(w.user_id);
      notify(w.user_id, 'Pengeluaran ditolak', `${note || 'Maklumat bank tidak sah'}. Wang telah dipulangkan ke dompet.`, '#/wallet');
    }
    return { ok: true };
  });

  route('GET', '/api/admin/users', ({ user, query }) => {
    needAdmin(user);
    const q = `%${String(query.get('q') || '').trim()}%`;
    return {
      users: db.all(`SELECT u.*, s.name AS shop_name FROM users u LEFT JOIN shops s ON s.owner_id = u.id
                     WHERE u.name LIKE ? OR u.email LIKE ? OR COALESCE(u.matric, '') LIKE ? ORDER BY u.id DESC LIMIT 200`, q, q, q)
        .map((u) => ({ ...publicUser(u), shop_name: u.shop_name }))
    };
  });
  route('POST', '/api/admin/users/:id/status', ({ user, params, body }) => {
    needAdmin(user);
    const target = db.one('SELECT * FROM users WHERE id = ?', Number(params.id)) || fail(404, 'Pengguna tidak dijumpai.');
    if (target.id === user.id) fail(400, 'Anda tidak boleh menukar status akaun sendiri.');
    const status = oneOf(body.status, ['active', 'suspended'], 'Status');
    db.run('UPDATE users SET status = ? WHERE id = ?', status, target.id);
    if (status === 'suspended') db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
    return { ok: true };
  });
  route('POST', '/api/admin/users/:id/credit', ({ user, params, body }) => {
    needAdmin(user);
    const target = db.one('SELECT * FROM users WHERE id = ?', Number(params.id)) || fail(404, 'Pengguna tidak dijumpai.');
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_TOPUP) fail(400, 'Jumlah tidak sah.');
    const note = text(body.note, 'Nota', { min: 3, max: 120 });
    db.tx(() => moveMoney(target.id, amount, amount > 0 ? 'TOPUP' : 'ADJUST', `${amount > 0 ? 'Tambah nilai kaunter' : 'Pelarasan'} – ${note}`, `ADM${user.id}`));
    pushBalance(target.id);
    notify(target.id, amount > 0 ? `Dompet dikreditkan ${rm(amount)}` : `Pelarasan dompet ${rm(amount)}`, note, '#/wallet');
    return { ok: true };
  });

  route('GET', '/api/admin/settings', ({ user }) => { needAdmin(user); return settingsOut(); });
  route('PUT', '/api/admin/settings', ({ user, body }) => {
    needAdmin(user);
    if (body.packages !== undefined) {
      if (!Array.isArray(body.packages) || !body.packages.length || body.packages.length > 6) fail(400, 'Senarai pakej tidak sah.');
      db.setSetting('packages', body.packages.map((p, i) => ({
        id: text(p.id || `P${i + 1}`, 'ID pakej', { max: 20 }).replace(/[^A-Za-z0-9_-]/g, ''),
        label: text(p.label, 'Nama pakej', { max: 40 }),
        price: sen(p.price, 'Harga pakej', { max: 1000000 }),
        days: sen(p.days, 'Tempoh pakej', { min: 1, max: 1000 }),
        tag: text(p.tag, 'Tag', { max: 30, optional: true }),
        blurb: text(p.blurb, 'Penerangan', { max: 120, optional: true })
      })));
    }
    if (body.commission_pct !== undefined) {
      const c = Number(body.commission_pct);
      if (!(c >= 0 && c <= 30)) fail(400, 'Komisen mesti antara 0% dan 30%.');
      db.setSetting('commission_pct', c);
    }
    if (body.topup_bank !== undefined) {
      db.setSetting('topup_bank', {
        bank: text(body.topup_bank.bank, 'Nama bank', { max: 60 }),
        account: text(body.topup_bank.account, 'No. akaun', { max: 30 }),
        name: text(body.topup_bank.name, 'Nama penerima', { max: 80 })
      });
    }
    if (body.topup_qr !== undefined) db.setSetting('topup_qr', uploadRef(body.topup_qr));
    if (body.counter_info !== undefined) db.setSetting('counter_info', text(body.counter_info, 'Info kaunter', { max: 200, optional: true }));
    if (body.announcement !== undefined) db.setSetting('announcement', text(body.announcement, 'Pengumuman', { max: 200, optional: true }));
    return settingsOut();
  });

  // ---------- dispatcher ----------
  function need(user) { if (!user) fail(401, 'Sila log masuk terlebih dahulu.'); }

  registerModules({
    db, route, need, needAdmin, notify, notifyAdmins, moveMoney, pushBalance, createOrder, orderOut, isListed, shopOut,
    conversationFor, sendMessage, cats, catEmoji, CAMPUSES, sellerRating
  });

  return { routes, need, DEFAULT_SETTINGS };
}

export const STREAMING = Symbol('streaming');
