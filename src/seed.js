import 'dotenv/config';
import fs from 'node:fs';
import db from './db.js';

// Loads the seed wallets (data/wallets.json + data/extra-wallets.json) into the roster without waiting for a full ingest
const read = (f) => { try { return JSON.parse(fs.readFileSync(new URL('../data/' + f, import.meta.url))); } catch { return []; } };
const seeds = [...read('wallets.json'), ...read('extra-wallets.json')];
const now = Math.floor(Date.now() / 1000);
const seed = db.prepare("INSERT OR IGNORE INTO wallets(address,name,role,status,source,status_since,first_seen) VALUES(?,?, 'trader','active','seed',?,?)");
db.transaction(() => seeds.forEach((w) => seed.run(w.address, w.name, now, now)))();
console.log(`Seeded ${seeds.length} wallets`);
