import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from './state.js';
import { isActive, idleMinutes } from './activity.js';
import { overBudget } from './credits.js';
import './server.js';

// Optional: run the discover > ingest > rotate cycle on a timer (AUTO_CYCLE=1)
if (process.env.AUTO_CYCLE === '1') {
const cwd = fileURLToPath(new URL('..', import.meta.url));
const periodMs = (+process.env.CYCLE_HOURS || 24) * 3600 * 1000;
const run = () => spawn(process.execPath, ['src/cycle.js'], { cwd, stdio: 'inherit' });
// The cycle is the big credit user, so it only runs when one is due. A restart or redeploy no longer re-runs it.
// Credits are only spent while a member is on the site: the check below runs a due cycle only when someone is active
let cycling = false;
const tick = () => {
  const lastRun = (readState('cycle').lastRun || 0) * 1000;
  if (!cycling && isActive() && Date.now() >= lastRun + periodMs) {
    cycling = true; run().on('exit', () => { cycling = false; });
  }
  if (process.env.IDLE_PAUSE_WEBHOOK !== '0') {
    const paused = !!readState('webhook').paused;
    const idleLimit = +process.env.IDLE_PAUSE_MIN || 30;
    if (!paused && idleMinutes() > idleLimit) spawn(process.execPath, ['src/webhook.js', '--pause'], { cwd, stdio: 'inherit' });
    else if (paused && isActive() && !overBudget()) spawn(process.execPath, ['src/webhook.js', '--resume'], { cwd, stdio: 'inherit' });
  }
};
setTimeout(tick, 2 * 60_000);
setInterval(tick, 5 * 60_000);
// Register the live-pings webhook shortly after start so it does not wait for the long first cycle to finish (skips itself when nothing changed)
setTimeout(() => spawn(process.execPath, ['src/seed.js'], { cwd, stdio: 'inherit' }).on('exit', () => spawn(process.execPath, ['src/webhook.js'], { cwd, stdio: 'inherit' })), 90_000);
// Hourly refresh from data already stored (no API credits): metas re-rated on the rolling 7 days, and anyone failing the 7-day test is benched at once
const live = () => { spawn(process.execPath, ['src/metas.js'], { cwd, stdio: 'inherit' }).on('exit', () => spawn(process.execPath, ['src/rotate.js', '--live'], { cwd, stdio: 'inherit' })); };
setTimeout(live, 10 * 60_000);
setInterval(live, (+process.env.LIVE_MINUTES || 60) * 60_000);
}
