// Domain helpers shared by the route handlers (port of src/api.js helpers).

var ACTIVE = ['PENDING', 'ACCEPTED', 'READY', 'DISPUTED'];
function isActive(status) { return ACTIVE.indexOf(status) >= 0; }
function byDesc(field) { return function (a, b) { return (b[field] || 0) - (a[field] || 0); }; }
function byAsc(field) { return function (a, b) { return (a[field] || 0) - (b[field] || 0); }; }
function pick(o, keys) { var r = {}; keys.forEach(function (k) { r[k] = o[k]; }); return r; }
function assign() {
  var out = {};
  for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; if (a) Object.keys(a).forEach(function (k) { out[k] = a[k]; }); }
  return out;
}
function withImages(row) { return row && assign(row, { images: JSON.parse(row.images || '[]') }); }

function publicUser(u) {
  return u && pick(u, ['id', 'name', 'email', 'matric', 'phone', 'campus', 'avatar', 'role', 'status', 'balance', 'created_at']);
}
function need(user) { if (!user) fail(401, 'Sila log masuk terlebih dahulu.'); }
function needAdmin(user) { need(user); if (user.role !== 'admin') fail(403, 'Akses pentadbir sahaja.'); }

// "Online" = polled within the last minute.
function isOnline(userId) { return Number(CacheService.getScriptCache().get('seen:' + userId) || 0) > Date.now() - 60e3; }

function notify(userId, title, body, link) {
  T('notifications').insert({ user_id: userId, title: title, body: body || '', link: link || null, read: 0, created_at: Date.now() });
  touch(userId);
}
function admins() { return T('users').all(function (u) { return u.role === 'admin' && u.status === 'active'; }); }
function notifyAdmins(title, body, link) { admins().forEach(function (a) { notify(a.id, title, body, link); }); }

// Positive amount credits, negative debits. The ledger row is written with it.
function moveMoney(userId, amount, type, description, ref) {
  var u = T('users').get(userId);
  if (!u) fail(404, 'Pengguna tidak dijumpai.');
  var next = u.balance + amount;
  if (next < 0) fail(400, 'Baki dompet tidak mencukupi. Baki semasa ' + rm(u.balance) + '.');
  if (amount > 0 && next > MAX_BALANCE && type === 'TOPUP') fail(400, 'Had baki dompet ialah ' + rm(MAX_BALANCE) + '.');
  T('users').update(u, { balance: next });
  T('transactions').insert({ user_id: userId, type: type, amount: amount, balance_after: next, description: description, ref: ref || null, created_at: Date.now() });
  touch(userId);
  return next;
}

function cats(kind) {
  return T('categories').all(function (c) { return c.kind === kind && c.active; })
    .sort(function (a, b) { return a.sort - b.sort || a.id - b.id; }).map(function (c) { return c.name; });
}
function catEmoji() {
  var o = {};
  T('categories').all().forEach(function (c) { o[c.name] = c.emoji; });
  return o;
}

function ratingOf(rows) {
  if (!rows.length) return { rating: 0, reviews: 0 };
  var sum = rows.reduce(function (s, r) { return s + r.rating; }, 0);
  return { rating: round1(sum / rows.length), reviews: rows.length };
}
function shopRating(shopId) { return ratingOf(T('reviews').all(function (r) { return r.shop_id === shopId; })); }
function sellerRating(userId) { return ratingOf(T('seller_reviews').all(function (r) { return r.seller_id === userId; })); }

function shopOut(s, extra) {
  return assign({
    id: s.id, owner_id: s.owner_id, name: s.name, category: s.category, campus: s.campus, description: s.description,
    image: s.image, hours: s.hours, delivery_fee: s.delivery_fee, min_order: s.min_order, allow_cash: !!s.allow_cash,
    is_open: !!s.is_open, status: s.status
  }, shopRating(s.id), extra);
}
function isListed(s) { return !!(s && s.status === 'APPROVED' && s.license_until > Date.now()); }

