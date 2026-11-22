// Creates or updates the Helius webhooks so they watch the current active roster.
// Needs PUBLIC_URL (your site, https), HELIUS_API_KEY and HELIUS_WEBHOOK_SECRET in .env. Run after every roster change (cycle.js does).
// Credit saving: only the WEBHOOK_MAX_TRADERS (default 250) most active roster wallets are watched live, because every swap by every watched wallet is billed.
// Credit saving: traders get a SWAP-only webhook (every other kind of transaction would be billed and then ignored),
// devs get an ANY webhook (launches are not swaps). Nothing is sent to Helius when the watched list has not changed.
import 'dotenv/config';
import crypto from 'node:crypto';
import db from './db.js';
import { readState, writeState } from './state.js';

const { HELIUS_API_KEY: KEY, HELIUS_WEBHOOK_SECRET: SECRET, PUBLIC_URL } = process.env;
if (!KEY || !SECRET || !PUBLIC_URL) { console.log('Live pings not configured (need HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET, PUBLIC_URL). Skipping.'); process.exit(0); }
if (!/^https:\/\//.test(PUBLIC_URL)) { console.error('PUBLIC_URL must start with https://'); process.exit(1); }

const hookUrl = PUBLIC_URL.replace(/\/+$/, '') + '/webhooks/helius';
const addrs = (sql) => db.prepare(sql).all().map((r) => r.address).sort();
const specs = [
  { key: 'traders', types: ['SWAP'], url: `${hookUrl}?set=traders`, addresses: addrs(`SELECT w.address FROM wallets w LEFT JOIN (SELECT wallet, SUM(sol) v FROM trades WHERE ts > strftime('%s','now') - 7*86400 GROUP BY wallet) t ON t.wallet = w.address
    WHERE w.status='active' AND w.role='trader' ORDER BY COALESCE(t.v, 0) DESC LIMIT ${Math.max(20, +process.env.WEBHOOK_MAX_TRADERS || 250)}`) },
  { key: 'devs', types: ['ANY'], url: `${hookUrl}?set=devs`, addresses: addrs("SELECT address FROM wallets WHERE status='active' AND role IN ('dev','both')") },
].filter((s) => s.addresses.length);
if (!specs.length) { console.log('No active wallets yet. Run npm run cycle first.'); process.exit(0); }

const base = 'https://api.helius.xyz/v0/webhooks';
const call = async (path, method, body) => {
  const r = await fetch(`${base}${path}?api-key=${KEY}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Helius webhooks ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return method === 'DELETE' ? null : r.json();
};
const sha = (v) => crypto.createHash('sha1').update(v).digest('hex');
const state = readState('webhook');
const mode = process.argv[2]; // --pause (site idle) or --resume (a member is back)
let listed = null;
const list = async () => (listed ||= await call('', 'GET'));

try {
  if (mode === '--pause') {
    const park = process.env.TREASURY_WALLET; // one quiet address: nothing is delivered, nothing is billed
    if (state.paused || !state.traders?.id || !park) process.exit(0);
    await call(`/${state.traders.id}`, 'PUT', { webhookURL: specs.find((x) => x.key === 'traders')?.url || `${hookUrl}?set=traders`, transactionTypes: ['SWAP'], accountAddresses: [park], webhookType: 'enhanced', authHeader: SECRET });
    state.paused = true; delete state.traders.hash; writeState('webhook', state);
    console.log('Trader webhook paused: no one is on the site');
    process.exit(0);
  }
  if (mode === '--resume') { state.paused = false; delete state.traders?.hash; writeState('webhook', state); }
  else if (state.paused) { console.log('Trader webhook is paused (site idle): leaving it'); process.exit(0); }
  // Retire the old single webhook (same URL without ?set=) so events are not delivered, and billed, twice
  if (!state.migrated) {
    for (const w of (await list()).filter((x) => x.webhookURL === hookUrl)) { await call(`/${w.webhookID}`, 'DELETE'); console.log(`Removed old combined webhook ${w.webhookID}`); }
    state.migrated = true; writeState('webhook', state);
  }
  for (const s of specs) {
    const hash = sha(JSON.stringify([s.types, s.addresses, s.url]));
    if (state[s.key]?.hash === hash) { console.log(`Webhook "${s.key}" unchanged (${s.addresses.length} wallets): no API call needed`); continue; }
    const payload = { webhookURL: s.url, transactionTypes: s.types, accountAddresses: s.addresses, webhookType: 'enhanced', authHeader: SECRET };
    let id = state[s.key]?.id;
    if (!id) id = (await list()).find((w) => w.webhookURL === s.url)?.webhookID;
    if (id) { await call(`/${id}`, 'PUT', payload); console.log(`Updated webhook "${s.key}" ${id}: watching ${s.addresses.length} wallets`); }
    else { id = (await call('', 'POST', payload)).webhookID; console.log(`Created webhook "${s.key}" ${id}: watching ${s.addresses.length} wallets`); }
    state[s.key] = { id, hash };
    writeState('webhook', state);
  }
} catch (e) { console.error(e.message); } // e.g. out of credits: skip quietly, the next run retries
