// Integration tests: boots the real server against a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'upsihub-test-'));
let server;

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: 'admin-pass-123', DEMO: '1', RELEASE_SWEEP_MS: '200' },
    stdio: 'pipe'
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/config`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { server.kill(); rmSync(dataDir, { recursive: true, force: true }); });

// Minimal cookie-keeping client.
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
const sessions = new Map(); // reuse logins so the login rate limit isn't hit
async function loginAs(email, password = 'demo1234') {
  if (sessions.has(email)) return sessions.get(email);
  const c = client();
  const r = await c('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, r.body.error);
  sessions.set(email, c);
  return c;
}
const balance = async (c) => (await c('GET', '/api/wallet')).body.balance;

async function placeOrder(stu, shopPrefix = 'Nasi Lemak', qty = 2) {
  const shop = (await stu('GET', '/api/shops')).body.shops.find((s) => s.name.startsWith(shopPrefix));
  const item = (await stu('GET', `/api/shops/${shop.id}`)).body.items[0];
  const r = await stu('POST', '/api/orders', { shopId: shop.id, items: [{ id: item.id, qty }], payment: 'WALLET', fulfilment: 'PICKUP' });
  assert.equal(r.status, 200, r.body.error);
  return r.body.order;
}
async function sellerCompletes(ven, id) {
  for (const status of ['ACCEPTED', 'READY', 'COMPLETED']) {
    const s = await ven('POST', `/api/orders/${id}/status`, { status });
    assert.equal(s.status, 200, s.body.error);
  }
}

test('wallet order is held, then paid to seller on completion', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const ven = await loginAs('nasilemak@demo.upsi');
  const { body: { shops } } = await stu('GET', '/api/shops');
  const shop = shops.find((s) => s.name.startsWith('Nasi Lemak'));
  const { body: detail } = await stu('GET', `/api/shops/${shop.id}`);
  const item = detail.items[0];

  const stuBefore = await balance(stu);
  const venBefore = await balance(ven);
  const r = await stu('POST', '/api/orders', { shopId: shop.id, items: [{ id: item.id, qty: 2 }], payment: 'WALLET', fulfilment: 'DELIVERY', address: 'Blok A' });
  assert.equal(r.status, 200, r.body.error);
  const total = item.price * 2 + shop.delivery_fee;
  assert.equal(r.body.order.total, total);
  assert.equal(await balance(stu), stuBefore - total);
  assert.equal(await balance(ven), venBefore, 'seller is not paid before completion');

  const id = r.body.order.id;
  // Buyer cannot accept their own order.
  assert.equal((await stu('POST', `/api/orders/${id}/status`, { status: 'ACCEPTED' })).status, 400);
  await sellerCompletes(ven, id);
  assert.equal(await balance(ven), venBefore, 'seller-marked completion keeps money held for the buyer');
  assert.equal((await ven('POST', `/api/orders/${id}/confirm`)).status, 403, 'seller cannot release their own payment');
  assert.equal((await stu('POST', `/api/orders/${id}/confirm`)).status, 200);
  assert.equal(await balance(ven), venBefore + total);
  assert.equal((await stu('POST', `/api/orders/${id}/confirm`)).status, 400, 'cannot release twice');

  const rev = await stu('POST', `/api/orders/${id}/review`, { rating: 5, comment: 'Mantap' });
  assert.equal(rev.status, 200);
  assert.equal((await stu('POST', `/api/orders/${id}/review`, { rating: 5 })).status, 409);
});

test('rejected order refunds the buyer in full', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const ven = await loginAs('nasilemak@demo.upsi');
  const shop = (await stu('GET', '/api/shops')).body.shops.find((s) => s.name.startsWith('Nasi Lemak'));
  const item = (await stu('GET', `/api/shops/${shop.id}`)).body.items[0];
  const before = await balance(stu);
  const r = await stu('POST', '/api/orders', { shopId: shop.id, items: [{ id: item.id, qty: 1 }], payment: 'WALLET', fulfilment: 'PICKUP' });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(await balance(stu), before - item.price);
  const rej = await ven('POST', `/api/orders/${r.body.order.id}/status`, { status: 'REJECTED', reason: 'Habis' });
  assert.equal(rej.status, 200);
  assert.equal(await balance(stu), before);
});

test('cannot overspend the wallet or order below minimum', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const shop = (await stu('GET', '/api/shops')).body.shops.find((s) => s.name.startsWith('Runner Print'));
  const items = (await stu('GET', `/api/shops/${shop.id}`)).body.items;
  const pricey = items.reduce((a, b) => (a.price > b.price ? a : b));
  const r = await stu('POST', '/api/orders', { shopId: shop.id, items: [{ id: pricey.id, qty: 50 }], payment: 'WALLET', fulfilment: 'PICKUP' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Baki/);

  const nl = (await stu('GET', '/api/shops')).body.shops.find((s) => s.name.startsWith('Nasi Lemak'));
  const cheap = (await stu('GET', `/api/shops/${nl.id}`)).body.items.find((i) => i.price < nl.min_order);
  const m = await stu('POST', '/api/orders', { shopId: nl.id, items: [{ id: cheap.id, qty: 1 }], payment: 'WALLET', fulfilment: 'PICKUP' });
  assert.equal(m.status, 400);
  assert.match(m.body.error, /minimum/);
});

test('top-up only credits after admin approval; transfers need password', async () => {
  const u = client();
  assert.equal((await u('POST', '/api/auth/register', { name: 'Uji Satu', email: 'uji1@test.my', password: 'password1' })).status, 200);
  assert.equal(await balance(u), 0);
  assert.equal((await u('POST', '/api/wallet/topup', { amount: 2000, method: 'BANK', reference: 'X1' })).status, 200);
  assert.equal(await balance(u), 0, 'not credited before approval');

  const admin = await loginAs('admin@upsihub.local', 'admin-pass-123');
  const { body: { topups } } = await admin('GET', '/api/admin/topups');
  const t = topups.find((x) => x.email === 'uji1@test.my');
  assert.equal((await admin('POST', `/api/admin/topups/${t.id}/approve`, {})).status, 200);
  assert.equal((await admin('POST', `/api/admin/topups/${t.id}/approve`, {})).status, 400, 'cannot approve twice');
  assert.equal(await balance(u), 2000);

  assert.equal((await u('POST', '/api/wallet/transfer', { to: 'pelajar@demo.upsi', amount: 500, password: 'wrong' })).status, 400);
  assert.equal((await u('POST', '/api/wallet/transfer', { to: 'pelajar@demo.upsi', amount: 500, password: 'password1' })).status, 200);
  assert.equal(await balance(u), 1500);
});

test('shop application charges licence fee and refunds on rejection', async () => {
  const u = client();
  await u('POST', '/api/auth/register', { name: 'Uji Dua', email: 'uji2@test.my', password: 'password1' });
  const admin = await loginAs('admin@upsihub.local', 'admin-pass-123');
  const { body: { users } } = await admin('GET', '/api/admin/users?q=uji2');
  await admin('POST', `/api/admin/users/${users[0].id}/credit`, { amount: 5000, note: 'Tunai kaunter' });

  const apply = await u('POST', '/api/seller/apply', { name: 'Kedai Uji', category: 'Servis Lain', campus: 'KSAB', description: 'Servis ujian untuk pelajar.', package: 'Semester' });
  assert.equal(apply.status, 200, apply.body.error);
  assert.equal(await balance(u), 1500);
  const shops = (await admin('GET', '/api/admin/shops')).body.shops;
  const s = shops.find((x) => x.name === 'Kedai Uji');
  assert.equal((await u('GET', '/api/shops')).body.shops.some((x) => x.id === s.id), false, 'pending shop is hidden');
  await admin('POST', `/api/admin/shops/${s.id}/reject`, { reason: 'Ujian' });
  assert.equal(await balance(u), 5000);
});

test('access control: guests, non-owners and non-admins are blocked', async () => {
  const guest = client();
  assert.equal((await guest('GET', '/api/wallet')).status, 401);
  assert.equal((await guest('POST', '/api/orders', {})).status, 401);
  const stu = await loginAs('pelajar@demo.upsi');
  assert.equal((await stu('GET', '/api/admin/overview')).status, 403);
  assert.equal((await stu('GET', '/api/orders/1')).status, 200);
  const other = await loginAs('print@demo.upsi');
  assert.equal((await other('GET', '/api/orders/1')).status, 404, 'unrelated user cannot see order');
  // Form-encoded cross-site posts are rejected.
  const res = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(res.status, 415);
});

test('chat messages are private to participants', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const shop = (await stu('GET', '/api/shops')).body.shops[0];
  const { body: { chat } } = await stu('POST', '/api/chats', { shopId: shop.id });
  assert.equal((await stu('POST', `/api/chats/${chat.id}/messages`, { body: 'Hai <b>peniaga</b>' })).status, 200);
  const outsider = await loginAs('print@demo.upsi');
  if (shop.name.startsWith('Runner')) return; // outsider happens to be the owner
  assert.equal((await outsider('GET', `/api/chats/${chat.id}/messages`)).status, 404);
});

test('buyer confirming receipt pays the seller immediately', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const ven = await loginAs('nasilemak@demo.upsi');
  const o = await placeOrder(stu);
  const before = await balance(ven);
  await ven('POST', `/api/orders/${o.id}/status`, { status: 'ACCEPTED' });
  await ven('POST', `/api/orders/${o.id}/status`, { status: 'READY' });
  assert.equal((await stu('POST', `/api/orders/${o.id}/status`, { status: 'COMPLETED' })).status, 200);
  assert.equal(await balance(ven), before + o.total);
});

test('dispute freezes money and full refund returns it to the buyer', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const ven = await loginAs('nasilemak@demo.upsi');
  const admin = await loginAs('admin@upsihub.local', 'admin-pass-123');
  const stuStart = await balance(stu);
  const venStart = await balance(ven);
  const o = await placeOrder(stu);
  await sellerCompletes(ven, o.id);

  assert.equal((await ven('POST', `/api/orders/${o.id}/dispute`, { reason: 'OTHER', details: 'Bukan pembeli ni' })).status, 403);
  assert.equal((await stu('POST', `/api/orders/${o.id}/dispute`, { reason: 'NOT_RECEIVED', details: 'pendek' })).status, 400, 'details too short');
  const d = await stu('POST', `/api/orders/${o.id}/dispute`, { reason: 'NOT_RECEIVED', details: 'Saya tidak terima apa-apa langsung.' });
  assert.equal(d.status, 200, d.body.error);
  assert.equal(d.body.order.status, 'DISPUTED');
  assert.equal((await stu('POST', `/api/orders/${o.id}/dispute`, { reason: 'OTHER', details: 'Laporan kedua sekali lagi' })).status, 409);
  // Nobody can move a disputed order or release its money outside the admin decision.
  assert.equal((await stu('POST', `/api/orders/${o.id}/confirm`)).status, 400);
  assert.equal((await ven('POST', `/api/orders/${o.id}/status`, { status: 'COMPLETED' })).status, 400);

  assert.equal((await ven('POST', `/api/orders/${o.id}/dispute/respond`, { response: 'Sudah dihantar ke bilik jam 1 petang.' })).status, 200);
  const { body: { disputes } } = await admin('GET', '/api/admin/disputes');
  const dispute = disputes.find((x) => x.order_id === o.id);
  assert.equal(dispute.seller_response, 'Sudah dihantar ke bilik jam 1 petang.');

  const r = await admin('POST', `/api/admin/disputes/${dispute.id}/resolve`, { outcome: 'REFUND', note: 'Tiada bukti penghantaran.' });
  assert.equal(r.status, 200, r.body.error);
  assert.equal(await balance(stu), stuStart);
  assert.equal(await balance(ven), venStart);
  assert.equal((await admin('POST', `/api/admin/disputes/${dispute.id}/resolve`, { outcome: 'RELEASE', note: 'Cuba lagi' })).status, 400, 'cannot resolve twice');
  assert.equal((await stu('GET', `/api/orders/${o.id}`)).body.order.status, 'CANCELLED');
});

test('split decision divides held money exactly', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const ven = await loginAs('nasilemak@demo.upsi');
  const admin = await loginAs('admin@upsihub.local', 'admin-pass-123');
  const stuStart = await balance(stu);
  const venStart = await balance(ven);
  const o = await placeOrder(stu);
  await ven('POST', `/api/orders/${o.id}/status`, { status: 'ACCEPTED' });
  const opened = await stu('POST', `/api/orders/${o.id}/dispute`, { reason: 'WRONG_ITEM', details: 'Dapat satu sahaja, order dua.' });
  assert.equal(opened.status, 200, opened.body.error);
  const dispute = (await admin('GET', '/api/admin/disputes')).body.disputes.find((x) => x.order_id === o.id);
  assert.equal((await admin('POST', `/api/admin/disputes/${dispute.id}/resolve`, { outcome: 'SPLIT', refund: o.total, note: 'Tidak sah' })).status, 400, 'split must leave something for each side');
  const refund = Math.floor(o.total / 2);
  const res = await admin('POST', `/api/admin/disputes/${dispute.id}/resolve`, { outcome: 'SPLIT', refund, note: 'Satu item sahaja dihantar.' });
  assert.equal(res.status, 200, res.body.error);
  assert.equal(await balance(stu), stuStart - o.total + refund);
  assert.equal(await balance(ven), venStart + o.total - refund);
});

test('held money auto-releases to the seller after the dispute window', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const ven = await loginAs('nasilemak@demo.upsi');
  const o = await placeOrder(stu);
  await sellerCompletes(ven, o.id);
  const before = await balance(ven);
  const held = (await stu('GET', `/api/orders/${o.id}`)).body.order;
  assert.equal(held.payout, 'HELD');
  assert.ok(held.release_at > Date.now() + 47 * 3600e3);

  // Fast-forward: pretend the 48 hours have passed.
  const db = new DatabaseSync(path.join(dataDir, 'upsihub.db'));
  db.prepare('UPDATE orders SET release_at = ? WHERE id = ?').run(Date.now() - 1, o.id);
  db.close();
  for (let i = 0; i < 30 && (await balance(ven)) === before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await balance(ven), before + o.total);
  assert.equal((await stu('POST', `/api/orders/${o.id}/dispute`, { reason: 'OTHER', details: 'Terlambat untuk melapor.' })).status, 400, 'too late once released');
});

test('cash orders cannot be disputed in-app', async () => {
  const stu = await loginAs('pelajar@demo.upsi');
  const ven = await loginAs('nasilemak@demo.upsi');
  const shop = (await stu('GET', '/api/shops')).body.shops.find((s) => s.name.startsWith('Nasi Lemak'));
  const item = (await stu('GET', `/api/shops/${shop.id}`)).body.items[0];
  const o = (await stu('POST', '/api/orders', { shopId: shop.id, items: [{ id: item.id, qty: 1 }], payment: 'CASH', fulfilment: 'PICKUP' })).body.order;
  await ven('POST', `/api/orders/${o.id}/status`, { status: 'ACCEPTED' });
  assert.equal((await stu('POST', `/api/orders/${o.id}/dispute`, { reason: 'OTHER', details: 'Masalah dengan pesanan tunai.' })).status, 400);
});