function orderOut(o) {
  var seller = T('users').get(o.seller_id);
  var listing = o.listing_id ? T('listings').get(o.listing_id) : null;
  var shopRow = o.shop_id ? T('shops').get(o.shop_id) : null;
  var shop = shopRow ? pick(shopRow, ['id', 'name', 'owner_id', 'campus'])
    : { id: null, name: listing ? listing.title : seller.name, owner_id: o.seller_id, campus: null };
  var vehicle = o.vehicle_id ? T('vehicles').get(o.vehicle_id) : null;
  var review = T('reviews').find(function (r) { return r.order_id === o.id; }) || T('seller_reviews').find(function (r) { return r.order_id === o.id; });
  return assign(o, {
    shop: shop,
    seller: pick(seller, ['id', 'name', 'phone']),
    listing: listing && { id: listing.id, kind: listing.kind, title: listing.title, image: JSON.parse(listing.images)[0] || null },
    vehicle: vehicle && pick(vehicle, ['id', 'model', 'plate', 'seats', 'image']),
    buyer: pick(T('users').get(o.user_id), ['id', 'name', 'phone', 'matric']),
    items: T('order_items').all(function (i) { return i.order_id === o.id; }).map(function (i) { return pick(i, ['item_id', 'title', 'price', 'qty']); }),
    events: T('order_events').all(function (e) { return e.order_id === o.id; }).sort(byAsc('id')).map(function (e) { return pick(e, ['status', 'at']); }),
    dispute: T('disputes').find(function (d) { return d.order_id === o.id; }),
    review: review ? withImages(pick(review, ['rating', 'comment', 'images', 'created_at'])) : null
  });
}

function setOrderStatus(o, status, reason) {
  var now = Date.now();
  var ch = { status: status, updated_at: now };
  if (reason) ch.cancel_reason = reason;
  T('orders').update(o, ch);
  T('order_events').insert({ order_id: o.id, status: status, at: now });
}
var ORDER_LABEL = {
  ACCEPTED: 'diterima & sedang disediakan', READY: 'sedia', COMPLETED: 'selesai',
  CANCELLED: 'dibatalkan', REJECTED: 'ditolak oleh peniaga'
};
function sellerShare(o) { return o.total - o.deposit - o.commission; }

function releaseToSeller(o, note) {
  moveMoney(o.seller_id, sellerShare(o), 'ORDER_EARN',
    'Hasil jualan ' + o.code + (o.commission ? ' (selepas komisen ' + rm(o.commission) + ')' : '') + (note || ''), o.code);
  if (o.deposit) moveMoney(o.user_id, o.deposit, 'ORDER_REFUND', 'Pulangan deposit ' + o.code, o.code);
  T('orders').update(o, { payout: 'RELEASED', release_at: null });
}
function refundBuyer(o, amount, note) {
  moveMoney(o.user_id, amount == null ? o.total : amount, 'ORDER_REFUND', 'Pulangan wang pesanan ' + o.code + (note || ''), o.code);
  T('orders').update(o, { payout: 'REFUNDED', release_at: null });
}
function broadcastOrder(o) {
  T('orders').update(o, { updated_at: Date.now() });
  touch(o.user_id);
  touch(o.seller_id);
}

// Releases seller-completed orders whose dispute window has passed (time trigger).
function sweepReleases() {
  var now = Date.now();
  T('orders').all(function (o) { return o.payout === 'HELD' && o.status === 'COMPLETED' && o.release_at != null && o.release_at <= now; })
    .forEach(function (o) {
      releaseToSeller(o, ' – dilepaskan automatik');
      notify(o.seller_id, 'Bayaran ' + o.code + ' dilepaskan 💰', rm(sellerShare(o)) + ' dikreditkan ke dompet anda.', '#/orders/' + o.id);
      if (o.deposit) notify(o.user_id, 'Deposit ' + o.code + ' dipulangkan', rm(o.deposit) + ' kembali ke dompet anda.', '#/orders/' + o.id);
    });
}

