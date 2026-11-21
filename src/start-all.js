import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './server.js';

// Optional: run the discover > ingest > rotate cycle on a timer (AUTO_CYCLE=1)
if (process.env.AUTO_CYCLE === '1') {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const hours = +process.env.CYCLE_HOURS || 24;
  const run = () => spawn(process.execPath, ['src/cycle.js'], { cwd, stdio: 'inherit' });
  setTimeout(run, 60_000);
  // Register the live-pings webhook shortly after start so it does not wait for the long first cycle to finish
  setTimeout(() => spawn(process.execPath, ['src/seed.js'], { cwd, stdio: 'inherit' }).on('exit', () => spawn(process.execPath, ['src/webhook.js'], { cwd, stdio: 'inherit' })), 90_000);
  setInterval(run, hours * 3600 * 1000);
  // Hourly refresh from data already stored (no API credits): metas re-rated on the rolling 7 days, and anyone failing the 7-day test is benched at once
  const live = () => { spawn(process.execPath, ['src/metas.js'], { cwd, stdio: 'inherit' }).on('exit', () => spawn(process.execPath, ['src/rotate.js', '--live'], { cwd, stdio: 'inherit' })); };
  setTimeout(live, 10 * 60_000);
  setInterval(live, (+process.env.LIVE_MINUTES || 60) * 60_000);
}
