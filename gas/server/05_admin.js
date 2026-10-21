// Admin routes (port of the admin part of src/api.js).

route('GET', '/api/admin/overview', function (c) {
  needAdmin(c.user);
  var O = T('orders');
  var cnt = function (t, pred) { return T(t).count(pred); };
  var licence = T('transactions').all(function (t) { return t.type === 'LICENSE_FEE' || t.type === 'LICENSE_REFUND'; }).reduce(function (s, t) { return s - t.amount; }, 0);
  var commission = O.all(function (o) { return o.status === 'COMPLETED' && o.payout === 'RELEASED'; }).reduce(function (s, o) { return s + o.commission; }, 0);
  var completed = O.all(function (o) { return o.status === 'COMPLETED'; });
  return {
    revenue: { licence: licence, commission: commission, total: licence + commission },
    users: cnt('users'),
    shops: cnt('shops', function (s) { return s.status === 'APPROVED'; }),
    pending: {
      shops: cnt('shops', function (s) { return s.status === 'PENDING'; }),
      topups: cnt('topups', function (t) { return t.status === 'PENDING'; }),
      withdrawals: cnt('withdrawals', function (w) { return w.status === 'PENDING'; }),
      disputes: cnt('disputes', function (d) { return d.status === 'OPEN'; }),
      listings: cnt('listings', function (l) { return l.reports > 0 && l.status !== 'REMOVED'; })
    },
    orders: { total: O.count(), completed: completed.length, gmv: completed.reduce(function (s, o) { return s + o.total; }, 0) },
    float: T('users').all().reduce(function (s, u) { return s + u.balance; }, 0),
    recent: O.all().sort(byDesc('id')).slice(0, 8).map(function (o) {
      var s = o.shop_id ? T('shops').get(o.shop_id) : null;
      var l = o.listing_id ? T('listings').get(o.listing_id) : null;
      return {
        id: o.id, code: o.code, kind: o.kind, total: o.total, status: o.status, payment: o.payment, created_at: o.created_at,
        shop: s ? s.name : l ? l.title : T('users').get(o.seller_id).name, buyer: T('users').get(o.user_id).name
      };
    })
  };
});

route('GET', '/api/admin/shops', function (c) {
  needAdmin(c.user);
  return {
    shops: T('shops').all().sort(function (a, b) { return ((a.status === 'PENDING' ? 0 : 1) - (b.status === 'PENDING' ? 0 : 1)) || (b.created_at - a.created_at); })
      .map(function (s) { var u = T('users').get(s.owner_id); return assign(s, { owner_name: u.name, owner_email: u.email, owner_phone: u.phone }, shopRating(s.id)); })
  };
});
route('POST', '/api/admin/shops/:id/:action', function (c) {
  needAdmin(c.user);
  var s = T('shops').get(Number(c.params.id)) || fail(404, 'Kedai tidak dijumpai.');
  var action = oneOf(c.params.action, ['approve', 'reject', 'suspend', 'restore'], 'Tindakan');
  var reason = text(c.body.reason, 'Sebab', { max: 200, optional: true });
  if (action === 'approve') {
    if (s.status !== 'PENDING') fail(400, 'Hanya permohonan yang menunggu boleh diluluskan.');
    var pkg = getSetting('packages').filter(function (p) { return p.id === s.package; })[0] || { days: 30, label: s.package };
    T('shops').update(s, { status: 'APPROVED', reject_reason: null, license_until: Date.now() + pkg.days * DAY_MS });
    notify(s.owner_id, 'Kedai anda telah diluluskan! 🎉', s.name + ' kini dipaparkan di Pasar Kampus. Tambah menu anda sekarang.', '#/seller');
  } else if (action === 'reject') {
    if (s.status !== 'PENDING') fail(400, 'Hanya permohonan yang menunggu boleh ditolak.');
    var fee = s.license_fee;
    T('shops').update(s, { status: 'REJECTED', reject_reason: reason || 'Tidak memenuhi syarat', license_fee: 0 });
    if (fee > 0) moveMoney(s.owner_id, fee, 'LICENSE_REFUND', 'Pulangan yuran lesen – ' + s.name, s.package);
    notify(s.owner_id, 'Permohonan kedai ditolak', (reason || 'Tidak memenuhi syarat') + '. Yuran ' + rm(fee) + ' telah dipulangkan ke dompet.', '#/seller');
  } else if (action === 'suspend') {
    T('shops').update(s, { status: 'SUSPENDED', reject_reason: reason || null });
    notify(s.owner_id, 'Kedai anda digantung', reason || 'Hubungi pentadbir untuk maklumat lanjut.', '#/seller');
  } else {
    if (s.status !== 'SUSPENDED') fail(400, 'Kedai tidak digantung.');
    T('shops').update(s, { status: 'APPROVED', reject_reason: null });
    notify(s.owner_id, 'Kedai anda diaktifkan semula', '', '#/seller');
  }
  return { ok: true };
});

