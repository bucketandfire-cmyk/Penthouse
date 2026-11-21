import db from './db.js';
import { positions, walletStats } from './stats.js';

let cache = null;
function build() {
  if (cache && Date.now() - cache.t < 10 * 60 * 1000) return cache;
  const ages = {};
  for (const t of db.prepare('SELECT mint, created_ts FROM tokens WHERE created_ts IS NOT NULL').all()) ages[t.mint] = t.created_ts;
  const rows = db.prepare('SELECT * FROM trades ORDER BY wallet, ts').all();
  const byWallet = new Map();
  for (const t of rows) (byWallet.get(t.wallet) || byWallet.set(t.wallet, []).get(t.wallet)).push(t);
  const info = new Map(db.prepare('SELECT address,name,role,status,source,note FROM wallets').all().map((w) => [w.address, w]));
  const names = new Map([...info].map(([a, w]) => [a, w.name]));
  const all = [];
  for (const [address, trades] of byWallet) {
    const s = walletStats(positions(trades, ages));
    const w = info.get(address) || {};
    if (s.trades && info.has(address)) all.push({ name: w.name, address, status: w.status, source: w.source, ...s });
  }
  const span = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM trades').get();
  cache = { t: Date.now(), all, span, ages, names, info };
  return cache;
}

const SORTS = {
  realized_pnl_sol: (a, b) => b.pnl_sol - a.pnl_sol,
  median_multiple: (a, b) => b.median_multiple - a.median_multiple,
  win_rate: (a, b) => b.win_rate - a.win_rate,
  early_entry: (a, b) => a.median_entry_age_min - b.median_entry_age_min,
};

export function leaderboard({ sort_by = 'realized_pnl_sol', min_trades = 20, limit = 10, name_contains, status = 'active', cap = 25 } = {}) {
  const { all, span } = build();
  let rows = all.filter((w) => w.trades >= min_trades && (status === 'any' || w.status === status));
  if (sort_by === 'early_entry') rows = rows.filter((w) => w.median_entry_age_min != null);
  if (name_contains) rows = rows.filter((w) => (w.name || '').toLowerCase().includes(name_contains.toLowerCase()));
  rows.sort(SORTS[sort_by] || SORTS.realized_pnl_sol);
  return {
    data_window: span.a ? { from: new Date(span.a * 1000).toISOString().slice(0, 10), to: new Date(span.b * 1000).toISOString().slice(0, 10) } : null,
    wallets_with_enough_trades: rows.length,
    results: rows.slice(0, Math.min(limit, cap)),
    notes: 'Realized PnL only (closed portions), in SOL, average-cost basis. Entry market cap assumes 1B supply. Past performance of a wallet is not a prediction.',
  };
}

export function lookup(query) {
  const { all, span, info } = build();
  const q = query.trim().toLowerCase();
  const rows = all.filter((w) => w.address.toLowerCase() === q || (w.name || '').toLowerCase().includes(q)).slice(0, 5);
  return { data_window: span, matches: rows.map((r) => ({ ...r, role: info.get(r.address)?.role, why_on_roster: info.get(r.address)?.note })), note: rows.length ? undefined : 'No tracked wallet with enough closed trades matched.' };
}

export function confluence({ hours = 6, min_wallets = 3 } = {}) {
  const { names } = build();
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = db.prepare(`SELECT t.mint, t.wallet, MIN(t.ts) ts, SUM(t.sol) sol, SUM(t.tokens) tokens FROM trades t JOIN wallets w ON w.address=t.wallet
    WHERE t.side='buy' AND t.ts>=? AND w.status='active' GROUP BY t.mint, t.wallet`).all(since);
  const by = new Map();
  for (const x of rows) (by.get(x.mint) || by.set(x.mint, []).get(x.mint)).push(x);
  const out = [...by.entries()].filter(([, v]) => v.length >= min_wallets)
    .map(([mint, v]) => ({ mint, tracked_wallets_bought: v.length, sol_spent_total: Math.round(v.reduce((s, x) => s + x.sol, 0) * 10) / 10,
      wallets: v.slice(0, 8).map((x) => names.get(x.wallet)) }))
    .sort((a, b) => b.tracked_wallets_bought - a.tracked_wallets_bought || b.sol_spent_total - a.sol_spent_total).slice(0, 20);
  const tm = db.prepare('SELECT symbol, name FROM token_meta WHERE mint=?');
  for (const t of out) { const m = tm.get(t.mint); t.symbol = m?.symbol || null; t.token_name = m?.name || null; }
  return { window_hours: hours, tokens: out, note: 'What active-roster wallets bought, not a recommendation. They may already be selling.' };
}

