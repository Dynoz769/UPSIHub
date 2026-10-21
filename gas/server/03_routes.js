// Core API routes (port of src/api.js). Paths match the Node server so the same UI works.

var ROUTES = [];
function route(method, pattern, handler, opts) {
  var keys = [];
  var re = new RegExp('^' + pattern.replace(/:(\w+)/g, function (_, k) { keys.push(k); return '([^/]+)'; }) + '$');
  ROUTES.push({ method: method, re: re, keys: keys, handler: handler, write: method !== 'GET' || !!(opts && opts.write) });
}

// =====================================================================
// CONFIG, SETUP & AUTH
// =====================================================================
route('GET', '/api/config', function () {
  var now = Date.now();
  return assign({
    categories: cats('shop'), market_categories: cats('market'), category_emoji: catEmoji(),
    listing_kinds: LISTING_KINDS, listing_meta: LISTING_META, campuses: CAMPUSES, dispute_reasons: DISPUTE_REASONS,
    demo: PropertiesService.getScriptProperties().getProperty('DEMO') === '1',
    platform: 'gas',
    needs_admin: admins().length === 0
  }, settingsOut(), {
    stats: {
      shops: T('shops').count(function (s) { return s.status === 'APPROVED' && s.license_until > now; }),
      users: T('users').count(),
      orders: T('orders').count(function (o) { return o.status === 'COMPLETED'; })
    }
  });
});

function startSession(userId) {
  var token = randomToken(40);
  T('sessions').insert({ token: token, user_id: userId, expires_at: Date.now() + SESSION_DAYS * DAY_MS });
  return token;
}

// First visit after deployment: the very first account becomes the administrator.
route('POST', '/api/setup/admin', function (c) {
  if (admins().length) fail(409, 'Akaun pentadbir sudah wujud.');
  var name = text(c.body.name, 'Nama', { min: 2, max: 80 });
  var email = text(c.body.email, 'E-mel', { max: 120 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'E-mel tidak sah.');
  var password = String(c.body.password || '');
  if (password.length < 8) fail(400, 'Kata laluan mesti sekurang-kurangnya 8 aksara.');
  var u = T('users').insert({ name: name, email: email, password: hashPassword(password), role: 'admin', campus: 'KSAB', balance: 0, created_at: Date.now() });
  return { user: publicUser(u), token: startSession(u.id) };
});

route('POST', '/api/auth/register', function (c) {
  if (!rateLimit('reg', 300, 3600e3)) fail(429, 'Terlalu banyak pendaftaran. Cuba lagi kemudian.');
  var b = c.body;
  var name = text(b.name, 'Nama', { min: 2, max: 80 });
  var email = text(b.email, 'E-mel', { max: 120 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'E-mel tidak sah.');
  var password = String(b.password || '');
  if (password.length < 8) fail(400, 'Kata laluan mesti sekurang-kurangnya 8 aksara.');
  var matric = text(b.matric, 'No. Matrik', { max: 30, optional: true }).toUpperCase();
  var phone = text(b.phone, 'No. Telefon', { max: 20, optional: true });
  var campus = oneOf(b.campus || 'KSAB', Object.keys(CAMPUSES), 'Kampus');
  if (T('users').find(function (u) { return u.email === email; })) fail(409, 'E-mel ini sudah didaftarkan.');
  var u = T('users').insert({ name: name, email: email, password: hashPassword(password), matric: matric || null, phone: phone || null, campus: campus, created_at: Date.now() });
  notify(u.id, 'Selamat datang ke UPSIHub! 🎉', 'Tambah nilai dompet anda untuk mula membuat pesanan tanpa tunai.', '#/wallet');
  return { user: publicUser(u), token: startSession(u.id) };
});

route('POST', '/api/auth/login', function (c) {
  var email = String(c.body.email || '').trim().toLowerCase();
  if (!rateLimit('login:' + email, 10, 900e3)) fail(429, 'Terlalu banyak cubaan log masuk. Cuba lagi dalam 15 minit.');
  var u = T('users').find(function (x) { return x.email === email; });
  if (!u || !verifyPassword(String(c.body.password || ''), u.password)) fail(401, 'E-mel atau kata laluan salah.');
  if (u.status !== 'active') fail(403, 'Akaun anda telah digantung. Hubungi pentadbir.');
  // Drop this user's expired sessions while we are here.
  var now = Date.now();
  T('sessions').remove(function (s) { return s.user_id === u.id && s.expires_at < now; });
  return { user: publicUser(u), token: startSession(u.id) };
});

route('POST', '/api/auth/logout', function (c) {
  if (c.token) T('sessions').remove(function (s) { return s.token === c.token; });
  return { ok: true };
});

route('GET', '/api/me', function (c) {
  var user = c.user;
  if (!user) return { user: null };
  var shop = T('shops').find(function (s) { return s.owner_id === user.id; });
  var convIds = {};
  T('conversations').all(function (x) { return x.user_a === user.id || x.user_b === user.id; }).forEach(function (x) { convIds[x.id] = 1; });
  return {
    user: publicUser(user),
    shop: shop ? pick(shop, ['id', 'name', 'status', 'is_open', 'license_until']) : null,
    unread: {
      chat: T('messages').count(function (m) { return convIds[m.conversation_id] && m.sender_id !== user.id && m.read_at == null; }),
      notifications: T('notifications').count(function (n) { return n.user_id === user.id && !n.read; })
    }
  };
});

route('PATCH', '/api/me', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  T('users').update(user, {
    name: text(b.name != null ? b.name : user.name, 'Nama', { min: 2, max: 80 }),
    phone: text(b.phone != null ? b.phone : user.phone, 'No. Telefon', { max: 20, optional: true }) || null,
    matric: text(b.matric != null ? b.matric : user.matric, 'No. Matrik', { max: 30, optional: true }).toUpperCase() || null,
    campus: oneOf(b.campus != null ? b.campus : user.campus, Object.keys(CAMPUSES), 'Kampus'),
    avatar: b.avatar !== undefined ? uploadRef(b.avatar) : user.avatar
  });
  return { user: publicUser(user) };
});

route('POST', '/api/me/password', function (c) {
  var user = c.user;
  need(user);
  if (!verifyPassword(String(c.body.current || ''), user.password)) fail(400, 'Kata laluan semasa salah.');
  var next = String(c.body.next || '');
  if (next.length < 8) fail(400, 'Kata laluan baharu mesti sekurang-kurangnya 8 aksara.');
  T('users').update(user, { password: hashPassword(next) });
  T('sessions').remove(function (s) { return s.user_id === user.id && s.token !== c.token; });
  return { ok: true };
});

// Photos go to the "UPSIHub Uploads" folder in the owner's Drive, shared view-only by link.
route('POST', '/api/upload', function (c) {
  need(c.user);
  if (!rateLimit('up:' + c.user.id, 60, 3600e3)) fail(429, 'Terlalu banyak muat naik. Cuba lagi kemudian.');
  var m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(c.body.data || ''));
  if (!m) fail(400, 'Format gambar tidak disokong (PNG, JPG, WEBP, GIF sahaja).');
  var bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 2 * 1024 * 1024) fail(400, 'Saiz gambar melebihi 2MB.');
  var ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  var file = uploadsFolder().createFile(Utilities.newBlob(bytes, 'image/' + m[1], randomToken(12) + '.' + ext));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // Some Google Workspace domains forbid public links; the photo then only shows to signed-in domain users.
    console.warn('Could not share upload publicly: ' + e);
  }
  return { url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1600' };
});

