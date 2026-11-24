// Radar: roster wallets that are not on the live webhook are checked every few minutes, only while a member is on the site.
// A check is one cheap signature lookup per wallet (1 credit). Only wallets with new activity get their transactions parsed,
// in batches of up to 100 (about 100 credits per batch), so a swap shows up a few minutes late instead of instantly.
// Spend is capped per day (RADAR_DAILY_CAP) and every call goes through the shared credit meter.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { readState, writeState } from './state.js';
import { spend, overBudget } from './credits.js';
import { tiers } from './tiers.js';
import { handleTransactions } from './live.js';
import { getPx } from './ingest-lib.js';
import { creatorOf } from './creator.js';

const today = () => new Date().toISOString().slice(0, 10);
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const CFG = () => ({
  cap: num(process.env.RADAR_DAILY_CAP, 25000),          // credits the Radar may use per UTC day
  perWallet: num(process.env.RADAR_SIGS_PER_WALLET, 40),  // newest signatures looked at per wallet per pass
  maxAgeMin: num(process.env.RADAR_MAX_AGE_MIN, 120),     // ignore anything older than this (after a long idle gap)
  maxParse: num(process.env.RADAR_MAX_PARSE_REQUESTS, 3), // parse requests per pass
});

const key = () => process.env.HELIUS_API_KEY;
async function rpcSigs(addr, until, limit) {
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit, ...(until ? { until } : {}), commitment: 'confirmed' }] }),
  });
  if (r.status === 429) throw Object.assign(new Error('rate limited'), { quota: true });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { quota: /max usage|quota|credits/i.test(j.error.message || '') });
  return j.result || [];
}
async function parseTxs(sigs) {
  const r = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ transactions: sigs }),
  });
  if (r.status === 429) throw Object.assign(new Error('rate limited'), { quota: true });
  if (!r.ok) throw new Error(`parse ${r.status}`);
  return (await r.json()).filter(Boolean);
}

/** One pass over `wallets`. io = { sigs, parse, handle, px, now } lets tests replace the network. Returns a summary. */
export async function radarPass(wallets, state, io, c = CFG()) {
  const now = io.now ? io.now() : Math.floor(Date.now() / 1000);
  state.seen ||= {};
  const found = []; // [address, [signatures]] with something new
  let used = 0, parsed = 0, made = 0, aborted = null;
  const track = async (addr) => {
    const prev = state.seen[addr];
    used += 1; spend(1);
    const rows = await io.sigs(addr, prev && prev !== '-' ? prev : undefined, prev ? 100 : 1);
    if (!prev) { state.seen[addr] = rows[0]?.signature || '-'; return; } // first sight: just remember where it is now
    if (!rows.length) return;
    state.seen[addr] = rows[0].signature;
    const fresh = rows.filter((x) => !x.err && (!x.blockTime || x.blockTime >= now - c.maxAgeMin * 60)).slice(0, c.perWallet).map((x) => x.signature);
    if (fresh.length) found.push([addr, fresh]);
  };
  for (let i = 0; i < wallets.length && !aborted; i += 8) {
    const chunk = wallets.slice(i, i + 8);
    const res = await Promise.allSettled(chunk.map(track));
    for (const r of res) if (r.status === 'rejected' && r.reason?.quota) aborted = r.reason.message;
    if (state.used + used >= c.cap) { aborted = aborted || 'daily radar cap'; break; }
  }
  const sigs = [...new Set(found.flatMap(([, s]) => s))];
  const txs = [];
  for (let i = 0, req = 0; i < sigs.length && req < c.maxParse && state.used + used < c.cap; i += 100, req++) {
    used += 100; spend(100);
    try { txs.push(...(await io.parse(sigs.slice(i, i + 100)))); parsed += Math.min(100, sigs.length - i); }
    catch (e) { aborted = aborted || e.message; break; }
  }
  if (txs.length) made = await io.handle(txs);
  state.used = (state.used || 0) + used;
  return { checked: wallets.length, withNew: found.length, sigs: sigs.length, parsed, made, used, aborted };
}

let running = false;
export async function runRadar() {
  if (running || !key() || overBudget()) return null;
  const c = CFG();
  const state = readState('radar');
  if (state.day !== today()) { state.day = today(); state.used = 0; }
  if (state.backoff && Date.now() < state.backoff) return null;
  if (state.used >= c.cap) return null;
  const { radar } = tiers();
  if (!radar.length) return null;
  running = true;
  try {
    const px = await getPx().catch(() => null);
    const out = await radarPass(radar, state, {
      sigs: rpcSigs, parse: parseTxs,
      handle: (txs) => handleTransactions(txs, { px, creatorOf }),
    }, c);
    // keep the memory small: forget wallets that are no longer on the Radar
    const keep = new Set(radar);
    for (const a of Object.keys(state.seen || {})) if (!keep.has(a)) delete state.seen[a];
    if (out.aborted && /rate|quota|max usage/i.test(out.aborted)) state.backoff = Date.now() + 30 * 60_000;
    writeState('radar', state);
    console.log(`[radar] ${out.checked} wallets, ${out.withNew} with new activity, ${out.parsed} parsed, ${out.made} events, ~${out.used} credits (today ${state.used}/${c.cap})${out.aborted ? `, stopped: ${out.aborted}` : ''}`);
    return out;
  } catch (e) { console.error('[radar]', e.message); return null; }
  finally { running = false; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runRadar().then(() => process.exit(0));
