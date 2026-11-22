import { touch } from './activity.js';
import { spend } from './credits.js';
import 'dotenv/config';
import express from 'express';
import cookieSession from 'cookie-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG as BILL, PLANS, REFERRAL_DAYS, access, configured, createInvoice, getInvoice, checkPayments, expiryOf } from './billing.js';
import { submitContact, MAIL_OK } from './contact.js';
import { handleTransactions, eventsFeed } from './live.js';
import { creatorOf } from './creator.js';
import { listWallets, addWallet, removeWallet, setMinePfp, clearMinePfp, validAddress } from './userwallets.js';
import { getPfp, pfpVersions } from './pfp.js';
import { backfillExternal, getPx } from './ingest-lib.js';
import { track, funnel, previewData, calledIt, refCode, recordReferral, referralStats } from './growth.js';
import { leaderboard, confluence, rosterChanges, currentMetas, devList, winnersList, overview } from './analytics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  DISCORD_CLIENT_ID: CID, DISCORD_CLIENT_SECRET: SECRET,
  DISCORD_REDIRECT_URI: REDIRECT, DISCORD_GUILD_ID: GUILD,
  SESSION_SECRET, PORT = 3000,
} = process.env;

const app = express();
app.set('trust proxy', 1);
const json50 = express.json({ limit: '50kb' });
app.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : json50(req, res, next)));
app.use(cookieSession({
  name: 'ph', keys: [SESSION_SECRET], maxAge: 7 * 24 * 3600 * 1000,
  httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
}));
// Front page + clipping page: fill in links and price from the environment
const INVITE_OK = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/;
const TIKTOK_OK = /^https:\/\/(www\.)?tiktok\.com\/@[\w.]+\/?$/;
const IG_OK = /^https:\/\/(www\.)?instagram\.com\/[\w.]+\/?$/;
const X_OK = /^https:\/\/(www\.)?(x|twitter)\.com\/\w+\/?$/;
const pick = (v, ok) => (ok.test(v || '') ? v : '#');
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REFUND_DAYS = Math.max(0, parseInt(process.env.REFUND_DAYS, 10) || 0); // 0 = payments are final
function page(file, evt, dir = 'public') {
  return (req, res) => {
    if (evt) track(evt, req.ip);
    const html = fs.readFileSync(path.join(__dirname, '..', dir, file), 'utf8')
      .replaceAll('{{INVITE}}', pick(process.env.DISCORD_INVITE_URL, INVITE_OK))
      .replaceAll('{{TIKTOK}}', pick(process.env.TIKTOK_URL, TIKTOK_OK))
      .replaceAll('{{CONTACT}}', MAIL_OK.test(process.env.CONTACT_EMAIL || '') ? `mailto:${process.env.CONTACT_EMAIL}` : pick(process.env.DISCORD_INVITE_URL, INVITE_OK))
      .replaceAll('{{INSTAGRAM}}', pick(process.env.INSTAGRAM_URL, IG_OK))
      .replaceAll('{{X}}', pick(process.env.X_URL, X_OK))
      .replaceAll('{{PRICE}}', String(BILL.priceUsd)).replaceAll('{{DAYS}}', String(BILL.periodDays))
      .replaceAll('{{PERDAY}}', (BILL.priceUsd / BILL.periodDays).toFixed(2))
      .replaceAll('{{QUARTER_PRICE}}', PLANS.quarter ? String(PLANS.quarter.usd) : '')
      .replaceAll('{{QUARTER_DAYS}}', PLANS.quarter ? String(PLANS.quarter.days) : '')
      .replaceAll('{{QUARTER_SAVE}}', PLANS.quarter ? (BILL.priceUsd * 3 - PLANS.quarter.usd).toFixed(0) : '0')
      .replaceAll('{{CLIP_RATE}}', esc(process.env.CLIP_RATE || 'The current rate is posted in the clipping channel on Discord.'))
      .replaceAll('{{CLIP_MIN}}', esc(process.env.CLIP_MIN || 'Posted in the clipping channel on Discord.'))
      .replaceAll('{{CLIP_PAYDAY}}', esc(process.env.CLIP_PAYDAY || 'Posted in the clipping channel on Discord.'))
      .replaceAll('{{TOP_CLIPPER}}', esc(process.env.TOP_CLIPPER || 'Each month the top clipper gets a shout-out on our socials. The first one will be announced here.'))
      .replaceAll('{{REFUND_DAYS}}', String(REFUND_DAYS))
      .replaceAll('{{REFERRAL_DAYS}}', String(REFERRAL_DAYS));
    res.type('html').send(html);
  };
}
app.get('/', page('index.html', 'visit'));
app.get('/guide', (req, res) => page(access(req.session).ok ? 'guide.html' : 'guide-locked.html', null, 'private')(req, res));
app.get('/guide.html', (req, res) => res.redirect('/guide'));
app.get('/r/:code', (req, res) => { if (/^[\w-]{8}\.\d{5,25}$/.test(req.params.code)) req.session.ref = req.params.code; res.redirect('/'); });
app.get('/clipping', page('clipping.html'));
app.get('/index.html', (req, res) => res.redirect('/'));
app.get('/clipping.html', (req, res) => res.redirect('/clipping'));
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// --- Discord login (checks server membership; token is never stored) ---
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  const q = new URLSearchParams({
    client_id: CID, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'identify guilds.members.read', state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${q}`);
});

app.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.state) return res.status(400).send('Login failed. Try again.');
    const tok = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CID, client_secret: SECRET, grant_type: 'authorization_code',
        code: String(code), redirect_uri: REDIRECT,
      }),
    }).then((r) => r.json());
    if (!tok.access_token) return res.status(400).send('Login failed. Try again.');

    const auth = { Authorization: `Bearer ${tok.access_token}` };
    const user = await fetch('https://discord.com/api/users/@me', { headers: auth }).then((r) => r.json());
    const mem = await fetch(`https://discord.com/api/users/@me/guilds/${GUILD}/member`, { headers: auth });

    const memJson = mem.ok ? await mem.json().catch(() => null) : null;
    const staff = BILL.staffRoles.some((r) => memJson?.roles?.includes(r));
    const ref = req.session?.ref;
    req.session = { id: user.id, name: user.global_name || user.username, member: mem.ok, staff };
    track('login', user.id);
    if (ref) recordReferral(ref, user.id);
    res.redirect('/dashboard.html');
  } catch (e) {
    console.error(e);
    res.status(500).send('Login error.');
  }
});