// Replaces the Node server's Server-Sent Events: the browser polls for anything new.
route('GET', '/api/poll', function (c) {
  var user = c.user;
  need(user);
  var cache = CacheService.getScriptCache();
  cache.put('seen:' + user.id, String(Date.now()), 21600);
  var now = Date.now();
  var since = Number(c.query.get('since')) || 0;
  if (!since) return { now: now, changed: false }; // first poll only sets the client's baseline
  var changed = Number(cache.get('chg:' + user.id) || 0);
  if (changed && changed < since) return { now: now, changed: false };
  var convIds = {};
  T('conversations').all(function (x) { return x.user_a === user.id || x.user_b === user.id; }).forEach(function (x) { convIds[x.id] = 1; });
  var reads = {};
  T('messages').all(function (m) { return convIds[m.conversation_id] && m.sender_id === user.id && m.read_at != null && m.read_at > since; })
    .forEach(function (m) { reads[m.conversation_id] = Math.max(reads[m.conversation_id] || 0, m.read_at); });
  return {
    now: now,
    changed: true,
    balance: user.balance,
    messages: T('messages').all(function (m) { return convIds[m.conversation_id] && m.created_at > since; }).sort(byAsc('id')).slice(-100),
    notifications: T('notifications').all(function (n) { return n.user_id === user.id && n.created_at > since; }).sort(byAsc('id')).slice(-50),
    orders: T('orders').all(function (o) { return (o.user_id === user.id || o.seller_id === user.id) && o.updated_at > since; })
      .map(function (o) { return { id: o.id, status: o.status, updated_at: o.updated_at }; }),
    reads: Object.keys(reads).map(function (k) { return { conversation_id: Number(k), at: reads[k] }; })
  };
});

// =====================================================================
// MARKETPLACE
// =====================================================================
route('GET', '/api/shops', function (c) {
  var q = String(c.query.get('q') || '').trim().toLowerCase();
  var campus = c.query.get('campus');
  var category = c.query.get('category');
  var sort = c.query.get('sort') || 'popular';
  var now = Date.now();
  var rows = T('shops').all(function (s) { return s.status === 'APPROVED' && s.license_until > now; });
  if (campus && campus !== 'ALL') rows = rows.filter(function (s) { return s.campus === campus; });
  if (category && category !== 'ALL') rows = rows.filter(function (s) { return s.category === category; });
  if (q) {
    var hits = {};
    T('items').all(function (i) { return i.available && ((i.title || '').toLowerCase().indexOf(q) >= 0 || (i.description || '').toLowerCase().indexOf(q) >= 0); })
      .forEach(function (i) { hits[i.shop_id] = 1; });
    rows = rows.filter(function (s) { return hits[s.id] || (s.name + ' ' + s.description + ' ' + s.category).toLowerCase().indexOf(q) >= 0; });
  }
  var out = rows.map(function (s) {
    var items = T('items').all(function (i) { return i.shop_id === s.id && i.available; });
    var min = items.length ? Math.min.apply(null, items.map(function (i) { return i.price; })) : null;
    return shopOut(s, {
      orders: T('orders').count(function (o) { return o.shop_id === s.id && o.status === 'COMPLETED'; }),
      item_count: items.length, from_price: min, created_at: s.created_at
    });
  });
  var sorters = {
    popular: function (a, b) { return (b.is_open - a.is_open) || (b.orders - a.orders); },
    rating: function (a, b) { return (b.rating - a.rating) || (b.reviews - a.reviews); },
    newest: function (a, b) { return b.created_at - a.created_at; },
    cheapest: function (a, b) { return (a.from_price == null ? 1e9 : a.from_price) - (b.from_price == null ? 1e9 : b.from_price); }
  };
  out.sort(sorters[sort] || sorters.popular);
  return { shops: out };
});

