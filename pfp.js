// Wallet profile pictures. owner "" = set by staff for a roster wallet; owner = a member's Discord id = that member's private photo.
import db from './db.js';

export const MAX_BYTES = 150 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Real file type from the first bytes (never trust what the client says). */
export function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
/** "data:image/png;base64,...." -> Buffer. Throws Error('bad_image'). */
export function fromDataUrl(s) {
  const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(s ?? ''));
  if (!m) throw new Error('bad_image');
  return Buffer.from(m[1], 'base64');
}

const q = {
  put: db.prepare('INSERT OR REPLACE INTO wallet_pfps(owner,address,mime,data,updated_ts) VALUES(?,?,?,?,?)'),
  del: db.prepare('DELETE FROM wallet_pfps WHERE owner=? AND address=?'),
  one: db.prepare('SELECT mime,data,updated_ts FROM wallet_pfps WHERE owner=? AND address=?'),
};
/** Throws Error('too_big' | 'bad_image'). */
export function savePfp(owner, address, buf) {
  if (!buf?.length || buf.length > MAX_BYTES) throw new Error('too_big');
  const mime = sniff(buf);
  if (!mime) throw new Error('bad_image');
  q.put.run(owner, address, mime, buf, Math.floor(Date.now() / 1000));
}
export const deletePfp = (owner, address) => q.del.run(owner, address).changes > 0;
/** The member's own photo wins, then the roster photo. */
export const getPfp = (owner, address) => q.one.get(owner, address) || q.one.get('', address) || null;

/** address -> version (updated_ts) for every address that has a photo this viewer should see. */
export function pfpVersions(owner, addresses) {
  const list = [...new Set(addresses)].filter(Boolean);
  const out = new Map();
  if (!list.length) return out;
  const rows = db.prepare(`SELECT address, owner, updated_ts FROM wallet_pfps WHERE owner IN (?, '') AND address IN (${list.map(() => '?').join(',')})`).all(owner, ...list);
  for (const r of rows) if (r.owner === owner || !out.has(r.address)) out.set(r.address, r.updated_ts);
  return out;
}
