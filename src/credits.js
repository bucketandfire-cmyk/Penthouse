// Local meter for Helius credits, shared by the server and the job processes through a small state file.
// History pages cost about 100 credits, RPC calls about 1, and each webhook event about 1.
// Polled work stops for the day once DAILY_CREDIT_CAP is reached, so the monthly plan cannot run out early.
// Default cap: 270,000 a day (about 8.1M over 30 days).
import { readState, writeState } from './state.js';

const today = () => new Date().toISOString().slice(0, 10);
const cap = () => +process.env.DAILY_CREDIT_CAP || 270000;

export function spend(n) {
  const s = readState('credits');
  if (s.day !== today()) { s.day = today(); s.used = 0; s.warned = false; }
  s.used = (s.used || 0) + n;
  s.total = (s.total || 0) + n; // everything this meter has seen since it was added
  if (s.used >= cap() && !s.warned) { s.warned = true; console.log(`[credits] daily cap ${cap()} reached: polled Helius calls pause until midnight UTC`); }
  writeState('credits', s);
}
export const usedToday = () => { const s = readState('credits'); return s.day === today() ? s.used || 0 : 0; };
export const overBudget = () => usedToday() >= cap();
