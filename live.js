// Live pings: Helius pushes enhanced transactions for the active roster to the webhook; we record them
// and turn them into events the dashboard shows as small notifications.
import db from './db.js';
import { parseSwap } from './parse.js';
import { pfpVersions } from './pfp.js';

const MIN_SOL = () => (process.env.PING_MIN_SOL == null ? 1 : +process.env.PING_MIN_SOL || 0);
const LAUNCHY = /MINT|CREATE|LAUNCH|INITIALIZE/i;

const q = {
  watched: db.prepare("SELECT address, name, role FROM wallets WHERE status='active' AND role IN ('trader','dev','both')"),
  insTrade: db.prepare('INSERT OR IGNORE INTO trades(sig,wallet,mint,side,tokens,sol,ts) VALUES(?,?,?,?,?,?,?)'),
  insEvent: db.prepare('INSERT OR IGNORE INTO events(ts,kind,address,name,mint,symbol,sol,sig) VALUES(?,?,?,?,?,?,?,?)'),
  launched: db.prepare("SELECT 1 FROM events WHERE kind='dev_launch' AND mint=?"),
  meta: db.prepare('SELECT symbol, image, fetched_ts FROM token_meta WHERE mint=?'),
  setMeta: db.prepare(`INSERT INTO token_meta(mint,name,symbol,created_ts,fetched_ts,image) VALUES(?,?,?,?,?,?)
    ON CONFLICT(mint) DO UPDATE SET name=COALESCE(excluded.name,name), symbol=COALESCE(excluded.symbol,symbol), created_ts=COALESCE(excluded.created_ts,created_ts), fetched_ts=excluded.fetched_ts, image=COALESCE(excluded.image,image)`),
  prune: db.prepare('DELETE FROM events WHERE ts < ?'),
  recent: db.prepare('SELECT e.id,e.ts,e.kind,e.name,e.address,e.mint,COALESCE(e.symbol,m.symbol) symbol,e.sol,m.image FROM events e LEFT JOIN token_meta m ON m.mint=e.mint ORDER BY e.id DESC LIMIT ?'),
  after: db.prepare('SELECT e.id,e.ts,e.kind,e.name,e.address,e.mint,COALESCE(e.symbol,m.symbol) symbol,e.sol,m.image FROM events e LEFT JOIN token_meta m ON m.mint=e.mint WHERE e.id > ? ORDER BY e.id LIMIT ?'),
  latest: db.prepare('SELECT COALESCE(MAX(id),0) id FROM events'),
};

let cache = null;
function watched() {
  if (!cache || Date.now() - cache.t > 60000) cache = { t: Date.now(), map: new Map(q.watched.all().map((w) => [w.address, w])) };
  return cache.map;
}
export const resetWatched = () => { cache = null; };

const imgOk = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]{4,280}$/.test(u) ? u : null);
// Name and picture of a coin. Best effort: a brand-new token may not be listed anywhere yet.
async function symbolOf(mint, fetchFn = fetch) {
  const row = q.meta.get(mint), now = Math.floor(Date.now() / 1000);
  if (row?.symbol && (row.image || now - (row.fetched_ts || 0) < 3600)) return row.symbol;
  try {
    const d = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json());
    const p = (d.pairs || []).find((x) => x.baseToken?.address === mint);
    const image = imgOk(p?.info?.imageUrl);
    if (p?.baseToken?.symbol || image) q.setMeta.run(mint, p?.baseToken?.name || null, p?.baseToken?.symbol || null, p?.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null, now, image);
    return p?.baseToken?.symbol || row?.symbol || null;
  } catch { return row?.symbol || null; }
}

/** txs: array of Helius enhanced transactions. deps lets tests swap the network pieces. Returns the number of events recorded. */
export async function handleTransactions(txs, { px = null, creatorOf, fetchFn = fetch } = {}) {
  const map = watched(), min = MIN_SOL();
  let made = 0;
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx || tx.transactionError || !tx.signature) continue;
    const involved = new Set([tx.feePayer, ...(tx.accountData || []).map((a) => a.account)]);
    for (const addr of involved) {
      const w = map.get(addr);
      if (!w) continue;
      const isDev = w.role === 'dev', ts = tx.timestamp || Math.floor(Date.now() / 1000);
      const swap = parseSwap(tx, addr, px);
      let launchedHere = null;

      // Launch: a tracked dev's transaction touches a token that dev created
      if (w.role === 'dev' || w.role === 'both') {
        const mints = [...new Set((tx.tokenTransfers || []).map((t) => t.mint))].filter((m) => m && !px?.quotes?.has(m) && !q.launched.get(m));
        for (const m of mints) {
          let mine = false;
          if (m.endsWith('pump') && creatorOf) mine = (await creatorOf(m)) === addr;
          else if (tx.feePayer === addr && LAUNCHY.test(String(tx.type || ''))) mine = true; // other launchpads: only trust an explicit create/mint transaction
          if (!mine) continue;
          const sym = await symbolOf(m, fetchFn);
          if (q.insEvent.run(ts, 'dev_launch', addr, w.name, m, sym, swap?.mint === m ? Math.round(swap.sol * 100) / 100 : null, tx.signature).changes) { made++; launchedHere = m; }
        }
      }
      if (!swap) continue;

      // Trader trades are also stored, so wallet stats stay current between cycles (devs are events only)
      if (!isDev) q.insTrade.run(swap.sig, addr, swap.mint, swap.side, swap.tokens, swap.sol, swap.ts);
      if (swap.sol < min || swap.mint === launchedHere) continue;
      if (isDev && swap.side !== 'buy') continue; // dev sells are not pinged
      const kind = `${isDev ? 'dev' : 'trader'}_${swap.side}`;
      const sym = await symbolOf(swap.mint, fetchFn);
      if (q.insEvent.run(swap.ts, kind, addr, w.name, swap.mint, sym, Math.round(swap.sol * 100) / 100, swap.sig).changes) made++;
    }
  }
  if (made) q.prune.run(Math.floor(Date.now() / 1000) - 7 * 86400);
  return made;
}

export function eventsFeed(after, viewer = '') {
  const latest = q.latest.get().id;
  const rows = after == null ? q.recent.all(15).reverse() : q.after.all(after, 25);
  const pv = pfpVersions(viewer, rows.map((e) => e.address));
  const events = rows.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, name: e.name || `${e.address.slice(0, 4)}…${e.address.slice(-4)}`, address: e.address,
    mint: e.mint, symbol: e.symbol, sol: e.sol, image: e.image || null, pfp_v: pv.get(e.address) ?? null }));
  return after == null ? { latest, events, baseline: true } : { latest, events };
}
