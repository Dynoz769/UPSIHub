// Integration tests for the one-stop-centre modules (bookings, listings, categories).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 4000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'upsihub-mod-'));
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
  return async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
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
const balance = async (c) => (await c('GET', '/api/wallet')).body.balance;
const ymd = (daysAhead) => new Date(Date.now() + 8 * 3600e3 + daysAhead * 864e5).toISOString().slice(0, 10);
async function topUp(email, amount) {
  const admin = await as('admin@upsihub.local', 'admin-pass-123');
  const { body: { users } } = await admin('GET', `/api/admin/users?q=${encodeURIComponent(email)}`);
  const r = await admin('POST', `/api/admin/users/${users[0].id}/credit`, { amount, note: 'Kredit ujian' });
  assert.equal(r.status, 200, r.body.error);
}
async function finish(seller, id) {
  for (const status of ['ACCEPTED', 'READY', 'COMPLETED']) {
    const r = await seller('POST', `/api/orders/${id}/status`, { status });
    assert.equal(r.status, 200, r.body.error);
  }
}

test('hub reports every module', async () => {
  const r = await client()('GET', '/api/hub');
  assert.equal(r.status, 200);
  const c = r.body.counts;
  for (const k of ['shops', 'rides', 'vehicles', 'services', 'ITEM', 'ROOM', 'JOB', 'EVENT', 'LOST']) assert.ok(c[k] >= 1, `${k} should have demo data`);
});

test('car rental: overlap blocked, deposit returned to renter on completion', async () => {
  await topUp('pelajar@demo.upsi', 50000);
  const stu = await as('pelajar@demo.upsi');
  const drv = await as('prebet@demo.upsi');
  const { body: { vehicles } } = await stu('GET', '/api/vehicles');
  const v = vehicles.find((x) => x.model.includes('Bezza'));
  const stuStart = await balance(stu);
  const drvStart = await balance(drv);

  const r = await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(3), end_date: ymd(5), pickup: 'KSAS Blok A, 9 pagi' });
  assert.equal(r.status, 200, r.body.error);
  const o = r.body.order;
  assert.equal(o.kind, 'RENTAL');
  assert.equal(o.total, v.daily_rate * 2 + v.deposit);
  assert.equal(await balance(stu), stuStart - o.total);

  const clash = await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(4), end_date: ymd(6) });
  assert.equal(clash.status, 409);
  const back2back = await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(5), end_date: ymd(6) });
  assert.equal(back2back.status, 200, 'return day can be the next pickup day');
  assert.equal((await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(8), end_date: ymd(8) })).status, 400, 'min 1 day');
  assert.equal((await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(10), end_date: ymd(11), payment: 'CASH' })).status, 400, 'rentals are wallet only');

  const booked = (await stu('GET', `/api/vehicles/${v.id}`)).body.booked;
  assert.equal(booked.length, 2);

  await finish(drv, o.id);
  assert.equal((await stu('POST', `/api/orders/${o.id}/confirm`)).status, 200);
  assert.equal(await balance(drv), drvStart + v.daily_rate * 2, 'driver gets rental fee only');
  assert.equal(await balance(stu), stuStart - o.total + v.deposit - back2back.body.order.total, 'renter gets the deposit back');
});

test('rides: booking needs a future time and pickup point', async () => {
  const stu = await as('pelajar@demo.upsi');
  const { body: { shops } } = await stu('GET', '/api/rides');
  const shop = shops[0];
  const route = shop.offers[0];
  const soon = Date.now() + 2 * 3600e3;
  assert.equal((await stu('POST', '/api/bookings', { type: 'RIDE', shopId: shop.id, itemId: route.id, start_at: Date.now() - 1000, pickup: 'Blok A', pax: 2 })).status, 400);
  assert.equal((await stu('POST', '/api/bookings', { type: 'RIDE', shopId: shop.id, itemId: route.id, start_at: soon, pickup: '', pax: 2 })).status, 400);
  const r = await stu('POST', '/api/bookings', { type: 'RIDE', shopId: shop.id, itemId: route.id, start_at: soon, pickup: 'Kolej Za\'ba', pax: 3 });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.order.total, route.price * 3);
  assert.equal(r.body.order.pax, 3);
  // Trip items cannot sneak in through the cart.
  assert.equal((await stu('POST', '/api/orders', { shopId: shop.id, items: [{ id: route.id, qty: 1 }], payment: 'WALLET', fulfilment: 'PICKUP' })).status, 400);
});

