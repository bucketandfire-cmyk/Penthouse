// Creates or updates the Helius webhook so it watches the current active roster.
// Needs PUBLIC_URL (your site, https), HELIUS_API_KEY and HELIUS_WEBHOOK_SECRET in .env. Run after every roster change (cycle.js does).
import 'dotenv/config';
import db from './db.js';

const { HELIUS_API_KEY: KEY, HELIUS_WEBHOOK_SECRET: SECRET, PUBLIC_URL } = process.env;
if (!KEY || !SECRET || !PUBLIC_URL) { console.log('Live pings not configured (need HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET, PUBLIC_URL). Skipping.'); process.exit(0); }
if (!/^https:\/\//.test(PUBLIC_URL)) { console.error('PUBLIC_URL must start with https://'); process.exit(1); }

const url = PUBLIC_URL.replace(/\/+$/, '') + '/webhooks/helius';
const addresses = db.prepare("SELECT address FROM wallets WHERE status='active' AND role IN ('trader','dev','both')").all().map((r) => r.address);
if (!addresses.length) { console.log('No active wallets yet. Run npm run cycle first.'); process.exit(0); }

const base = 'https://api.helius.xyz/v0/webhooks';
const call = async (path, method, body) => {
  const r = await fetch(`${base}${path}?api-key=${KEY}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Helius webhooks ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const payload = { webhookURL: url, transactionTypes: ['ANY'], accountAddresses: addresses, webhookType: 'enhanced', authHeader: SECRET };
const existing = (await call('', 'GET')).find((w) => w.webhookURL === url);
if (existing) { await call(`/${existing.webhookID}`, 'PUT', payload); console.log(`Updated webhook ${existing.webhookID}: watching ${addresses.length} wallets`); }
else { const w = await call('', 'POST', payload); console.log(`Created webhook ${w.webhookID}: watching ${addresses.length} wallets`); }
