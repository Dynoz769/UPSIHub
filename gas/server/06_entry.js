// Apps Script entry points: web page, API bridge, setup, triggers, backups and demo data.

// Serves the app. Deploy → Web app → Execute as: Me, Who has access: Anyone.
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('UPSIHub – Pasar Kampus, Dompet & Chat Pelajar UPSI')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// Called from the browser with google.script.run.api(method, path, body, token).
// Returns a JSON string of { status, body } exactly like the Node server's responses
// (a string survives google.script.run's serialisation untouched).
function api(method, path, body, token) {
  return JSON.stringify(handleApi(method, path, body, token));
}
function handleApi(method, path, body, token) {
  var started = Date.now();
  var lock = null;
  try {
    var parts = String(path || '').split('?');
    var pathname = parts[0];
    var r = null;
    var match = null;
    for (var i = 0; i < ROUTES.length; i++) {
      if (ROUTES[i].method === method && (match = ROUTES[i].re.exec(pathname))) { r = ROUTES[i]; break; }
    }
    if (!r) return { status: 404, body: { error: 'Laluan API tidak dijumpai.' } };
    if (r.write) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) return { status: 503, body: { error: 'Sistem sedang sibuk. Sila cuba lagi sebentar.' } };
    }
    ensureInstalled();
    DB.reset(r.write);
    var params = {};
    r.keys.forEach(function (k, j) { params[k] = decodeURIComponent(match[j + 1]); });
    var q = {};
    (parts[1] || '').split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      q[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
    });
    var auth = sessionUser(token);
    var out = r.handler({ user: auth.user, token: auth.token, body: body || {}, params: params, query: { get: function (k) { return q[k] == null ? null : q[k]; } } });
    if (r.write) DB.flush();
    return { status: 200, body: out };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    console.error(method + ' ' + path + ' failed: ' + (err && err.stack || err));
    return { status: 500, body: { error: 'Ralat pelayan. Sila cuba lagi.' } };
  } finally {
    if (lock) lock.releaseLock();
    if (Date.now() - started > 8000) console.warn('Slow request ' + method + ' ' + path + ': ' + (Date.now() - started) + 'ms');
  }
}

function sessionUser(token) {
  if (!token || typeof token !== 'string') return { token: null, user: null };
  var now = Date.now();
  var s = T('sessions').find(function (x) { return x.token === token && x.expires_at > now; });
  if (!s) return { token: null, user: null };
  var u = T('users').get(s.user_id);
  return u && u.status === 'active' ? { token: token, user: u } : { token: null, user: null };
}

// ---------- installation ----------
// Creates the database spreadsheet, default data, Drive folders and triggers on first use.
function ensureInstalled() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('INSTALLED') === '3') return;
  var lock = LockService.getScriptLock();
  var own = !lock.hasLock();
  if (own) lock.waitLock(30000);
  try {
    if (props.getProperty('INSTALLED') === '3') return;
    DB.reset(true);
    install(props);
  } finally {
    if (own) lock.releaseLock();
  }
}
function install(props) {
  DB.ensureAll();
  if (!T('categories').count()) {
    Object.keys(DEFAULT_CATEGORIES).forEach(function (kind) {
      DEFAULT_CATEGORIES[kind].forEach(function (c, i) { T('categories').insert({ kind: kind, name: c[0], emoji: c[1], sort: i, active: 1 }); });
    });
  }
  DB.flush();
  installTriggers();
  props.setProperty('INSTALLED', '3');
}
function installTriggers() {
  var have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (have.indexOf('scheduledTasks') < 0) ScriptApp.newTrigger('scheduledTasks').timeBased().everyMinutes(10).create();
  if (have.indexOf('dailyBackup') < 0) ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(3).create();
}

