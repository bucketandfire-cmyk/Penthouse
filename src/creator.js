// Who created a pump.fun token: read from the bonding-curve account (exact, no guessing)
import { PublicKey } from '@solana/web3.js';

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export async function creatorOf(mint) {
  try {
    const pda = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP)[0];
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda.toBase58(), { encoding: 'base64' }] }),
    }).then((x) => x.json());
    const v = r.result?.value;
    if (!v || v.owner !== PUMP.toBase58()) return null;
    const buf = Buffer.from(v.data[0], 'base64');
    return buf.length >= 81 ? new PublicKey(buf.subarray(49, 81)).toBase58() : null; // creator follows 5 u64s + 1 bool
  } catch { return null; }
}
