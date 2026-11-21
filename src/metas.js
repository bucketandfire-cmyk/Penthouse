import 'dotenv/config';
import fs from 'node:fs';
import db from './db.js';
import { words, compileLexicon, themesOf, termsOf, scoreGroups, mergeCooccurring } from './meta-lib.js';

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const dayNow = Math.floor(now / DAY);
const MIN_TOKENS = +process.env.META_MIN_TOKENS || 4;
const MIN_VOL = +process.env.META_MIN_VOL_USD || 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. names + launch times for every token discovery has seen
async function fillTokenMeta() {
  const mints = db.prepare('SELECT DISTINCT mint FROM pool_daily WHERE mint NOT IN (SELECT mint FROM token_meta)').all().map((x) => x.mint);
  const ins = db.prepare('INSERT OR REPLACE INTO token_meta(mint,name,symbol,created_ts,fetched_ts) VALUES(?,?,?,?,?)');
  console.log(`Fetching names for ${mints.length} tokens`);
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const d = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`).then((r) => r.json());
      const info = {};
      for (const p of d.pairs || []) {
        const m = p.baseToken?.address; if (!m) continue;
        const c = p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null;
        const e = info[m] || (info[m] = { name: p.baseToken.name, symbol: p.baseToken.symbol, created: c });
        if (c && (!e.created || c < e.created)) e.created = c;
      }
      db.transaction(() => batch.forEach((m) => ins.run(m, info[m]?.name ?? null, info[m]?.symbol ?? null, info[m]?.created ?? null, now)))();
    } catch (e) { console.error('name lookup failed', e.message); }
    await sleep(300);
  }
}
await fillTokenMeta();

// 2. build token records
const daily = db.prepare('SELECT mint, day, MAX(vol) vol FROM pool_daily WHERE day >= ? GROUP BY mint, day').all(dayNow - 40);
const span = db.prepare('SELECT MIN(day) a, MAX(day) b FROM pool_daily').get();
const historyDays = span.a == null ? 0 : span.b - span.a + 1;
const metaRows = new Map(db.prepare('SELECT * FROM token_meta WHERE name IS NOT NULL OR symbol IS NOT NULL').all().map((m) => [m.mint, m]));
const winners = new Set(db.prepare('SELECT mint FROM winners').all().map((w) => w.mint));
const lex = compileLexicon(JSON.parse(fs.readFileSync(new URL('../data/themes.json', import.meta.url))));
const lexWords = new Set(lex.flatMap((t) => [...t.set]));

const byMint = new Map();
for (const d of daily) {
  const m = metaRows.get(d.mint); if (!m) continue;
  let t = byMint.get(d.mint);
  if (!t) {
    const w = words(m.name, m.symbol);
    t = { mint: d.mint, name: m.name, symbol: m.symbol, created: m.created_ts, dayVol: new Map(), winner: winners.has(d.mint), themes: themesOf(lex, w), terms: termsOf(w), firstDay: d.day };
    byMint.set(d.mint, t);
  }
  t.dayVol.set(d.day, d.vol || 0);
  t.firstDay = Math.min(t.firstDay, d.day);
}
const tokens = [...byMint.values()].map((t) => ({ ...t, created: t.created ?? t.firstDay * DAY }));
const reliable = historyDays >= 7;
console.log(`${tokens.length} named tokens, ${historyDays} days of history${reliable ? '' : ' (need 7+ for trend ratings; showing activity only)'}`);

// 3. score themes (known lexicon) and terms (unknown, data-driven)
const opts = { now, minTokens: MIN_TOKENS, minVol: MIN_VOL, reliable };
const themeRows = scoreGroups(tokens, (t) => t.themes, opts);
const termRows = mergeCooccurring(
  scoreGroups(tokens, (t) => [...t.terms].filter((x) => !x.split(' ').some((p) => lexWords.has(p))), opts)
    .filter((r) => r.status === 'emerging' || r.status === 'hot' || !reliable).slice(0, 40)
).slice(0, 12);

// 4. which active-roster wallets bought into each group this week
const buys = db.prepare(`SELECT t.mint, t.wallet, SUM(t.sol) sol FROM trades t JOIN wallets w ON w.address=t.wallet
  WHERE t.side='buy' AND t.ts >= ? AND w.status='active' GROUP BY t.mint, t.wallet`).all(now - 7 * DAY);
function smart(mints) {
  const ws = new Set(); let sol = 0;
  for (const b of buys) if (mints.has(b.mint)) { ws.add(b.wallet); sol += b.sol; }
  return { wallets: ws.size, sol: Math.round(sol * 10) / 10 };
}

// 5. persist + announce changes
const prevRun = db.prepare('SELECT MAX(run_ts) r FROM meta_snapshots').get().r;
const prevStatus = new Map(prevRun ? db.prepare("SELECT kind, key, status FROM meta_snapshots WHERE run_ts=?").all(prevRun).map((r) => [`${r.kind}:${r.key}`, r.status]) : []);
const ins = db.prepare('INSERT OR REPLACE INTO meta_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const saved = [];
db.transaction(() => {
  ins.run(now, 'info', 'history_days', historyDays, null, null, null, null, null, reliable ? 'reliable' : 'unrated', null, null, null, null, null);
  for (const [kind, rows] of [['theme', themeRows], ['term', termRows]]) for (const r of rows) {
    const s = smart(r.mints);
    ins.run(now, kind, r.key, r.tokens_cur, r.tokens_prev, r.tokens_base_weekly, r.vol_cur, r.vol_share, r.trend, r.status, r.winners, s.wallets, s.sol,
      JSON.stringify(r.examples), JSON.stringify(r.aliases || []));
    saved.push({ kind, ...r, smart: s });
  }
})();

for (const r of saved.slice(0, 20)) {
  console.log(`${r.kind.padEnd(5)} ${r.key.padEnd(18)} ${r.status.padEnd(9)} launches ${r.tokens_cur} (prev ${r.tokens_prev})  vol share ${Math.round(r.vol_share * 100)}%  tracked wallets ${r.smart.wallets}  e.g. ${r.examples.slice(0, 3).join(', ')}`);
}

if (process.env.META_WEBHOOK_URL && reliable && prevRun) {
  const news = saved.filter((r) => (r.status === 'emerging' || r.status === 'hot' || r.status === 'cooling') && prevStatus.get(`${r.kind}:${r.key}`) !== r.status).slice(0, 10);
  const icon = { emerging: '🌱', hot: '🔥', cooling: '🧊' };
  if (news.length) await fetch(process.env.META_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `**Meta update**\n${news.map((r) => `${icon[r.status]} **${r.key}** is ${r.status}: ${r.tokens_cur} launches this week vs ${r.tokens_prev} last week, e.g. ${r.examples.slice(0, 3).join(', ')}`).join('\n')}`.slice(0, 1900) }),
  }).catch(() => {});
}
// keep 90 days of snapshots
db.prepare('DELETE FROM meta_snapshots WHERE run_ts < ?').run(now - 90 * DAY);
db.prepare('DELETE FROM pool_daily WHERE day < ?').run(dayNow - 90);
