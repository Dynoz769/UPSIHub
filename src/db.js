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
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  status TEXT NOT NULL,
  payment TEXT NOT NULL,
  fulfilment TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL,
  total INTEGER NOT NULL,
  commission INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_shop ON items(shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_shop ON orders(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews(shop_id);
`;

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

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

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
  if (student) {
    q.run("INSERT INTO transactions (user_id, type, amount, balance_after, description, created_at) VALUES (?, 'ADJUST', 5000, 5000, 'Kredit demo', ?)", student, now);
  }

  const year = 365 * 864e5;
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
      shop: ['Abang Prebet Express (KSAB ⇄ KSAS)', 'Prebet & Transport', 'KSAS', 'Servis ulang-alik Tanjung Malim, KTM, KSAS dan KSAB. Kereta MPV selesa, dipandu cermat.', 'Setiap hari, 7:00 pagi – 11:00 malam', 0, 0, 'Tahunan', 6000],
      items: [
        ['Trip KSAB ke KSAS (Satu Hala)', 'Per kepala (min 3 orang)', 400],
        ['Trip Stesen KTM Tanjung Malim', 'Diambil terus dari perhentian bas kampus', 500],
        ['Sewa Kereta + Pemandu (Sehari)', 'Untuk tugasan luaran / rombongan', 12000]
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
    }
  ];

  for (const s of shops) {
    const owner = addUser(s.owner[0], s.owner[1], s.owner[2], 0, null);
    const [name, category, campus, description, hours, fee, min, pkg, price] = s.shop;
    const shopId = Number(q.run(
      `INSERT INTO shops (owner_id, name, category, campus, description, hours, delivery_fee, min_order, status, package, license_fee, license_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?)`,
      owner, name, category, campus, description, hours, fee, min, pkg, price, now + year, now
    ).lastInsertRowid);
    for (const [title, desc, p] of s.items) {
      q.run('INSERT INTO items (shop_id, title, description, price, created_at) VALUES (?, ?, ?, ?, ?)', shopId, title, desc, p, now);
    }
  }
}
