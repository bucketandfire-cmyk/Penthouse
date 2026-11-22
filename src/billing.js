import 'dotenv/config';
import crypto from 'node:crypto';
import db from './db.js';
import { solUsd } from './prices.js';
import { spend, addBonus } from './credits.js';

const env = process.env;
const list = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
export const CFG = {
  enabled: env.PAYWALL_ENABLED !== '0',
  treasury: (env.TREASURY_WALLET || '').trim(),
  priceUsd: +env.PRICE_USD || 49,
  periodDays: +env.PERIOD_DAYS || 30,
  invoiceMin: +env.INVOICE_MINUTES || 30,
  graceHours: 24, // payments for an expired invoice are still credited for this long
  admins: new Set(list(env.ADMIN_DISCORD_IDS)),
  staffRoles: list(env.ACCESS_ROLE_IDS),
  requireMember: env.REQUIRE_MEMBER === '1',
};
// Plans: monthly, plus an optional discounted quarter (QUARTER_DISCOUNT_PCT, default 10; set 0 to hide it).
const qPct = Math.min(50, Math.max(0, env.QUARTER_DISCOUNT_PCT === undefined ? 10 : +env.QUARTER_DISCOUNT_PCT || 0));
export const PLANS = {
  month: { days: CFG.periodDays, usd: CFG.priceUsd },
  ...(qPct > 0 ? { quarter: { days: CFG.periodDays * 3, usd: Math.round(CFG.priceUsd * 3 * (1 - qPct / 100) * 100) / 100 } } : {}),
};
export const CREDIT_PACKS = { credits5: { usd: 5, credits: 1e6 }, credits10: { usd: 10, credits: 2e6 }, credits25: { usd: 25, credits: 5e6 } }; // $5 per 1M Helius credits
export const isPack = (id) => String(id).startsWith('cr_');
export const donatedUsd = (now = nowS()) => db.prepare("SELECT COALESCE(SUM(usd),0) v FROM invoices WHERE id LIKE 'cr\\_%' ESCAPE '\\' AND status='paid' AND created_ts>?").get(now - 30 * DAY).v;
export const daysForUsd = (usd) => Object.values(PLANS).find((p) => Math.abs(p.usd - usd) < 0.005)?.days ?? CFG.periodDays;
export const REFERRAL_DAYS = Math.max(0, +env.REFERRAL_DAYS || 7); // free days the referrer gets per paying referral (0 turns it off)
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);

/** Billing works only with a valid treasury address and a Helius key; otherwise the dashboard stays locked (fail closed). */
export const configured = () => B58.test(CFG.treasury) && !!env.HELIUS_API_KEY;

// ---------- access ----------
export const expiryOf = (id) => db.prepare('SELECT expires_ts FROM subscribers WHERE discord_id=?').get(id)?.expires_ts || 0;

export function access(session, now = nowS()) {
  if (!session?.id) return { ok: false, reason: 'login' };
  if (CFG.requireMember && !session.member) return { ok: false, reason: 'not_member' };
  if (!CFG.enabled) return { ok: true, via: 'open' };
  if (CFG.admins.has(session.id)) return { ok: true, via: 'admin' };
  if (session.staff) return { ok: true, via: 'role' };
  const exp = expiryOf(session.id);
  return exp > now ? { ok: true, via: 'paid', expires: exp } : { ok: false, reason: 'payment_required', expires: exp || null };
}

// ---------- invoices ----------
const fmtAmount = (asset, atomic) => (asset === 'usdc' ? (atomic / 1e6).toFixed(6) : (atomic / 1e9).toFixed(9));
function view(inv) {
  const amount = fmtAmount(inv.asset, inv.amount_atomic);
  const q = new URLSearchParams({ amount, label: 'Penthouse', message: 'Penthouse access' });
  if (inv.asset === 'usdc') q.set('spl-token', USDC);
  return {
    id: inv.id, asset: inv.asset, amount, usd: inv.usd, address: CFG.treasury, expires_ts: inv.expires_ts,
    status: inv.status === 'pending' && inv.expires_ts <= nowS() ? 'expired' : inv.status,
    link: `solana:${CFG.treasury}?${q}`,
  };
}