route('GET', '/api/shops/:id', function (c) {
  var s = T('shops').get(Number(c.params.id));
  var canPreview = s && c.user && (c.user.role === 'admin' || c.user.id === s.owner_id);
  if (!s || (!isListed(s) && !canPreview)) fail(404, 'Kedai tidak dijumpai atau belum aktif.');
  var owner = T('users').get(s.owner_id);
  return {
    shop: shopOut(s, {
      owner: { id: owner.id, name: owner.name, avatar: owner.avatar, online: isOnline(owner.id) },
      orders: T('orders').count(function (o) { return o.shop_id === s.id && o.status === 'COMPLETED'; })
    }),
    items: T('items').all(function (i) { return i.shop_id === s.id; })
      .sort(function (a, b) { return (b.available - a.available) || (a.id - b.id); })
      .map(function (i) { return withImages(pick(i, ['id', 'title', 'description', 'price', 'image', 'images', 'available', 'kind', 'duration_min'])); }),
    vehicles: T('vehicles').all(function (v) { return v.shop_id === s.id && v.active; }).sort(byAsc('daily_rate'))
      .map(function (v) { return withImages(pick(v, ['id', 'model', 'plate', 'seats', 'transmission', 'image', 'images', 'daily_rate', 'deposit', 'notes'])); }),
    booking_hours: s.booking_hours ? JSON.parse(s.booking_hours) : null,
    reviews: T('reviews').all(function (r) { return r.shop_id === s.id; }).sort(byDesc('created_at')).slice(0, 30)
      .map(function (r) { return withImages({ rating: r.rating, comment: r.comment, images: r.images, created_at: r.created_at, name: T('users').get(r.user_id).name }); })
  };
});

// =====================================================================
// ORDERS
// =====================================================================
route('POST', '/api/orders', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  var shop = T('shops').get(Number(b.shopId));
  if (!isListed(shop)) fail(404, 'Kedai tidak aktif.');
  if (!shop.is_open) fail(400, 'Kedai sedang tutup. Cuba lagi nanti.');
  if (shop.owner_id === user.id) fail(400, 'Anda tidak boleh membuat pesanan di kedai sendiri.');
  var payment = oneOf(b.payment, ['WALLET', 'CASH'], 'Kaedah bayaran');
  if (payment === 'CASH' && !shop.allow_cash) fail(400, 'Kedai ini hanya menerima bayaran Dompet UPSIHub.');
  var fulfilment = oneOf(b.fulfilment || 'DELIVERY', ['DELIVERY', 'PICKUP'], 'Kaedah penerimaan');
  var address = text(b.address, 'Lokasi penghantaran', { max: 200, optional: fulfilment === 'PICKUP' });
  var note = text(b.note, 'Nota', { max: 300, optional: true });
  var lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length || lines.length > 50) fail(400, 'Troli kosong.');
  var picked = lines.map(function (l) {
    var item = T('items').get(Number(l.id));
    if (!item || item.shop_id !== shop.id || !item.available) fail(400, 'Sebahagian item tidak lagi tersedia. Sila kemas kini troli.');
    return { item: item, qty: sen(l.qty, 'Kuantiti', { min: 1, max: 99 }) };
  });
  if (picked.some(function (p) { return p.item.kind !== 'PRODUCT'; })) fail(400, 'Trip & servis perlu ditempah melalui butang Tempah.');
  var subtotal = picked.reduce(function (s, p) { return s + p.item.price * p.qty; }, 0);
  if (subtotal < shop.min_order) fail(400, 'Pesanan minimum kedai ini ialah ' + rm(shop.min_order) + '.');
  var o = createOrder({
    buyer: user, sellerId: shop.owner_id, shopId: shop.id, kind: 'ORDER', payment: payment, fulfilment: fulfilment, address: address, note: note,
    deliveryFee: fulfilment === 'DELIVERY' ? shop.delivery_fee : 0,
    lines: picked.map(function (p) { return { item_id: p.item.id, title: p.item.title, price: p.item.price, qty: p.qty }; }),
    label: shop.name
  });
  return { order: orderOut(o) };
});

route('GET', '/api/orders', function (c) {
  need(c.user);
  return { orders: T('orders').all(function (o) { return o.user_id === c.user.id; }).sort(byDesc('created_at')).slice(0, 100).map(orderOut) };
});

route('GET', '/api/orders/:id', function (c) {
  need(c.user);
  var r = loadOrder(c.params.id, c.user);
  return { order: orderOut(r.o), role: r.role };
});

