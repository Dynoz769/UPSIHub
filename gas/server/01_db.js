// Google Sheets storage: one tab per table, header row = column names.
// A request loads only the tables it touches, works in memory, and writes the
// changes back once at the end (only if the handler succeeded). Writes run under
// a script lock, so each request is all-or-nothing and requests never interleave.

var SCHEMA_SPEC = {
  users: 'id:n name email matric phone campus avatar password role status balance:n created_at:n',
  sessions: 'token user_id:n expires_at:n',
  shops: 'id:n owner_id:n name category campus description image hours delivery_fee:n min_order:n allow_cash:n is_open:n status reject_reason package license_fee:n license_until:n booking_hours created_at:n',
  items: 'id:n shop_id:n title description price:n image images available:n kind duration_min:n created_at:n',
  vehicles: 'id:n shop_id:n model plate seats:n transmission image images daily_rate:n deposit:n notes active:n created_at:n',
  listings: 'id:n user_id:n kind category title description price:n negotiable:n condition campus location images meta stock:n status views:n reports:n removed_reason created_at:n updated_at:n',
  orders: 'id:n code kind user_id:n seller_id:n shop_id:n listing_id:n vehicle_id:n status payment fulfilment address note subtotal:n delivery_fee:n deposit:n total:n commission:n payout release_at:n start_at:n end_at:n pickup dropoff pax:n cancel_reason created_at:n updated_at:n',
  order_items: 'id:n order_id:n item_id:n title price:n qty:n',
  order_events: 'id:n order_id:n status at:n',
  reviews: 'id:n order_id:n shop_id:n user_id:n rating:n comment images created_at:n',
  seller_reviews: 'id:n order_id:n seller_id:n user_id:n rating:n comment images created_at:n',
  transactions: 'id:n user_id:n type amount:n balance_after:n description ref created_at:n',
  topups: 'id:n user_id:n amount:n method reference receipt status admin_note created_at:n reviewed_at:n',
  withdrawals: 'id:n user_id:n amount:n bank_name account_no account_name status admin_note created_at:n reviewed_at:n',
  conversations: 'id:n user_a:n user_b:n kind last_at:n',
  messages: 'id:n conversation_id:n sender_id:n body image created_at:n read_at:n',
  notifications: 'id:n user_id:n title body link read:n created_at:n',
  disputes: 'id:n order_id:n user_id:n reason details evidence prev_status seller_response seller_evidence status outcome refund:n admin_note created_at:n resolved_at:n',
  categories: 'id:n kind name emoji sort:n active:n',
  settings: 'key value'
};
var DEFAULTS = {
  users: { role: 'user', status: 'active', balance: 0, campus: 'KSAB' },
  shops: { description: '', hours: '', delivery_fee: 0, min_order: 0, allow_cash: 1, is_open: 1, status: 'PENDING', license_fee: 0 },
  items: { description: '', available: 1, kind: 'PRODUCT', images: '[]' },
  vehicles: { seats: 4, transmission: 'AUTO', deposit: 0, notes: '', images: '[]', active: 1 },
  listings: { description: '', negotiable: 0, location: '', images: '[]', meta: '{}', status: 'ACTIVE', views: 0, reports: 0 },
  orders: { address: '', note: '', deposit: 0, commission: 0, payout: 'NONE' },
  reviews: { comment: '', images: '[]' },
  seller_reviews: { comment: '', images: '[]' },
  transactions: { description: '' },
  topups: { reference: '', status: 'PENDING' },
  withdrawals: { status: 'PENDING' },
  conversations: { kind: 'direct' },
  messages: { body: '' },
  notifications: { body: '', read: 0 },
  disputes: { details: '', status: 'OPEN' },
  categories: { emoji: '', sort: 0, active: 1 }
};

var TEXT_MARK = '⁣'; // invisible prefix: keeps text as text (no number/date/formula coercion)
var CACHE_TTL = 1200; // seconds
var CACHE_CHUNK = 30000; // chars per cache value (limit is 100KB of UTF-8)