export function rosterChanges({ days = 7, limit = 25 } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const counts = db.prepare('SELECT role, status, COUNT(*) n FROM wallets GROUP BY role, status').all();
  const events = db.prepare(`SELECT w.name, w.role, e.from_status, e.to_status, e.reason, e.ts FROM wallet_events e JOIN wallets w ON w.address=e.address
    WHERE e.ts>=? ORDER BY e.ts DESC LIMIT ?`).all(since, limit)
    .map((e) => ({ ...e, date: new Date(e.ts * 1000).toISOString().slice(0, 10), ts: undefined }));
  const winners = db.prepare('SELECT name, launchpad, peak_fdv_usd, gain_x FROM winners WHERE detected_ts>=? ORDER BY peak_fdv_usd DESC LIMIT 10').all(since);
  return { roster_counts: counts, recent_changes: events, recent_winning_tokens: winners };
}

const parse = (x) => { try { return JSON.parse(x || '[]'); } catch { return []; } };
export function currentMetas({ limit = 8, status } = {}) {
  const run = db.prepare('SELECT MAX(run_ts) r FROM meta_snapshots').get().r;
  if (!run) return { error: 'No meta data yet. Run the discovery cycle first.' };
  const info = db.prepare("SELECT tokens_cur days, status FROM meta_snapshots WHERE run_ts=? AND kind='info'").get(run);
  const q = (kind) => db.prepare(`SELECT key, status, tokens_cur AS launches_this_week, tokens_prev AS launches_last_week, ROUND(tokens_base,1) AS weekly_avg_before,
      vol_share, trend, winners, smart_wallets AS tracked_wallets_buying, smart_sol AS tracked_sol_bought, examples, aliases
      FROM meta_snapshots WHERE run_ts=? AND kind=? ${status ? 'AND status=?' : ''} ORDER BY vol_share DESC LIMIT ?`).all(...[run, kind, ...(status ? [status] : []), limit])
    .map((r) => ({ ...r, examples: parse(r.examples), aliases: parse(r.aliases) }));
  return {
    as_of: new Date(run * 1000).toISOString().slice(0, 10),
    days_of_history: info?.days, ratings_reliable: info?.status === 'reliable',
    themes: q('theme'), unlabeled_emerging_terms: q('term'),
    notes: 'Launches = tokens created that week that traded at least the minimum daily volume. vol_share is the theme share of all tracked trading volume this week. trend is log2(this week / last week). Based only on tokens discovery has seen, so quiet or old metas can be undercounted.',
  };
}
export function metaHistory({ key, days = 28 } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare(`SELECT run_ts, tokens_cur AS launches_that_week, vol_share, status FROM meta_snapshots WHERE kind IN ('theme','term') AND LOWER(key) LIKE ? AND run_ts>=? ORDER BY run_ts`)
    .all(`%${String(key || '').toLowerCase()}%`, since);
  return { key, history: rows.map((r) => ({ date: new Date(r.run_ts * 1000).toISOString().slice(0, 10), launches_that_week: r.launches_that_week, vol_share: r.vol_share, status: r.status })) };
}

export function devList() {
  return db.prepare(`SELECT w.address, w.name, w.status, w.note, w.status_since,
      (SELECT COUNT(*) FROM winners x WHERE x.creator=w.address) AS winners,
      (SELECT MAX(detected_ts) FROM winners x WHERE x.creator=w.address) AS last_win_ts,
      (SELECT MAX(peak_fdv_usd) FROM winners x WHERE x.creator=w.address) AS best_peak_fdv_usd
    FROM wallets w WHERE w.role IN ('dev','both') AND w.status != 'retired'
    ORDER BY (w.status='active') DESC, winners DESC LIMIT 300`).all();
}

export function winnersList({ days = 7 } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return db.prepare(`SELECT x.mint, COALESCE(m.symbol, x.name) AS symbol, x.launchpad, x.peak_fdv_usd, x.gain_x, x.detected_ts,
      x.creator, w.name AS creator_name, w.status AS creator_status
    FROM winners x LEFT JOIN token_meta m ON m.mint=x.mint LEFT JOIN wallets w ON w.address=x.creator
    WHERE x.detected_ts>=? ORDER BY x.peak_fdv_usd DESC LIMIT 100`).all(since);
}

export function overview() {
  const statusCounts = db.prepare("SELECT status, COUNT(*) n FROM wallets WHERE role IN ('trader','both') GROUP BY status").all();
  return {
    trader_status: Object.fromEntries(statusCounts.map((r) => [r.status, r.n])),
    active_devs: db.prepare("SELECT COUNT(*) n FROM wallets WHERE role IN ('dev','both') AND status='active'").get().n,
    last_trade_ts: db.prepare('SELECT MAX(ts) t FROM trades').get().t,
    last_meta_ts: db.prepare('SELECT MAX(run_ts) t FROM meta_snapshots').get().t,
    last_roster_change_ts: db.prepare('SELECT MAX(ts) t FROM wallet_events').get().t,
  };
}