route('POST', '/api/orders/:id/status', function (c) {
  var user = c.user;
  need(user);
  var r = loadOrder(c.params.id, user);
  var o = r.o; var role = r.role; var ownerId = r.ownerId;
  var next = String(c.body.status || '');
  var reason = text(c.body.reason, 'Sebab', { max: 200, optional: true });
  var allowed = {
    seller: { PENDING: ['ACCEPTED', 'REJECTED'], ACCEPTED: ['READY', 'CANCELLED'], READY: ['COMPLETED', 'CANCELLED'] },
    buyer: { PENDING: ['CANCELLED'], READY: ['COMPLETED'] },
    admin: { PENDING: ['CANCELLED'], ACCEPTED: ['CANCELLED'], READY: ['CANCELLED', 'COMPLETED'] }
  };
  if ((allowed[role][o.status] || []).indexOf(next) < 0) fail(400, 'Tindakan ini tidak dibenarkan untuk status pesanan semasa.');
  var wallet = o.payment === 'WALLET';
  var holdForBuyer = wallet && next === 'COMPLETED' && role === 'seller';
  var openRental = o.kind === 'RENTAL' && o.end_at == null && next === 'COMPLETED';
  var settlement = null;
  var total0 = o.total;
  if (openRental) settlement = settleOpenRental(o, rentalReturnDate(o, role === 'seller' ? c.body.return_date : null));
  setOrderStatus(o, next, reason || null);
  syncListing(o, next);
  if (wallet) {
    if (next === 'COMPLETED') {
      if (holdForBuyer) T('orders').update(o, { release_at: Date.now() + DISPUTE_WINDOW });
      else releaseToSeller(o);
    } else if (next === 'CANCELLED' || next === 'REJECTED') {
      refundBuyer(o);
    }
  }
  if (settlement) {
    var s2 = settlement;
    notify(o.user_id, 'Sewa ' + o.code + ': ' + s2.days + ' hari', 'Jumlah sewa ' + rm(s2.rent) + '.' +
      (s2.fromWallet ? ' ' + rm(s2.fromWallet) + ' ditolak dari dompet.' : '') + (s2.fromDeposit ? ' ' + rm(s2.fromDeposit) + ' ditolak dari deposit.' : '') +
      (s2.unpaid ? ' Baki ' + rm(s2.unpaid) + ' belum dibayar – sila selesaikan dengan pemilik.' : ''), '#/orders/' + o.id);
    if (s2.unpaid) notify(ownerId, 'Baki sewa ' + o.code + ' belum dibayar', rm(s2.unpaid) + ' melebihi baki dompet & deposit penyewa. Hubungi penyewa atau admin.', '#/orders/' + o.id);
  }
  var link = '#/orders/' + o.id;
  var label = ORDER_LABEL[next];
  var refundNote = wallet && (next === 'CANCELLED' || next === 'REJECTED') ? ' ' + rm(total0) + ' telah dipulangkan ke dompet.' : '';
  var buyerNote = holdForBuyer ? 'Bayaran akan dilepaskan kepada peniaga dalam 48 jam. Ada masalah? Laporkan sebelum itu.' : '';
  if (role !== 'buyer') notify(o.user_id, 'Pesanan ' + o.code + ' ' + label, (reason ? 'Sebab: ' + reason + '. ' : '') + refundNote + buyerNote, link);
  if (role !== 'seller') notify(ownerId, 'Pesanan ' + o.code + ' ' + label, next === 'COMPLETED' && wallet ? rm(sellerShare(o)) + ' dikreditkan ke dompet anda.' : (reason ? 'Sebab: ' + reason : ''), link);
  broadcastOrder(o);
  return { order: orderOut(o) };
});

route('POST', '/api/orders/:id/review', function (c) {
  var user = c.user;
  need(user);
  var r = loadOrder(c.params.id, user);
  var o = r.o;
  if (r.role !== 'buyer') fail(403, 'Hanya pembeli boleh memberi ulasan.');
  if (o.status !== 'COMPLETED') fail(400, 'Ulasan hanya boleh diberi selepas pesanan selesai.');
  var has = function (t) { return T(t).find(function (x) { return x.order_id === o.id; }); };
  if (has('reviews') || has('seller_reviews')) fail(409, 'Anda sudah memberi ulasan untuk pesanan ini.');
  var rating = sen(c.body.rating, 'Penilaian', { min: 1, max: 5 });
  var comment = text(c.body.comment, 'Ulasan', { max: 500, optional: true });
  var images = JSON.stringify(uploadList(c.body.images, 3));
  if (o.shop_id) T('reviews').insert({ order_id: o.id, shop_id: o.shop_id, user_id: user.id, rating: rating, comment: comment, images: images, created_at: Date.now() });
  else T('seller_reviews').insert({ order_id: o.id, seller_id: o.seller_id, user_id: user.id, rating: rating, comment: comment, images: images, created_at: Date.now() });
  notify(r.ownerId, 'Ulasan baharu ' + new Array(rating + 1).join('★'), comment || user.name + ' memberi ' + rating + ' bintang.', o.shop_id ? '#/seller' : '#/u/' + o.seller_id);
  return { ok: true };
});

route('GET', '/api/users/:id', function (c) {
  var u = T('users').get(Number(c.params.id));
  if (!u || u.status !== 'active') fail(404, 'Pengguna tidak dijumpai.');
  return {
    user: assign(pick(u, ['id', 'name', 'avatar', 'campus', 'created_at']), { online: isOnline(u.id) }, sellerRating(u.id), {
      sold: T('orders').count(function (o) { return o.seller_id === u.id && o.listing_id != null && o.status === 'COMPLETED'; })
    }),
    reviews: T('seller_reviews').all(function (r) { return r.seller_id === u.id; }).sort(byDesc('created_at')).slice(0, 30).map(function (r) {
      var o = T('orders').get(r.order_id);
      var l = o && o.listing_id ? T('listings').get(o.listing_id) : null;
      return withImages({ rating: r.rating, comment: r.comment, images: r.images, created_at: r.created_at, name: T('users').get(r.user_id).name, title: l ? l.title : null });
    })
  };
});

route('POST', '/api/orders/:id/confirm', function (c) {
  need(c.user);
  var r = loadOrder(c.params.id, c.user);
  var o = r.o;
  if (r.role !== 'buyer') fail(403, 'Hanya pembeli boleh mengesahkan penerimaan.');
  if (o.status !== 'COMPLETED' || o.payout !== 'HELD') fail(400, 'Tiada bayaran yang sedang dipegang untuk pesanan ini.');
  releaseToSeller(o, ' – disahkan pembeli');
  notify(r.ownerId, 'Pembeli mengesahkan pesanan ' + o.code + ' ✅', rm(sellerShare(o)) + ' dikreditkan ke dompet anda.', '#/orders/' + o.id);
  broadcastOrder(o);
  return { order: orderOut(o) };
});

