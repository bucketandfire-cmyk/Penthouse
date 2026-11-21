import { funnel } from './growth.js';
for (const d of [7, 30]) { const f = funnel(d); console.log(`Last ${d} days: ${f.visits} visits, ${f.logins} logins, ${f.invoices} invoices, ${f.payments} payments`); }