route('GET', '/api/admin/disputes', function (c) {
  needAdmin(c.user);
  var status = c.query.get('status') || 'OPEN';
  return {
    reasons: DISPUTE_REASONS,
    disputes: T('disputes').all(function (d) { return status === 'ALL' || d.status === status; }).sort(byDesc('id')).slice(0, 200)
      .map(function (d) { return assign(d, { order: orderOut(T('orders').get(d.order_id)) }); })
  };
});
route('POST', '/api/admin/disputes/:id/resolve', function (c) {
  needAdmin(c.user);
  var d = T('disputes').get(Number(c.params.id)) || fail(404, 'Pertikaian tidak dijumpai.');
  if (d.status !== 'OPEN') fail(400, 'Pertikaian ini telah diselesaikan.');
  var o = T('orders').get(d.order_id);
  if (o.payout !== 'HELD') fail(409, 'Bayaran pesanan ini tidak lagi dipegang.');
  var outcome = oneOf(c.body.outcome, ['REFUND', 'RELEASE', 'SPLIT'], 'Keputusan');
  var note = text(c.body.note, 'Nota keputusan', { min: 5, max: 500 });
  var refund = outcome === 'REFUND' ? o.total : outcome === 'RELEASE' ? o.deposit : sen(c.body.refund, 'Jumlah pulangan', { min: 0, max: o.total - 1 });
  var ownerId = o.seller_id;
  var released = sellerShare(o);
  if (outcome === 'REFUND') {
    refundBuyer(o, o.total, ' – keputusan pertikaian');
    setOrderStatus(o, 'CANCELLED', 'Pertikaian: ' + note);
    syncListing(o, 'CANCELLED');
  } else if (outcome === 'RELEASE') {
    releaseToSeller(o, ' – keputusan pertikaian');
    setOrderStatus(o, 'COMPLETED');
  } else {
    var share = o.total - refund;
    var commission = Math.round(o.commission * share / o.total);
    if (refund) moveMoney(o.user_id, refund, 'ORDER_REFUND', 'Pulangan separa ' + o.code + ' – keputusan pertikaian', o.code);
    moveMoney(ownerId, share - commission, 'ORDER_EARN', 'Hasil jualan ' + o.code + ' – keputusan pertikaian', o.code);
    T('orders').update(o, { payout: 'RELEASED', release_at: null, commission: commission });
    setOrderStatus(o, 'COMPLETED');
  }
  T('disputes').update(d, { status: 'RESOLVED', outcome: outcome, refund: refund, admin_note: note, resolved_at: Date.now() });
  var link = '#/orders/' + o.id;
  var toBuyer = { REFUND: rm(o.total) + ' dipulangkan sepenuhnya ke dompet anda.', RELEASE: 'Bayaran dilepaskan kepada peniaga.', SPLIT: rm(refund) + ' dipulangkan ke dompet anda.' }[outcome];
  var toSeller = { REFUND: 'Bayaran dipulangkan kepada pembeli.', RELEASE: rm(released) + ' dikreditkan ke dompet anda.', SPLIT: 'Sebahagian bayaran (' + rm(o.total - refund) + ') dikreditkan kepada anda.' }[outcome];
  notify(o.user_id, 'Keputusan laporan ' + o.code, toBuyer + ' Nota admin: ' + note, link);
  notify(ownerId, 'Keputusan laporan ' + o.code, toSeller + ' Nota admin: ' + note, link);
  broadcastOrder(o);
  return { ok: true };
});

