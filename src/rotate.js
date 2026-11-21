import 'dotenv/config';
import db from './db.js';
import { positions, walletStats } from './stats.js';
import { decideTrader, decideDev, better, CFG } from './rules.js';

const LIVE = process.argv.includes('--live'); // hourly pass: demotions only (promotions need daily reviews)
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

const ages = {};
for (const t of db.prepare('SELECT mint, created_ts FROM tokens WHERE created_ts IS NOT NULL').all()) ages[t.mint] = t.created_ts;
const byWallet = new Map();
for (const t of db.prepare('SELECT * FROM trades ORDER BY wallet, ts').all()) (byWallet.get(t.wallet) || byWallet.set(t.wallet, []).get(t.wallet)).push(t);

const winCount = db.prepare('SELECT COUNT(*) n FROM winners WHERE creator = ? AND detected_ts >= ?');
const upd = db.prepare('UPDATE wallets SET status=?, streak=?, status_since=?, note=? WHERE address=?');
const updStreak = db.prepare('UPDATE wallets SET streak=? WHERE address=?');
const ev = db.prepare('INSERT INTO wallet_events(address,ts,from_status,to_status,reason) VALUES(?,?,?,?,?)');

const changes = [];
const wallets = db.prepare("SELECT * FROM wallets WHERE status != 'retired'").all();
db.transaction(() => {
  for (const w of wallets) {
    const results = [];
    if (w.role === 'trader' || w.role === 'both') {
      const pos = positions(byWallet.get(w.address) || [], ages);
      results.push(decideTrader(w, walletStats(pos, { since: now - 7 * DAY }), walletStats(pos), now));
    }
    if (w.role === 'dev' || w.role === 'both') {
      results.push(decideDev(w, { recent: winCount.get(w.address, now - CFG.devIdleDays * DAY).n }, now));
    }
    const d = results.reduce((a, b) => better(a, b));
    if (LIVE && !(w.status === 'active' && d.status === 'benched')) continue;
    if (d.status !== w.status) {
      upd.run(d.status, d.streak, now, d.reason || null, w.address);
      ev.run(w.address, now, w.status, d.status, d.reason || '');
      changes.push({ name: w.name, role: w.role, from: w.status, to: d.status, reason: d.reason });
    } else if (d.streak !== w.streak) updStreak.run(d.streak, w.address);
  }
})();

const counts = db.prepare("SELECT role, status, COUNT(*) n FROM wallets GROUP BY role, status ORDER BY role, status").all();
console.log('Roster:', counts.map((c) => `${c.role}/${c.status}=${c.n}`).join('  '));
console.log(`${changes.length} status changes`);

if (changes.length && process.env.ROSTER_WEBHOOK_URL) {
  const icon = { active: '🟢', benched: '🟠', retired: '⚫', candidate: '🔵' };
  const lines = changes.filter((c) => c.to === 'active' || c.to === 'benched').slice(0, 25)
    .map((c) => `${icon[c.to]} **${c.name}** (${c.role}) ${c.from} → ${c.to}${c.reason ? `: ${c.reason}` : ''}`);
  if (lines.length) await fetch(process.env.ROSTER_WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `**Roster update**\n${lines.join('\n')}`.slice(0, 1900) }),
  }).catch(() => {});
}