var DB = (function () {
  var schema = {};
  Object.keys(SCHEMA_SPEC).forEach(function (name) {
    schema[name] = SCHEMA_SPEC[name].split(' ').map(function (c) {
      var p = c.split(':');
      return { name: p[0], num: p[1] === 'n' };
    });
  });
  var ss = null;
  var tables = {};

  function spreadsheet() {
    if (!ss) {
      var props = PropertiesService.getScriptProperties();
      var id = props.getProperty('DB_ID');
      if (!id) {
        ss = SpreadsheetApp.create('UPSIHub Database');
        props.setProperty('DB_ID', ss.getId());
      } else {
        ss = SpreadsheetApp.openById(id);
      }
    }
    return ss;
  }
  function sheetFor(name) {
    var book = spreadsheet();
    var sh = book.getSheetByName(name);
    if (!sh) {
      sh = book.insertSheet(name);
      var cols = schema[name].map(function (c) { return c.name; });
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
      sh.setFrozenRows(1);
    }
    return sh;
  }

  function toCell(v, col) {
    if (v === null || v === undefined) return '';
    if (col.num) return Number(v);
    return TEXT_MARK + String(v);
  }
  function fromCell(v, col) {
    if (v === '' || v === null || v === undefined) return null;
    if (col.num) {
      var n = Number(v);
      return isNaN(n) ? null : n;
    }
    var s = String(v);
    return s.charAt(0) === TEXT_MARK ? s.slice(1) : s;
  }

  // ---------- cache (snapshot of a whole table as JSON chunks) ----------
  function cacheGet(name) {
    var cache = CacheService.getScriptCache();
    var meta = cache.get('tbl:' + name);
    if (!meta) return null;
    var m = JSON.parse(meta);
    var keys = [];
    for (var i = 0; i < m.n; i++) keys.push('tbl:' + name + ':' + m.v + ':' + i);
    var got = cache.getAll(keys);
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
      if (got[keys[j]] == null) return null;
      parts.push(got[keys[j]]);
    }
    return JSON.parse(parts.join(''));
  }
  function cacheInvalidate(name) { CacheService.getScriptCache().remove('tbl:' + name); }
  function cachePut(name, header, rows) {
    var data = JSON.stringify({ header: header, rows: rows });
    if (data.length > CACHE_CHUNK * 60) return; // too big to cache – always read the sheet
    var v = Utilities.getUuid().slice(0, 8);
    var put = {};
    var n = 0;
    for (var i = 0; i < data.length; i += CACHE_CHUNK) put['tbl:' + name + ':' + v + ':' + (n++)] = data.slice(i, i + CACHE_CHUNK);
    var cache = CacheService.getScriptCache();
    cache.putAll(put, CACHE_TTL);
    cache.put('tbl:' + name, JSON.stringify({ v: v, n: n }), CACHE_TTL);
  }

  function load(name) {
    if (tables[name]) return tables[name];
    if (!schema[name]) throw new Error('Unknown table ' + name);
    var cols = schema[name];
    var header;
    var raw;
    var cached = cacheGet(name);
    if (cached) {
      header = cached.header;
      raw = cached.rows;
    } else {
      var sh = sheetFor(name);
      var values = sh.getDataRange().getValues();
      header = values[0].map(String);
      // New columns added to the schema later are appended to the sheet.
      var missing = cols.filter(function (c) { return header.indexOf(c.name) < 0; });
      if (missing.length) {
        missing.forEach(function (c) { header.push(c.name); });
        sh.getRange(1, 1, 1, header.length).setValues([header]);
      }
      raw = values.slice(1).filter(function (r) { return r.some(function (v) { return v !== '' && v !== null; }); });
    }
    var idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    var rows = raw.map(function (r) {
      var o = {};
      cols.forEach(function (c) { o[c.name] = fromCell(idx[c.name] == null ? '' : r[idx[c.name]], c); });
      return o;
    });
    var maxId = 0;
    rows.forEach(function (r) { if (r.id > maxId) maxId = r.id; });
    // `loaded` = rows already in the sheet; `mutated` = an existing row changed or was removed.
    var t = { name: name, cols: cols, header: header, rows: rows, nextId: maxId + 1, changed: false, mutated: false, loaded: rows.length, byId: null };
    tables[name] = t;
    // Only a request holding the script lock may fill the cache: a reader could catch a
    // sheet halfway through a write and pin that snapshot for every later writer.
    if (!cached && writer) cachePut(name, header, raw);
    return t;
  }

  function rowValues(t, r) {
    var out = t.header.map(function () { return ''; });
    t.cols.forEach(function (c) {
      var i = t.header.indexOf(c.name);
      if (i >= 0) out[i] = toCell(r[c.name], c);
    });
    return out;
  }

  // Writes every changed table back. Insert-only changes (messages, ledger,
  // notifications) are appended; anything else rewrites the table in one call.
  function flush() {
    Object.keys(tables).forEach(function (name) {
      var t = tables[name];
      if (!t.changed) return;
      cacheInvalidate(name); // never let a reader see a stale snapshot after a write
      var sh = sheetFor(name);
      var all = t.rows.map(function (r) { return rowValues(t, r); });
      var last = sh.getLastRow();
      if (!t.mutated && last === t.loaded + 1) {
        var fresh = all.slice(t.loaded);
        ensureRows(sh, last + fresh.length);
        if (fresh.length) sh.getRange(last + 1, 1, fresh.length, t.header.length).setValues(fresh);
      } else {
        var data = [t.header].concat(all);
        ensureRows(sh, data.length);
        sh.getRange(1, 1, data.length, t.header.length).setValues(data);
        if (last > data.length) sh.getRange(data.length + 1, 1, last - data.length, sh.getLastColumn()).clearContent();
      }
      cachePut(name, t.header, all);
      t.changed = false;
      t.mutated = false;
      t.loaded = t.rows.length;
    });
  }
  function ensureRows(sh, need) {
    var max = sh.getMaxRows();
    if (need > max) sh.insertRowsAfter(max, need - max + 200);
  }
  var writer = false;
  function reset(isWriter) { tables = {}; writer = !!isWriter; }

  function api(name) {
    var t = load(name);
    var self = {
      all: function (pred) { return pred ? t.rows.filter(pred) : t.rows.slice(); },
      find: function (pred) {
        for (var i = 0; i < t.rows.length; i++) if (pred(t.rows[i])) return t.rows[i];
        return null;
      },
      get: function (id) {
        if (id == null) return null;
        if (!t.byId) {
          t.byId = {};
          t.rows.forEach(function (r) { t.byId[r.id] = r; });
        }
        return t.byId[Number(id)] || null;
      },
      count: function (pred) { return pred ? t.rows.filter(pred).length : t.rows.length; },
      insert: function (obj) {
        var r = {};
        var d = DEFAULTS[name] || {};
        t.cols.forEach(function (c) { r[c.name] = obj[c.name] !== undefined ? obj[c.name] : d[c.name] !== undefined ? d[c.name] : null; });
        if (t.cols[0].name === 'id' && r.id == null) r.id = t.nextId++;
        t.rows.push(r);
        if (t.byId) t.byId[r.id] = r;
        t.changed = true;
        return r;
      },
      update: function (r, changes) {
        Object.keys(changes).forEach(function (k) { r[k] = changes[k]; });
        t.changed = true;
        if (t.rows.indexOf(r) < t.loaded) t.mutated = true;
        return r;
      },
      remove: function (pred) {
        var before = t.rows.length;
        t.rows = t.rows.filter(function (r) { return !pred(r); });
        if (t.rows.length !== before) { t.changed = true; t.mutated = true; t.byId = null; }
      }
    };
    return self;
  }

  return {
    T: api, flush: flush, reset: reset, spreadsheet: spreadsheet, tableNames: Object.keys(SCHEMA_SPEC),
    ensureAll: function () { Object.keys(SCHEMA_SPEC).forEach(function (n) { sheetFor(n); }); }
  };
})();

function T(name) { return DB.T(name); }

function getSetting(key) {
  var r = T('settings').find(function (s) { return s.key === key; });
  return r ? JSON.parse(r.value) : DEFAULT_SETTINGS[key];
}
function setSetting(key, value) {
  var t = T('settings');
  var r = t.find(function (s) { return s.key === key; });
  if (r) t.update(r, { value: JSON.stringify(value) });
  else t.insert({ key: key, value: JSON.stringify(value) });
}