function withUser(r, fields) {
  var u = T('users').get(r.user_id);
  var extra = {};
  fields.forEach(function (f) { extra[f] = u ? u[f] : null; });
  return assign(r, extra);
}
route('GET', '/api/admin/topups', function (c) {
  needAdmin(c.user);
  var status = c.query.get('status') || 'PENDING';
  return { topups: T('topups').all(function (t) { return status === 'ALL' || t.status === status; }).sort(byDesc('id')).slice(0, 200).map(function (t) { return withUser(t, ['name', 'email', 'matric']); }) };
});
route('POST', '/api/admin/topups/:id/:action', function (c) {
  needAdmin(c.user);
  var t = T('topups').get(Number(c.params.id)) || fail(404, 'Permohonan tidak dijumpai.');
  if (t.status !== 'PENDING') fail(400, 'Permohonan ini telah disemak.');
  var action = oneOf(c.params.action, ['approve', 'reject'], 'Tindakan');
  var note = text(c.body.note, 'Nota', { max: 200, optional: true });
  if (action === 'approve') {
    T('topups').update(t, { status: 'APPROVED', admin_note: note || null, reviewed_at: Date.now() });
    moveMoney(t.user_id, t.amount, 'TOPUP', 'Tambah nilai (' + (t.method === 'BANK' ? 'pindahan bank' : 'tunai kaunter') + ')', 'TU' + t.id);
    notify(t.user_id, 'Tambah nilai ' + rm(t.amount) + ' berjaya ✅', 'Baki dompet anda telah dikemas kini.', '#/wallet');
  } else {
    T('topups').update(t, { status: 'REJECTED', admin_note: note || 'Bayaran tidak dapat disahkan', reviewed_at: Date.now() });
    notify(t.user_id, 'Tambah nilai ditolak', note || 'Bayaran tidak dapat disahkan. Hubungi sokongan melalui chat.', '#/wallet');
  }
  return { ok: true };
});

route('GET', '/api/admin/withdrawals', function (c) {
  needAdmin(c.user);
  var status = c.query.get('status') || 'PENDING';
  return { withdrawals: T('withdrawals').all(function (w) { return status === 'ALL' || w.status === status; }).sort(byDesc('id')).slice(0, 200).map(function (w) { return withUser(w, ['name', 'email']); }) };
});
route('POST', '/api/admin/withdrawals/:id/:action', function (c) {
  needAdmin(c.user);
  var w = T('withdrawals').get(Number(c.params.id)) || fail(404, 'Permohonan tidak dijumpai.');
  if (w.status !== 'PENDING') fail(400, 'Permohonan ini telah disemak.');
  var action = oneOf(c.params.action, ['paid', 'reject'], 'Tindakan');
  var note = text(c.body.note, 'Nota', { max: 200, optional: true });
  if (action === 'paid') {
    T('withdrawals').update(w, { status: 'PAID', admin_note: note || null, reviewed_at: Date.now() });
    notify(w.user_id, 'Pengeluaran ' + rm(w.amount) + ' telah dibayar', note ? 'Rujukan: ' + note : 'Semak akaun bank anda.', '#/wallet');
  } else {
    T('withdrawals').update(w, { status: 'REJECTED', admin_note: note || null, reviewed_at: Date.now() });
    moveMoney(w.user_id, w.amount, 'WITHDRAW_REFUND', 'Pengeluaran ditolak – wang dipulangkan', 'WD' + w.id);
    notify(w.user_id, 'Pengeluaran ditolak', (note || 'Maklumat bank tidak sah') + '. Wang telah dipulangkan ke dompet.', '#/wallet');
  }
  return { ok: true };
});

route('GET', '/api/admin/users', function (c) {
  needAdmin(c.user);
  var q = String(c.query.get('q') || '').trim().toLowerCase();
  return {
    users: T('users').all(function (u) { return !q || ((u.name || '') + ' ' + (u.email || '') + ' ' + (u.matric || '')).toLowerCase().indexOf(q) >= 0; })
      .sort(byDesc('id')).slice(0, 200)
      .map(function (u) { var s = T('shops').find(function (x) { return x.owner_id === u.id; }); return assign(publicUser(u), { shop_name: s ? s.name : null }); })
  };
});
route('POST', '/api/admin/users/:id/status', function (c) {
  needAdmin(c.user);
  var target = T('users').get(Number(c.params.id)) || fail(404, 'Pengguna tidak dijumpai.');
  if (target.id === c.user.id) fail(400, 'Anda tidak boleh menukar status akaun sendiri.');
  var status = oneOf(c.body.status, ['active', 'suspended'], 'Status');
  T('users').update(target, { status: status });
  if (status === 'suspended') T('sessions').remove(function (s) { return s.user_id === target.id; });
  return { ok: true };
});
route('POST', '/api/admin/users/:id/credit', function (c) {
  needAdmin(c.user);
  var target = T('users').get(Number(c.params.id)) || fail(404, 'Pengguna tidak dijumpai.');
  var amount = Number(c.body.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_TOPUP) fail(400, 'Jumlah tidak sah.');
  var note = text(c.body.note, 'Nota', { min: 3, max: 120 });
  moveMoney(target.id, amount, amount > 0 ? 'TOPUP' : 'ADJUST', (amount > 0 ? 'Tambah nilai kaunter' : 'Pelarasan') + ' – ' + note, 'ADM' + c.user.id);
  notify(target.id, amount > 0 ? 'Dompet dikreditkan ' + rm(amount) : 'Pelarasan dompet ' + rm(amount), note, '#/wallet');
  return { ok: true };
});

