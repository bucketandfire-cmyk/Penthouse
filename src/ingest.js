import 'dotenv/config';
import fs from 'node:fs';
import db from './db.js';
import { getPx, ingestWallet, ingestExternal, fillTokenAges, rosterIo } from './ingest-lib.js';

if (!process.env.HELIUS_API_KEY) { console.error('Set HELIUS_API_KEY in .env'); process.exit(1); }
const CONC = +process.env.CONCURRENCY || 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readSeeds = (f) => { try { return JSON.parse(fs.readFileSync(new URL('../data/' + f, import.meta.url))); } catch { return []; } };
const seeds = [...readSeeds('wallets.json'), ...readSeeds('extra-wallets.json')];
const now0 = Math.floor(Date.now() / 1000);
const seed = db.prepare("INSERT OR IGNORE INTO wallets(address,name,role,status,source,status_since,first_seen) VALUES(?,?, 'trader','active','seed',?,?)");
db.transaction(() => seeds.forEach((w) => seed.run(w.address, w.name, now0, now0)))();

// Everyone still in the cycle (retired wallets are dropped to save API credits), plus wallets members added themselves
const roster = db.prepare("SELECT address, name FROM wallets WHERE role IN ('trader','both') AND status IN ('active','benched','candidate')").all()
  .map((w) => ({ addr: w.address, name: w.name, run: (px) => ingestWallet(w.address, rosterIo, px) }));
const mine = db.prepare('SELECT DISTINCT address FROM user_wallets WHERE address NOT IN (SELECT address FROM wallets)').all()
  .map((w) => ({ addr: w.address, name: `member wallet ${w.address.slice(0, 6)}`, run: (px) => ingestExternal(w.address, px) }));
const jobs = [...roster, ...mine];
console.log(`Ingesting ${roster.length} roster wallets and ${mine.length} member wallets`);

const px = await getPx();
let next = 0, done = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    try { await j.run(px); } catch (e) { console.error(j.name, e.message); }
    if (++done % 50 === 0) console.log(`${done}/${jobs.length} wallets`);
    await sleep(100);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await fillTokenAges();
console.log('Ingest complete.');
