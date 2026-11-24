// Creates or updates the Helius webhooks so they watch the current roster.
// Needs PUBLIC_URL (your site, https), HELIUS_API_KEY and HELIUS_WEBHOOK_SECRET in .env. Run after every roster change (cycle.js does).
// Credit saving: every event a webhook sends costs 1 credit, even if our server ignores it, so the lists are kept small:
//   - traders: only the "Live" tier (see tiers.js: proven human-speed wallets, noisy bots left out), SWAP events only.
//     The rest of the roster is checked by radar.js every few minutes instead.
//   - devs: at most DEV_MAX (default 8) wallets that launched winners most recently, ANY transaction (launches are not swaps).
// Nothing is sent to Helius when the watched list has not changed. Modes:
//   --pause     point both webhooks at one random, unused address (nothing delivered, nothing billed)
//   --resume    put the real lists back (refused while the daily credit cap is hit)
//   --recreate  delete and create both webhooks from scratch (use if one is stuck "Disabled" in the Helius dashboard)
import 'dotenv/config';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { readState, writeState } from './state.js';
import { overBudget } from './credits.js';
import { tiers, devAddresses, CFG } from './tiers.js';

const { HELIUS_API_KEY: KEY, HELIUS_WEBHOOK_SECRET: SECRET, PUBLIC_URL } = process.env;
if (!KEY || !SECRET || !PUBLIC_URL) { console.log('Live pings not configured (need HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET, PUBLIC_URL). Skipping.'); process.exit(0); }
if (!/^https:\/\//.test(PUBLIC_URL)) { console.error('PUBLIC_URL must start with https://'); process.exit(1); }

const hookUrl = PUBLIC_URL.replace(/\/+$/, '') + '/webhooks/helius';
const KINDS = { traders: ['SWAP'], devs: ['ANY'] };
const urlOf = (key) => `${hookUrl}?set=${key}`;

const base = 'https://api.helius.xyz/v0/webhooks';
const call = async (path, method, body) => {
  const r = await fetch(`${base}${path}?api-key=${KEY}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Helius webhooks ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return method === 'DELETE' ? null : r.json();
};
const payload = (key, addresses) => ({ webhookURL: urlOf(key), transactionTypes: KINDS[key], accountAddresses: addresses, webhookType: 'enhanced', authHeader: SECRET });
const sha = (v) => crypto.createHash('sha1').update(v).digest('hex');
const state = readState('webhook');
const mode = process.argv[2];
let listed = null;
const list = async () => (listed ||= await call('', 'GET'));
const save = () => writeState('webhook', state);
const idOf = async (key) => state[key]?.id || (await list()).find((w) => w.webhookURL === urlOf(key))?.webhookID;
// Put a webhook's address list, creating it if it was deleted in the Helius dashboard
async function put(key, addresses) {
  const id = await idOf(key);
  if (id) {
    try { await call(`/${id}`, 'PUT', payload(key, addresses)); state[key] = { ...state[key], id }; return { id, how: 'updated' }; }
    catch (e) { if (!/ 404/.test(e.message)) throw e; }
  }
  const made = await call('', 'POST', payload(key, addresses));
  state[key] = { ...state[key], id: made.webhookID };
  return { id: made.webhookID, how: 'created' };
}

try {
  if (!mode && !state.paused && overBudget()) process.argv[2] = '--pause'; // daily credit cap reached: park everything
  const m = process.argv[2];

  if (m === '--pause') {
    if (state.paused) process.exit(0);
    state.park ||= Keypair.generate().publicKey.toBase58(); // random: nobody ever sends to it, so nothing is delivered or billed
    for (const key of Object.keys(KINDS)) {
      if (!state[key]?.id) continue;
      try { await put(key, [state.park]); delete state[key].hash; }
      catch (e) { console.error(`Could not park "${key}": ${e.message}`); }
    }
    state.paused = true; state.pausedAt = Date.now(); save();
    console.log('Webhooks paused (no one on the site, or the daily credit cap was reached)');
    process.exit(0);
  }
  if (m === '--resume' && overBudget()) { console.log('Daily credit cap reached: not resuming webhooks'); process.exit(0); }
  if (m === '--resume' || m === '--recreate') { state.paused = false; delete state.pausedAt; for (const k of Object.keys(KINDS)) delete state[k]?.hash; save(); }
  else if (state.paused) { console.log('Webhooks are paused: leaving them'); process.exit(0); }

  // Retire the old single webhook (same URL without ?set=) so events are not delivered, and billed, twice
  if (!state.migrated) {
    for (const w of (await list()).filter((x) => x.webhookURL === hookUrl)) { await call(`/${w.webhookID}`, 'DELETE'); console.log(`Removed old combined webhook ${w.webhookID}`); }
    state.migrated = true; save();
  }

  const t = tiers();
  const lists = { traders: t.live, devs: devAddresses() };
  console.log(`Tiers: ${t.live.length} Live, ${t.radar.length} Radar, of ${t.total} trader wallets; ${lists.devs.length}/${CFG().devs} dev wallets.`);
  if (t.noisy.length) console.log('Noisiest wallets (left out of Live):', t.noisy.map((w) => `${w.address.slice(0, 6)}… ${Math.round(w.n7 / 7)}/day`).join(', '));
  if (!lists.traders.length && !lists.devs.length) { console.log('No active wallets yet. Run npm run cycle first.'); process.exit(0); }

  for (const key of Object.keys(KINDS)) {
    const addresses = lists[key];
    if (!addresses.length) continue;
    if (m === '--recreate' && state[key]?.id) {
      try { await call(`/${state[key].id}`, 'DELETE'); } catch (e) { if (!/ 404/.test(e.message)) throw e; }
      delete state[key].id;
    }
    const hash = sha(JSON.stringify([KINDS[key], addresses, urlOf(key)]));
    if (state[key]?.hash === hash) { console.log(`Webhook "${key}" unchanged (${addresses.length} wallets): no API call needed`); continue; }
    const { id, how } = await put(key, addresses);
    state[key].hash = hash; save();
    console.log(`${how === 'created' ? 'Created' : 'Updated'} webhook "${key}" ${id}: watching ${addresses.length} wallets`);
  }
} catch (e) { console.error(e.message); } // e.g. out of credits: skip quietly, the next run retries
