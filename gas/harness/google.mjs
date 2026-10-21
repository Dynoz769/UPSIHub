// In-memory stand-ins for the Google Apps Script services UPSIHub uses, faithful enough
// to run gas/dist/Code.gs under Node: Sheets type coercion, CacheService size limits,
// Drive files and folders, script properties, locks and triggers.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Sheets turns text that looks like a number or boolean into one, like the real thing.
function coerce(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith('=')) throw new Error(`Formula written to sheet: ${v.slice(0, 40)}`);
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const src = this.sheet.cells[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.cols; c++) { const v = src[this.col - 1 + c]; line.push(v === undefined || v === null ? '' : v); }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.rows || values.some((l) => l.length !== this.cols)) throw new Error('setValues: dimensions do not match range');
    if (this.row - 1 + this.rows > this.sheet.maxRows) throw new Error('Range exceeds sheet rows');
    values.forEach((line, r) => {
      const dest = (this.sheet.cells[this.row - 1 + r] ||= []);
      line.forEach((v, c) => {
        if (typeof v === 'string' && v.length > 50000) throw new Error('Cell text longer than 50000 characters');
        dest[this.col - 1 + c] = coerce(v);
      });
    });
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.rows; r++) {
      const line = this.sheet.cells[this.row - 1 + r];
      if (line) for (let c = 0; c < this.cols; c++) line[this.col - 1 + c] = '';
    }
    return this;
  }
}

class Sheet {
  constructor(name) { this.name = name; this.cells = []; this.maxRows = 1000; this.frozen = 0; }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.cells.length; r > 0; r--) if ((this.cells[r - 1] || []).some((v) => v !== '' && v != null)) return r;
    return 0;
  }
  getLastColumn() { return this.cells.reduce((m, l) => { let n = (l || []).length; while (n && (l[n - 1] === '' || l[n - 1] == null)) n--; return Math.max(m, n); }, 0); }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; return this; }
  getRange(row, col, rows = 1, cols = 1) {
    if (row < 1 || col < 1 || rows < 1 || cols < 1) throw new Error(`Bad range ${row},${col},${rows},${cols}`);
    return new Range(this, row, col, rows, cols);
  }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  setFrozenRows(n) { this.frozen = n; return this; }
}

