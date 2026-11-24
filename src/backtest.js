// Paper replay: "if I had copied these signals with these rules, what would have happened?" No wallet, no money, no network.
// Reads the stored trades (every tracked trader's swaps), turns some of them into entry signals, and walks forward in time
// applying entry level, take-profit in dollars, a per-trade stop, a max-drawdown halt and trading costs.
// Run on the server:  node src/backtest.js
//
// Honest limits (also printed with the results):
//  - Prices only exist when a tracked wallet traded that coin, so the price path is sparse: gaps and spikes between those points are invisible.
//  - The tracked wallets were picked because they did well recently, so replaying their trades flatters the result (look-ahead bias).
//  - Fills assume you get the signalling wallet's price plus costs; in a fast move you would usually get a worse one.
import { fileURLToPath } from 'node:url';

export const DEF = {
  start: 70,        // starting dollars
  size: 14,         // dollars per position
  tp: 7.5,          // take profit, dollars of net profit per position
  stopPct: 0.10,    // per-position stop: exit when the position is down this much (net)
  haltDD: 0.10,     // stop opening new positions once the account is down this much from its peak...
  haltH: 24,        // ...for this many hours, then start measuring from the current balance again
  cost: 0.03,       // round-trip slippage + fees as a share of the position (half paid on each side)
  fee: 0.2,         // fixed dollars per round trip (priority fee etc.)
  maxHoldH: 6,      // sell at the last seen price after this many hours
  dip: 0,           // 0 = buy at the signal price; 0.1 = rest a buy 10% below it
  limitMin: 60,     // a resting buy is cancelled after this many minutes
};

/** Set of trade signatures that count as entry signals. mode: 'single' (one buy of >= minSol) or 'confluence' (two wallets buy the same coin within windowMin). */
export function signalsOf(trades, { mode = 'single', minSol = 1, windowMin = 30, cooldownH = 12 } = {}) {
  const out = new Set(), lastSig = new Map(), buyers = new Map();
  for (const t of trades) {
    if (t.side !== 'buy' || !(t.tokens > 0)) continue;
    if (t.sol < (mode === 'single' ? minSol : minSol / 2)) continue;
    if (t.ts - (lastSig.get(t.mint) ?? -Infinity) < cooldownH * 3600) continue;
    if (mode === 'single') { out.add(t.sig); lastSig.set(t.mint, t.ts); continue; }
    const m = buyers.get(t.mint) || new Map(); buyers.set(t.mint, m);
    m.set(t.wallet, t.ts);
    for (const [w, ts] of m) if (t.ts - ts > windowMin * 60) m.delete(w);
    if (m.size >= 2) { out.add(t.sig); lastSig.set(t.mint, t.ts); m.clear(); }
  }
  return out;
}

/** trades: rows {sig,wallet,mint,side,tokens,sol,ts} sorted by ts. Returns summary stats and the list of closed positions. */
export function simulate(trades, sigs, cfg = {}) {
  const c = { ...DEF, ...cfg }, half = c.cost / 2, maxPos = Math.max(1, Math.floor(c.start / c.size));
  let realized = c.start, peak = c.start, tpeak = c.start, maxDD = 0, halted = false, haltedAt = null, halts = 0;
  const open = [], pend = [], done = [], last = new Map();
  const cash = () => realized - open.reduce((a, p) => a + p.size, 0);
  const have = (mint) => open.some((p) => p.mint === mint) || pend.some((p) => p.mint === mint);

  const openPos = (mint, price, ts) => {
    if (halted || open.length >= maxPos || cash() < c.size || open.some((p) => p.mint === mint)) return;
    const tokens = c.size / (price * (1 + half));
    const net = (px) => tokens * px * (1 - half);
    open.push({ mint, ts, size: c.size, tokens, entry: price,
      tpPx: (c.size + c.fee + c.tp) / (tokens * (1 - half)),
      stopPx: (c.size * (1 - c.stopPct)) / (tokens * (1 - half)), net });
  };
  const close = (p, price, ts, why) => {
    open.splice(open.indexOf(p), 1);
    const pnl = p.net(price) - p.size - c.fee;
    realized += pnl; peak = Math.max(peak, realized); tpeak = Math.max(tpeak, realized); maxDD = Math.max(maxDD, tpeak - realized); // maxDD is measured from the all-time peak; 'peak' resets after a halt and only drives the halt rule
    if (!halted && realized <= peak * (1 - c.haltDD)) { halted = true; haltedAt = ts; halts++; }
    done.push({ mint: p.mint, ts: p.ts, held: ts - p.ts, pnl, why });
  };

  for (const t of trades) {
    if (!(t.tokens > 0) || !(t.sol > 0)) continue;
    const price = t.sol / t.tokens;
    last.set(t.mint, price);
    if (halted && t.ts >= haltedAt + c.haltH * 3600) { halted = false; peak = realized; }
    for (const p of [...open]) if (t.ts - p.ts >= c.maxHoldH * 3600) close(p, last.get(p.mint), t.ts, 'time');
    for (let i = pend.length - 1; i >= 0; i--) if (t.ts > pend[i].expire) pend.splice(i, 1);
    for (const p of [...open]) {
      if (p.mint !== t.mint) continue;
      if (price >= p.tpPx) close(p, p.tpPx, t.ts, 'tp');
      else if (price <= p.stopPx) close(p, price, t.ts, 'stop');
    }
    for (let i = pend.length - 1; i >= 0; i--) {
      const q = pend[i];
      if (q.mint === t.mint && price <= q.limit) { pend.splice(i, 1); openPos(q.mint, q.limit, t.ts); }
    }
    if (sigs.has(t.sig) && !halted && !have(t.mint)) {
      if (c.dip > 0) pend.push({ mint: t.mint, limit: price * (1 - c.dip), expire: t.ts + c.limitMin * 60 });
      else openPos(t.mint, price, t.ts);
    }
  }
  for (const p of [...open]) close(p, last.get(p.mint), trades.at(-1)?.ts ?? p.ts, 'open'); // still held at the end of the data: marked at the last seen price

  const wins = done.filter((d) => d.pnl > 0), losses = done.filter((d) => d.pnl <= 0);
  let streak = 0, worst = 0;
  for (const d of done) { streak = d.pnl > 0 ? 0 : streak + 1; worst = Math.max(worst, streak); }
  const gw = wins.reduce((a, d) => a + d.pnl, 0), gl = -losses.reduce((a, d) => a + d.pnl, 0);
  const share = (w) => (done.length ? done.filter((d) => d.why === w).length / done.length : 0);
  return { n: done.length, win: done.length ? wins.length / done.length : 0, pnl: realized - c.start, final: realized,
    avg: done.length ? (realized - c.start) / done.length : 0, maxDD, worst, pf: gl ? gw / gl : (gw ? Infinity : 0),
    tp: share('tp'), stop: share('stop'), time: share('time'), openEnd: share('open'), halts, done };
}

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '∞');

