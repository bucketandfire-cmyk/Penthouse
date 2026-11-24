// Who created a pump.fun token: read from the bonding-curve account (exact, no guessing).
// Cached: the creator of a token never changes, so each coin is looked up once (it used to be one paid call per mention, 77K in a day).
import { PublicKey } from '@solana/web3.js';
import { spend } from './credits.js';
import { isProgram } from './programs.js';

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const found = new Map();   // mint -> creator address (permanent)
const missing = new Map(); // mint -> when to try again (not found / not readable yet)
const inflight = new Map(); // mint -> promise, so a burst of the same coin makes one call
const MAX = 5000, MISS_MS = 30 * 60_000;
const remember = (map, k, v) => { map.set(k, v); if (map.size > MAX) map.delete(map.keys().next().value); };

async function lookup(mint) {
  try {
    const pda = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP)[0];
    spend(1);
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda.toBase58(), { encoding: 'base64' }] }),
      signal: AbortSignal.timeout(8000),
    }).then((x) => x.json());
    if (r.error) return undefined; // an error is not an answer: do not cache it
    const v = r.result?.value;
    if (!v || v.owner !== PUMP.toBase58()) return null;
    const buf = Buffer.from(v.data[0], 'base64');
    const c = buf.length >= 81 ? new PublicKey(buf.subarray(49, 81)).toBase58() : null; // creator follows 5 u64s + 1 bool
    return isProgram(c) ? null : c; // an all-zero creator is the System Program, not a person
  } catch { return undefined; }
}

export async function creatorOf(mint) {
  if (found.has(mint)) return found.get(mint);
  if ((missing.get(mint) || 0) > Date.now()) return null;
  if (inflight.has(mint)) return inflight.get(mint);
  const p = lookup(mint).then((c) => {
    if (c) remember(found, mint, c);
    else if (c === null) remember(missing, mint, Date.now() + MISS_MS);
    return c ?? null;
  }).finally(() => inflight.delete(mint));
  inflight.set(mint, p);
  return p;
}
