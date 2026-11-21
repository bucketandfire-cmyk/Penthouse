// Pure rotation rules. Stats come from stats.js walletStats().
const env = process.env;
export const CFG = {
  minTrades30: +env.MIN_TRADES_30 || 20,   // closed trades needed in the 30-day window
  minTrades7: +env.MIN_TRADES_7 || 3,      // closed trades needed in the last 7 days to judge a week
  confirm: +env.CONFIRM_REVIEWS || 2,      // consecutive passing reviews before (re)promotion
  benchWinRate: 1,                         // any losing week (win rate below this) benches an active wallet
  candidateDays: +env.CANDIDATE_DAYS || 14,
  benchedDays: +env.BENCHED_DAYS || 30,
  devIdleDays: +env.DEV_IDLE_DAYS || 7,    // dev benched if none of their tokens won in this long
  devRetireDays: +env.DEV_RETIRE_DAYS || 45,
};
const pct = (x) => Math.round(x * 100);

export function decideTrader(w, s7, s30, now, c = CFG) {
  const ageDays = (now - (w.status_since || now)) / 86400;
  const proven = s30.trades >= c.minTrades30 && s30.pnl_sol > 0 && s30.profitable_in_both_halves
    && s7.trades >= c.minTrades7 && s7.pnl_sol > 0;

  if (w.status === 'active') {
    const badWeek = s7.trades >= c.minTrades7 && s7.pnl_sol < 0 && s7.win_rate < c.benchWinRate;
    const badMonth = s30.trades >= c.minTrades30 && s30.pnl_sol < 0;
    if (badWeek) return { status: 'benched', streak: 0, reason: `bad week: ${s7.pnl_sol} SOL over ${s7.trades} trades, ${pct(s7.win_rate)}% wins` };
    if (badMonth) return { status: 'benched', streak: 0, reason: `30-day PnL ${s30.pnl_sol} SOL over ${s30.trades} trades` };
    return { status: 'active', streak: 0 };
  }
  // candidate or benched: must pass several reviews in a row
  if (proven) {
    const streak = (w.streak || 0) + 1;
    if (streak >= c.confirm) return { status: 'active', streak: 0, reason: `edge proven: 30d ${s30.pnl_sol} SOL / ${s30.trades} trades, 7d ${s7.pnl_sol} SOL / ${s7.trades} trades` };
    return { status: w.status, streak };
  }
  const limit = w.status === 'candidate' ? c.candidateDays : c.benchedDays;
  if (ageDays > limit) return { status: 'retired', streak: 0, reason: `no proven edge after ${limit} days` };
  return { status: w.status, streak: 0 };
}

/** wins = winning tokens this dev launched: { d14, d45 } */
export function decideDev(w, wins, now, c = CFG) {
  const ageDays = (now - (w.status_since || now)) / 86400;
  if (wins.recent >= 1) return w.status === 'active' ? { status: 'active', streak: 0 } : { status: 'active', streak: 0, reason: `new winning token (${wins.recent} in ${c.devIdleDays}d)` };
  if (w.status === 'active') return { status: 'benched', streak: 0, reason: `no winning token in ${c.devIdleDays} days` };
  if (w.status === 'benched' && ageDays > c.devRetireDays) return { status: 'retired', streak: 0, reason: `no winners for ${c.devRetireDays} days` };
  return { status: w.status, streak: 0 };
}

const RANK = { active: 3, benched: 2, candidate: 1, retired: 0 };
export const better = (a, b) => (RANK[a.status] >= RANK[b.status] ? a : b);
