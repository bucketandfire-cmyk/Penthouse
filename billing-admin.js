import 'dotenv/config';
import db from './db.js';
import { credit, CFG, USDC } from './billing.js';

const [cmd, a, b, c] = process.argv.slice(2);
const date = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-');
const now = Math.floor(Date.now() / 1000);

if (cmd === 'list') {
  const rows = db.prepare('SELECT * FROM subscribers ORDER BY expires_ts DESC').all();
  const active = rows.filter((r) => r.expires_ts > now);
  console.log(`${active.length} active of ${rows.length} subscribers, $${rows.reduce((s, r) => s + r.total_paid_usd, 0).toFixed(2)} collected in total`);
  for (const r of rows) console.log(`${r.discord_id}  ${(r.name || '').padEnd(20)} until ${date(r.expires_ts)} ${r.expires_ts > now ? '' : '(expired)'}  paid $${r.total_paid_usd.toFixed(2)}`);
} else if (cmd === 'unmatched') {
  const rows = db.prepare('SELECT * FROM unmatched WHERE sig NOT IN (SELECT sig FROM payments) ORDER BY ts DESC LIMIT 50').all();
  console.log('Incoming transfers that matched no invoice (wrong amount, or paid without an invoice):');
  for (const r of rows) console.log(`${date(r.ts)}  ${r.asset === 'usdc' ? (r.amount_atomic / 1e6).toFixed(4) + ' USDC' : (r.amount_atomic / 1e9).toFixed(5) + ' SOL'}  from ${r.payer}  tx ${r.sig}`);
  console.log('To credit one: npm run billing -- grant <discordId> <days> [name]');
} else if (cmd === 'grant' && a && +b > 0) {
  console.log(`${a} now has access until ${date(credit(a, c || '', +b, 0))}`);
} else if (cmd === 'revoke' && a) {
  db.prepare('UPDATE subscribers SET expires_ts=0 WHERE discord_id=?').run(a);
  console.log(`Revoked ${a}`);
} else {
  console.log(`Usage:
  npm run billing -- list
  npm run billing -- unmatched
  npm run billing -- grant <discordId> <days> [name]
  npm run billing -- revoke <discordId>
Price: $${CFG.priceUsd} per ${CFG.periodDays} days. Treasury: ${CFG.treasury || '(not set)'}`);
}
