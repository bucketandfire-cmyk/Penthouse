import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './server.js';

// Optional: run the discover > ingest > rotate cycle on a timer (AUTO_CYCLE=1)
if (process.env.AUTO_CYCLE === '1') {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const hours = +process.env.CYCLE_HOURS || 24;
  const run = () => spawn(process.execPath, ['src/cycle.js'], { cwd, stdio: 'inherit' });
  setTimeout(run, 60_000);
  setInterval(run, hours * 3600 * 1000);
}
