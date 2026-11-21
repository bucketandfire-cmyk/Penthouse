import db from './db.js';

export const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

async function priceOf(mints) {
  const best = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const d = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.slice(i, i + 30).join(',')}`).then((r) => r.json());
      for (const p of d.pairs || []) {
        const m = p.baseToken?.address, liq = p.liquidity?.usd || 0;
        if (m && p.priceUsd && liq >= (best.get(m)?.liq ?? -1)) best.set(m, { price: +p.priceUsd, liq });
      }
    } catch { /* leave unpriced */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return new Map([...best].map(([m, v]) => [m, v.price]));
}

/** Prices for quote assets (stablecoins, tokenized stocks, ...) so swaps against them can be valued in SOL.
 *  Spot prices are applied to the whole history: a rough approximation, fine for slow-moving quote assets. */
export async function loadPx() {
  const rows = db.prepare('SELECT mint FROM quote_tokens').all().map((r) => r.mint);
  const prices = await priceOf([WSOL, ...rows]);
  const quotes = new Map([[USDC, 1], [USDT, 1]]);
  for (const m of rows) if (prices.get(m)) quotes.set(m, prices.get(m));
  const solUsd = prices.get(WSOL);
  if (!solUsd) { console.warn('Could not price SOL; non-SOL-quoted trades will be skipped'); return null; }
  console.log(`Quote assets priced: ${quotes.size - 2}/${rows.length} (+USDC/USDT)`);
  return { quotes, solUsd };
}

/** Current SOL price in USD, or null. */
export async function solUsd() { return (await priceOf([WSOL])).get(WSOL) || null; }
