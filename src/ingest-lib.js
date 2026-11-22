// Shared by the ingest job and by "My wallets" (so a new wallet gets history right away)
import db from './db.js';
import { parseSwap } from './parse.js';
import { loadPx } from './prices.js';
import { spend, overBudget } from './credits.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const insT = db.prepare('INSERT OR IGNORE INTO trades(sig,wallet,mint,side,tokens,sol,ts) VALUES(?,?,?,?,?,?,?)');

// One shared price lookup: the promise is cached, so a burst of webhook posts does not each call DexScreener (rate limits left SOL unpriced)
let pxP = null, pxT = 0;
export async function getPx() {
  if (!pxP || Date.now() - pxT > 5 * 60 * 1000) { pxT = Date.now(); pxP = loadPx().catch(() => null); }
  const v = await pxP;
  if (!v) pxT = Date.now() - 4 * 60 * 1000; // pricing failed: try again in about a minute
  return v;
}

// When Helius says the plan's credits are used up, stop calling it for a while instead of retrying every wallet
let quotaUntil = 0;
export const quotaHit = () => Date.now() < quotaUntil || overBudget();

async function page(addr, before) {
  if (quotaHit()) throw new Error('Helius quota exhausted');
  const u = new URL(`https://api.helius.xyz/v0/addresses/${addr}/transactions`);
  u.searchParams.set('api-key', process.env.HELIUS_API_KEY);
  u.searchParams.set('limit', '100');
  u.searchParams.set('type', 'SWAP');
  if (before) u.searchParams.set('before', before);
  for (let a = 0; a < 5; a++) {
    spend(100);
    const res = await fetch(u);
    if (res.status === 429) {
      if (/max usage|quota|credits/i.test(await res.text().catch(() => ''))) { quotaUntil = Date.now() + 30 * 60 * 1000; throw new Error('Helius quota exhausted'); }
      await sleep(1000 * 2 ** a); continue; // an ordinary rate limit: back off and retry
    }
    if (res.status >= 500) { await sleep(1000 * 2 ** a); continue; }
    if (!res.ok) throw new Error(`Helius ${res.status}`);
    return res.json();
  }
  throw new Error('Helius retries exhausted');
}

/** Pulls swaps for one address into the trades table. io = { get(addr), set(addr, ts) } tracks the newest swap seen. */
export async function ingestWallet(addr, io, px) {
  const days = +process.env.DAYS_BACK || 30, maxPages = +process.env.MAX_PAGES || 6;
  const cutoff = Math.max(io.get(addr) || 0, Math.floor(Date.now() / 1000) - days * 86400);
  let before, newest = 0, stop = false;
  for (let p = 0; p < maxPages && !stop; p++) {
    const txs = await page(addr, before);
    if (!txs.length) break;
    db.transaction(() => {
      for (const tx of txs) {
        if (tx.timestamp <= cutoff) { stop = true; break; }
        newest = Math.max(newest, tx.timestamp);
        const t = parseSwap(tx, addr, px);
        if (t) insT.run(t.sig, addr, t.mint, t.side, t.tokens, t.sol, t.ts);
      }
    })();
    before = txs[txs.length - 1].signature;
    if (txs.length < 100) break;
  }
  if (newest) io.set(addr, newest);
}

const rosterGet = db.prepare('SELECT newest_ts FROM wallets WHERE address=?');
const rosterSet = db.prepare('UPDATE wallets SET newest_ts=? WHERE address=?');
export const rosterIo = { get: (a) => rosterGet.get(a)?.newest_ts, set: (a, t) => rosterSet.run(t, a) };

const extGet = db.prepare('SELECT newest_ts FROM ext_wallets WHERE address=?');
const extSet = db.prepare('UPDATE ext_wallets SET newest_ts=? WHERE address=?');
const extDone = db.prepare('UPDATE ext_wallets SET synced_ts=? WHERE address=?');
const extAdd = db.prepare('INSERT OR IGNORE INTO ext_wallets(address) VALUES(?)');
export const extIo = { get: (a) => extGet.get(a)?.newest_ts, set: (a, t) => extSet.run(t, a) };

/** A wallet a member added that is not on the Penthouse roster. */
export async function ingestExternal(addr, px) {
  extAdd.run(addr);
  await ingestWallet(addr, extIo, px);
  extDone.run(Math.floor(Date.now() / 1000), addr);
}

export async function fillTokenAges() {
  const mints = db.prepare('SELECT DISTINCT mint FROM trades WHERE mint NOT IN (SELECT mint FROM tokens)').all().map((x) => x.mint);
  const ins = db.prepare('INSERT OR REPLACE INTO tokens(mint,created_ts) VALUES(?,?)');
  console.log(`Looking up launch time for ${mints.length} tokens`);
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const d = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`).then((r) => r.json());
      const earliest = {};
      for (const pr of d.pairs || []) {
        const m = pr.baseToken?.address;
        if (m && pr.pairCreatedAt) earliest[m] = Math.min(earliest[m] ?? Infinity, Math.floor(pr.pairCreatedAt / 1000));
      }
      db.transaction(() => batch.forEach((m) => ins.run(m, earliest[m] ?? null)))();
    } catch (e) { console.error('age lookup failed', e.message); }
    await sleep(300);
  }
}

// One at a time, so a burst of new wallets cannot burn through the API quota
let chain = Promise.resolve();
export function backfillExternal(addr) {
  if (!process.env.HELIUS_API_KEY) return Promise.resolve(false);
  chain = chain.then(async () => {
    try { await ingestExternal(addr, await getPx()); await fillTokenAges(); return true; }
    catch (e) { console.error('backfill failed', addr.slice(0, 6), e.message); return false; }
  });
  return chain;
}
