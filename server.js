// UPSIHub server – zero external dependencies (Node >= 22.13).
import http from 'node:http';
import { mkdirSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, bootstrap } from './src/db.js';
import { createApi, HttpError, STREAMING } from './src/api.js';
import { createBackups } from './src/backup.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DEMO = process.env.DEMO !== '0';
const MAX_BODY = 4 * 1024 * 1024;

mkdirSync(UPLOADS_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'upsihub.db'));
const adminEmail = (process.env.ADMIN_EMAIL || 'admin@upsihub.local').toLowerCase();
const { generatedPassword } = bootstrap(db, { adminEmail, adminPassword: process.env.ADMIN_PASSWORD, demo: DEMO });
const backups = createBackups(db, path.join(DATA_DIR, 'backups'), { keep: Number(process.env.BACKUP_KEEP) || 14 });
const { routes } = createApi({ db, uploadsDir: UPLOADS_DIR, demo: DEMO, backups });

// Startup health check: structure + wallet ledger.
const integrity = db.integrity();
if (integrity.join() !== 'ok') console.error('  ⚠️  Semakan integriti database GAGAL:', integrity);
const mismatches = db.ledgerMismatches();
if (mismatches.length) console.error(`  ⚠️  ${mismatches.length} baki dompet tidak sepadan dengan lejar:`, mismatches);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon'
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Data terlalu besar.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON tidak sah.')); }
    });
    req.on('error', reject);
  });
}

function sessionUser(req) {
  const m = /(?:^|;\s*)uh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (!m) return { token: null, user: null };
  const row = db.one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                      WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'`, m[1], Date.now());
  return { token: m[1], user: row || null };
}

async function handleApi(req, res, url) {
  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route) {
    const pathExists = routes.some((r) => r.re.test(url.pathname));
    return sendJson(res, pathExists ? 405 : 404, { error: 'Laluan API tidak dijumpai.' });
  }
  const match = route.re.exec(url.pathname);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
  try {
    // State-changing requests must be JSON (blocks cross-site form posts).
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type mesti application/json.');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const { token, user } = sessionUser(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const out = await route.handler({ req, res, url, query: url.searchParams, params, body, user, token, ip });
    if (out === STREAMING) return;
    sendJson(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Ralat pelayan. Sila cuba lagi.' });
  }
}

function serveFile(res, file, { cache = false } = {}) {
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': cache ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS
  });
  createReadStream(file).pipe(res);
  return true;
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return sendJson(res, 400, { error: 'Bad path' }); }
  if (pathname.startsWith('/uploads/')) {
    const file = safeJoin(UPLOADS_DIR, pathname.slice('/uploads/'.length));
    if (file && serveFile(res, file, { cache: true })) return;
    return sendJson(res, 404, { error: 'Not found' });
  }
  const file = safeJoin(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (file && serveFile(res, file)) return;
  // SPA fallback for client-side routes.
  if (!path.extname(pathname)) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  sendJson(res, 404, { error: 'Not found' });
});

// Expire old sessions once an hour.
setInterval(() => db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 3600e3).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  UPSIHub berjalan di http://localhost:${PORT}\n`);
  if (generatedPassword) {
    console.log(`  Akaun pentadbir dicipta:\n    E-mel       : ${adminEmail}\n    Kata laluan : ${generatedPassword}\n  (Simpan kata laluan ini. Tetapkan ADMIN_PASSWORD untuk memilih sendiri.)\n`);
  }
  if (DEMO) console.log('  Mod demo aktif – akaun demo: pelajar@demo.upsi / demo1234 (set DEMO=0 untuk matikan)\n');
});

export { server };
