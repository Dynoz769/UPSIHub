// Input validation shared by all API modules. Errors carry an HTTP status.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export function text(v, label, { min = 0, max = 500, optional = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (!s && optional) return '';
  if (s.length < Math.max(min, optional ? 0 : 1)) fail(400, `${label} diperlukan${min > 1 ? ` (min ${min} aksara)` : ''}.`);
  if (s.length > max) fail(400, `${label} terlalu panjang (maks ${max} aksara).`);
  return s;
}
export function sen(v, label, { min = 0, max = 10000000 } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} tidak sah.`);
  return n;
}
export function oneOf(v, list, label) {
  if (!list.includes(v)) fail(400, `${label} tidak sah.`);
  return v;
}
export function uploadRef(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\/uploads\/[A-Za-z0-9_-]+\.(png|jpg|webp|gif)$/.test(v)) fail(400, 'Rujukan gambar tidak sah.');
  return v;
}
export function uploadList(v, max = 5) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) fail(400, `Maksimum ${max} gambar.`);
  return v.map(uploadRef).filter(Boolean);
}
// 'YYYY-MM-DD' → that day's midnight in Malaysia time (UTC+8, no DST), as epoch ms.
export const MY_OFFSET = 8 * 3600e3;
export function myDate(v, label) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) fail(400, `${label} tidak sah.`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - MY_OFFSET;
}
export const rm = (n) => `RM${(n / 100).toFixed(2)}`;
