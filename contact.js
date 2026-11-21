// Contact form (landing page): saves every message, then posts an automatic alert to your Discord channel.
import db from './db.js';

export const MAIL_OK = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,200}\.[A-Za-z]{2,}$/;
const HOOK_OK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const KINDS = { partner: 'Work with us', apply: 'Work for us', clip: 'Clip submission' };
const ROLES = ['Aspiring dev', 'Moderator', 'Editor', 'Designer', 'Clipper', 'Other'];
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

const ins = db.prepare('INSERT INTO contact_messages(ts,kind,email,name,role,message) VALUES(?,?,?,?,?,?) RETURNING id');
const mark = db.prepare('UPDATE contact_messages SET notified=1 WHERE id=?');

/** Throws Error('bad_email' | 'bad_kind'). Returns { ok: true }. Honeypot hits are dropped without a trace. */
export async function submitContact(body, { fetchFn = fetch, hook = process.env.CONTACT_WEBHOOK_URL } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (clean(b.website, 200)) return { ok: true }; // hidden field only bots fill in
  const kind = clean(b.kind, 20);
  if (!(kind in KINDS)) throw new Error('bad_kind');
  const email = clean(b.email, 254);
  if (!MAIL_OK.test(email)) throw new Error('bad_email');
  const name = clean(b.name, 80), message = clean(b.message, kind === 'clip' ? 1500 : 1000);
  const role = kind === 'apply' ? (ROLES.includes(b.role) ? b.role : 'Other') : '';
  const { id } = ins.get(Math.floor(Date.now() / 1000), kind, email, name, role, message);

  if (HOOK_OK.test(hook || '')) {
    const fields = [['Email', email], ['Name', name], ['Role', role], ['Message', message]].filter(([, v]) => v).map(([n, v]) => ({ name: n, value: v.slice(0, 1000) }));
    try {
      const r = await fetchFn(hook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ username: 'Penthouse site', allowed_mentions: { parse: [] }, // never lets a message ping @everyone
          embeds: [{ title: `New contact: ${KINDS[kind]}`, color: 0x39ff6a, fields, timestamp: new Date().toISOString() }] }),
      });
      if (r.ok) mark.run(id); else console.error('contact webhook', r.status);
    } catch (e) { console.error('contact webhook', e.message); }
  }
  return { ok: true };
}