app.get('/logout', (req, res) => { req.session = null; res.redirect('/'); });
app.get('/api/me', (req, res) => {
  if (!req.session?.id) return res.json({});
  const a = access(req.session);
  res.json({ name: req.session.name, member: !!req.session.member, paid: a.ok, via: a.via, reason: a.reason, expires: a.expires || expiryOf(req.session.id) || null,
    price_usd: BILL.priceUsd, period_days: BILL.periodDays, plans: PLANS });
});

// --- Billing (crypto, Solana): invoices are matched to on-chain payments to the treasury address ---
const needLogin = (req, res, next) => (req.session?.id ? next() : res.status(401).json({ error: 'Sign in with Discord first.' }));
app.get('/api/billing/plan', needLogin, (req, res) => res.json({
  configured: configured(), price_usd: BILL.priceUsd, period_days: BILL.periodDays, invoice_minutes: BILL.invoiceMin, assets: ['usdc', 'sol'], plans: PLANS }));
app.post('/api/billing/invoice', needLogin, async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Bad request.' });
  const msg = { not_configured: 'Payments are not set up yet. Contact the admins.', price_unavailable: 'Could not get the SOL price. Try USDC or try again.',
    rate_limited: 'Too many invoices. Wait a bit, or use the open one.', busy: 'Try again in a moment.', bad_asset: 'Pick USDC or SOL.', bad_plan: 'Pick a plan.' };
  try { const inv = await createInvoice({ id: req.session.id, name: req.session.name }, String(req.body?.asset), String(req.body?.plan || 'month')); track('invoice', req.session.id); res.json(inv); }
  catch (e) { res.status(e.message in msg ? 400 : 500).json({ error: msg[e.message] || 'Could not create the invoice.' }); }
});
app.get('/api/billing/invoice/:id', needLogin, async (req, res) => {
  await checkPayments();
  const inv = getInvoice(req.params.id, req.session.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  res.json({ status: inv.status, expires_ts: inv.expires_ts, access_until: expiryOf(req.session.id) || null });
});
setInterval(() => checkPayments({ force: true }), 30000);

// --- Public growth endpoints: a delayed preview, the "called it" board, aggregate proof ---
const pubHits = new Map();
const pub = (fn) => (req, res) => {
  const now = Date.now(), arr = (pubHits.get(req.ip) ?? []).filter((t) => now - t < 60000);
  if (arr.length >= 30) return res.status(429).json({ error: 'Too many requests.' });
  arr.push(now); pubHits.set(req.ip, arr);
  try { res.set('Cache-Control', 'public, max-age=300').json(fn()); } catch (e) { console.error(e); res.json({}); }
};
app.get('/api/public/preview', pub(() => previewData()));
app.get('/api/public/called-it', pub(() => ({ calls: calledIt({ limit: 12 }) })));

// --- Dashboard: read-only data, members only ---
const dashHits = new Map();
function member(req, res, next) {
  const a = access(req.session);
  if (!a.ok) {
    if (a.reason === 'login') return res.status(401).json({ error: 'Sign in with Discord first.' });
    if (a.reason === 'not_member') return res.status(403).json({ error: 'Join the Penthouse Discord to see the dashboard.' });
    return res.status(402).json({ error: 'A subscription is required.', code: 'payment_required' });
  }
  touch();
  const now = Date.now(), arr = (dashHits.get(req.session.id) ?? []).filter((t) => now - t < 60000);
  arr.push(now); dashHits.set(req.session.id, arr);
  if (arr.length > 120) return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
  next();
}
const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const dash = (fn) => (req, res) => {
  try { res.json(fn(req.query)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'No data yet. Run "npm run cycle" to collect it.' }); }
};
app.get('/dashboard', (req, res) => res.redirect('/dashboard.html'));
app.get('/api/dash/overview', member, dash(() => overview()));
app.get('/api/dash/metas', member, dash(() => currentMetas({ limit: 30 })));
app.get('/api/dash/wallets', member, (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (d) => { if (d?.results) { const pv = pfpVersions(req.session.id, d.results.map((r) => r.address)); d.results.forEach((r) => { r.pfp_v = pv.get(r.address) ?? null; }); } return json(d); };
  next();
}, dash((q) => leaderboard({
  sort_by: q.sort, cap: 200, limit: int(q.limit, 1, 200, 100), min_trades: int(q.min, 1, 500, 10),
  status: ['active', 'benched', 'candidate', 'any'].includes(q.status) ? q.status : 'active',
  name_contains: String(q.q || '').slice(0, 40) || undefined,
})));
app.get('/api/dash/buys', member, dash((q) => confluence({ hours: int(q.hours, 1, 72, 6), min_wallets: int(q.min, 1, 20, 2) })));
app.get('/api/dash/devs', member, dash(() => ({ devs: devList() })));
app.get('/api/dash/winners', member, dash((q) => ({ winners: winnersList({ days: int(q.days, 1, 30, 7) }) })));
app.get('/api/dash/roster', member, dash((q) => rosterChanges({ days: int(q.days, 1, 60, 14), limit: 100 })));

