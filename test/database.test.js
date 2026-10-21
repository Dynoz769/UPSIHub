// Database safety rules, health checks, backups and photo uploads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 4100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'upsihub-db-'));
let server;
// UPSIHUB_SERVER=gas/harness/server.mjs runs the same tests against the Google Apps Script build.
const SERVER = process.env.UPSIHUB_SERVER || 'server.js';
const GAS = SERVER.includes('gas');
// Edits a row behind the app's back (like changing the database or spreadsheet by hand).
async function editRow(table, id, sql, params, gasChange) {
  if (GAS) {
    const r = await fetch(`${BASE}/__test/update`, { method: 'POST', body: JSON.stringify({ table, id, ...gasChange }) });
    assert.equal(r.status, 200);
    return;
  }
  const db = new DatabaseSync(path.join(dataDir, 'upsihub.db'));
  db.prepare(sql).run(...params, id);
  db.close();
}

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: 'admin-pass-123', DEMO: '1' },
    stdio: 'pipe'
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { server.kill(); rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const c = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return c;
}
const sessions = new Map();
async function as(email, password = 'demo1234') {
  if (sessions.has(email)) return sessions.get(email);
  const c = client();
  const r = await c('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, r.body.error);
  sessions.set(email, c);
  return c;
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function upload(c) {
  const r = await c('POST', '/api/upload', { data: PNG });
  assert.equal(r.status, 200, r.body.error);
  return r.body.url;
}
const openDb = () => new DatabaseSync(path.join(dataDir, 'upsihub.db'));

test('health check flags data corrupted by hand in the spreadsheet', { skip: !GAS && 'Apps Script build only' }, async () => {
  const admin = await as('admin@upsihub.local', 'admin-pass-123');
  assert.deepEqual((await admin('GET', '/api/admin/system')).body.integrity, ['ok']);
  await editRow('listings', 1, '', [], { set: { stock: -1 } });
  assert.ok((await admin('GET', '/api/admin/system')).body.integrity.some((i) => /Stok negatif/.test(i)));
  await editRow('listings', 1, '', [], { set: { stock: 1 } });
  assert.deepEqual((await admin('GET', '/api/admin/system')).body.integrity, ['ok']);
});

test('database rules block corrupt money and ratings even outside the app', { skip: GAS && 'SQLite triggers (Node build only)' }, () => {
  const db = openDb();
  const tryRun = (sql, ...p) => { try { db.prepare(sql).run(...p); return null; } catch (e) { return e.message; } };
  assert.match(tryRun('UPDATE users SET balance = -100 WHERE id = 1'), /negatif/);
  assert.match(tryRun('UPDATE transactions SET amount = 999999'), /tidak boleh diubah/);
  assert.match(tryRun('DELETE FROM transactions'), /tidak boleh dipadam/);
  assert.match(tryRun("INSERT INTO orders (code, kind, user_id, seller_id, status, payment, fulfilment, subtotal, delivery_fee, deposit, total, created_at, updated_at) VALUES ('X1','ORDER',1,1,'PENDING','CASH','PICKUP',100,0,0,999,0,0)"), /tidak konsisten/);
  assert.match(tryRun("UPDATE listings SET stock = -1 WHERE id = 1"), /Stok/);
  db.close();
});

test('health check, backup and download (admin only)', async () => {
  const admin = await as('admin@upsihub.local', 'admin-pass-123');
  const sys = (await admin('GET', '/api/admin/system')).body;
  assert.deepEqual(sys.integrity, ['ok']);
  assert.equal(sys.ledger_mismatches.length, 0);
  const stu = await as('pelajar@demo.upsi');
  if (GAS) {
    // Backups are copies of the spreadsheet in the owner's Drive, opened from Drive.
    const r = await admin('POST', '/api/admin/backups');
    assert.equal(r.status, 200, r.body.error);
    const b = (await admin('GET', '/api/admin/system')).body.backups.find((x) => x.name === r.body.name);
    assert.match(b.url, /^https:\/\/drive\.google\.com\//);
    assert.equal((await stu('POST', '/api/admin/backups')).status, 403);
    assert.equal((await stu('GET', '/api/admin/system')).status, 403);
    return;
  }
  assert.ok(sys.triggers.length >= 10);
  assert.ok(sys.backups.length >= 1, 'a backup is taken on first start');

  const r = await admin('POST', '/api/admin/backups');
  assert.equal(r.status, 200, r.body.error);
  assert.ok(existsSync(path.join(dataDir, 'backups', r.body.name)));
  const dl = await admin('GET', `/api/admin/backups/${r.body.name}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.subarray(0, 15).toString(), 'SQLite format 3');
  // The backup is a complete, readable database.
  const copy = new DatabaseSync(path.join(dataDir, 'backups', r.body.name));
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 5);
  copy.close();

  assert.equal((await admin('GET', '/api/admin/backups/..%2Fupsihub.db')).status, 404, 'no path traversal');
  assert.equal((await stu('GET', `/api/admin/backups/${r.body.name}`)).status, 403);
  assert.equal((await stu('POST', '/api/admin/backups')).status, 403);
});

test('products and vehicles take up to 5 photos; first is the cover', async () => {
  const drv = await as('prebet@demo.upsi');
  const pics = [await upload(drv), await upload(drv), await upload(drv)];
  const item = await drv('POST', '/api/seller/items', { title: 'Trip Kampus → Aeon', price: 1200, kind: 'ROUTE', images: pics });
  assert.equal(item.status, 200, item.body.error);
  assert.deepEqual(item.body.item.images, pics);
  assert.equal(item.body.item.image, pics[0]);
  const six = Array(6).fill(pics[0]);
  assert.equal((await drv('POST', '/api/seller/items', { title: 'Terlalu banyak', price: 100, images: six })).status, 400);
  assert.equal((await drv('POST', '/api/seller/items', { title: 'Gambar luar', price: 100, images: ['https://evil.example/x.png'] })).status, 400, 'only our own uploads');

  const veh = await drv('POST', '/api/seller/vehicles', { model: 'Proton Saga 1.3', plate: 'ABC 123', daily_rate: 7000, deposit: 5000, images: pics });
  assert.equal(veh.status, 200, veh.body.error);
  assert.equal(veh.body.vehicle.images.length, 3);
  const pub = (await client()('GET', `/api/vehicles/${veh.body.vehicle.id}`)).body.vehicle;
  assert.equal(pub.images.length, 3);
  assert.equal(pub.image, pics[0]);
});

test('reviews can carry up to 3 photos, for shops and individual sellers', async () => {
  const buyer = await as('pelajar@demo.upsi');
  const seller = await as('senior@demo.upsi');
  const item = (await buyer('GET', '/api/listings?kind=ITEM&q=kalkulator')).body.listings[0];
  const o = (await buyer('POST', `/api/listings/${item.id}/buy`, { payment: 'WALLET' })).body.order;
  for (const status of ['ACCEPTED', 'READY', 'COMPLETED']) await seller('POST', `/api/orders/${o.id}/status`, { status });
  await buyer('POST', `/api/orders/${o.id}/confirm`);
  const pics = [await upload(buyer), await upload(buyer), await upload(buyer), await upload(buyer)];
  assert.equal((await buyer('POST', `/api/orders/${o.id}/review`, { rating: 5, images: pics })).status, 400, 'max 3 photos');
  const r = await buyer('POST', `/api/orders/${o.id}/review`, { rating: 5, comment: 'Seperti dalam gambar', images: pics.slice(0, 2) });
  assert.equal(r.status, 200, r.body.error);
  assert.equal((await buyer('GET', `/api/orders/${o.id}`)).body.order.review.images.length, 2);
  const profile = (await client()('GET', `/api/users/${item.owner.id}`)).body;
  assert.equal(profile.reviews[0].images.length, 2);

  // Ledger still balances after all the money movement.
  const admin = await as('admin@upsihub.local', 'admin-pass-123');
  assert.equal((await admin('GET', '/api/admin/system')).body.ledger_mismatches.length, 0);
});
