// List what people sent through the Contact form: npm run contacts [how many]
import db from './db.js';
const n = Math.min(200, Math.max(1, +process.argv[2] || 20));
const rows = db.prepare('SELECT * FROM contact_messages ORDER BY id DESC LIMIT ?').all(n);
if (!rows.length) console.log('No messages yet.');
for (const r of rows) console.log(`#${r.id}  ${new Date(r.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${r.kind === 'apply' ? 'WORK FOR US' : 'WORK WITH US'}${r.role ? ` (${r.role})` : ''}\n  ${r.email}${r.name ? `  ${r.name}` : ''}${r.message ? `\n  ${r.message.replace(/\n+/g, ' ')}` : ''}${r.notified ? '' : '\n  (Discord alert was not sent)'}\n`);