test('services: slots respect hours and cannot be double-booked', async () => {
  const stu = await as('pelajar@demo.upsi');
  const { body: { shops } } = await stu('GET', '/api/services');
  const shop = shops.find((s) => s.name.includes('Tutor'));
  const svc = shop.offers.find((x) => x.duration_min === 60);
  // Find the next open day.
  let slots = [];
  for (let d = 1; d < 8 && !slots.length; d++) slots = (await stu('GET', `/api/shops/${shop.id}/slots?item=${svc.id}&date=${ymd(d)}`)).body.slots;
  assert.ok(slots.length > 0);
  assert.equal(slots[0].label, '09:00');
  const pick = slots[0];
  const r = await stu('POST', '/api/bookings', { type: 'SERVICE', shopId: shop.id, itemId: svc.id, start_at: pick.start_at, address: 'Perpustakaan' });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.order.end_at - r.body.order.start_at, 60 * 60e3);

  const other = client();
  await other('POST', '/api/auth/register', { name: 'Pelajar Dua', email: 'dua@test.my', password: 'password1' });
  await topUp('dua@test.my', 10000);
  const again = await other('POST', '/api/bookings', { type: 'SERVICE', shopId: shop.id, itemId: svc.id, start_at: pick.start_at });
  assert.equal(again.status, 409);
  const overlap = await other('POST', '/api/bookings', { type: 'SERVICE', shopId: shop.id, itemId: svc.id, start_at: pick.start_at + 30 * 60e3 });
  assert.equal(overlap.status, 409, '30 minutes in still overlaps a 1-hour booking');
  const offHours = await other('POST', '/api/bookings', { type: 'SERVICE', shopId: shop.id, itemId: svc.id, start_at: pick.start_at - 3 * 3600e3 });
  assert.equal(offHours.status, 400);
  const date = new Date(pick.start_at + 8 * 3600e3).toISOString().slice(0, 10);
  const after = (await other('GET', `/api/shops/${shop.id}/slots?item=${svc.id}&date=${date}`)).body.slots;
  assert.equal(after.find((x) => x.start_at === pick.start_at).free, false);
});

test('second-hand item: reserved on purchase, back on sale if cancelled, sold on completion', async () => {
  const buyer = await as('pelajar@demo.upsi');
  const seller = await as('senior@demo.upsi');
  const { body: { listings } } = await buyer('GET', '/api/listings?kind=ITEM&q=kalkulator');
  const item = listings[0];
  assert.equal(item.status, 'ACTIVE');
  const sellerStart = await balance(seller);

  const r = await buyer('POST', `/api/listings/${item.id}/buy`, { payment: 'WALLET', meet: 'Perpustakaan' });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.order.kind, 'ITEM');
  assert.equal(r.body.order.seller_id, item.owner.id);
  assert.equal((await buyer('GET', `/api/listings/${item.id}`)).body.listing.status, 'RESERVED');
  const dup = await (await (async () => { const c = client(); await c('POST', '/api/auth/login', { email: 'dua@test.my', password: 'password1' }); return c; })())('POST', `/api/listings/${item.id}/buy`, {});
  assert.equal(dup.status, 400, 'reserved item cannot be bought twice');

  // Seller cancels → item is back on sale and buyer is refunded.
  assert.equal((await seller('POST', `/api/orders/${r.body.order.id}/status`, { status: 'REJECTED', reason: 'Dah janji dengan kawan' })).status, 200);
  assert.equal((await buyer('GET', `/api/listings/${item.id}`)).body.listing.status, 'ACTIVE');

  const r2 = await buyer('POST', `/api/listings/${item.id}/buy`, { payment: 'WALLET' });
  assert.equal(r2.status, 200, r2.body.error);
  await finish(seller, r2.body.order.id);
  await buyer('POST', `/api/orders/${r2.body.order.id}/confirm`);
  assert.equal((await buyer('GET', `/api/listings/${item.id}`)).body.listing.status, 'SOLD');
  assert.equal(await balance(seller), sellerStart + item.price);
  // Second-hand orders can still be disputed like any other order.
  assert.ok((await buyer('GET', `/api/orders/${r2.body.order.id}`)).body.order.listing);

  // Buyer rates the individual seller; it shows on the seller's profile and listings.
  assert.equal((await seller('POST', `/api/orders/${r2.body.order.id}/review`, { rating: 5 })).status, 403);
  const rev = await buyer('POST', `/api/orders/${r2.body.order.id}/review`, { rating: 4, comment: 'Barang macam baru, penjual mesra' });
  assert.equal(rev.status, 200, rev.body.error);
  assert.equal((await buyer('POST', `/api/orders/${r2.body.order.id}/review`, { rating: 5 })).status, 409);
  const profile = (await client()('GET', `/api/users/${item.owner.id}`)).body;
  assert.equal(profile.user.rating, 4);
  assert.equal(profile.user.reviews, 1);
  assert.equal(profile.reviews[0].title, item.title);
  const again = (await client()('GET', `/api/listings/${item.id}`)).body.listing;
  assert.equal(again.owner.reviews, 1);
});

