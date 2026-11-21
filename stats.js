// Pure functions: no database, no network. Easy to test.
export const SUPPLY = 1e9; // pump.fun tokens launch with 1B supply; used to turn price into market cap

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** trades: one wallet's trades. ages: { mint: createdTsSeconds }. Average-cost accounting per token. */
export function positions(trades, ages = {}) {
  const by = new Map();
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    let p = by.get(t.mint);
    if (!p) by.set(t.mint, (p = { mint: t.mint, cost: 0, qty: 0, closedCost: 0, proceeds: 0, firstBuy: null, entryMcap: null, lastSell: null }));
    if (t.side === 'buy') {
      if (p.firstBuy == null) { p.firstBuy = t.ts; p.entryMcap = (t.sol / t.tokens) * SUPPLY; }
      p.cost += t.sol; p.qty += t.tokens;
    } else if (p.qty > 0) {
      const sold = Math.min(t.tokens, p.qty);
      const basis = p.cost * (sold / p.qty);
      p.proceeds += t.sol * (sold / t.tokens);
      p.closedCost += basis; p.cost -= basis; p.qty -= sold; p.lastSell = t.ts;
    }
  }
  return [...by.values()].filter((p) => p.firstBuy != null).map((p) => {
    const created = ages[p.mint];
    const age = created ? (p.firstBuy - created) / 60 : null;
    return {
      mint: p.mint, firstBuy: p.firstBuy, entryMcapSol: p.entryMcap,
      ageMin: age != null && age >= 0 ? age : null,
      closedCost: p.closedCost, pnl: p.proceeds - p.closedCost,
      multiple: p.closedCost > 0 ? p.proceeds / p.closedCost : null,
      holdMin: p.lastSell ? (p.lastSell - p.firstBuy) / 60 : null,
      lastSellTs: p.lastSell,
      stillHolding: p.qty > 0 && p.cost > 0.02,
    };
  });
}

export function walletStats(pos, { minCost = 0.05, since = 0 } = {}) {
  const closed = pos.filter((p) => p.closedCost >= minCost && (p.lastSellTs || 0) >= since).sort((a, b) => a.firstBuy - b.firstBuy);
  if (!closed.length) return { trades: 0 };
  const half = closed.length >> 1;
  const sum = (a) => a.reduce((s, p) => s + p.pnl, 0);
  const first = sum(closed.slice(0, half)), second = sum(closed.slice(half));
  return {
    trades: closed.length,
    win_rate: r(closed.filter((p) => p.pnl > 0).length / closed.length),
    two_x_rate: r(closed.filter((p) => p.multiple >= 2).length / closed.length),
    median_multiple: r(median(closed.map((p) => p.multiple))),
    pnl_sol: r(sum(closed), 1),
    median_entry_mcap_sol: r(median(closed.map((p) => p.entryMcapSol)), 0),
    median_entry_age_min: r(median(closed.filter((p) => p.ageMin != null).map((p) => p.ageMin)), 1),
    median_hold_min: r(median(closed.filter((p) => p.holdMin != null).map((p) => p.holdMin)), 1),
    pnl_first_half_sol: r(first, 1), pnl_second_half_sol: r(second, 1),
    profitable_in_both_halves: half > 0 && first > 0 && second > 0,
    open_positions: pos.filter((p) => p.stillHolding).length,
  };
}
