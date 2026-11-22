import 'dotenv/config';
import { creatorOf } from './creator.js';
import db from './db.js';
import { parseSwap } from './parse.js';
import { loadPx, WSOL } from './prices.js';
import { spend, overBudget } from './credits.js';

const KEY = process.env.HELIUS_API_KEY;
if (!KEY) { console.error('Set HELIUS_API_KEY in .env'); process.exit(1); }
const env = process.env;
const C = {
  minPeakFdv: +env.MIN_PEAK_FDV_USD || 1_000_000,  // a "winner" peaked at least this high...
  minGainX: +env.MIN_GAIN_X || 3,                  // ...after a run of at least this multiple inside the window
  minLiq: +env.MIN_LIQ_USD || 10_000,              // and still has real liquidity
  evalLimit: +env.EVAL_LIMIT || 120,               // pools evaluated per run (GeckoTerminal free tier is ~30 calls/min)
  tokensPerRun: +env.TOKENS_PER_RUN || 25,         // new winners analysed per run
  tokenPages: +env.MAX_TOKEN_PAGES || 10,          // 100 swaps per page, newest first
  minBuySol: 0.5, minProfitSol: +env.MIN_TRADER_PROFIT_SOL || 2, perToken: +env.TRADERS_PER_TOKEN || 15,
};
const px = await loadPx();
let quota = false; // set when Helius says the plan's credits are used up
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

// ---------- GeckoTerminal ----------
async function gt(path) {
  await sleep(2200);
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`https://api.geckoterminal.com/api/v2${path}`, { headers: { Accept: 'application/json;version=20230302' } });
    if (r.status === 429) { await sleep(5000 * (a + 1)); continue; }
    if (!r.ok) return null;
    return r.json();
  }
  return null;
}

// Which launchpad a pool came from, judged by its DEX on GeckoTerminal.
// StonkFun runs on Raydium LaunchLab with a non-SOL quote (tokenized stock), so that shows as 'launchlab-paired'.
const labelOf = (dex = '', quote) => /pump/.test(dex) ? 'pumpfun' : /meteora/.test(dex) ? 'meteora'
  : /launchlab/.test(dex) ? (quote && quote !== WSOL ? 'launchlab-paired' : 'launchlab') : dex || 'other';

async function collectPools() {
  const up = db.prepare(`INSERT INTO pools_seen(pool,mint,name,fdv_usd,liq_usd,vol24_usd,last_seen,dex,quote_mint) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pool) DO UPDATE SET fdv_usd=excluded.fdv_usd, liq_usd=excluded.liq_usd, vol24_usd=excluded.vol24_usd, last_seen=excluded.last_seen, dex=excluded.dex, quote_mint=excluded.quote_mint`);
  const daily = db.prepare('INSERT INTO pool_daily(pool,day,mint,vol,fdv) VALUES(?,?,?,?,?) ON CONFLICT(pool,day) DO UPDATE SET vol=MAX(vol,excluded.vol), fdv=MAX(COALESCE(fdv,0),COALESCE(excluded.fdv,0))');
  const addQuote = db.prepare('INSERT OR IGNORE INTO quote_tokens(mint,name,added_ts) VALUES(?,?,?)');
  const feeds = ['/networks/solana/trending_pools?duration=24h', '/networks/solana/trending_pools?duration=6h', '/networks/solana/new_pools'];
  // Launchpad-specific feeds: any Solana DEX whose id/name matches DEX_MATCH (Meteora, LaunchLab, pump...)
  const dexes = await gt('/networks/solana/dexes');
  const re = new RegExp(process.env.DEX_MATCH || 'meteora|launchlab|stonk|pump', 'i');
  const matched = (dexes?.data || []).filter((d) => re.test(d.id) || re.test(d.attributes?.name || '')).slice(0, 8);
  console.log('Launchpad feeds:', matched.map((d) => d.id).join(', ') || 'none matched');
  for (const d of matched) feeds.push(`/networks/solana/dexes/${d.id}/pools`);
  let n = 0;
  for (const f of feeds) for (let page = 1; page <= 3; page++) {
    const d = await gt(`${f}${f.includes('?') ? '&' : '?'}page=${page}`);
    for (const p of d?.data || []) {
      const a = p.attributes, mint = p.relationships?.base_token?.data?.id?.replace('solana_', '');
      const quote = p.relationships?.quote_token?.data?.id?.replace('solana_', '');
      if (!mint) continue;
      up.run(a.address, mint, a.name, +(a.fdv_usd || a.market_cap_usd) || null, +a.reserve_in_usd || null, +a.volume_usd?.h24 || null, now,
        p.relationships?.dex?.data?.id || null, quote || null);
      daily.run(a.address, Math.floor(now / 86400), mint, +a.volume_usd?.h24 || 0, +(a.fdv_usd || a.market_cap_usd) || null);
      if (quote && quote !== WSOL) addQuote.run(quote, (a.name || '').split('/')[1]?.trim() || null, now);
      n++;
    }
  }
  console.log(`Collected ${n} pool sightings`);
}

