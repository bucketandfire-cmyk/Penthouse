// Staff tool: node src/pfp-admin.js set <wallet address> <image file> | remove <address> | list
// Photos for roster wallets. Keep images small (about 128 to 256 px square, under 150 KB): png, jpeg or webp.
import fs from 'node:fs';
import db from './db.js';
import { savePfp, deletePfp } from './pfp.js';
import { validAddress } from './userwallets.js';

const [cmd, a, file] = process.argv.slice(2);
if (cmd === 'set' && validAddress(a) && file) {
  try { savePfp('', a, fs.readFileSync(file)); console.log('Saved. Members will see it in pings and the Wallets tab.'); }
  catch (e) { console.error({ too_big: 'Image is empty or over 150 KB. Resize it.', bad_image: 'Not a png, jpeg or webp image.' }[e.message] || e.message); process.exit(1); }
} else if (cmd === 'remove' && validAddress(a)) console.log(deletePfp('', a) ? 'Removed.' : 'No photo was set.');
else if (cmd === 'list') for (const r of db.prepare("SELECT p.address, w.name, p.updated_ts FROM wallet_pfps p LEFT JOIN wallets w ON w.address=p.address WHERE p.owner='' ORDER BY p.updated_ts DESC").all())
  console.log(`${r.name || '(not on roster)'}  ${r.address}  ${new Date(r.updated_ts * 1000).toISOString().slice(0, 10)}`);
else { console.log('Usage:\n  npm run pfp -- set <wallet address> <image file>\n  npm run pfp -- remove <wallet address>\n  npm run pfp -- list'); process.exit(1); }