test('post, edit, report and remove a listing', async () => {
  const u = await as('pelajar@demo.upsi');
  const bad = await u('POST', '/api/listings', { kind: 'ITEM', title: 'Kasut', description: 'pendek', campus: 'KSAB' });
  assert.equal(bad.status, 400);
  const r = await u('POST', '/api/listings', {
    kind: 'ITEM', title: 'Kasut Futsal Nike saiz 8', description: 'Pakai 3 kali sahaja, tiada kecacatan.', campus: 'KSAB',
    category: 'Sukan & Hobi', price: 8000, negotiable: true, condition: 'SEPERTI_BARU', location: 'KSAB'
  });
  assert.equal(r.status, 200, r.body.error);
  const id = r.body.listing.id;
  assert.equal((await u('PATCH', `/api/listings/${id}`, { price: 7000 })).body.listing.price, 7000);
  const other = await as('nasilemak@demo.upsi');
  assert.equal((await other('PATCH', `/api/listings/${id}`, { price: 1 })).status, 403);
  assert.equal((await other('POST', `/api/listings/${id}/report`, { reason: 'Harga mengelirukan' })).status, 200);
  assert.equal((await other('POST', `/api/listings/${id}/report`, { reason: 'Lapor lagi sekali' })).status, 409);

  const admin = await as('admin@upsihub.local', 'admin-pass-123');
  const reported = (await admin('GET', '/api/admin/listings?f=reported')).body.listings;
  assert.ok(reported.some((l) => l.id === id));
  assert.equal((await admin('POST', `/api/admin/listings/${id}/remove`, { reason: 'Melanggar syarat' })).status, 200);
  assert.equal((await other('GET', `/api/listings/${id}`)).status, 404, 'removed listing hidden from public');
  assert.equal((await u('GET', `/api/listings/${id}`)).status, 200, 'owner can still see it');
});

test('room deposit and event tickets', async () => {
  const stu = await as('pelajar@demo.upsi');
  const owner = await as('senior@demo.upsi');
  const room = (await stu('GET', '/api/listings?kind=ROOM&gender=PEREMPUAN')).body.listings[0];
  assert.ok(room.meta.booking_fee > 0);
  const r = await stu('POST', `/api/listings/${room.id}/buy`, {});
  assert.equal(r.status, 200, r.body.error);
  assert.equal(r.body.order.total, room.meta.booking_fee);
  assert.equal(r.body.order.kind, 'ROOM');
  assert.equal((await stu('GET', `/api/listings/${room.id}`)).body.listing.status, 'RESERVED');
  await finish(owner, r.body.order.id);
  await stu('POST', `/api/orders/${r.body.order.id}/confirm`);
  assert.equal((await stu('GET', `/api/listings/${room.id}`)).body.listing.status, 'CLOSED');

  const ev = (await stu('GET', '/api/listings?kind=EVENT')).body.listings[0];
  const t = await stu('POST', `/api/listings/${ev.id}/buy`, { qty: 3 });
  assert.equal(t.status, 200, t.body.error);
  assert.equal(t.body.order.total, ev.price * 3);
  assert.equal((await stu('GET', `/api/listings/${ev.id}`)).body.listing.stock, ev.stock - 3);
  assert.equal((await stu('POST', `/api/listings/${ev.id}/buy`, { qty: 11 })).status, 400);

  const job = (await stu('GET', '/api/listings?kind=JOB')).body.listings[0];
  assert.equal((await stu('POST', `/api/listings/${job.id}/buy`, {})).status, 400, 'jobs are contact-only');
});

test('admin manages categories; renaming carries shops along', async () => {
  const admin = await as('admin@upsihub.local', 'admin-pass-123');
  assert.equal((await admin('POST', '/api/admin/categories', { kind: 'shop', name: 'Bunga & Hadiah', emoji: '💐' })).status, 200);
  assert.equal((await admin('POST', '/api/admin/categories', { kind: 'shop', name: 'Bunga & Hadiah' })).status, 409);
  let cfg = (await client()('GET', '/api/config')).body;
  assert.ok(cfg.categories.includes('Bunga & Hadiah'));
  assert.equal(cfg.category_emoji['Bunga & Hadiah'], '💐');

  const cats = (await admin('GET', '/api/admin/categories')).body.categories;
  const food = cats.find((c) => c.kind === 'shop' && c.name === 'Makanan & Minuman');
  assert.ok(food.used >= 1);
  assert.equal((await admin('PATCH', `/api/admin/categories/${food.id}`, { name: 'Makanan & Minuman Kampus' })).status, 200);
  const shops = (await client()('GET', '/api/shops')).body.shops;
  assert.ok(shops.some((s) => s.category === 'Makanan & Minuman Kampus'));
  await admin('PATCH', `/api/admin/categories/${food.id}`, { name: 'Makanan & Minuman' });

  const bunga = cats.find((c) => c.name === 'Bunga & Hadiah');
  await admin('PATCH', `/api/admin/categories/${bunga.id}`, { active: false });
  cfg = (await client()('GET', '/api/config')).body;
  assert.ok(!cfg.categories.includes('Bunga & Hadiah'));
  const stu = await as('pelajar@demo.upsi');
  assert.equal((await stu('GET', '/api/admin/categories')).status, 403);
});