export async function createInvoice(user, asset, plan = 'month') {
  const pack = CREDIT_PACKS[plan], pl = pack || PLANS[plan]; if (!pl) throw new Error('bad_plan');
  if (!['usdc', 'sol'].includes(asset)) throw new Error('bad_asset');
  if (!configured()) throw new Error('not_configured');
  const now = nowS();
  const open = db.prepare("SELECT * FROM invoices WHERE discord_id=? AND asset=? AND status='pending' AND expires_ts>? AND ABS(usd-?)<0.005").all(user.id, asset, now, pl.usd).find((i) => isPack(i.id) === !!pack);
  if (open) return view(open);
  if (db.prepare('SELECT COUNT(*) n FROM invoices WHERE discord_id=? AND created_ts>?').get(user.id, now - 3600).n >= 6) throw new Error('rate_limited');

  let base;
  if (asset === 'usdc') base = Math.round(pl.usd * 1e6);
  else { const px = await solUsd(); if (!px) throw new Error('price_unavailable'); base = Math.round((pl.usd / px) * 1e9); }
  // A unique amount (under $0.01 extra) ties an incoming payment to exactly one invoice
  const range = asset === 'usdc' ? 9999 : 50000;
  const taken = new Set(db.prepare("SELECT amount_atomic a FROM invoices WHERE asset=? AND status!='paid' AND created_ts>?").all(asset, now - CFG.graceHours * 3600).map((r) => r.a));
  let amt = 0;
  for (let i = 0; i < 300; i++) { amt = base + 1 + crypto.randomInt(range); if (!taken.has(amt)) break; }
  if (taken.has(amt)) throw new Error('busy');

  const inv = { id: (pack ? 'cr_' : '') + crypto.randomBytes(9).toString('base64url'), discord_id: user.id, name: user.name || '', asset, amount_atomic: amt, usd: pl.usd,
    status: 'pending', created_ts: now, expires_ts: now + CFG.invoiceMin * 60, paid_sig: null };
  db.prepare('INSERT INTO invoices VALUES(@id,@discord_id,@name,@asset,@amount_atomic,@usd,@status,@created_ts,@expires_ts,@paid_sig)').run(inv);
  return view(inv);
}

export const getInvoice = (id, discordId) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(String(id));
  return inv && inv.discord_id === discordId ? view(inv) : null;
};

// ---------- reading the chain ----------
/** All transfers to the treasury inside one Helius enhanced transaction. */
export function transfersTo(tx, treasury = CFG.treasury) {
  if (!tx || tx.transactionError) return [];
  const out = [];
  for (const t of tx.tokenTransfers || []) if (t.mint === USDC && t.toUserAccount === treasury && t.tokenAmount > 0)
    out.push({ asset: 'usdc', atomic: Math.round(t.tokenAmount * 1e6), payer: t.fromUserAccount });
  for (const t of tx.nativeTransfers || []) if (t.toUserAccount === treasury && t.amount > 0)
    out.push({ asset: 'sol', atomic: Math.round(t.amount), payer: t.fromUserAccount });
  return out;
}

/** Pair transfers with unpaid invoices by asset and exact amount. Pure: no database, no network. */
export function matchTransfers(txs, invoices, treasury = CFG.treasury) {
  const matches = [], loose = [], used = new Set();
  for (const tx of txs) for (const t of transfersTo(tx, treasury)) {
    const inv = invoices.find((i) => !used.has(i.id) && i.asset === t.asset && Number(i.amount_atomic) === t.atomic && tx.timestamp >= i.created_ts - 30);
    if (inv) { used.add(inv.id); matches.push({ invoice: inv, sig: tx.signature, payer: t.payer, ts: tx.timestamp, atomic: t.atomic }); }
    else if ((t.asset === 'usdc' && t.atomic >= 1e6) || (t.asset === 'sol' && t.atomic >= 1e7)) loose.push({ sig: tx.signature, ...t, ts: tx.timestamp });
  }
  return { matches, loose };
}

export function credit(discordId, name, days, usd = 0, now = nowS()) {
  const cur = expiryOf(discordId);
  const exp = Math.max(now, cur) + days * DAY;
  db.prepare(`INSERT INTO subscribers(discord_id,name,expires_ts,total_paid_usd,first_paid_ts) VALUES(?,?,?,?,?)
    ON CONFLICT(discord_id) DO UPDATE SET expires_ts=excluded.expires_ts, name=COALESCE(NULLIF(excluded.name,''), name), total_paid_usd=total_paid_usd+excluded.total_paid_usd`)
    .run(discordId, name || '', exp, usd, now);
  return exp;
}

