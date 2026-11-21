// Tiny JSON state files next to the database (on the volume), so job timings survive restarts and redeploys
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = process.env.DB_DIR ? process.env.DB_DIR.replace(/\/?$/, '/') : fileURLToPath(new URL('../data/', import.meta.url));
export const readState = (name) => { try { return JSON.parse(fs.readFileSync(`${dir}${name}.state.json`, 'utf8')); } catch { return {}; } };
export const writeState = (name, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}${name}.state.json`, JSON.stringify(obj)); };
