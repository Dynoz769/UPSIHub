// Daily database backups using SQLite's online VACUUM INTO (consistent while the app runs).
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const DAY = 864e5;

export function createBackups(db, dir, { keep = 14 } = {}) {
  mkdirSync(dir, { recursive: true });
  const list = () => readdirSync(dir)
    .filter((f) => /^upsihub-\d{8}-\d{6}-\d{3}\.db$/.test(f))
    .map((f) => ({ name: f, size: statSync(path.join(dir, f)).size, created_at: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.created_at - a.created_at);

  function run() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `upsihub-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}.db`;
    db.backupTo(path.join(dir, name));
    for (const old of list().slice(keep)) unlinkSync(path.join(dir, old.name));
    return name;
  }

  function maybeRun() {
    const last = list()[0];
    if (!last || Date.now() - last.created_at > DAY) {
      try { console.log(`  Sandaran database: ${run()}`); } catch (err) { console.error('Backup failed:', err); }
    }
  }
  maybeRun();
  setInterval(maybeRun, 3600e3).unref();

  // Only plain backup file names are ever resolved, so no path traversal.
  const fileFor = (name) => (/^upsihub-\d{8}-\d{6}-\d{3}\.db$/.test(name) ? path.join(dir, name) : null);
  return { run, list, fileFor };
}