// =====================================================================
// DISPUTES
// =====================================================================
route('POST', '/api/orders/:id/dispute', function (c) {
  var user = c.user;
  need(user);
  var r = loadOrder(c.params.id, user);
  var o = r.o;
  if (r.role !== 'buyer') fail(403, 'Hanya pembeli boleh melaporkan masalah.');
  if (T('disputes').find(function (d) { return d.order_id === o.id; })) fail(409, 'Laporan untuk pesanan ini sudah dihantar.');
  if (o.payment !== 'WALLET') fail(400, 'Pesanan tunai tidak dilindungi. Sila hubungi sokongan melalui chat.');
  if (o.payout !== 'HELD' || ['ACCEPTED', 'READY', 'COMPLETED'].indexOf(o.status) < 0) {
    fail(400, o.payout === 'RELEASED' ? 'Bayaran telah dilepaskan kepada peniaga. Hubungi sokongan melalui chat.' : 'Pesanan ini tidak boleh dipertikaikan.');
  }
  var reason = oneOf(c.body.reason, Object.keys(DISPUTE_REASONS), 'Sebab');
  var details = text(c.body.details, 'Butiran', { min: 10, max: 1000 });
  var evidence = uploadRef(c.body.evidence);
  T('disputes').insert({ order_id: o.id, user_id: user.id, reason: reason, details: details, evidence: evidence, prev_status: o.status, status: 'OPEN', created_at: Date.now() });
  setOrderStatus(o, 'DISPUTED');
  T('orders').update(o, { release_at: null });
  var link = '#/orders/' + o.id;
  notify(r.ownerId, '⚠️ Pesanan ' + o.code + ' dilaporkan', DISPUTE_REASONS[reason] + '. Bayaran ' + rm(o.total) + ' dibekukan. Beri penjelasan anda kepada admin.', link);
  notifyAdmins('Pertikaian baharu', o.code + ' – ' + DISPUTE_REASONS[reason] + ' (' + rm(o.total) + ')', '#/admin/disputes');
  broadcastOrder(o);
  return { order: orderOut(o) };
});

route('POST', '/api/orders/:id/dispute/respond', function (c) {
  need(c.user);
  var r = loadOrder(c.params.id, c.user);
  var o = r.o;
  if (r.role !== 'seller') fail(403, 'Hanya peniaga boleh memberi penjelasan.');
  var d = T('disputes').find(function (x) { return x.order_id === o.id && x.status === 'OPEN'; }) || fail(404, 'Tiada pertikaian aktif.');
  var response = text(c.body.response, 'Penjelasan', { min: 10, max: 1000 });
  var evidence = uploadRef(c.body.evidence);
  T('disputes').update(d, { seller_response: response, seller_evidence: evidence || d.seller_evidence });
  notifyAdmins('Peniaga membalas pertikaian', o.code + ': ' + response.slice(0, 80), '#/admin/disputes');
  notify(o.user_id, 'Peniaga membalas laporan ' + o.code, response.slice(0, 120), '#/orders/' + o.id);
  broadcastOrder(o);
  return { ok: true };
});

// =====================================================================
// SELLER CENTRE
// =====================================================================
function myShop(user) { return T('shops').find(function (s) { return s.owner_id === user.id; }); }
function needShop(user) { return myShop(user) || fail(404, 'Anda belum mendaftar kedai.'); }
function val(a, b) { return a !== undefined && a !== null ? a : b; }

function bookingHours(v) {
  if (v == null || v === '') return null;
  var days = Array.isArray(v.days) ? v.days.map(Number).filter(function (d, i, arr) { return d >= 0 && d <= 6 && arr.indexOf(d) === i; }) : [];
  var hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!days.length || !hhmm.test(v.start) || !hhmm.test(v.end) || v.start >= v.end) fail(400, 'Waktu tempahan tidak sah.');
  return JSON.stringify({ days: days.sort(), start: v.start, end: v.end });
}
function shopFields(b, base) {
  base = base || {};
  return {
    name: text(val(b.name, base.name), 'Nama kedai', { min: 3, max: 80 }),
    category: oneOf(val(b.category, base.category), cats('shop'), 'Kategori'),
    campus: oneOf(val(b.campus, base.campus), Object.keys(CAMPUSES), 'Kampus'),
    description: text(val(b.description, base.description), 'Penerangan', { min: 10, max: 600 }),
    image: b.image !== undefined ? uploadRef(b.image) : val(base.image, null),
    hours: text(val(b.hours, base.hours), 'Waktu operasi', { max: 80, optional: true }),
    delivery_fee: sen(val(b.delivery_fee, val(base.delivery_fee, 0)), 'Caj penghantaran', { max: 5000 }),
    min_order: sen(val(b.min_order, val(base.min_order, 0)), 'Pesanan minimum', { max: 100000 }),
    allow_cash: b.allow_cash !== undefined ? (b.allow_cash ? 1 : 0) : val(base.allow_cash, 1),
    booking_hours: b.booking_hours !== undefined ? bookingHours(b.booking_hours) : val(base.booking_hours, null)
  };
}
function pkgById(id) {
  return getSetting('packages').filter(function (p) { return p.id === id; })[0] || fail(400, 'Pakej tidak sah.');
}