async function evaluate() {
  const rows = db.prepare(`SELECT * FROM pools_seen WHERE last_seen >= ? AND evaluated_ts < ? AND fdv_usd IS NOT NULL
    ORDER BY vol24_usd DESC LIMIT ?`).all(now - 7 * DAY, now - DAY, C.evalLimit);
  const mark = db.prepare('UPDATE pools_seen SET evaluated_ts=? WHERE pool=?');
  const win = db.prepare('INSERT OR IGNORE INTO winners(mint,pool,name,peak_fdv_usd,gain_x,detected_ts,launchpad) VALUES(?,?,?,?,?,?,?)');
  let found = 0;
  for (const p of rows) {
    const d = await gt(`/networks/solana/pools/${p.pool}/ohlcv/hour?aggregate=1&limit=168&currency=usd`);
    mark.run(now, p.pool);
    const list = (d?.data?.attributes?.ohlcv_list || []).sort((a, b) => a[0] - b[0]); // [ts,o,h,l,c,v]
    if (list.length < 3) continue;
    const last = list[list.length - 1][4];
    let hi = 0, hiIdx = 0;
    list.forEach((c, i) => { if (c[2] > hi) { hi = c[2]; hiIdx = i; } });
    const lowBefore = Math.min(...list.slice(0, hiIdx + 1).map((c) => c[3]).filter((x) => x > 0));
    const gain = hi / lowBefore, peakFdv = p.fdv_usd * (hi / last);
    if (peakFdv >= C.minPeakFdv && gain >= C.minGainX && (p.liq_usd || 0) >= C.minLiq) {
      if (win.run(p.mint, p.pool, p.name, Math.round(peakFdv), Math.round(gain * 10) / 10, now, labelOf(p.dex, p.quote_mint)).changes) found++;
    }
  }
  console.log(`Evaluated ${rows.length} pools, ${found} new winners`);
}

// ---------- Creator (pump.fun bonding curve account) ----------
// Generic fallback for Meteora, LaunchLab/StonkFun and anything else: the signer of the mint's earliest transaction.
// Guarded: if the API ignores sort order, asc and desc return the same tx and we refuse to guess.
async function earliestSigner(mint) {
  if (overBudget()) return null;
  spend(200);
  try {
    const get = async (order) => {
      const u = new URL(`https://api.helius.xyz/v0/addresses/${mint}/transactions`);
      u.searchParams.set('api-key', KEY); u.searchParams.set('limit', '1'); u.searchParams.set('sort-order', order);
      const r = await fetch(u);
      return r.ok ? (await r.json())[0] : null;
    };
    const [first, newest] = [await get('asc'), await get('desc')];
    if (!first || !newest || first.signature === newest.signature) return null;
    return first.feePayer || null;
  } catch { return null; }
}
async function findCreator(w) {
  if (w.launchpad === 'pumpfun' || w.mint.endsWith('pump')) { const c = await creatorOf(w.mint); if (c) return c; }
  return earliestSigner(w.mint);
}