function shiftStart(id, days) {
  // Pretend the car was collected `days` days ago.
  return editRow('orders', id, 'UPDATE orders SET start_at = start_at - ? WHERE id = ?', [days * 864e5], { add: { start_at: -days * 864e5 } });
}

test('rental without a return date: car blocked until returned, actual days charged', async () => {
  await topUp('pelajar@demo.upsi', 100000);
  const drv = await as('prebet@demo.upsi');
  const stu = await as('pelajar@demo.upsi');
  const v = (await stu('GET', '/api/vehicles')).body.vehicles.find((x) => x.model.includes('Alza'));
  const stuStart = await balance(stu);
  const drvStart = await balance(drv);
  const r = await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(0) });
  assert.equal(r.status, 200, r.body.error);
  const o = r.body.order;
  assert.equal(o.end_at, null);
  assert.equal(o.total, v.daily_rate + v.deposit, 'pays 1 day + deposit up front');
  assert.equal((await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(20), end_date: ymd(21) })).status, 409, 'blocked until returned');
  assert.equal((await stu('GET', `/api/vehicles/${v.id}`)).body.booked[0].end_at, null);

  await drv('POST', `/api/orders/${o.id}/status`, { status: 'ACCEPTED' });
  await drv('POST', `/api/orders/${o.id}/status`, { status: 'READY' });
  await shiftStart(o.id, 3);
  assert.equal((await drv('POST', `/api/orders/${o.id}/status`, { status: 'COMPLETED', return_date: ymd(5) })).status, 400, 'return date cannot be in the future');
  const done = await drv('POST', `/api/orders/${o.id}/status`, { status: 'COMPLETED', return_date: ymd(0) });
  assert.equal(done.status, 200, done.body.error);
  assert.equal(done.body.order.items[0].qty, 3);
  assert.equal(done.body.order.subtotal, v.daily_rate * 3);
  assert.equal(await balance(stu), stuStart - v.daily_rate * 3 - v.deposit, 'extra 2 days taken from wallet');
  await stu('POST', `/api/orders/${o.id}/confirm`);
  assert.equal(await balance(stu), stuStart - v.daily_rate * 3, 'deposit returned in full');
  assert.equal(await balance(drv), drvStart + v.daily_rate * 3);
  const later = await stu('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(20), end_date: ymd(21) });
  assert.equal(later.status, 200, 'car free again once returned');
  await stu('POST', `/api/orders/${later.body.order.id}/status`, { status: 'CANCELLED' });
});

test('open rental with an empty wallet: shortfall comes out of the deposit', async () => {
  const drv = await as('prebet@demo.upsi');
  const u = client();
  await u('POST', '/api/auth/register', { name: 'Penyewa Tiga', email: 'tiga@test.my', password: 'password1' });
  const v = (await u('GET', '/api/vehicles')).body.vehicles.find((x) => x.model.includes('Alza'));
  await topUp('tiga@test.my', v.daily_rate + v.deposit);
  const r = await u('POST', '/api/bookings', { type: 'RENTAL', vehicleId: v.id, start_date: ymd(0) });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(await balance(u), 0);
  const drvStart = await balance(drv);
  await drv('POST', `/api/orders/${r.body.order.id}/status`, { status: 'ACCEPTED' });
  await drv('POST', `/api/orders/${r.body.order.id}/status`, { status: 'READY' });
  await shiftStart(r.body.order.id, 3);
  const done = await drv('POST', `/api/orders/${r.body.order.id}/status`, { status: 'COMPLETED', return_date: ymd(0) });
  assert.equal(done.status, 200, done.body.error);
  assert.equal(done.body.order.deposit, 0, 'whole deposit used towards rent');
  assert.match(done.body.order.note, /Baki sewa belum dibayar/);
  await u('POST', `/api/orders/${r.body.order.id}/confirm`);
  assert.equal(await balance(drv), drvStart + v.daily_rate + v.deposit);
  assert.equal(await balance(u), 0);
});
