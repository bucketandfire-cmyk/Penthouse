// Addresses that are programs or system accounts, not people.
// Watching one on a webhook would deliver (and bill) almost every transaction on Solana: the System Program once got into the
// dev list as a "creator" and produced about a million events. These are never treated as wallets.
const PROGRAMS = new Set([
  '11111111111111111111111111111111',            // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated token account program
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'So11111111111111111111111111111111111111112', // wrapped SOL
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // pump.fun AMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
]);
export const isProgram = (a) => !a || PROGRAMS.has(a) || /^1{16,}/.test(a);