// Creates any kind of order (cart, booking, listing purchase) and holds wallet payment.
function createOrder(a) {
  var deliveryFee = a.deliveryFee || 0;
  var deposit = a.deposit || 0;
  var subtotal = a.lines.reduce(function (s, l) { return s + l.price * l.qty; }, 0);
  var total = subtotal + deliveryFee + deposit;
  var commission = a.payment === 'WALLET' ? Math.round((subtotal + deliveryFee) * (Number(getSetting('commission_pct')) || 0) / 100) : 0;
  if (a.inTx) a.inTx();
  var now = Date.now();
  var code = 'UH' + now.toString(36).toUpperCase().slice(-6) + randomToken(2).toUpperCase();
  var o = T('orders').insert({
    code: code, kind: a.kind || 'ORDER', user_id: a.buyer.id, seller_id: a.sellerId, shop_id: a.shopId || null, listing_id: a.listingId || null,
    vehicle_id: a.vehicleId || null, status: 'PENDING', payment: a.payment, fulfilment: a.fulfilment || 'PICKUP', address: a.address || '',
    note: a.note || '', subtotal: subtotal, delivery_fee: deliveryFee, deposit: deposit, total: total, commission: commission,
    payout: a.payment === 'WALLET' ? 'HELD' : 'NONE', release_at: null, start_at: a.startAt == null ? null : a.startAt,
    end_at: a.endAt == null ? null : a.endAt, pickup: a.pickup || null, dropoff: a.dropoff || null, pax: a.pax || null,
    cancel_reason: null, created_at: now, updated_at: now
  });
  a.lines.forEach(function (l) { T('order_items').insert({ order_id: o.id, item_id: l.item_id == null ? null : l.item_id, title: l.title, price: l.price, qty: l.qty }); });
  T('order_events').insert({ order_id: o.id, status: 'PENDING', at: now });
  if (a.payment === 'WALLET') moveMoney(a.buyer.id, -total, 'ORDER_PAY', 'Bayaran ' + code + ' – ' + a.label, code);
  var what = { ORDER: 'Pesanan', RIDE: 'Tempahan trip', SERVICE: 'Tempahan servis', RENTAL: 'Tempahan sewa kereta', ITEM: 'Pembelian', TICKET: 'Pembelian tiket', ROOM: 'Deposit tempahan bilik' }[o.kind] || 'Pesanan';
  notify(a.sellerId, what + ' baharu ' + code + ' 🛎️', a.buyer.name + ' – ' + rm(total) + ' (' + (a.payment === 'WALLET' ? 'Dompet' : 'Tunai') + ').', '#/orders/' + o.id);
  broadcastOrder(o);
  return o;
}

// Listing stock follows its orders: reserved on purchase, restocked on cancel, sold on completion.
function syncListing(o, next) {
  if (!o.listing_id) return;
  var l = T('listings').get(o.listing_id);
  if (!l) return;
  var qty = T('order_items').all(function (i) { return i.order_id === o.id; }).reduce(function (s, i) { return s + i.qty; }, 0);
  if (next === 'CANCELLED' || next === 'REJECTED') {
    T('listings').update(l, {
      stock: l.stock == null ? null : l.stock + qty,
      status: l.status === 'RESERVED' || l.status === 'SOLD' ? 'ACTIVE' : l.status,
      updated_at: Date.now()
    });
  } else if (next === 'COMPLETED' && l.stock === 0 && l.kind === 'ITEM') {
    T('listings').update(l, { status: 'SOLD', updated_at: Date.now() });
  } else if (next === 'COMPLETED' && l.kind === 'ROOM') {
    T('listings').update(l, { status: 'CLOSED', updated_at: Date.now() });
  }
}

function loadOrder(id, user) {
  var o = T('orders').get(Number(id));
  if (!o) fail(404, 'Pesanan tidak dijumpai.');
  var role = o.user_id === user.id ? 'buyer' : o.seller_id === user.id ? 'seller' : user.role === 'admin' ? 'admin' : null;
  if (!role) fail(404, 'Pesanan tidak dijumpai.');
  return { o: o, role: role, ownerId: o.seller_id };
}