// ---------- Traders who profited on a token ----------
async function topTraders(mint, creator) {
  const agg = new Map();
  let before, tries = 0;
  for (let p = 0; p < C.tokenPages; p++) {
    const u = new URL(`https://api.helius.xyz/v0/addresses/${mint}/transactions`);
    u.searchParams.set('api-key', KEY); u.searchParams.set('limit', '100'); u.searchParams.set('type', 'SWAP');
    if (before) u.searchParams.set('before', before);
    if (overBudget()) { quota = true; break; }
    spend(100);
    const r = await fetch(u);
    if (r.status === 429) { // rate limit: retry a few times; out of credits: give up on this token
      if (/max usage|quota|credits/i.test(await r.text().catch(() => '')) || ++tries > 5) { quota = true; break; }
      await sleep(2000 * tries); p--; continue;
    }
    if (!r.ok) break;
    const txs = await r.json();
    if (!txs.length) break;
    for (const tx of txs) {
      if (tx.timestamp < now - 7 * DAY) { before = null; break; }
      const t = parseSwap(tx, tx.feePayer, px);
      if (!t) continue;
      const a = agg.get(tx.feePayer) || { buySol: 0, buyTok: 0, sellSol: 0, sellTok: 0 };
      if (t.side === 'buy') { a.buySol += t.sol; a.buyTok += t.tokens; } else { a.sellSol += t.sol; a.sellTok += t.tokens; }
      agg.set(tx.feePayer, a);
    }
    if (before === null || txs.length < 100) break;
    before = txs[txs.length - 1].signature;
  }
  // Only wallets whose buys we actually saw (no unmatched sells), so profit is real, not an artifact of sampling
  return [...agg.entries()].filter(([w, a]) => w !== creator && a.buySol >= C.minBuySol && a.sellTok > 0 && a.sellTok <= a.buyTok * 1.02)
    .map(([w, a]) => { const cost = a.buySol * (a.sellTok / a.buyTok); return { w, profit: a.sellSol - cost, mult: a.sellSol / cost }; })
    .filter((x) => x.profit >= C.minProfitSol && x.mult >= 1.5)
    .sort((a, b) => b.profit - a.profit).slice(0, C.perToken);
}

// ---------- Roster inserts ----------
const getW = db.prepare('SELECT role, status FROM wallets WHERE address=?');
const insW = db.prepare("INSERT INTO wallets(address,name,role,status,source,status_since,first_seen,note) VALUES(?,?,?,?,'discovered',?,?,?)");
const setW = db.prepare('UPDATE wallets SET role=?, status=?, status_since=?, streak=0, note=? WHERE address=?');
const ev = db.prepare('INSERT INTO wallet_events(address,ts,from_status,to_status,reason) VALUES(?,?,?,?,?)');
function addWallet(address, role, status, note) {
  const ex = getW.get(address);
  if (!ex) { insW.run(address, `${role}-${address.slice(0, 4)}`, role, status, now, now, note); ev.run(address, now, null, status, note); return true; }
  const newRole = ex.role === role ? role : 'both';
  if (ex.status === 'retired') { setW.run(newRole, status, now, note, address); ev.run(address, now, 'retired', status, `rediscovered: ${note}`); return true; }
  if (ex.role !== newRole) db.prepare('UPDATE wallets SET role=? WHERE address=?').run(newRole, address);
  return false;
}

await collectPools();
await evaluate();

const todo = db.prepare('SELECT * FROM winners WHERE scanned=0 ORDER BY peak_fdv_usd DESC LIMIT ?').all(C.tokensPerRun);
let devs = 0, traders = 0;
for (const w of todo) {
  if (quota) { console.error('Helius quota exhausted: stopping discovery early (resumes next run)'); break; }
  const creator = await findCreator(w);
  const list = await topTraders(w.mint, creator);
  if (quota) continue; // incomplete data: leave this token to be scanned again later
  db.transaction(() => {
    if (creator && addWallet(creator, 'dev', 'active', `launched ${w.name} (peak $${Math.round(w.peak_fdv_usd / 1000)}k FDV)`)) devs++;
    for (const t of list) if (addWallet(t.w, 'trader', 'candidate', `+${t.profit.toFixed(1)} SOL (${t.mult.toFixed(1)}x) on ${w.name}`)) traders++;
    db.prepare('UPDATE winners SET creator=?, scanned=1 WHERE mint=?').run(creator, w.mint);
  })();
  console.log(`[${w.launchpad || '?'}] ${w.name}: creator ${creator ? creator.slice(0, 6) : 'unknown'}, ${list.length} profitable traders`);
}
console.log(`Discovery complete: +${devs} devs, +${traders} trader candidates`);
