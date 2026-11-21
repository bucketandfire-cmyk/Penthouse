const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * Turn one Helius enhanced transaction into a single-token buy or sell for `wallet`, or null.
 * px = { quotes: Map<mint, usdPrice>, solUsd } lets swaps against USDC/USDT/tokenized stocks (StonkFun-style
 * pairs) be valued in SOL. Without px, only SOL-quoted swaps are parsed.
 */
export function parseSwap(tx, wallet, px = null) {
  if (!tx || tx.transactionError) return null;
  const acct = (tx.accountData || []).find((a) => a.account === wallet);
  if (!acct) return null;

  const net = new Map();
  for (const t of tx.tokenTransfers || []) {
    if (t.mint === WSOL) continue;
    let d = 0;
    if (t.toUserAccount === wallet) d += t.tokenAmount;
    if (t.fromUserAccount === wallet) d -= t.tokenAmount;
    if (d) net.set(t.mint, (net.get(t.mint) || 0) + d);
  }

  // native SOL change for the wallet, with the network fee added back
  let sol = (acct.nativeBalanceChange || 0) / 1e9;
  if (tx.feePayer === wallet) sol += (tx.fee || 0) / 1e9;

  // fold quote-asset legs (stablecoin / tokenized stock) into the SOL figure
  if (px) {
    for (const [m, a] of [...net]) {
      if (px.quotes.has(m)) { sol += (a * px.quotes.get(m)) / px.solUsd; net.delete(m); }
    }
  }
  if (net.size !== 1) return null; // skip multi-token routes and plain transfers
  const [mint, tokens] = [...net][0];

  if (tokens > 0 && sol < -0.01) return { side: 'buy', mint, tokens, sol: -sol, ts: tx.timestamp, sig: tx.signature };
  if (tokens < 0 && sol > 0.01) return { side: 'sell', mint, tokens: -tokens, sol, ts: tx.timestamp, sig: tx.signature };
  return null;
}
