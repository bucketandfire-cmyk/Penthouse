import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
for (const step of ['discover', 'ingest', 'metas', 'rotate', 'webhook']) {
  console.log(`\n=== ${step} ===`);
  const r = spawnSync(process.execPath, [`src/${step}.js`], { cwd, stdio: 'inherit' });
  if (r.status !== 0) console.error(`${step} exited with ${r.status}; continuing`);
}
