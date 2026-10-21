// SQLite storage using Node's built-in driver (no external packages).
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, randomToken } from './security.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  matric TEXT,
  phone TEXT,
  campus TEXT NOT NULL DEFAULT 'KSAB',
  avatar TEXT,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  balance INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  campus TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image TEXT,
  hours TEXT NOT NULL DEFAULT '',
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  min_order INTEGER NOT NULL DEFAULT 0,
  allow_cash INTEGER NOT NULL DEFAULT 1,
  is_open INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reject_reason TEXT,
  package TEXT,
  license_fee INTEGER NOT NULL DEFAULT 0,
  license_until INTEGER,
  booking_hours TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  image TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'PRODUCT',
  duration_min INTEGER,
  images TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'ORDER',
  user_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  shop_id INTEGER REFERENCES shops(id),
  listing_id INTEGER REFERENCES listings(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  status TEXT NOT NULL,
  payment TEXT NOT NULL,
  fulfilment TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL,
  deposit INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  commission INTEGER NOT NULL DEFAULT 0,
  payout TEXT NOT NULL DEFAULT 'NONE',
  release_at INTEGER,
  start_at INTEGER,
  end_at INTEGER,
  pickup TEXT,
  dropoff TEXT,
  pax INTEGER,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seller_reviews (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topups (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  receipt TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  bank_name TEXT NOT NULL,
  account_no TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'direct',
  last_at INTEGER NOT NULL,
  UNIQUE(user_a, user_b, kind)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  image TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  evidence TEXT,
  prev_status TEXT NOT NULL,
  seller_response TEXT,
  seller_evidence TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  outcome TEXT,
  refund INTEGER,
  admin_note TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(kind, name)
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  plate TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 4,
  transmission TEXT NOT NULL DEFAULT 'AUTO',
  image TEXT,
  daily_rate INTEGER NOT NULL,
  deposit INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER,
  negotiable INTEGER NOT NULL DEFAULT 0,
  condition TEXT,
  campus TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  stock INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  views INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  removed_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_shop ON items(shop_id);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews(shop_id);
CREATE INDEX IF NOT EXISTS idx_seller_reviews ON seller_reviews(seller_id);
`;

const POST_MIGRATION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_release ON orders(payout, release_at);
CREATE INDEX IF NOT EXISTS idx_orders_vehicle ON orders(vehicle_id, start_at);
CREATE INDEX IF NOT EXISTS idx_listings_kind ON listings(kind, status, created_at);
CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_shop ON vehicles(shop_id);
`;

// Safety rules enforced by the database itself, so a bug in application code
// can never corrupt money or ratings.
const GUARD_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS trg_balance_nonneg BEFORE UPDATE OF balance ON users
  WHEN NEW.balance < 0 BEGIN SELECT RAISE(ABORT, 'Baki dompet tidak boleh negatif'); END;
CREATE TRIGGER IF NOT EXISTS trg_balance_insert BEFORE INSERT ON users
  WHEN NEW.balance < 0 BEGIN SELECT RAISE(ABORT, 'Baki dompet tidak boleh negatif'); END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_update BEFORE UPDATE ON transactions
  BEGIN SELECT RAISE(ABORT, 'Lejar transaksi tidak boleh diubah'); END;
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_delete BEFORE DELETE ON transactions
  BEGIN SELECT RAISE(ABORT, 'Lejar transaksi tidak boleh dipadam'); END;
CREATE TRIGGER IF NOT EXISTS trg_order_total_ins BEFORE INSERT ON orders
  WHEN NEW.total != NEW.subtotal + NEW.delivery_fee + NEW.deposit OR NEW.total < 0 OR NEW.commission < 0
  BEGIN SELECT RAISE(ABORT, 'Jumlah pesanan tidak konsisten'); END;
CREATE TRIGGER IF NOT EXISTS trg_order_total_upd BEFORE UPDATE OF total, subtotal, delivery_fee, deposit, commission ON orders
  WHEN NEW.total != NEW.subtotal + NEW.delivery_fee + NEW.deposit OR NEW.total < 0 OR NEW.commission < 0
  BEGIN SELECT RAISE(ABORT, 'Jumlah pesanan tidak konsisten'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_range BEFORE INSERT ON reviews
  WHEN NEW.rating NOT BETWEEN 1 AND 5 BEGIN SELECT RAISE(ABORT, 'Rating mesti 1-5'); END;
CREATE TRIGGER IF NOT EXISTS trg_seller_review_range BEFORE INSERT ON seller_reviews
  WHEN NEW.rating NOT BETWEEN 1 AND 5 BEGIN SELECT RAISE(ABORT, 'Rating mesti 1-5'); END;
CREATE TRIGGER IF NOT EXISTS trg_listing_stock BEFORE UPDATE OF stock ON listings
  WHEN NEW.stock < 0 BEGIN SELECT RAISE(ABORT, 'Stok tidak boleh negatif'); END;
CREATE TRIGGER IF NOT EXISTS trg_item_price BEFORE UPDATE OF price ON items
  WHEN NEW.price < 1 BEGIN SELECT RAISE(ABORT, 'Harga tidak sah'); END;
`;

export const DEFAULT_CATEGORIES = {
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

export const DEFAULT_SETTINGS = {
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

function migrate(db) {
  const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const cols = colsOf('orders');
  if (!cols.includes('payout')) {
    // payout tracks the held wallet money: NONE (cash), HELD, RELEASED (to seller) or REFUNDED (to buyer).
    db.exec(`
      ALTER TABLE orders ADD COLUMN payout TEXT NOT NULL DEFAULT 'NONE';
      ALTER TABLE orders ADD COLUMN release_at INTEGER;
      UPDATE orders SET payout = CASE
        WHEN payment != 'WALLET' THEN 'NONE'
        WHEN status = 'COMPLETED' THEN 'RELEASED'
        WHEN status IN ('CANCELLED', 'REJECTED') THEN 'REFUNDED'
        ELSE 'HELD' END;`);
  }
  if (!colsOf('items').includes('kind')) {
    db.exec("ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'PRODUCT'; ALTER TABLE items ADD COLUMN duration_min INTEGER;");
  }
  if (!colsOf('shops').includes('booking_hours')) db.exec('ALTER TABLE shops ADD COLUMN booking_hours TEXT;');
  // Photo galleries: products & vehicles keep `image` as the cover, `images` holds all of them.
  for (const t of ['items', 'vehicles', 'reviews', 'seller_reviews']) {
    if (!colsOf(t).includes('images')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN images TEXT NOT NULL DEFAULT '[]';`);
      if (t === 'items' || t === 'vehicles') db.exec(`UPDATE ${t} SET images = json_array(image) WHERE image IS NOT NULL;`);
    }
  }
  if (!colsOf('orders').includes('seller_id')) {
    // Orders used to always belong to a shop. Rebuild so a seller can also be an
    // individual (second-hand listings) and bookings can carry dates/locations.
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`BEGIN;
      CREATE TABLE orders_new (
        id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'ORDER',
        user_id INTEGER NOT NULL REFERENCES users(id), seller_id INTEGER NOT NULL REFERENCES users(id),
        shop_id INTEGER REFERENCES shops(id), listing_id INTEGER REFERENCES listings(id), vehicle_id INTEGER REFERENCES vehicles(id),
        status TEXT NOT NULL, payment TEXT NOT NULL, fulfilment TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
        subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, deposit INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
        commission INTEGER NOT NULL DEFAULT 0, payout TEXT NOT NULL DEFAULT 'NONE', release_at INTEGER,
        start_at INTEGER, end_at INTEGER, pickup TEXT, dropoff TEXT, pax INTEGER, cancel_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO orders_new (id, code, kind, user_id, seller_id, shop_id, status, payment, fulfilment, address, note, subtotal,
        delivery_fee, total, commission, payout, release_at, cancel_reason, created_at, updated_at)
        SELECT o.id, o.code, 'ORDER', o.user_id, s.owner_id, o.shop_id, o.status, o.payment, o.fulfilment, o.address, o.note, o.subtotal,
        o.delivery_fee, o.total, o.commission, o.payout, o.release_at, o.cancel_reason, o.created_at, o.updated_at
        FROM orders o JOIN shops s ON s.id = o.shop_id;
      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;
      COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON;');
  }
  db.exec(POST_MIGRATION_INDEXES);
  db.exec(GUARD_TRIGGERS);
  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
    const ins = db.prepare('INSERT INTO categories (kind, name, emoji, sort) VALUES (?, ?, ?, ?)');
    for (const [kind, list] of Object.entries(DEFAULT_CATEGORIES)) list.forEach(([name, emoji], i) => ins.run(kind, name, emoji, i));
  }
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  // WAL for concurrent reads; synchronous=FULL so a committed payment survives a power cut.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);

  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql); cache.set(sql, st); }
    return st;
  };
  // node:sqlite rejects `undefined`, so normalise it to NULL.
  const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));

  const q = {
    raw: db,
    one: (sql, ...p) => prep(sql).get(...clean(p)),
    all: (sql, ...p) => prep(sql).all(...clean(p)),
    run: (sql, ...p) => prep(sql).run(...clean(p)),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getSetting(key) {
      const row = q.one('SELECT value FROM settings WHERE key = ?', key);
      return row ? JSON.parse(row.value) : DEFAULT_SETTINGS[key];
    },
    // Quick structural check of the database file.
    integrity: () => db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]),
    // Every wallet balance must equal the sum of its ledger entries.
    ledgerMismatches: () => db.prepare(`SELECT u.id, u.name, u.balance, COALESCE(SUM(t.amount), 0) AS ledger FROM users u
                                        LEFT JOIN transactions t ON t.user_id = u.id GROUP BY u.id HAVING u.balance != ledger`).all(),
    // Consistent online copy of the whole database (safe while the app is running).
    backupTo(file) {
      db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
    },
    setSetting(key, value) {
      q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    }
  };
  return q;
}

// Creates the admin account (and optional demo data) on an empty database.
export function bootstrap(q, { adminEmail, adminPassword, demo }) {
  const now = Date.now();
  const hasAdmin = q.one("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  let generatedPassword = null;
  if (!hasAdmin) {
    const password = adminPassword || (generatedPassword = randomToken(9));
    q.run(
      "INSERT INTO users (name, email, password, role, campus, created_at) VALUES (?, ?, ?, 'admin', 'KSAB', ?)",
      'Pentadbir UPSIHub', adminEmail, hashPassword(password), now
    );
  }

  const userCount = q.one('SELECT COUNT(*) AS n FROM users').n;
  if (demo && userCount <= 1) seedDemo(q, now);
  return { generatedPassword };
}

function seedDemo(q, now) {
  const pass = hashPassword('demo1234');
  const addUser = (name, email, campus, balance, matric) =>
    Number(q.run('INSERT INTO users (name, email, password, campus, balance, matric, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name, email, pass, campus, balance, matric, now).lastInsertRowid);

  const student = addUser('Aina Pelajar', 'pelajar@demo.upsi', 'KSAB', 5000, 'D20231000001');
  q.run("INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at) VALUES (?, 'ADJUST', 5000, 5000, 'Kredit demo', ?)", student, now);

  const year = 365 * 864e5;
  const tutorHours = JSON.stringify({ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '21:00' });
  // items: [title, description, price, kind?, duration_min?]
  const shops = [
    {
      owner: ['Kak Ros', 'nasilemak@demo.upsi', 'KSAB'],
      shop: ['Nasi Lemak Royale KSAB', 'Makanan & Minuman', 'KSAB', 'Nasi lemak panas beraroma dengan pelbagai lauk pauk. Penghantaran ke blok kediaman KSAB!', '7:00 pagi – 2:00 petang', 100, 500, 'Semester', 3500],
      items: [
        ['Nasi Lemak Ayam Goreng Berempah', 'Sambal padu, telur rebus & timun', 700],
        ['Nasi Lemak Paru Goreng', 'Paru goreng rangup berempah', 650],
        ['Teh O Ais Madu', 'Ais segar manis madu', 250]
      ]
    },
    {
      owner: ['Abang Farhan', 'prebet@demo.upsi', 'KSAS'],
      shop: ['Abang Prebet Express (KSAB ⇄ KSAS)', 'Prebet & Transport', 'KSAS', 'Servis ulang-alik Tanjung Malim, KTM, KSAS dan KSAB. Kereta MPV selesa, dipandu cermat. Kereta sewa harian juga tersedia.', 'Setiap hari, 7:00 pagi – 11:00 malam', 0, 0, 'Tahunan', 6000],
      items: [
        ['KSAB ⇄ KSAS (satu hala)', 'Harga seorang. Ambil di mana-mana blok kediaman.', 400, 'ROUTE'],
        ['Kampus → Stesen KTM Tanjung Malim', 'Harga seorang. Sesuai untuk balik kampung.', 500, 'ROUTE'],
        ['Kampus → Aeon Rawang / Bandar Behrang', 'Harga seorang, pergi-balik.', 1500, 'ROUTE']
      ],
      vehicles: [
        ['Perodua Bezza 1.3 (Auto)', 'PKX 2231', 5, 'AUTO', 8000, 5000, 'Minyak penuh semasa ambil, pulangkan penuh. Lesen P tidak dibenarkan.'],
        ['Perodua Alza (7 tempat duduk)', 'WYB 8812', 7, 'AUTO', 13000, 10000, 'Sesuai untuk rombongan & balik kampung beramai-ramai.']
      ]
    },
    {
      owner: ['Hafiz Runner', 'print@demo.upsi', 'TM'],
      shop: ['Runner Print & Assignment Pro', 'Servis Runner', 'TM', 'Servis cetak tugasan A4, hard binding, dan runner hantar terus ke bilik kolej anda.', 'Isnin – Sabtu, 9:00 pagi – 10:00 malam', 200, 300, 'Bulanan', 1000],
      items: [
        ['Print Hitam Putih (Per Muka)', 'Kertas 80gsm berkualiti', 15],
        ['Print Warna (Per Muka)', 'Sesuai untuk graf & laporan', 50],
        ['Comb Binding + Cover Transparent', 'Termasuk plastik depan/belakang', 350]
      ]
    },
    {
      owner: ['Cikgu Amir', 'tutor@demo.upsi', 'KSAB'],
      shop: ['Tutor Matematik & Statistik Cikgu Amir', 'Tutor & Akademik', 'KSAB', 'Kelas tuisyen 1-ke-1 untuk Kalkulus, Statistik & SPSS. Di perpustakaan atau dalam talian.', 'Isnin – Sabtu, 9:00 pagi – 9:00 malam', 0, 0, 'Semester', 3500],
      hours: tutorHours,
      items: [
        ['Tuisyen Kalkulus (1 jam)', '1-ke-1, termasuk latihan tambahan', 3000, 'SERVICE', 60],
        ['Bimbingan SPSS / Analisis Data (2 jam)', 'Bawa data kajian anda', 7000, 'SERVICE', 120],
        ['Semakan Tugasan Statistik (30 min)', 'Semakan pantas sebelum hantar', 1500, 'SERVICE', 30]
      ]
    }
  ];

  for (const s of shops) {
    const owner = addUser(s.owner[0], s.owner[1], s.owner[2], 0, null);
    const [name, category, campus, description, hours, fee, min, pkg, price] = s.shop;
    const shopId = Number(q.run(
      `INSERT INTO shops (owner_id, name, category, campus, description, hours, delivery_fee, min_order, status, package, license_fee, license_until, booking_hours, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?)`,
      owner, name, category, campus, description, hours, fee, min, pkg, price, now + year, s.hours || null, now
    ).lastInsertRowid);
    for (const [title, desc, p, kind = 'PRODUCT', duration = null] of s.items) {
      q.run('INSERT INTO items (shop_id, title, description, price, kind, duration_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', shopId, title, desc, p, kind, duration, now);
    }
    for (const [model, plate, seats, trans, rate, deposit, notes] of s.vehicles || []) {
      q.run('INSERT INTO vehicles (shop_id, model, plate, seats, transmission, daily_rate, deposit, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        shopId, model, plate, seats, trans, rate, deposit, notes, now);
    }
  }

  // Student-to-student listings
  const seller = addUser('Danial Senior', 'senior@demo.upsi', 'KSAS', 0, 'D20201000777');
  const listing = (kind, category, title, description, price, extra = {}) =>
    q.run(`INSERT INTO listings (user_id, kind, category, title, description, price, negotiable, condition, campus, location, meta, stock, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      extra.user || seller, kind, category, title, description, price, extra.negotiable ? 1 : 0, extra.condition || null,
      extra.campus || 'KSAS', extra.location || '', JSON.stringify(extra.meta || {}), extra.stock ?? null, now, now);
  listing('ITEM', 'Buku & Nota', 'Buku Teks Psikologi Pendidikan (Edisi ke-3)', 'Ada sedikit highlight. Sesuai untuk kursus KPF3012.', 2500, { negotiable: true, condition: 'BAIK', location: 'Kolej Ungku Omar', stock: 1 });
  listing('ITEM', 'Perabot & Barang Bilik', 'Kipas Meja KDK + Rak Buku Plastik', 'Pindah keluar kolej, jual murah. Ambil sendiri.', 4000, { negotiable: true, condition: 'BAIK', location: 'KSAS Blok C', stock: 1 });
  listing('ITEM', 'Elektronik & Gajet', 'Kalkulator Saintifik Casio fx-570EX', 'Guna satu semester sahaja, macam baru.', 4500, { condition: 'SEPERTI_BARU', location: 'Perpustakaan Tuanku Bainun', stock: 1 });
  listing('ROOM', null, 'Bilik Sederhana Taman Bernam Jaya – Pelajar Perempuan', 'Rumah teres 2 tingkat, 5 minit ke KSAS. WiFi & mesin basuh disediakan.', 30000, {
    location: 'Taman Bernam Jaya',
    meta: { room_type: 'BILIK_SINGLE', gender: 'PEREMPUAN', available_from: new Date(now + 7 * 864e5).toISOString().slice(0, 10), deposit_note: '1 bulan + RM100 utiliti', booking_fee: 5000, facilities: ['WIFI', 'MESIN_BASUH', 'PERABOT', 'PARKING'] }
  });
  listing('ROOM', null, 'Master Bedroom Proton City – Lelaki', 'Bilik master dengan bilik air sendiri & aircond.', 45000, {
    campus: 'TM', location: 'Proton City Fasa 2',
    meta: { room_type: 'MASTER', gender: 'LELAKI', available_from: new Date(now).toISOString().slice(0, 10), deposit_note: '2 bulan', booking_fee: 10000, facilities: ['WIFI', 'AIRCOND', 'BILIK_AIR_SENDIRI', 'PERABOT'] }
  });
  listing('JOB', null, 'Pembantu Kafe Hujung Minggu', 'Kafe di Bandar Behrang perlukan 2 pembantu. Sabtu & Ahad.', 900, {
    campus: 'TM', location: 'Bandar Behrang 2020', meta: { pay_unit: 'JAM', employer: 'Kafe Kopi Kampus', schedule: 'Sabtu & Ahad, 10 pagi – 6 petang' }
  });
  listing('EVENT', null, 'Malam Kebudayaan UPSI 2026', 'Persembahan tarian, muzik tradisional & gerai makanan.', 1000, {
    location: 'Dewan Tuanku Canselor', stock: 200, meta: { event_at: now + 10 * 864e5, venue: 'Dewan Tuanku Canselor, KSAS' }
  });
  listing('LOST', null, 'Hilang: Kad Matrik & Dompet Hitam', 'Tercicir sekitar kafeteria KSAB petang semalam. Sesiapa jumpa sila chat.', null, {
    campus: 'KSAB', location: 'Kafeteria KSAB', meta: { type: 'LOST', date: new Date(now - 864e5).toISOString().slice(0, 10) }
  });
}