app.get('/api/dash/referral', member, (req, res) => res.json({
  path: `/r/${refCode(req.session.id)}`, reward_days: REFERRAL_DAYS, ...referralStats(req.session.id) }));

// --- Contact form (public): rate limited per visitor and overall ---
const contactHits = new Map();
let contactAll = [];
app.post('/api/contact', async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Bad request.' });
  const now = Date.now(), mine = (contactHits.get(req.ip) ?? []).filter((t) => now - t < 3600000);
  contactAll = contactAll.filter((t) => now - t < 3600000);
  if (mine.length >= 5 || contactAll.length >= 100) return res.status(429).json({ error: 'Too many messages. Please try again later.' });
  try {
    const r = await submitContact(req.body);
    mine.push(now); contactAll.push(now); contactHits.set(req.ip, mine);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message === 'bad_email' ? 'Enter a valid email address.' : 'Something went wrong. Please try again.' }); }
});

// --- Live pings: Helius pushes roster transactions here (set HELIUS_WEBHOOK_SECRET; see README) ---
const HOOK = process.env.HELIUS_WEBHOOK_SECRET;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
app.post('/webhooks/helius', (req, res, next) => {
  if (!HOOK) return res.status(503).end();
  if (!crypto.timingSafeEqual(sha(req.get('authorization') || ''), sha(HOOK))) return res.status(401).end(); // checked before the body is parsed
  next();
}, express.json({ limit: '10mb' }), (req, res) => {
  res.status(200).end();
  spend(Array.isArray(req.body) ? req.body.length : 1);
  (async () => {
    try { await handleTransactions(req.body, { px: await getPx().catch(() => null), creatorOf }); }
    catch (e) { console.error('webhook', e.message); }
  })();
});
app.get('/api/dash/events', member, (req, res) => {
  try {
    const a = parseInt(req.query.after, 10);
    res.json({ live: !!HOOK, ...eventsFeed(Number.isFinite(a) ? a : null, req.session.id) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load pings.' }); }
});

// --- My wallets: each member's own watch list (private to them) ---
const addHits = new Map();
const mineErr = { bad_address: 'That is not a valid Solana wallet address.', exists: 'You already track that wallet.',
  limit: 'You have reached your wallet limit. Remove one first.', global_cap: 'Wallet tracking is full right now. Try again later.' };
app.get('/api/dash/mine', member, (req, res) => {
  try { res.json(listWallets(req.session.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load your wallets.' }); }
});
app.get('/api/dash/mine.csv', member, (req, res) => {
  try {
    const q = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const head = ['address', 'label', 'swaps_30d', 'closed_trades', 'win_rate', 'realized_pnl_sol', 'median_multiple', 'last_trade_utc'];
    const rows = listWallets(req.session.id).wallets.map((w) => [w.address, w.label, w.swaps_30d, w.stats?.trades ?? '', w.stats?.win_rate ?? '', w.stats?.realized_pnl_sol ?? '',
      w.stats?.median_multiple ?? '', w.last_trade_ts ? new Date(w.last_trade_ts * 1000).toISOString() : '']);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="my-wallets.csv"' })
      .send([head, ...rows].map((r) => r.map(q).join(',')).join('\n') + '\n');
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not export.' }); }
});
app.post('/api/dash/mine', member, (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Bad request.' });
  const now = Date.now(), arr = (addHits.get(req.session.id) ?? []).filter((t) => now - t < 3600000);
  if (arr.length >= 30) return res.status(429).json({ error: 'You are adding wallets too fast. Try again later.' });
  try {
    const r = addWallet(req.session.id, req.body?.address, req.body?.label);
    arr.push(now); addHits.set(req.session.id, arr);
    if (r.needs_backfill) backfillExternal(r.address); // fetch history in the background
    res.json(listWallets(req.session.id));
  } catch (e) { res.status(e.message in mineErr ? 400 : 500).json({ error: mineErr[e.message] || 'Could not add that wallet.' }); }
});
// Wallet photos. A member's own photo wins over the roster photo. Only images are served, with nosniff.
app.get('/api/pfp/:address', (req, res) => {
  if (!access(req.session).ok || !validAddress(req.params.address)) return res.status(404).end();
  const p = getPfp(req.session.id, req.params.address);
  if (!p) return res.status(404).end();
  res.set({ 'Content-Type': p.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=86400' }).send(p.data);
});
const pfpMsg = { not_tracked: 'Add the wallet to your list first.', bad_image: 'Use a png, jpeg or webp image.', too_big: 'That image is too large.' };
app.put('/api/dash/mine/:address/pfp', member, (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Bad request.' });
  const now = Date.now(), arr = (addHits.get('pfp' + req.session.id) ?? []).filter((t) => now - t < 3600000);
  if (arr.length >= 40) return res.status(429).json({ error: 'Too many uploads. Try again later.' });
  try { setMinePfp(req.session.id, req.params.address, req.body?.image); arr.push(now); addHits.set('pfp' + req.session.id, arr); res.json(listWallets(req.session.id)); }
  catch (e) { res.status(e.message in pfpMsg ? 400 : 500).json({ error: pfpMsg[e.message] || 'Could not save the photo.' }); }
});
app.delete('/api/dash/mine/:address/pfp', member, (req, res) => {
  try { clearMinePfp(req.session.id, req.params.address); res.json(listWallets(req.session.id)); }
  catch (e) { res.status(e.message in pfpMsg ? 400 : 500).json({ error: pfpMsg[e.message] || 'Could not remove the photo.' }); }
});
app.delete('/api/dash/mine/:address', member, (req, res) => {
  try { removeWallet(req.session.id, req.params.address); res.json(listWallets(req.session.id)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not remove that wallet.' }); }
});

app.listen(PORT, () => console.log(`Penthouse web on :${PORT}`));