export function report(trades) {
  const lines = [];
  const first = trades[0]?.ts, lastTs = trades.at(-1)?.ts;
  const wallets = new Set(trades.map((t) => t.wallet)).size, mints = new Set(trades.map((t) => t.mint)).size;
  lines.push(`Data: ${trades.length} trades, ${wallets} wallets, ${mints} coins, ${first ? f((lastTs - first) / 86400) : 0} days.  Start $70, stop -10% per position, pause 24h at -10% account drawdown, ${DEF.cost * 100}% round-trip cost + $${DEF.fee}.`);
  const rows = [];
  for (const mode of ['single', 'confluence']) {
    const sigs = signalsOf(trades, { mode });
    lines.push(`Signals (${mode}): ${sigs.size}`);
    for (const dip of [0, 0.1]) for (const size of [14, 35]) for (const tp of [5, 7.5, 10]) {
      const r = simulate(trades, sigs, { mode, dip, size, tp });
      rows.push({ mode, dip, size, tp, r });
    }
  }
  lines.push('signal      entry  size  tp  | trades win%  pnl$  avgPnl  maxDD$  PF   tp%  stop%  time%  halts');
  for (const { mode, dip, size, tp, r } of rows) {
    lines.push(`${mode.padEnd(10)}  ${dip ? 'dip10 ' : 'market'} ${String(size).padStart(4)}  ${String(tp).padStart(4)} | ${String(r.n).padStart(5)}  ${f(r.win * 100, 0).padStart(3)}  ${f(r.pnl).padStart(6)}  ${f(r.avg, 2).padStart(6)}  ${f(r.maxDD).padStart(6)}  ${f(r.pf, 2).padStart(4)}  ${f(r.tp * 100, 0).padStart(3)}  ${f(r.stop * 100, 0).padStart(4)}  ${f(r.time * 100, 0).padStart(4)}   ${r.halts}`);
  }
  const pos = rows.filter((x) => x.r.pnl > 0).length;
  lines.push(`${pos} of ${rows.length} rule sets ended above $70 on this data. Median result: ${f([...rows].map((x) => x.r.pnl).sort((a, b) => a - b)[Math.floor(rows.length / 2)])} dollars.`);
  lines.push('Limits: sparse price path (only moments a tracked wallet traded), wallets chosen for recent success (flatters results), optimistic fills. Treat as a sanity check, not a forecast.');
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { default: db } = await import('./db.js');
  const trades = db.prepare('SELECT sig, wallet, mint, side, tokens, sol, ts FROM trades WHERE tokens > 0 AND sol > 0 ORDER BY ts, sig').all();
  const text = report(trades);
  console.log(text);
  try { (await import('node:fs')).writeFileSync(`${process.env.DB_DIR || '.'}/backtest-report.txt`, text + '\n'); } catch { /* optional */ }
}
