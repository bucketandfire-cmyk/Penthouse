// Which roster wallets are watched how, so Helius credits go to the wallets that matter.
//  - Live:  real-time webhook (1 credit per swap event). Proven pace, human-speed wallets only.
//  - Radar: checked every few minutes with a cheap signature lookup (see radar.js), so a swap shows up a few minutes late.
// Rate limits matter more than volume: a wallet that swaps hundreds of times a day is usually a bot and costs the most.
import db from './db.js';

const env = process.env;
export const CFG = () => ({
  live: Math.max(10, +env.LIVE_WALLETS || 120),            // wallets in the Live tier
  liveUnknown: Math.max(0, env.LIVE_UNKNOWN_MAX == null ? 30 : +env.LIVE_UNKNOWN_MAX), // wallets with no stored history that may be live until measured
  liveMaxPerDay: +env.LIVE_MAX_SWAPS_PER_DAY || 100,        // above this a wallet is too noisy for Live
  radar: Math.max(0, env.RADAR_WALLETS == null ? 150 : +env.RADAR_WALLETS), // wallets in the Radar tier
  radarMaxPerDay: +env.RADAR_MAX_SWAPS_PER_DAY || 150,
  devs: Math.max(1, +env.DEV_MAX || 8),                     // dev wallets on the ANY webhook (every transaction they touch is billed)
});

const rows = () => db.prepare(`SELECT w.address, COALESCE(t.n, 0) n7, COALESCE(t.v, 0) v7,
    EXISTS(SELECT 1 FROM trades x WHERE x.wallet = w.address) alln
  FROM wallets w
  LEFT JOIN (SELECT wallet, COUNT(*) n, SUM(sol) v FROM trades WHERE ts > strftime('%s','now') - 7*86400 GROUP BY wallet) t ON t.wallet = w.address
  WHERE w.status = 'active' AND w.role = 'trader'`).all();

/** Pure part, so it can be tested: rows -> { live, radar, noisy } address lists. */
export function pickTiers(all, c = CFG()) {
  const perDay = (w) => w.n7 / 7;
  const proven = all.filter((w) => w.n7 >= 3 && perDay(w) <= c.liveMaxPerDay).sort((a, b) => b.v7 - a.v7 || (a.address < b.address ? -1 : 1));
  const live = proven.slice(0, c.live);
  const inLive = new Set(live.map((w) => w.address));
  // never leave Live empty while history is still being collected: a few unknown wallets may run live until their pace is measured
  if (live.length < c.live) {
    const unknown = all.filter((w) => !inLive.has(w.address) && w.alln === 0).sort((a, b) => (a.address < b.address ? -1 : 1))
      .slice(0, Math.min(c.liveUnknown, c.live - live.length));
    for (const w of unknown) { live.push(w); inLive.add(w.address); }
  }
  const radar = all.filter((w) => !inLive.has(w.address) && perDay(w) <= c.radarMaxPerDay)
    .sort((a, b) => b.v7 - a.v7 || (a.address < b.address ? -1 : 1)).slice(0, c.radar);
  const noisy = all.filter((w) => perDay(w) > c.liveMaxPerDay).sort((a, b) => b.n7 - a.n7).slice(0, 5);
  return { live: live.map((w) => w.address).sort(), radar: radar.map((w) => w.address), noisy, total: all.length };
}

export const tiers = () => pickTiers(rows());

/** Dev wallets for the ANY webhook: the ones that launched a winner most recently. */
export const devAddresses = () => db.prepare(`SELECT w.address FROM wallets w
  WHERE w.status = 'active' AND w.role IN ('dev','both')
  ORDER BY COALESCE((SELECT MAX(detected_ts) FROM winners x WHERE x.creator = w.address), 0) DESC, w.address LIMIT ?`).all(CFG().devs).map((r) => r.address).sort();