route('GET', '/api/seller', function (c) {
  need(c.user);
  var s = myShop(c.user);
  if (!s) return { shop: null };
  var dayStart = myToday();
  var done = T('orders').all(function (o) { return o.shop_id === s.id && o.status === 'COMPLETED'; });
  var sum = function (rows) { return { n: rows.length, total: rows.reduce(function (t, o) { return t + o.total - o.commission; }, 0) }; };
  var weekAgo = Date.now() - 7 * DAY_MS;
  var byDay = {};
  done.filter(function (o) { return o.created_at >= weekAgo; }).forEach(function (o) {
    var d = myYmd(o.created_at);
    byDay[d] = byDay[d] || { day: d, n: 0, total: 0 };
    byDay[d].n += 1;
    byDay[d].total += o.total - o.commission;
  });
  return {
    shop: assign(shopOut(s), { package: s.package, license_until: s.license_until, license_fee: s.license_fee, reject_reason: s.reject_reason, created_at: s.created_at, booking_hours: s.booking_hours ? JSON.parse(s.booking_hours) : null }),
    items: T('items').all(function (i) { return i.shop_id === s.id; }).sort(byAsc('id')).map(withImages),
    vehicles: T('vehicles').all(function (v) { return v.shop_id === s.id; }).sort(byAsc('id')).map(withImages),
    stats: {
      today: sum(done.filter(function (o) { return o.created_at >= dayStart; })),
      all: sum(done),
      active: T('orders').count(function (o) { return o.shop_id === s.id && isActive(o.status); }),
      pending: T('orders').count(function (o) { return o.shop_id === s.id && o.status === 'PENDING'; }),
      last7: Object.keys(byDay).sort().map(function (k) { return byDay[k]; })
    }
  };
});

route('POST', '/api/seller/apply', function (c) {
  var user = c.user;
  need(user);
  if (user.role === 'admin') fail(400, 'Akaun pentadbir tidak boleh membuka kedai.');
  var existing = myShop(user);
  if (existing && existing.status !== 'REJECTED') fail(409, 'Anda sudah mempunyai kedai berdaftar.');
  var f = shopFields(c.body, existing || {});
  var pkg = pkgById(c.body.package);
  var fields = { name: f.name, category: f.category, campus: f.campus, description: f.description, image: f.image, hours: f.hours,
    delivery_fee: f.delivery_fee, min_order: f.min_order, allow_cash: f.allow_cash, status: 'PENDING', reject_reason: null, package: pkg.id, license_fee: pkg.price };
  if (existing) T('shops').update(existing, fields);
  else T('shops').insert(assign(fields, { owner_id: user.id, is_open: 1, created_at: Date.now() }));
  if (pkg.price > 0) moveMoney(user.id, -pkg.price, 'LICENSE_FEE', 'Yuran lesen peniaga – pakej ' + pkg.label, pkg.id);
  notifyAdmins('Permohonan kedai baharu', f.name + ' (' + f.category + ') – yuran ' + rm(pkg.price) + ' telah dibayar melalui dompet.', '#/admin/shops');
  return { ok: true };
});

route('POST', '/api/seller/renew', function (c) {
  var user = c.user;
  need(user);
  var s = needShop(user);
  if (s.status !== 'APPROVED') fail(400, 'Hanya kedai yang diluluskan boleh memperbaharui lesen.');
  var pkg = pkgById(c.body.package);
  moveMoney(user.id, -pkg.price, 'LICENSE_FEE', 'Pembaharuan lesen – pakej ' + pkg.label, pkg.id);
  var until = Math.max(Date.now(), s.license_until || 0) + pkg.days * DAY_MS;
  T('shops').update(s, { package: pkg.id, license_fee: s.license_fee + pkg.price, license_until: until });
  notify(user.id, 'Lesen diperbaharui ✅', 'Pakej ' + pkg.label + ' aktif sehingga ' + myYmd(until) + '.', '#/seller/license');
  return { ok: true };
});

route('PATCH', '/api/seller/shop', function (c) {
  need(c.user);
  var s = needShop(c.user);
  var b = c.body;
  if (b.is_open !== undefined && Object.keys(b).length === 1) {
    T('shops').update(s, { is_open: b.is_open ? 1 : 0 });
    return { ok: true };
  }
  var f = shopFields(b, s);
  if (b.is_open !== undefined) f.is_open = b.is_open ? 1 : 0;
  T('shops').update(s, f);
  return { ok: true };
});

function itemFields(b, base) {
  base = base || {};
  var images = b.images !== undefined ? uploadList(b.images) : base.images ? JSON.parse(base.images) : (base.image ? [base.image] : []);
  var f = {
    title: text(val(b.title, base.title), 'Nama item', { min: 2, max: 100 }),
    description: text(val(b.description, base.description), 'Penerangan', { max: 300, optional: true }),
    price: sen(val(b.price, base.price), 'Harga', { min: 1, max: 1000000 }),
    images: JSON.stringify(images),
    image: images[0] || null,
    available: b.available !== undefined ? (b.available ? 1 : 0) : val(base.available, 1),
    kind: oneOf(val(b.kind, val(base.kind, 'PRODUCT')), ['PRODUCT', 'ROUTE', 'SERVICE'], 'Jenis item'),
    duration_min: null
  };
  if (f.kind === 'SERVICE') f.duration_min = sen(val(b.duration_min, base.duration_min), 'Tempoh servis (minit)', { min: 15, max: 480 });
  return f;
}
route('POST', '/api/seller/items', function (c) {
  need(c.user);
  var s = needShop(c.user);
  if (T('items').count(function (i) { return i.shop_id === s.id; }) >= 200) fail(400, 'Had maksimum 200 item.');
  var it = T('items').insert(assign(itemFields(c.body), { shop_id: s.id, created_at: Date.now() }));
  return { item: withImages(it) };
});
route('PATCH', '/api/seller/items/:id', function (c) {
  need(c.user);
  var s = needShop(c.user);
  var it = T('items').get(Number(c.params.id));
  if (!it || it.shop_id !== s.id) fail(404, 'Item tidak dijumpai.');
  T('items').update(it, itemFields(c.body, it));
  return { item: withImages(it) };
});
route('DELETE', '/api/seller/items/:id', function (c) {
  need(c.user);
  var s = needShop(c.user);
  var id = Number(c.params.id);
  T('items').remove(function (i) { return i.id === id && i.shop_id === s.id; });
  return { ok: true };
});