export function applyMatches(matches, now = nowS()) {
  let n = 0;
  db.transaction(() => {
    for (const m of matches) {
      const ins = db.prepare('INSERT OR IGNORE INTO payments(sig,invoice_id,discord_id,asset,amount_atomic,payer,ts) VALUES(?,?,?,?,?,?,?)')
        .run(m.sig, m.invoice.id, m.invoice.discord_id, m.invoice.asset, m.atomic, m.payer, m.ts);
      if (!ins.changes) continue; // this transaction was already credited
      db.prepare("UPDATE invoices SET status='paid', paid_sig=? WHERE id=?").run(m.sig, m.invoice.id);
      if (isPack(m.invoice.id)) { addBonus(Math.round(m.invoice.usd / 5 * 1e6)); db.prepare("INSERT INTO funnel_events(ts,day,kind,who) VALUES(?,date(?,'unixepoch'),'credits',?)").run(now, now, m.invoice.discord_id); continue; }
      credit(m.invoice.discord_id, m.invoice.name, daysForUsd(m.invoice.usd), m.invoice.usd, now);
      db.prepare("INSERT INTO funnel_events(ts,day,kind,who) VALUES(?,date(?,'unixepoch'),'paid',?)").run(now, now, m.invoice.discord_id);
      const ref = REFERRAL_DAYS > 0 ? db.prepare('SELECT referrer FROM referrals WHERE referred=? AND rewarded=0').get(m.invoice.discord_id) : null;
      if (ref) { credit(ref.referrer, '', REFERRAL_DAYS, 0, now); db.prepare('UPDATE referrals SET rewarded=? WHERE referred=?').run(now, m.invoice.discord_id); }
      n++;
    }
  })();
  return n;
}

// Credit saving: a full parsed-history pull costs ~100 Helius credits, and this runs every 30 s while any invoice is open
// (invoices stay open for the 24 h grace period). So first ask the cheap RPC (1 credit) whether the treasury has any new
// transaction, and only do the full pull when it has, or at least every 10 minutes as a safety net.
let lastSig = null, lastFull = 0;
async function newestSig() {
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [CFG.treasury, { limit: 1 }] }),
    }).then((x) => x.json());
    return r.result?.[0]?.signature || null;
  } catch { return null; } // unknown: fall through to the full check
}

let last = 0, running = false;
export async function checkPayments({ force = false } = {}) {
  if (!configured() || running || (!force && Date.now() - last < 8000)) return 0;
  running = true; last = Date.now();
  try {
    const now = nowS();
    db.prepare("UPDATE invoices SET status='expired' WHERE status='pending' AND expires_ts<?").run(now);
    const pend = db.prepare("SELECT * FROM invoices WHERE status!='paid' AND created_ts>?").all(now - CFG.graceHours * 3600);
    if (!pend.length) return 0;
    const sig = await newestSig();
    if (sig && sig === lastSig && Date.now() - lastFull < 10 * 60 * 1000) return 0; // nothing new on the treasury wallet
    const u = new URL(`https://api.helius.xyz/v0/addresses/${CFG.treasury}/transactions`);
    u.searchParams.set('api-key', env.HELIUS_API_KEY); u.searchParams.set('limit', '100');
    spend(100);
    const r = await fetch(u);
    if (!r.ok) return 0;
    const earliest = Math.min(...pend.map((i) => i.created_ts)) - 120;
    const txs = (await r.json()).filter((t) => t.timestamp >= earliest);
    lastSig = sig; lastFull = Date.now();
    const { matches, loose } = matchTransfers(txs, pend);
    const n = applyMatches(matches, now);
    const paid = new Set(db.prepare('SELECT sig FROM payments').all().map((p) => p.sig));
    const ins = db.prepare('INSERT OR IGNORE INTO unmatched(sig,asset,amount_atomic,payer,ts) VALUES(?,?,?,?,?)');
    db.transaction(() => { for (const l of loose) if (!paid.has(l.sig)) ins.run(l.sig, l.asset, l.atomic, l.payer, l.ts); })();
    return n;
  } catch (e) { console.error('payment check failed:', e.message); return 0; }
  finally { running = false; }
}