// Run once from the editor (▶ setup) to authorise and create everything.
function setup() {
  ensureInstalled();
  console.log('UPSIHub sedia. Pangkalan data: ' + DB.spreadsheet().getUrl());
}
// Optional: fills the app with sample shops, listings and demo accounts (password demo1234).
function setupDemo() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    DB.reset(true);
    ensureInstalled();
    seedDemo();
    DB.flush();
    PropertiesService.getScriptProperties().setProperty('DEMO', '1');
    console.log('Data demo ditambah. Log masuk: pelajar@demo.upsi / demo1234');
  } finally {
    lock.releaseLock();
  }
}
// Hides the demo-account hint on the login page (demo data itself stays).
function hideDemoHint() { PropertiesService.getScriptProperties().deleteProperty('DEMO'); }
// Use after editing the spreadsheet by hand so the app re-reads it.
function clearCache() {
  var cache = CacheService.getScriptCache();
  DB.tableNames.forEach(function (n) { cache.remove('tbl:' + n); });
}

// ---------- triggers ----------
function scheduledTasks() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return;
  try {
    // Re-read every table: keeps the cache warm for readers and picks up hand edits in the sheet.
    clearCache();
    DB.reset(true);
    DB.tableNames.forEach(T);
    sweepReleases();
    var now = Date.now();
    T('sessions').remove(function (s) { return s.expires_at < now; });
    DB.flush();
  } finally {
    lock.releaseLock();
  }
}
function dailyBackup() { runBackup(); }

// ---------- backups (copies of the spreadsheet in Drive) ----------
function folderNamed(name) {
  var props = PropertiesService.getScriptProperties();
  var key = 'FOLDER_' + name.replace(/\W/g, '_');
  var id = props.getProperty(key);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted – recreate */ }
  }
  var f = DriveApp.createFolder(name);
  props.setProperty(key, f.getId());
  return f;
}
function uploadsFolder() { return folderNamed('UPSIHub Uploads'); }
function backupsFolder() { return folderNamed('UPSIHub Backups'); }
function runBackup() {
  var d = new Date(Date.now() + MY_OFFSET).toISOString();
  var name = 'UPSIHub Backup ' + d.slice(0, 10) + ' ' + d.slice(11, 19).replace(/:/g, '');
  DriveApp.getFileById(DB.spreadsheet().getId()).makeCopy(name, backupsFolder());
  var keep = Number(PropertiesService.getScriptProperties().getProperty('BACKUP_KEEP')) || 14;
  listBackups().slice(keep).forEach(function (b) { DriveApp.getFileById(b.id).setTrashed(true); });
  return name;
}
function listBackups() {
  var out = [];
  var it = backupsFolder().getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed && f.isTrashed()) continue;
    out.push({ id: f.getId(), name: f.getName(), size: f.getSize(), created_at: f.getDateCreated().getTime(), url: f.getUrl() });
  }
  return out.sort(function (a, b) { return b.created_at - a.created_at; });
}