route('GET', '/api/seller/orders', function (c) {
  need(c.user);
  var s = needShop(c.user);
  var filter = c.query.get('status') || 'ACTIVE';
  var pred = filter === 'ACTIVE' ? isActive
    : filter === 'DONE' ? function (st) { return ['COMPLETED', 'CANCELLED', 'REJECTED'].indexOf(st) >= 0; } : function () { return true; };
  return { orders: T('orders').all(function (o) { return o.shop_id === s.id && pred(o.status); }).sort(byDesc('created_at')).slice(0, 200).map(orderOut) };
});

// =====================================================================
// WALLET
// =====================================================================
route('GET', '/api/wallet', function (c) {
  need(c.user);
  var uid = c.user.id;
  var mine = function (r) { return r.user_id === uid; };
  return {
    balance: c.user.balance,
    transactions: T('transactions').all(mine).sort(byDesc('id')).slice(0, 100),
    topups: T('topups').all(mine).sort(byDesc('id')).slice(0, 20),
    withdrawals: T('withdrawals').all(mine).sort(byDesc('id')).slice(0, 20)
  };
});

route('POST', '/api/wallet/topup', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  var amount = sen(b.amount, 'Jumlah tambah nilai', { min: 100, max: MAX_TOPUP });
  var method = oneOf(b.method, ['BANK', 'COUNTER'], 'Kaedah');
  var reference = text(b.reference, 'No. rujukan', { max: 60, optional: method === 'COUNTER' });
  var receipt = uploadRef(b.receipt);
  if (method === 'BANK' && !receipt && !reference) fail(400, 'Sila sertakan no. rujukan atau resit pindahan.');
  if (T('topups').count(function (t) { return t.user_id === user.id && t.status === 'PENDING'; }) >= 3) fail(400, 'Anda mempunyai 3 permohonan tambah nilai yang belum disemak.');
  T('topups').insert({ user_id: user.id, amount: amount, method: method, reference: reference, receipt: receipt, status: 'PENDING', created_at: Date.now() });
  notifyAdmins('Permohonan tambah nilai', user.name + ' – ' + rm(amount) + ' (' + (method === 'BANK' ? 'Pindahan bank' : 'Tunai di kaunter') + ')', '#/admin/topups');
  return { ok: true };
});

route('POST', '/api/wallet/transfer', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  if (!rateLimit('xfer:' + user.id, 20, 3600e3)) fail(429, 'Terlalu banyak pindahan. Cuba lagi kemudian.');
  var to = String(b.to || '').trim();
  var target = T('users').find(function (u) { return u.status === 'active' && (u.email === to.toLowerCase() || (u.matric && u.matric.toUpperCase() === to.toUpperCase())); });
  if (!target) fail(404, 'Penerima tidak dijumpai. Masukkan e-mel atau no. matrik yang tepat.');
  if (target.id === user.id) fail(400, 'Anda tidak boleh memindahkan wang kepada diri sendiri.');
  var amount = sen(b.amount, 'Jumlah', { min: 10, max: MAX_BALANCE });
  var note = text(b.note, 'Nota', { max: 100, optional: true });
  if (!verifyPassword(String(b.password || ''), user.password)) fail(400, 'Kata laluan salah. Pindahan dibatalkan.');
  var ref = 'TRF' + Date.now().toString(36).toUpperCase();
  moveMoney(user.id, -amount, 'TRANSFER_OUT', 'Pindahan kepada ' + target.name + (note ? ' – ' + note : ''), ref);
  moveMoney(target.id, amount, 'TRANSFER_IN', 'Diterima daripada ' + user.name + (note ? ' – ' + note : ''), ref);
  notify(target.id, 'Anda menerima ' + rm(amount) + ' 💸', 'Daripada ' + user.name + (note ? ': ' + note : ''), '#/wallet');
  return { ok: true, to: target.name };
});

route('POST', '/api/wallet/withdraw', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  var amount = sen(b.amount, 'Jumlah', { min: 1000, max: MAX_BALANCE });
  var bankName = text(b.bank_name, 'Nama bank', { max: 60 });
  var accountNo = text(b.account_no, 'No. akaun', { min: 6, max: 30 });
  var accountName = text(b.account_name, 'Nama pemegang akaun', { max: 80 });
  if (!verifyPassword(String(b.password || ''), user.password)) fail(400, 'Kata laluan salah.');
  var w = T('withdrawals').insert({ user_id: user.id, amount: amount, bank_name: bankName, account_no: accountNo, account_name: accountName, status: 'PENDING', created_at: Date.now() });
  moveMoney(user.id, -amount, 'WITHDRAW', 'Pengeluaran ke ' + bankName + ' ••' + accountNo.slice(-4), 'WD' + w.id);
  notifyAdmins('Permohonan pengeluaran', user.name + ' – ' + rm(amount) + ' ke ' + bankName, '#/admin/withdrawals');
  return { ok: true };
});

