// "My wallets": private per-member watch lists. Kept apart from the Penthouse roster, so
// member wallets never appear in the leaderboard, live buys or rotation.
import db from './db.js';
import { fromDataUrl, savePfp, deletePfp, pfpVersions } from './pfp.js';
import { positions, walletStats } from './stats.js';

const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function validAddress(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
  return bytes + s.match(/^1*/)[0].length === 32; // a Solana public key is exactly 32 bytes
}

export const LIMITS = () => ({ perUser: +process.env.USER_WALLET_LIMIT || 25, global: +process.env.USER_WALLET_GLOBAL_CAP || 500 });
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 32);

const q = {
  count: db.prepare('SELECT COUNT(*) n FROM user_wallets WHERE discord_id=?'),
  has: db.prepare('SELECT 1 FROM user_wallets WHERE discord_id=? AND address=?'),
  ins: db.prepare('INSERT INTO user_wallets(discord_id,address,label,added_ts) VALUES(?,?,?,?)'),
  del: db.prepare('DELETE FROM user_wallets WHERE discord_id=? AND address=?'),
  others: db.prepare('SELECT 1 FROM user_wallets WHERE address=? LIMIT 1'),
  onRoster: db.prepare('SELECT status FROM wallets WHERE address=?'),
  extCount: db.prepare('SELECT COUNT(DISTINCT address) n FROM user_wallets WHERE address NOT IN (SELECT address FROM wallets)'),
  mine: db.prepare('SELECT address,label,added_ts FROM user_wallets WHERE discord_id=? ORDER BY added_ts DESC'),
  ext: db.prepare('SELECT synced_ts FROM ext_wallets WHERE address=?'),
  trades: db.prepare('SELECT * FROM trades WHERE wallet=? AND ts>=? ORDER BY ts'),
  recent: db.prepare(`SELECT t.sig,t.mint,t.side,t.sol,t.ts,m.symbol FROM trades t LEFT JOIN token_meta m ON m.mint=t.mint WHERE t.wallet=? ORDER BY t.ts DESC LIMIT 8`),
  ages: db.prepare('SELECT mint, created_ts FROM tokens WHERE created_ts IS NOT NULL AND mint IN (SELECT DISTINCT mint FROM trades WHERE wallet=?)'),
  dropTrades: db.prepare('DELETE FROM trades WHERE wallet=?'),
  dropExt: db.prepare('DELETE FROM ext_wallets WHERE address=?'),
};

/** Throws Error('bad_address' | 'limit' | 'global_cap' | 'exists'). */
export function addWallet(discordId, address, label) {
  address = String(address ?? '').trim();
  if (!validAddress(address)) throw new Error('bad_address');
  const lim = LIMITS();
  return db.transaction(() => {
    if (q.has.get(discordId, address)) throw new Error('exists');
    if (q.count.get(discordId).n >= lim.perUser) throw new Error('limit');
    const known = q.onRoster.get(address) || q.others.get(address);
    if (!known && q.extCount.get().n >= lim.global) throw new Error('global_cap');
    q.ins.run(discordId, address, clean(label), Math.floor(Date.now() / 1000));
    return { address, needs_backfill: !q.onRoster.get(address) };
  })();
}

export function removeWallet(discordId, address) {
  return db.transaction(() => {
    const r = q.del.run(discordId, String(address));
    // nobody else tracks it and it is not on the roster: drop its data
    deletePfp(discordId, String(address));
    if (r.changes && !q.others.get(address) && !q.onRoster.get(address)) { q.dropTrades.run(address); q.dropExt.run(address); }
    return r.changes > 0;
  })();
}

export function listWallets(discordId) {
  const lim = LIMITS(), now = Math.floor(Date.now() / 1000), since = now - 30 * 86400;
  const mineRows = q.mine.all(discordId), pv = pfpVersions(discordId, mineRows.map((w) => w.address));
  const wallets = mineRows.map((w) => {
    const trades = q.trades.all(w.address, since);
    const ages = Object.fromEntries(q.ages.all(w.address).map((t) => [t.mint, t.created_ts]));
    const roster = q.onRoster.get(w.address);
    const synced = !!roster || (q.ext.get(w.address)?.synced_ts || 0) > 0;
    const s = walletStats(positions(trades, ages));
    return {
      address: w.address, label: w.label, pfp_v: pv.get(w.address) ?? null, added_ts: w.added_ts, roster_status: roster?.status ?? null, pending: !synced,
      swaps_30d: trades.length, last_trade_ts: trades.length ? trades[trades.length - 1].ts : null,
      buys_24h: trades.filter((t) => t.side === 'buy' && t.ts >= now - 86400).length,
      stats: s.trades ? s : null,
      recent: q.recent.all(w.address).map((t) => ({ mint: t.mint, symbol: t.symbol, side: t.side, sol: Math.round(t.sol * 100) / 100, ts: t.ts })),
    };
  });
  return { limit: lim.perUser, wallets, note: 'Only you can see this list. Realized PnL only (closed portions), in SOL, average-cost basis, last 30 days. Past performance is not a prediction.' };
}

/** Throws Error('not_tracked' | 'bad_image' | 'too_big'). */
export function setMinePfp(discordId, address, dataUrl) {
  if (!q.has.get(discordId, String(address))) throw new Error('not_tracked');
  savePfp(discordId, address, fromDataUrl(dataUrl));
}
export function clearMinePfp(discordId, address) {
  if (!q.has.get(discordId, String(address))) throw new Error('not_tracked');
  deletePfp(discordId, address);
}