// ---------- demo data ----------
function seedDemo() {
  if (T('users').find(function (u) { return u.email === 'pelajar@demo.upsi'; })) return;
  var now = Date.now();
  var pass = hashPassword('demo1234');
  var addUser = function (name, email, campus, balance, matric) {
    var u = T('users').insert({ name: name, email: email, password: pass, campus: campus, balance: 0, matric: matric || null, created_at: now });
    if (balance) moveMoney(u.id, balance, 'ADJUST', 'Kredit demo', 'DEMO');
    return u.id;
  };
  addUser('Aina Pelajar', 'pelajar@demo.upsi', 'KSAB', 5000, 'D20231000001');
  var year = 365 * DAY_MS;
  var tutorHours = JSON.stringify({ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '21:00' });
  var shops = [
    { owner: ['Kak Ros', 'nasilemak@demo.upsi', 'KSAB'],
      shop: ['Nasi Lemak Royale KSAB', 'Makanan & Minuman', 'KSAB', 'Nasi lemak panas beraroma dengan pelbagai lauk pauk. Penghantaran ke blok kediaman KSAB!', '7:00 pagi – 2:00 petang', 100, 500, 'Semester', 3500],
      items: [['Nasi Lemak Ayam Goreng Berempah', 'Sambal padu, telur rebus & timun', 700], ['Nasi Lemak Paru Goreng', 'Paru goreng rangup berempah', 650], ['Teh O Ais Madu', 'Ais segar manis madu', 250]] },
    { owner: ['Abang Farhan', 'prebet@demo.upsi', 'KSAS'],
      shop: ['Abang Prebet Express (KSAB ⇄ KSAS)', 'Prebet & Transport', 'KSAS', 'Servis ulang-alik Tanjung Malim, KTM, KSAS dan KSAB. Kereta MPV selesa, dipandu cermat. Kereta sewa harian juga tersedia.', 'Setiap hari, 7:00 pagi – 11:00 malam', 0, 0, 'Tahunan', 6000],
      items: [['KSAB ⇄ KSAS (satu hala)', 'Harga seorang. Ambil di mana-mana blok kediaman.', 400, 'ROUTE'], ['Kampus → Stesen KTM Tanjung Malim', 'Harga seorang. Sesuai untuk balik kampung.', 500, 'ROUTE'], ['Kampus → Aeon Rawang / Bandar Behrang', 'Harga seorang, pergi-balik.', 1500, 'ROUTE']],
      vehicles: [['Perodua Bezza 1.3 (Auto)', 'PKX 2231', 5, 'AUTO', 8000, 5000, 'Minyak penuh semasa ambil, pulangkan penuh. Lesen P tidak dibenarkan.'], ['Perodua Alza (7 tempat duduk)', 'WYB 8812', 7, 'AUTO', 13000, 10000, 'Sesuai untuk rombongan & balik kampung beramai-ramai.']] },
    { owner: ['Hafiz Runner', 'print@demo.upsi', 'TM'],
      shop: ['Runner Print & Assignment Pro', 'Servis Runner', 'TM', 'Servis cetak tugasan A4, hard binding, dan runner hantar terus ke bilik kolej anda.', 'Isnin – Sabtu, 9:00 pagi – 10:00 malam', 200, 300, 'Bulanan', 1000],
      items: [['Print Hitam Putih (Per Muka)', 'Kertas 80gsm berkualiti', 15], ['Print Warna (Per Muka)', 'Sesuai untuk graf & laporan', 50], ['Comb Binding + Cover Transparent', 'Termasuk plastik depan/belakang', 350]] },
    { owner: ['Cikgu Amir', 'tutor@demo.upsi', 'KSAB'],
      shop: ['Tutor Matematik & Statistik Cikgu Amir', 'Tutor & Akademik', 'KSAB', 'Kelas tuisyen 1-ke-1 untuk Kalkulus, Statistik & SPSS. Di perpustakaan atau dalam talian.', 'Isnin – Sabtu, 9:00 pagi – 9:00 malam', 0, 0, 'Semester', 3500],
      hours: tutorHours,
      items: [['Tuisyen Kalkulus (1 jam)', '1-ke-1, termasuk latihan tambahan', 3000, 'SERVICE', 60], ['Bimbingan SPSS / Analisis Data (2 jam)', 'Bawa data kajian anda', 7000, 'SERVICE', 120], ['Semakan Tugasan Statistik (30 min)', 'Semakan pantas sebelum hantar', 1500, 'SERVICE', 30]] }
  ];
  shops.forEach(function (s) {
    var owner = addUser(s.owner[0], s.owner[1], s.owner[2], 0, null);
    var d = s.shop;
    var shop = T('shops').insert({ owner_id: owner, name: d[0], category: d[1], campus: d[2], description: d[3], hours: d[4], delivery_fee: d[5], min_order: d[6],
      status: 'APPROVED', package: d[7], license_fee: d[8], license_until: now + year, booking_hours: s.hours || null, is_open: 1, allow_cash: 1, created_at: now });
    s.items.forEach(function (it) {
      T('items').insert({ shop_id: shop.id, title: it[0], description: it[1], price: it[2], kind: it[3] || 'PRODUCT', duration_min: it[4] || null, images: '[]', available: 1, created_at: now });
    });
    (s.vehicles || []).forEach(function (v) {
      T('vehicles').insert({ shop_id: shop.id, model: v[0], plate: v[1], seats: v[2], transmission: v[3], daily_rate: v[4], deposit: v[5], notes: v[6], images: '[]', active: 1, created_at: now });
    });
  });
  var seller = addUser('Danial Senior', 'senior@demo.upsi', 'KSAS', 0, 'D20201000777');
  var listing = function (kind, category, title, description, price, x) {
    x = x || {};
    T('listings').insert({ user_id: x.user || seller, kind: kind, category: category, title: title, description: description, price: price,
      negotiable: x.negotiable ? 1 : 0, condition: x.condition || null, campus: x.campus || 'KSAS', location: x.location || '', images: '[]',
      meta: JSON.stringify(x.meta || {}), stock: x.stock == null ? null : x.stock, status: 'ACTIVE', views: 0, reports: 0, created_at: now, updated_at: now });
  };
  listing('ITEM', 'Buku & Nota', 'Buku Teks Psikologi Pendidikan (Edisi ke-3)', 'Ada sedikit highlight. Sesuai untuk kursus KPF3012.', 2500, { negotiable: true, condition: 'BAIK', location: 'Kolej Ungku Omar', stock: 1 });
  listing('ITEM', 'Perabot & Barang Bilik', 'Kipas Meja KDK + Rak Buku Plastik', 'Pindah keluar kolej, jual murah. Ambil sendiri.', 4000, { negotiable: true, condition: 'BAIK', location: 'KSAS Blok C', stock: 1 });
  listing('ITEM', 'Elektronik & Gajet', 'Kalkulator Saintifik Casio fx-570EX', 'Guna satu semester sahaja, macam baru.', 4500, { condition: 'SEPERTI_BARU', location: 'Perpustakaan Tuanku Bainun', stock: 1 });
  listing('ROOM', null, 'Bilik Sederhana Taman Bernam Jaya – Pelajar Perempuan', 'Rumah teres 2 tingkat, 5 minit ke KSAS. WiFi & mesin basuh disediakan.', 30000, {
    location: 'Taman Bernam Jaya',
    meta: { room_type: 'BILIK_SINGLE', gender: 'PEREMPUAN', available_from: myYmd(now + 7 * DAY_MS), deposit_note: '1 bulan + RM100 utiliti', booking_fee: 5000, facilities: ['WIFI', 'MESIN_BASUH', 'PERABOT', 'PARKING'] }
  });
  listing('ROOM', null, 'Master Bedroom Proton City – Lelaki', 'Bilik master dengan bilik air sendiri & aircond.', 45000, {
    campus: 'TM', location: 'Proton City Fasa 2',
    meta: { room_type: 'MASTER', gender: 'LELAKI', available_from: myYmd(now), deposit_note: '2 bulan', booking_fee: 10000, facilities: ['WIFI', 'AIRCOND', 'BILIK_AIR_SENDIRI', 'PERABOT'] }
  });
  listing('JOB', null, 'Pembantu Kafe Hujung Minggu', 'Kafe di Bandar Behrang perlukan 2 pembantu. Sabtu & Ahad.', 900, {
    campus: 'TM', location: 'Bandar Behrang 2020', meta: { pay_unit: 'JAM', employer: 'Kafe Kopi Kampus', schedule: 'Sabtu & Ahad, 10 pagi – 6 petang' }
  });
  listing('EVENT', null, 'Malam Kebudayaan UPSI 2026', 'Persembahan tarian, muzik tradisional & gerai makanan.', 1000, {
    location: 'Dewan Tuanku Canselor', stock: 200, meta: { event_at: now + 10 * DAY_MS, venue: 'Dewan Tuanku Canselor, KSAS' }
  });
  listing('LOST', null, 'Hilang: Kad Matrik & Dompet Hitam', 'Tercicir sekitar kafeteria KSAB petang semalam. Sesiapa jumpa sila chat.', null, {
    campus: 'KSAB', location: 'Kafeteria KSAB', meta: { type: 'LOST', date: myYmd(now - DAY_MS) }
  });
}
