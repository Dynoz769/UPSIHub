// UPSIHub for Google Apps Script – shared helpers.
// All server files are concatenated into one Code.gs by gas/build.mjs.

var MY_OFFSET = 8 * 3600e3; // Malaysia time, UTC+8, no DST
var DAY_MS = 864e5;
var SESSION_DAYS = 30;
var MAX_TOPUP = 100000; // RM1,000 per request
var MAX_BALANCE = 500000; // RM5,000 wallet cap
var DISPUTE_WINDOW = 48 * 3600e3;

var CAMPUSES = {
  KSAB: 'Kampus Sultan Abdul Jalil (KSAB)',
  KSAS: 'Kampus Sultan Azlan Shah (KSAS)',
  TM: 'Tanjung Malim / Proton City'
};
var DISPUTE_REASONS = {
  NOT_RECEIVED: 'Pesanan tidak diterima',
  WRONG_ITEM: 'Item salah atau tidak lengkap',
  QUALITY: 'Kualiti tidak memuaskan / rosak',
  OVERCHARGED: 'Dikenakan bayaran berlebihan',
  OTHER: 'Lain-lain'
};
var LISTING_KINDS = {
  ITEM: 'Barang Terpakai',
  ROOM: 'Sewa Bilik & Rumah',
  JOB: 'Kerja Part-time',
  EVENT: 'Event & Tiket',
  LOST: 'Hilang & Jumpa'
};
var LISTING_META = {
  conditions: { BARU: 'Baru', SEPERTI_BARU: 'Seperti baru', BAIK: 'Baik', SEDERHANA: 'Sederhana' },
  room_types: { BILIK_SINGLE: 'Bilik single', BILIK_SHARING: 'Bilik berkongsi', MASTER: 'Master bedroom', RUMAH: 'Seluruh rumah' },
  genders: { LELAKI: 'Lelaki', PEREMPUAN: 'Perempuan', CAMPUR: 'Tiada had' },
  facilities: { WIFI: 'WiFi', AIRCOND: 'Aircond', MESIN_BASUH: 'Mesin basuh', PERABOT: 'Berperabot', PARKING: 'Parking', BILIK_AIR_SENDIRI: 'Bilik air sendiri', DAPUR: 'Dapur' },
  pay_units: { JAM: 'sejam', HARI: 'sehari', TUGASAN: 'setugasan', BULAN: 'sebulan' },
  lost_types: { LOST: 'Hilang', FOUND: 'Dijumpai' }
};
var DEFAULT_SETTINGS = {
  packages: [
    { id: 'Bulanan', label: 'Bulanan', price: 1000, days: 30, tag: 'Cuba-Cuba', blurb: 'Sesuai untuk menguji perniagaan baharu di kampus.' },
    { id: 'Semester', label: '1 Semester', price: 3500, days: 120, tag: 'Paling Popular', blurb: 'Akses penuh sepanjang satu semester pengajian.' },
    { id: 'Tahunan', label: 'Tahunan', price: 6000, days: 365, tag: 'Jimat 50%', blurb: 'Untuk peniaga tegar & pemandu prebet tetap.' }
  ],
  commission_pct: 0,
  topup_bank: { bank: 'Bank Islam Malaysia Berhad', account: '08019020999881', name: 'UPSIHub Tech Services' },
  topup_qr: null,
  counter_info: 'Kaunter UPSIHub (kemas kini lokasi & waktu di Admin › Tetapan)',
  announcement: 'Hab Digital Pelajar Kampus Sultan Abdul Jalil (KSAB) & Sultan Azlan Shah (KSAS)'
};
var DEFAULT_CATEGORIES = {
  shop: [
    ['Makanan & Minuman', '🍱'], ['Prebet & Transport', '🚗'], ['Servis Runner', '⚡'], ['Servis Lain', '🛠️'],
    ['Kek & Bakeri', '🎂'], ['Pakaian & Fesyen', '👕'], ['Dobi & Laundry', '🧺'], ['Kecantikan & Kesihatan', '💄'],
    ['Elektronik & Gajet', '📱'], ['Alat Tulis & Percetakan', '🖨️'], ['Tutor & Akademik', '🎓']
  ],
  market: [
    ['Buku & Nota', '📚'], ['Elektronik & Gajet', '💻'], ['Perabot & Barang Bilik', '🛏️'], ['Pakaian & Aksesori', '👟'],
    ['Kenderaan & Aksesori', '🛵'], ['Sukan & Hobi', '⚽'], ['Dapur & Peralatan', '🍳'], ['Lain-lain', '📦']
  ]
};

