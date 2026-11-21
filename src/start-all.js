import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from './state.js';
import './server.js';

// Optional: run the discover > ingest > rotate cycle on a timer (AUTO_CYCLE=1)
if (process.env.AUTO_CYCLE === '1') {
const cwd = fileURLToPath(new URL('..', import.meta.url));
const periodMs = (+process.env.CYCLE_HOURS || 24) * 3600 * 1000;
const run = () => spawn(process.execPath, ['src/cycle.js'], { cwd, stdio: 'inherit' });
// The cycle is the big credit user, so it only runs when one is due. A restart or redeploy no longer re-runs it.
const lastRun = (readState('cycle').lastRun || 0) * 1000;
const wait = Math.max(60_000, lastRun + periodMs - Date.now());
console.log(`Next full cycle in ${Math.round(wait / 60000)} min`);
setTimeout(() => { run(); setInterval(run, periodMs); }, wait);
// Register the live-pings webhook shortly after start so it does not wait for the long first cycle to finish (skips itself when nothing changed)
setTimeout(() => spawn(process.execPath, ['src/seed.js'], { cwd, stdio: 'inherit' }).on('exit', () => spawn(process.execPath, ['src/webhook.js'], { cwd, stdio: 'inherit' })), 90_000);
// Hourly refresh from data already stored (no API credits): metas re-rated on the rolling 7 days, and anyone failing the 7-day test is benched at once
const live = () => { spawn(process.execPath, ['src/metas.js'], { cwd, stdio: 'inherit' }).on('exit', () => spawn(process.execPath, ['src/rotate.js', '--live'], { cwd, stdio: 'inherit' })); };
setTimeout(live, 10 * 60_000);
setInterval(live, (+process.env.LIVE_MINUTES || 60) * 60_000);
}