// ---------- health & backups ----------
// The Node version enforces these with database triggers; here they are checked on demand.
var DATA_RULES = ['balance_nonneg', 'ledger_matches_balance', 'order_total_consistent', 'review_range', 'listing_stock', 'item_price'];
function healthCheck() {
  var issues = [];
  T('users').all().forEach(function (u) { if (u.balance < 0) issues.push('Baki negatif: ' + u.name); });
  T('orders').all().forEach(function (o) { if (o.total !== o.subtotal + o.delivery_fee + o.deposit) issues.push('Jumlah tidak konsisten: ' + o.code); });
  T('reviews').all().concat(T('seller_reviews').all()).forEach(function (r) { if (r.rating < 1 || r.rating > 5) issues.push('Rating tidak sah #' + r.id); });
  T('listings').all().forEach(function (l) { if (l.stock != null && l.stock < 0) issues.push('Stok negatif: ' + l.title); });
  return issues.length ? issues : ['ok'];
}
function ledgerMismatches() {
  var sums = {};
  T('transactions').all().forEach(function (t) { sums[t.user_id] = (sums[t.user_id] || 0) + t.amount; });
  return T('users').all(function (u) { return u.balance !== (sums[u.id] || 0); })
    .map(function (u) { return { id: u.id, name: u.name, balance: u.balance, ledger: sums[u.id] || 0 }; });
}
route('GET', '/api/admin/system', function (c) {
  needAdmin(c.user);
  var counts = {};
  var cells = 0;
  ['users', 'shops', 'items', 'vehicles', 'listings', 'orders', 'transactions', 'messages', 'reviews', 'seller_reviews', 'disputes'].forEach(function (t) {
    counts[t] = T(t).count();
  });
  DB.tableNames.forEach(function (t) { cells += JSON.stringify(T(t).all()).length; });
  return {
    integrity: healthCheck(), ledger_mismatches: ledgerMismatches(), db_size: cells, tables: counts, triggers: DATA_RULES,
    backups: listBackups(), database_url: DB.spreadsheet().getUrl()
  };
});
route('POST', '/api/admin/backups', function (c) {
  needAdmin(c.user);
  return { name: runBackup(), backups: listBackups() };
});

route('GET', '/api/admin/settings', function (c) { needAdmin(c.user); return settingsOut(); });
route('PUT', '/api/admin/settings', function (c) {
  needAdmin(c.user);
  var b = c.body;
  if (b.packages !== undefined) {
    if (!Array.isArray(b.packages) || !b.packages.length || b.packages.length > 6) fail(400, 'Senarai pakej tidak sah.');
    setSetting('packages', b.packages.map(function (p, i) {
      return {
        id: text(p.id || 'P' + (i + 1), 'ID pakej', { max: 20 }).replace(/[^A-Za-z0-9_-]/g, ''),
        label: text(p.label, 'Nama pakej', { max: 40 }),
        price: sen(p.price, 'Harga pakej', { max: 1000000 }),
        days: sen(p.days, 'Tempoh pakej', { min: 1, max: 1000 }),
        tag: text(p.tag, 'Tag', { max: 30, optional: true }),
        blurb: text(p.blurb, 'Penerangan', { max: 120, optional: true })
      };
    }));
  }
  if (b.commission_pct !== undefined) {
    var cp = Number(b.commission_pct);
    if (!(cp >= 0 && cp <= 30)) fail(400, 'Komisen mesti antara 0% dan 30%.');
    setSetting('commission_pct', cp);
  }
  if (b.topup_bank !== undefined) {
    setSetting('topup_bank', {
      bank: text(b.topup_bank.bank, 'Nama bank', { max: 60 }),
      account: text(b.topup_bank.account, 'No. akaun', { max: 30 }),
      name: text(b.topup_bank.name, 'Nama penerima', { max: 80 })
    });
  }
  if (b.topup_qr !== undefined) setSetting('topup_qr', uploadRef(b.topup_qr));
  if (b.counter_info !== undefined) setSetting('counter_info', text(b.counter_info, 'Info kaunter', { max: 200, optional: true }));
  if (b.announcement !== undefined) setSetting('announcement', text(b.announcement, 'Pengumuman', { max: 200, optional: true }));
  return settingsOut();
});
