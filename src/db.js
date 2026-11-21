import Database from 'better-sqlite3';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = process.env.DB_DIR ? process.env.DB_DIR.replace(/\/?$/, '/') : fileURLToPath(new URL('../data/', import.meta.url));
fs.mkdirSync(dir, { recursive: true });
const db = new Database(dir + 'penthouse.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS wallets (address TEXT PRIMARY KEY, name TEXT, newest_ts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS trades (sig TEXT, wallet TEXT, mint TEXT, side TEXT, tokens REAL, sol REAL, ts INTEGER, PRIMARY KEY (sig, wallet));
CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet, ts);
CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts);
CREATE TABLE IF NOT EXISTS tokens (mint TEXT PRIMARY KEY, created_ts INTEGER);
`);
const cols = db.prepare('PRAGMA table_info(wallets)').all().map((c) => c.name);
for (const [n, d] of [['role', "TEXT DEFAULT 'trader'"], ['status', "TEXT DEFAULT 'active'"], ['source', "TEXT DEFAULT 'seed'"],
  ['status_since', 'INTEGER DEFAULT 0'], ['first_seen', 'INTEGER DEFAULT 0'], ['streak', 'INTEGER DEFAULT 0'], ['note', 'TEXT']])
  if (!cols.includes(n)) db.exec(`ALTER TABLE wallets ADD COLUMN ${n} ${d}`);
db.exec(`
CREATE TABLE IF NOT EXISTS pools_seen (pool TEXT PRIMARY KEY, mint TEXT, name TEXT, fdv_usd REAL, liq_usd REAL, vol24_usd REAL, last_seen INTEGER, evaluated_ts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS winners (mint TEXT PRIMARY KEY, pool TEXT, name TEXT, peak_fdv_usd REAL, gain_x REAL, detected_ts INTEGER, creator TEXT, scanned INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS token_meta (mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, created_ts INTEGER, fetched_ts INTEGER);
CREATE TABLE IF NOT EXISTS pool_daily (pool TEXT, day INTEGER, mint TEXT, vol REAL, fdv REAL, PRIMARY KEY (pool, day));
CREATE INDEX IF NOT EXISTS pool_daily_day ON pool_daily(day);
CREATE TABLE IF NOT EXISTS meta_snapshots (run_ts INTEGER, kind TEXT, key TEXT, tokens_cur INTEGER, tokens_prev INTEGER, tokens_base REAL, vol_cur REAL, vol_share REAL, trend REAL, status TEXT, winners INTEGER, smart_wallets INTEGER, smart_sol REAL, examples TEXT, aliases TEXT, PRIMARY KEY (run_ts, kind, key));
CREATE TABLE IF NOT EXISTS subscribers (discord_id TEXT PRIMARY KEY, name TEXT, expires_ts INTEGER DEFAULT 0, total_paid_usd REAL DEFAULT 0, first_paid_ts INTEGER);
CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, discord_id TEXT, name TEXT, asset TEXT, amount_atomic INTEGER, usd REAL, status TEXT, created_ts INTEGER, expires_ts INTEGER, paid_sig TEXT);
CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status, created_ts);
CREATE TABLE IF NOT EXISTS payments (sig TEXT PRIMARY KEY, invoice_id TEXT, discord_id TEXT, asset TEXT, amount_atomic INTEGER, payer TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS unmatched (sig TEXT, asset TEXT, amount_atomic INTEGER, payer TEXT, ts INTEGER, PRIMARY KEY (sig, asset));
CREATE TABLE IF NOT EXISTS quote_tokens (mint TEXT PRIMARY KEY, name TEXT, added_ts INTEGER);
CREATE TABLE IF NOT EXISTS user_wallets (discord_id TEXT, address TEXT, label TEXT, added_ts INTEGER, PRIMARY KEY (discord_id, address));
CREATE INDEX IF NOT EXISTS user_wallets_addr ON user_wallets(address);
CREATE TABLE IF NOT EXISTS ext_wallets (address TEXT PRIMARY KEY, newest_ts INTEGER DEFAULT 0, synced_ts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, address TEXT, name TEXT, mint TEXT, symbol TEXT, sol REAL, sig TEXT, UNIQUE(sig, address, kind));
CREATE TABLE IF NOT EXISTS wallet_pfps (owner TEXT, address TEXT, mime TEXT, data BLOB, updated_ts INTEGER, PRIMARY KEY (owner, address));
CREATE TABLE IF NOT EXISTS contact_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, email TEXT, name TEXT, role TEXT, message TEXT, notified INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS funnel_events (ts INTEGER, day TEXT, kind TEXT, who TEXT);
CREATE INDEX IF NOT EXISTS funnel_day ON funnel_events(day, kind);
CREATE TABLE IF NOT EXISTS preview_snapshots (ts INTEGER PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS referrals (referred TEXT PRIMARY KEY, referrer TEXT, ts INTEGER, rewarded INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS wallet_events (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT, ts INTEGER, from_status TEXT, to_status TEXT, reason TEXT);
`);
for (const [t, n, d] of [['pools_seen', 'dex', 'TEXT'], ['pools_seen', 'quote_mint', 'TEXT'], ['winners', 'launchpad', 'TEXT'], ['token_meta', 'image', 'TEXT']]) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === n)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${n} ${d}`);
}
export default db;
