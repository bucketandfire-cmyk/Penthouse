import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeState } from './state.js';

const cwd = fileURLToPath(new URL('..', import.meta.url));
writeState('cycle', { lastRun: Math.floor(Date.now() / 1000) }); // recorded up front so a crash cannot cause a retry loop that burns credits
for (const step of ['discover', 'ingest', 'metas', 'rotate', 'webhook']) {
  console.log(`\n=== ${step} ===`);
  const r = spawnSync(process.execPath, [`src/${step}.js`], { cwd, stdio: 'inherit' });
  if (r.status !== 0) console.error(`${step} exited with ${r.status}; continuing`);
}