// =====================================================================
// CHAT
// =====================================================================
function convOut(cv, me) {
  var otherId = cv.user_a === me ? cv.user_b : cv.user_a;
  var other = T('users').get(otherId);
  var shop = T('shops').find(function (s) { return s.owner_id === otherId; });
  var msgs = T('messages').all(function (m) { return m.conversation_id === cv.id; });
  var last = msgs.length ? msgs.reduce(function (a, b) { return b.id > a.id ? b : a; }) : null;
  return {
    id: cv.id, kind: cv.kind, last_at: cv.last_at,
    other: assign(pick(other, ['id', 'name', 'avatar', 'role']), { online: isOnline(otherId) }),
    shop: shop ? { id: shop.id, name: shop.name } : null,
    last: last ? pick(last, ['body', 'image', 'sender_id', 'created_at']) : null,
    unread: msgs.filter(function (m) { return m.sender_id !== me && m.read_at == null; }).length
  };
}
function loadConv(id, user) {
  var cv = T('conversations').get(Number(id));
  if (!cv || (cv.user_a !== user.id && cv.user_b !== user.id)) fail(404, 'Perbualan tidak dijumpai.');
  return cv;
}

route('GET', '/api/chats', function (c) {
  need(c.user);
  var me = c.user.id;
  return { chats: T('conversations').all(function (x) { return x.user_a === me || x.user_b === me; }).sort(byDesc('last_at')).slice(0, 100).map(function (x) { return convOut(x, me); }) };
});

route('POST', '/api/chats', function (c) {
  var user = c.user; var b = c.body;
  need(user);
  var otherId;
  var kind = 'direct';
  if (b.support) {
    var admin = T('users').all(function (u) { return u.role === 'admin' && u.status === 'active' && u.id !== user.id; }).sort(byAsc('id'))[0];
    if (!admin) fail(404, 'Tiada pentadbir tersedia.');
    otherId = admin.id;
    kind = 'support';
  } else if (b.shopId) {
    var s = T('shops').get(Number(b.shopId)) || fail(404, 'Kedai tidak dijumpai.');
    otherId = s.owner_id;
  } else if (b.listingId) {
    var l = T('listings').get(Number(b.listingId));
    if (!l || l.status === 'REMOVED') fail(404, 'Iklan tidak dijumpai.');
    otherId = l.user_id;
  } else if (b.orderId) {
    var r = loadOrder(b.orderId, user);
    otherId = r.o.user_id === user.id ? r.ownerId : r.o.user_id;
  } else if (b.userId && user.role === 'admin') {
    otherId = Number(b.userId);
    kind = 'support';
  } else fail(400, 'Penerima tidak dinyatakan.');
  if (otherId === user.id) fail(400, 'Anda tidak boleh berbual dengan diri sendiri.');
  if (!T('users').get(otherId)) fail(404, 'Pengguna tidak dijumpai.');
  var cv = conversationFor(user.id, otherId, kind);
  if (b.listingId) {
    var ref = 'Berkenaan iklan: ' + T('listings').get(Number(b.listingId)).title;
    if (!T('messages').find(function (m) { return m.conversation_id === cv.id && m.body === ref; })) sendMessage(cv, user.id, ref, null);
  }
  if (b.orderId) {
    var code = T('orders').get(Number(b.orderId)).code;
    if (!T('messages').find(function (m) { return m.conversation_id === cv.id && (m.body || '').indexOf(code) >= 0; })) sendMessage(cv, user.id, 'Berkenaan pesanan #' + code, null);
  }
  return { chat: convOut(cv, user.id) };
});

route('GET', '/api/chats/:id/messages', function (c) {
  need(c.user);
  var cv = loadConv(c.params.id, c.user);
  var before = Number(c.query.get('before')) || Number.MAX_SAFE_INTEGER;
  var rows = T('messages').all(function (m) { return m.conversation_id === cv.id && m.id < before; }).sort(byAsc('id')).slice(-60);
  return { chat: convOut(cv, c.user.id), messages: rows };
});

route('POST', '/api/chats/:id/messages', function (c) {
  var user = c.user;
  need(user);
  if (!rateLimit('msg:' + user.id, 60, 60e3)) fail(429, 'Anda menghantar mesej terlalu pantas.');
  var cv = loadConv(c.params.id, user);
  var image = uploadRef(c.body.image);
  var body = text(c.body.body, 'Mesej', { max: 2000, optional: !!image });
  var msg = sendMessage(cv, user.id, body, image);
  var otherId = cv.user_a === user.id ? cv.user_b : cv.user_a;
  if (!isOnline(otherId)) {
    var link = '#/chat/' + cv.id;
    if (!T('notifications').find(function (n) { return n.user_id === otherId && n.link === link && !n.read; })) {
      notify(otherId, 'Mesej baharu daripada ' + user.name, body ? body.slice(0, 80) : '📷 Gambar', link);
    }
  }
  return { message: msg };
});

route('POST', '/api/chats/:id/read', function (c) {
  need(c.user);
  var cv = loadConv(c.params.id, c.user);
  var now = Date.now();
  T('messages').all(function (m) { return m.conversation_id === cv.id && m.sender_id !== c.user.id && m.read_at == null; })
    .forEach(function (m) { T('messages').update(m, { read_at: now }); });
  touch(cv.user_a === c.user.id ? cv.user_b : cv.user_a);
  return { ok: true };
});

// =====================================================================
// NOTIFICATIONS
// =====================================================================
route('GET', '/api/notifications', function (c) {
  need(c.user);
  return { notifications: T('notifications').all(function (n) { return n.user_id === c.user.id; }).sort(byDesc('id')).slice(0, 50) };
});
route('POST', '/api/notifications/read', function (c) {
  need(c.user);
  var id = Number(c.body.id) || null;
  T('notifications').all(function (n) { return n.user_id === c.user.id && !n.read && (!id || n.id === id); })
    .forEach(function (n) { T('notifications').update(n, { read: 1 }); });
  return { ok: true };
});