// ---------- open-ended car rentals ----------
function rentalReturnDate(o, v) {
  var today = myToday();
  var ret = v ? myDate(v, 'Tarikh pulang') : today;
  if (ret < o.start_at) fail(400, 'Tarikh pulang tidak boleh sebelum tarikh ambil.');
  if (ret > today) fail(400, 'Tarikh pulang tidak boleh pada masa hadapan.');
  return ret;
}
// Charges the actual days used: prepaid day first, then wallet, then deposit.
function settleOpenRental(o, returnAt) {
  var line = T('order_items').find(function (i) { return i.order_id === o.id; });
  var days = Math.max(1, Math.round((returnAt - o.start_at) / DAY_MS));
  var rent = days * line.price;
  var extra = Math.max(0, rent - o.subtotal);
  var balance = T('users').get(o.user_id).balance;
  var fromWallet = Math.min(balance, extra);
  if (fromWallet) moveMoney(o.user_id, -fromWallet, 'ORDER_PAY', 'Caj sewa tambahan ' + o.code + ' (' + days + ' hari)', o.code);
  var fromDeposit = Math.min(o.deposit, extra - fromWallet);
  var unpaid = extra - fromWallet - fromDeposit;
  var subtotal = o.subtotal + fromWallet + fromDeposit;
  var pct = Number(getSetting('commission_pct')) || 0;
  T('order_items').update(line, { qty: days });
  var deposit = o.deposit - fromDeposit;
  T('orders').update(o, {
    end_at: returnAt, subtotal: subtotal, deposit: deposit, total: subtotal + deposit, commission: Math.round(subtotal * pct / 100),
    note: unpaid > 0 ? ((o.note || '') + ' [Baki sewa belum dibayar: ' + rm(unpaid) + ']').trim() : o.note
  });
  return { days: days, rent: rent, fromWallet: fromWallet, fromDeposit: fromDeposit, unpaid: unpaid };
}

// ---------- chat ----------
function conversationFor(a, b, kind) {
  kind = kind || 'direct';
  var x = Math.min(a, b);
  var y = Math.max(a, b);
  var c = T('conversations').find(function (r) { return r.user_a === x && r.user_b === y && r.kind === kind; });
  if (!c) c = T('conversations').insert({ user_a: x, user_b: y, kind: kind, last_at: Date.now() });
  return c;
}
function sendMessage(conv, senderId, body, image) {
  var now = Date.now();
  var msg = T('messages').insert({ conversation_id: conv.id, sender_id: senderId, body: body || '', image: image || null, created_at: now, read_at: null });
  T('conversations').update(conv, { last_at: now });
  touch(conv.user_a);
  touch(conv.user_b);
  return msg;
}

function settingsOut() {
  return {
    packages: getSetting('packages'), commission_pct: getSetting('commission_pct'), topup_bank: getSetting('topup_bank'),
    topup_qr: getSetting('topup_qr'), counter_info: getSetting('counter_info'), announcement: getSetting('announcement')
  };
}

// ---------- listings ----------
function listingOut(l, full) {
  var owner = T('users').get(l.user_id);
  var out = {
    id: l.id, kind: l.kind, category: l.category, title: l.title, price: l.price, negotiable: !!l.negotiable, condition: l.condition,
    campus: l.campus, location: l.location || '', images: JSON.parse(l.images || '[]'), meta: JSON.parse(l.meta || '{}'), stock: l.stock, status: l.status,
    views: l.views, created_at: l.created_at, updated_at: l.updated_at,
    owner: assign({ id: owner.id, name: owner.name, avatar: owner.avatar }, sellerRating(owner.id))
  };
  if (full) {
    out.description = l.description;
    out.reports = l.reports;
    out.removed_reason = l.removed_reason;
    out.owner = assign(out.owner, {
      campus: owner.campus, created_at: owner.created_at, online: isOnline(owner.id),
      listings: T('listings').count(function (x) { return x.user_id === owner.id && x.status === 'ACTIVE'; }),
      sold: T('orders').count(function (o) { return o.seller_id === owner.id && o.listing_id != null && o.status === 'COMPLETED'; })
    }, sellerRating(owner.id));
  }
  return out;
}
