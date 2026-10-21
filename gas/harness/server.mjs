// Runs the Apps Script build (gas/dist/Code.gs) behind a local HTTP server so the normal
// test suites and a browser can exercise it. Cookies are mapped to the token the Apps
// Script API expects, and "/" serves Index.html with a google.script.run shim.
//
//   node gas/build.mjs && PORT=3000 DEMO=1 ADMIN_PASSWORD=secret123 node gas/harness/server.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScript } from './google.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { context: gas, store } = loadScript(join(dist, 'Code.gs'));
const call = (method, path, body, token) => JSON.parse(gas.api(method, path, body ?? null, token ?? null));

gas.setup();
if (process.env.DEMO === '1') gas.setupDemo();
if (process.env.ADMIN_PASSWORD) {
  const r = call('POST', '/api/setup/admin', { name: 'Pentadbir UPSIHub', email: process.env.ADMIN_EMAIL || 'admin@upsihub.local', password: process.env.ADMIN_PASSWORD });
  if (r.status !== 200 && r.status !== 409) throw new Error(r.body.error);
}
// Stand-in for the 10-minute time trigger.
const sweepMs = Number(process.env.RELEASE_SWEEP_MS) || 0;
if (sweepMs) setInterval(() => gas.scheduledTasks(), sweepMs).unref();

const shim = `<script>
window.google = { script: { get run() {
  let ok = () => {}, bad = () => {};
  const runner = {
    withSuccessHandler(f) { ok = f; return runner; },
    withFailureHandler(f) { bad = f; return runner; },
    api(...args) {
      fetch('/__gas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
        .then((r) => r.text()).then(ok, bad);
    }
  };
  return runner;
} } };
</script>`;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(join(dist, 'Index.html'), 'utf8').replace('<head>', `<head>\n${shim}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'POST' && url.pathname === '/__gas') {
      const [method, path, body, token] = await readBody(req);
      return send(res, 200, gas.api(method, path, body, token));
    }
    // Test hooks standing in for editing the spreadsheet by hand.
    if (req.method === 'POST' && url.pathname === '/__test/update') {
      const { table, id, set, add } = await readBody(req);
      gas.DB.reset(true);
      const t = gas.T(table);
      const row = t.get(id);
      if (!row) return send(res, 404, { error: 'no row' });
      const changes = { ...set };
      for (const [k, v] of Object.entries(add || {})) changes[k] = row[k] + v;
      t.update(row, changes);
      gas.DB.flush();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__test/sheet') {
      const { table } = await readBody(req);
      const ss = gas.DB.spreadsheet();
      return send(res, 200, { values: ss.getSheetByName(table).getDataRange().getValues(), backups: store.files.size });
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    const token = /(?:^|;\s*)uh_token=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null;
    const body = req.method === 'GET' ? null : await readBody(req);
    const out = call(req.method, url.pathname + url.search, body, token);
    const headers = {};
    if (out.body?.token) headers['set-cookie'] = `uh_token=${out.body.token}; Path=/; HttpOnly`;
    if (url.pathname === '/api/auth/logout') headers['set-cookie'] = 'uh_token=; Path=/; Max-Age=0';
    send(res, out.status, out.body, headers);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: String(err) });
  }
}).listen(Number(process.env.PORT) || 3000, process.env.HOST || '127.0.0.1', () => {
  console.log(`UPSIHub (Apps Script harness) on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`);
});
