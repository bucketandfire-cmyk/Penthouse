// Daily and weekly public posts to a Discord channel (webhook). Run `npm run daily` / `npm run weekly` on a schedule (cron).
// Set RECAP_WEBHOOK_URL to a webhook of your PUBLIC channel. Nothing here includes paid-only data beyond what the landing page shows.
import 'dotenv/config';
import { currentMetas, leaderboard, devList } from './analytics.js';
import { calledIt } from './growth.js';

const HOOK_OK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const hook = process.env.RECAP_WEBHOOK_URL || '';
const site = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const mode = process.argv[2] === 'weekly' ? 'weekly' : 'daily';

const m = currentMetas({ limit: 3 });
const top = m.themes?.[0];
const lines = [];
if (top) lines.push(`Top meta right now: **${top.key}** (${top.status}, ${top.launches_this_week} launches this week).`);
if (mode === 'daily') {
  const c = calledIt({ limit: 1 })[0];
  if (c) lines.push(`Called it: a roster wallet bought **$${c.symbol}** before it ran ${c.gain_x}x.`);
} else {
  const best = leaderboard({ sort_by: 'realized_pnl_sol', cap: 5, limit: 1, min_trades: 10, status: 'active' }).results?.[0];
  if (best) lines.push(`Best trader this window: **${best.name || best.address.slice(0, 4) + '…'}** (${Math.round((best.win_rate || 0) * 100)}% win rate over ${best.trades} closed trades).`);
  const dev = devList().sort((a, b) => b.winners - a.winners)[0];
  if (dev?.winners) lines.push(`Dev with the most winning launches: **${dev.name || dev.address.slice(0, 4) + '…'}** (${dev.winners}).`);
}
lines.push(site ? `Full dashboard: ${site}` : 'Full dashboard: see the Penthouse site.', 'Information, not financial advice.');
const text = lines.join('\n');
if (!HOOK_OK.test(hook)) { console.log(text); console.log('\n(RECAP_WEBHOOK_URL not set: printed only. Paste this into X or TikTok yourself.)'); process.exit(0); }
const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
  body: JSON.stringify({ username: 'Penthouse', allowed_mentions: { parse: [] }, embeds: [{ title: mode === 'weekly' ? 'Penthouse weekly recap' : 'Penthouse daily', description: text, color: 0x39ff6a, timestamp: new Date().toISOString() }] }) });
console.log(r.ok ? 'posted' : `failed ${r.status}`);