export function createGoogle({ now = () => Date.now() } = {}) {
  const store = { spreadsheets: new Map(), files: new Map(), folders: new Map(), props: new Map(), cache: new Map(), triggers: [], stats: { reads: 0, writes: 0 } };
  let nextId = 1;
  const newId = (p) => `${p}${(nextId++).toString(36).padStart(6, '0')}${randomUUID().slice(0, 8)}`;

  class Spreadsheet {
    constructor(name) { this.id = newId('ss'); this.name = name; this.sheets = [new Sheet('Sheet1')]; }
    getId() { return this.id; }
    getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
    getName() { return this.name; }
    getSheets() { return this.sheets; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(n) {
      if (this.getSheetByName(n)) throw new Error(`Sheet ${n} exists`);
      const s = new Sheet(n);
      this.sheets.push(s);
      return s;
    }
  }
  const SpreadsheetApp = {
    create(name) {
      const ss = new Spreadsheet(name);
      store.spreadsheets.set(ss.id, ss);
      store.files.set(ss.id, driveFile(ss.id, name, 'application/vnd.google-apps.spreadsheet', 0, null));
      return ss;
    },
    openById(id) {
      const ss = store.spreadsheets.get(id);
      if (!ss) throw new Error(`No spreadsheet ${id}`);
      return ss;
    }
  };

  function driveFile(id, name, mime, size, folder) {
    return {
      id, name, mime, size, folder, trashed: false, created: new Date(now()), sharing: null, bytes: null,
      getId() { return this.id; },
      getName() { return this.name; },
      getSize() { return this.size; },
      getUrl() { return `https://drive.google.com/file/d/${this.id}/view`; },
      getDateCreated() { return this.created; },
      isTrashed() { return this.trashed; },
      setTrashed(t) { this.trashed = !!t; return this; },
      setSharing(access, perm) { this.sharing = [access, perm]; return this; },
      makeCopy(copyName, dest) {
        const copy = driveFile(newId('f'), copyName, this.mime, this.size, dest.id);
        const ss = store.spreadsheets.get(this.id);
        if (ss) {
          const dup = new Spreadsheet(copyName);
          dup.id = copy.id;
          dup.sheets = ss.sheets.map((s) => { const n = new Sheet(s.name); n.cells = s.cells.map((l) => [...(l || [])]); n.maxRows = s.maxRows; return n; });
          store.spreadsheets.set(dup.id, dup);
        }
        store.files.set(copy.id, copy);
        return copy;
      }
    };
  }
  function folder(id, name) {
    return {
      id, name,
      getId() { return this.id; },
      getName() { return this.name; },
      createFile(blob) {
        const f = driveFile(newId('f'), blob.getName(), blob.getContentType(), blob.getBytes().length, this.id);
        f.bytes = blob.getBytes();
        store.files.set(f.id, f);
        return f;
      },
      getFiles() {
        const list = [...store.files.values()].filter((f) => f.folder === this.id && !f.trashed);
        let i = 0;
        return { hasNext: () => i < list.length, next: () => list[i++] };
      }
    };
  }
  const DriveApp = {
    Access: { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    createFolder(name) { const f = folder(newId('d'), name); store.folders.set(f.id, f); return f; },
    getFolderById(id) { const f = store.folders.get(id); if (!f) throw new Error('No folder'); return f; },
    getFileById(id) { const f = store.files.get(id); if (!f) throw new Error('No file'); return f; }
  };

  // Script cache: string values up to 100KB, keys up to 250 chars, TTL ≤ 6h.
  const live = (k) => { const e = store.cache.get(k); if (!e) return null; if (e.exp <= now()) { store.cache.delete(k); return null; } return e.v; };
  const putOne = (k, v, ttl = 600) => {
    if (typeof v !== 'string') throw new Error('Cache values must be strings');
    if (k.length > 250) throw new Error('Cache key too long');
    if (Buffer.byteLength(v) > 100 * 1024) throw new Error(`Argument too large: cache value for ${k}`);
    store.cache.set(k, { v, exp: now() + Math.min(21600, ttl) * 1000 });
  };
  const scriptCache = {
    get: live,
    getAll: (keys) => Object.fromEntries(keys.map((k) => [k, live(k)]).filter(([, v]) => v != null)),
    put: putOne,
    putAll: (obj, ttl) => Object.entries(obj).forEach(([k, v]) => putOne(k, v, ttl)),
    remove: (k) => { store.cache.delete(k); },
    removeAll: (keys) => keys.forEach((k) => store.cache.delete(k))
  };
  const CacheService = { getScriptCache: () => scriptCache };

  const lock = { held: false, tryLock() { this.held = true; return true; }, waitLock() { this.held = true; }, releaseLock() { this.held = false; }, hasLock() { return this.held; } };
  const LockService = { getScriptLock: () => lock };

  const props = {
    getProperty: (k) => (store.props.has(k) ? store.props.get(k) : null),
    setProperty(k, v) { store.props.set(k, String(v)); return this; },
    deleteProperty(k) { store.props.delete(k); return this; },
    getProperties: () => Object.fromEntries(store.props)
  };
  const PropertiesService = { getScriptProperties: () => props };

  // Apps Script byte arrays are signed Java bytes.
  const signed = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
  const unsigned = (arr) => Buffer.from(arr.map((b) => b & 255));
  const Utilities = {
    getUuid: () => randomUUID(),
    newBlob(data, type = 'text/plain', name = null) {
      const bytes = typeof data === 'string' ? signed(Buffer.from(data, 'utf8')) : [...data];
      return { getBytes: () => bytes, getContentType: () => type, getName: () => name, getDataAsString: () => unsigned(bytes).toString('utf8') };
    },
    computeHmacSha256Signature(value, key) {
      const v = typeof value === 'string' ? Buffer.from(value) : unsigned(value);
      const k = typeof key === 'string' ? Buffer.from(key) : unsigned(key);
      return signed(createHmac('sha256', k).update(v).digest());
    },
    base64Encode: (b) => (typeof b === 'string' ? Buffer.from(b) : unsigned(b)).toString('base64'),
    base64Decode: (s) => signed(Buffer.from(s, 'base64'))
  };

  const ScriptApp = {
    getProjectTriggers: () => store.triggers.map((t) => ({ getHandlerFunction: () => t.fn })),
    newTrigger(fn) {
      const b = { timeBased: () => b, everyMinutes: () => b, everyDays: () => b, atHour: () => b, create: () => { store.triggers.push({ fn }); return {}; } };
      return b;
    }
  };
  const HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
    createHtmlOutputFromFile: (name) => {
      const out = { name, setTitle: () => out, addMetaTag: () => out, setXFrameOptionsMode: () => out };
      return out;
    }
  };

  return { store, globals: { SpreadsheetApp, DriveApp, CacheService, LockService, PropertiesService, Utilities, ScriptApp, HtmlService } };
}

// Loads Code.gs into a fresh V8 context with the mocks above.
export function loadScript(codePath, opts) {
  const google = createGoogle(opts);
  const context = vm.createContext({ ...google.globals, console, Date, Math, JSON });
  vm.runInContext(readFileSync(codePath, 'utf8'), context, { filename: 'Code.gs' });
  return { context, store: google.store };
}