// ---------- errors & validation ----------
function HttpError(status, message) {
  this.status = status;
  this.message = message;
}
function fail(status, message) { throw new HttpError(status, message); }

function text(v, label, opts) {
  var o = opts || {};
  var min = o.min || 0;
  var max = o.max || 500;
  var s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (!s && o.optional) return '';
  if (s.length < Math.max(min, o.optional ? 0 : 1)) fail(400, label + ' diperlukan' + (min > 1 ? ' (min ' + min + ' aksara)' : '') + '.');
  if (s.length > max) fail(400, label + ' terlalu panjang (maks ' + max + ' aksara).');
  return s;
}
function sen(v, label, opts) {
  var o = opts || {};
  var min = o.min == null ? 0 : o.min;
  var max = o.max == null ? 10000000 : o.max;
  var n = Number(v);
  if (v === null || v === '' || !Number.isInteger(n) || n < min || n > max) fail(400, label + ' tidak sah.');
  return n;
}
function oneOf(v, list, label) {
  if (list.indexOf(v) < 0) fail(400, label + ' tidak sah.');
  return v;
}
// Only photos uploaded through this app (stored in our Drive folder) are accepted.
var UPLOAD_RE = /^https:\/\/drive\.google\.com\/thumbnail\?id=[A-Za-z0-9_-]{10,}&sz=w1600$/;
function uploadRef(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !UPLOAD_RE.test(v)) fail(400, 'Rujukan gambar tidak sah.');
  return v;
}
function uploadList(v, max) {
  max = max || 5;
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) fail(400, 'Maksimum ' + max + ' gambar.');
  return v.map(uploadRef).filter(Boolean);
}
// 'YYYY-MM-DD' → that day's midnight in Malaysia time, as epoch ms.
function myDate(v, label) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) fail(400, label + ' tidak sah.');
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - MY_OFFSET;
}
function myToday() { return myDate(new Date(Date.now() + MY_OFFSET).toISOString().slice(0, 10), 'Hari ini'); }
function myYmd(ms) { return new Date(ms + MY_OFFSET).toISOString().slice(0, 10); }
function rm(n) { return 'RM' + (n / 100).toFixed(2); }
function round1(x) { return Math.round(x * 10) / 10; }

// ---------- crypto ----------
function randomToken(len) {
  var s = '';
  while (s.length < (len || 32)) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, len || 32);
}
function bytesOf(s) { return Utilities.newBlob(String(s)).getBytes(); }
// Iterated HMAC-SHA256 (PBKDF-style) – Apps Script has no scrypt/bcrypt.
var PW_ITER = 600;
function derive(password, salt, iter) {
  var key = bytesOf(password);
  var b = Utilities.computeHmacSha256Signature(bytesOf(salt), key);
  for (var i = 1; i < iter; i++) b = Utilities.computeHmacSha256Signature(b, key);
  return Utilities.base64Encode(b);
}
function hashPassword(password) {
  var salt = randomToken(24);
  return 'hmac$' + PW_ITER + '$' + salt + '$' + derive(password, salt, PW_ITER);
}
function verifyPassword(password, stored) {
  var p = String(stored || '').split('$');
  if (p.length !== 4 || p[0] !== 'hmac') return false;
  var got = derive(password, p[2], Number(p[1]));
  if (got.length !== p[3].length) return false;
  var diff = 0;
  for (var i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ p[3].charCodeAt(i);
  return diff === 0;
}

// Fixed-window limiter stored in the script cache.
function rateLimit(key, limit, windowMs) {
  var cache = CacheService.getScriptCache();
  var k = 'rl:' + key;
  var n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), Math.min(21600, Math.max(1, Math.ceil(windowMs / 1000))));
  return n <= limit;
}

// Marks that something changed for a user, so their next poll fetches updates.
function touch(userId) {
  if (userId) CacheService.getScriptCache().put('chg:' + userId, String(Date.now()), 21600);
}
