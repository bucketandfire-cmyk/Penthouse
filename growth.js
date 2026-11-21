// Growth helpers: delayed public preview, "called it" board, funnel counts, referrals.
import crypto from 'node:crypto';
import db from './db.js';
import { currentMetas, leaderboard } from './analytics.js';

const nowS = () => Math.floor(Date.now() / 1000);
export const PREVIEW_DELAY_H = Math.max(1, +process.env.PREVIEW_DELAY_HOURS || 24);

// ---------- funnel: visits, logins, invoices, payments ----------
const ins = db.prepare("INSERT INTO funnel_events(ts,day,kind,who) VALUES(?,date(?,'unixepoch'),?,?)");
const seen = db.prepare("SELECT 1 FROM funnel_events WHERE kind=? AND who=? AND day=date(?,'unixepoch')");
/** `who` is a salted hash for visits (so a visitor counts once a day) or the Discord id for the other events. */
export function track(kind, who = '') {
  try {
    const t = nowS();
    if (kind === 'visit') {
      who = crypto.createHash('sha256').update((process.env.SESSION_SECRET || '') + who + new Date().toISOString().slice(0, 10)).digest('hex').slice(0, 16);
      if (seen.get(kind, who, t)) return;
    }
    ins.run(t, t, kind, String(who));
  } catch (e) { console.error('track', e.message); }
}
export function funnel(days = 30) {
  const rows = db.prepare(`SELECT kind, COUNT(*) n, COUNT(DISTINCT who) u FROM funnel_events WHERE ts>=? GROUP BY kind`).all(nowS() - days * 86400);
  const o = Object.fromEntries(rows.map((r) => [r.kind, r]));
  const g = (k) => o[k]?.u ?? 0;
  return { days, visits: g('visit'), logins: g('login'), invoices: g('invoice'), payments: g('paid') };
}

// ---------- delayed public preview ----------
/** Capture a snapshot at most once an hour (called on every preview request, cheap). */
function capture() {
  const t = nowS(), last = db.prepare('SELECT MAX(ts) t FROM preview_snapshots').get().t || 0;
  if (t - last < 3600) return;
  try {
    const m = currentMetas({ limit: 5 });
    if (m.error) return;
    const w = leaderboard({ sort_by: 'realized_pnl_sol', cap: 200, limit: 5, min_trades: 10, status: 'active' });
    const wallets = (w.results || []).slice(0, 5).map((r) => ({ name: r.name || r.address.slice(0, 4) + '…' + r.address.slice(-4), win_rate: r.win_rate ?? null, trades: r.trades ?? null, pnl_sol: r.realized_pnl_sol ?? r.pnl_sol ?? null }));
    const metas = (m.themes || []).slice(0, 5).map((x) => ({ key: x.key, status: x.status, launches: x.launches_this_week, trend: x.trend }));
    db.prepare('INSERT OR REPLACE INTO preview_snapshots(ts,json) VALUES(?,?)').run(t, JSON.stringify({ metas, wallets }));
    db.prepare('DELETE FROM preview_snapshots WHERE ts<?').run(t - 14 * 86400);
  } catch (e) { console.error('preview snapshot', e.message); }
}
export function previewData() {
  capture();
  const cutoff = nowS() - PREVIEW_DELAY_H * 3600;
  const row = db.prepare('SELECT ts,json FROM preview_snapshots WHERE ts<=? ORDER BY ts DESC LIMIT 1').get(cutoff);
  if (!row) return { ready: false, delay_hours: PREVIEW_DELAY_H };
  return { ready: true, delay_hours: PREVIEW_DELAY_H, as_of: row.ts, ...JSON.parse(row.json) };
}

// ---------- "called it" board: a roster wallet bought, then the coin was logged as a >=2x winner ----------
export function calledIt({ limit = 12 } = {}) {
  const rows = db.prepare(`SELECT x.mint, COALESCE(m.symbol, x.name) AS symbol, x.gain_x, x.detected_ts, MIN(t.ts) AS bought_ts
      FROM winners x JOIN trades t ON t.mint=x.mint AND t.side='buy' AND t.ts<=x.detected_ts
      JOIN wallets w ON w.address=t.wallet AND w.role IN ('trader','both')
      LEFT JOIN token_meta m ON m.mint=x.mint
      WHERE x.gain_x>=2 GROUP BY x.mint ORDER BY x.detected_ts DESC LIMIT ?`).all(limit);
  return rows.map((r) => ({ symbol: r.symbol, mint: r.mint, gain_x: Math.round(r.gain_x * 10) / 10, bought_ts: r.bought_ts, detected_ts: r.detected_ts }));
}

// ---------- referrals ----------
export const refCode = (id) => crypto.createHash('sha256').update('ref' + (process.env.SESSION_SECRET || '') + id).digest('base64url').slice(0, 8) + '.' + id;
export function recordReferral(code, referred) {
  const [h, id] = String(code || '').split('.');
  if (!id || !/^\d{5,25}$/.test(id) || id === referred || refCode(id) !== `${h}.${id}`) return;
  db.prepare('INSERT OR IGNORE INTO referrals(referred,referrer,ts) VALUES(?,?,?)').run(referred, id, nowS());
}
export function referralStats(id) {
  const r = db.prepare('SELECT COUNT(*) joined, SUM(rewarded>0) paid FROM referrals WHERE referrer=?').get(id);
  return { joined: r.joined || 0, paid: r.paid || 0 };
}
