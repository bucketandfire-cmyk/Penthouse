import 'dotenv/config';
import fs from 'node:fs';
import db from './db.js';
import { getPx, ingestWallet, ingestExternal, fillTokenAges, rosterIo, quotaHit } from './ingest-lib.js';
import { readState, writeState } from './state.js';

if (!process.env.HELIUS_API_KEY) { console.error('Set HELIUS_API_KEY in .env'); process.exit(1); }
const CONC = +process.env.CONCURRENCY || 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readSeeds = (f) => { try { return JSON.parse(fs.readFileSync(new URL('../data/' + f, import.meta.url))); } catch { return []; } };
const seeds = [...readSeeds('wallets.json'), ...readSeeds('extra-wallets.json')];
const now0 = Math.floor(Date.now() / 1000);
const seed = db.prepare("INSERT OR IGNORE INTO wallets(address,name,role,status,source,status_since,first_seen) VALUES(?,?, 'trader','active','seed',?,?)");
db.transaction(() => seeds.forEach((w) => seed.run(w.address, w.name, now0, now0)))();

// Credit saving: each wallet costs ~100 credits per pull, so not everyone is pulled every day.
//  - candidates: daily (they are being judged)
//  - active wallets: every INGEST_EVERY_DAYS (default 7) when live pings are on, because the webhook already saves their trades as they happen
//  - benched wallets: every INGEST_BENCHED_EVERY_DAYS (default 3)
//  - wallets never pulled before: at most INGEST_NEW_PER_RUN (default 400) per run, so the first backfill is spread over several days
const EVERY = Math.max(1, +process.env.INGEST_EVERY_DAYS || 7);
const EVERY_BENCHED = Math.max(1, +process.env.INGEST_BENCHED_EVERY_DAYS || 3);
const NEW_CAP = Math.max(0, process.env.INGEST_NEW_PER_RUN == null ? 400 : +process.env.INGEST_NEW_PER_RUN);
const liveOn = !!(process.env.HELIUS_WEBHOOK_SECRET && process.env.PUBLIC_URL);
const seen = readState('ingest'); // address -> when we last pulled it (unix seconds)
const waitFor = (status) => ((status === 'candidate' ? 1 : status === 'benched' ? EVERY_BENCHED : liveOn ? EVERY : 1) * 86400) - 3600;
const all = db.prepare("SELECT address, name, status, newest_ts FROM wallets WHERE role IN ('trader','both') AND status IN ('active','benched','candidate')").all();
const lastPull = (w) => seen[w.address] ?? (w.newest_ts > 0 ? now0 - 86400 : 0); // pulled before this tracking existed counts as yesterday
const due = all.filter((w) => now0 - lastPull(w) >= waitFor(w.status));
const refresh = due.filter((w) => lastPull(w) > 0);
const fresh = due.filter((w) => lastPull(w) === 0).sort((a, b) => (b.status === 'candidate') - (a.status === 'candidate')).slice(0, NEW_CAP);
const roster = [...refresh, ...fresh].map((w) => ({ addr: w.address, name: w.name, run: async (px) => { await ingestWallet(w.address, rosterIo, px); seen[w.address] = Math.floor(Date.now() / 1000); } }));
const mine = db.prepare('SELECT DISTINCT address FROM user_wallets WHERE address NOT IN (SELECT address FROM wallets)').all()
.map((w) => ({ addr: w.address, name: `member wallet ${w.address.slice(0, 6)}`, run: (px) => ingestExternal(w.address, px) }));
const jobs = [...roster, ...mine];
console.log(`Ingesting ${roster.length} of ${all.length} roster wallets (${refresh.length} refresh, ${fresh.length} first-time) and ${mine.length} member wallets`);

const px = await getPx();
let next = 0, done = 0;
async function worker() {
while (next < jobs.length) {
if (quotaHit()) { console.error('Helius quota exhausted: stopping ingest early (resumes next run)'); return; }
const j = jobs[next++];
try { await j.run(px); } catch (e) { console.error(j.name, e.message); }
if (++done % 50 === 0) { console.log(`${done}/${jobs.length} wallets`); writeState('ingest', seen); }
await sleep(100);
}
}
await Promise.all(Array.from({ length: CONC }, worker));
writeState('ingest', seen);
if (!quotaHit()) await fillTokenAges();
console.log('Ingest complete.');
