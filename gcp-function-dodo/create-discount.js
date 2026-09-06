#!/usr/bin/env node
// Create a percentage discount code in Dodo (Live) for a site-wide sale.
// Reads DODO_API_KEY from the deployed dodowebhook Cloud Run env (via gcloud),
// so nothing secret lives in the repo. Restricted to the six program products
// (control + A/B test variants); the $19 retake is deliberately excluded.
//
//   node create-discount.js CODE PERCENT EXPIRES_AT_ISO [NAME]
//   e.g. node create-discount.js LABORDAY20 20 2026-09-10T03:59:59Z "Labor Day Sale 2026"
const { execSync } = require('node:child_process');

const [code, pctArg, expiresAt, nameArg] = process.argv.slice(2);
if (!code || !pctArg || !expiresAt) {
  console.error('usage: node create-discount.js CODE PERCENT EXPIRES_AT_ISO [NAME]');
  process.exit(1);
}
const pct = Number(pctArg);
if (!(pct > 0 && pct <= 100) || Number.isNaN(Date.parse(expiresAt))) {
  console.error('PERCENT must be 1-100 and EXPIRES_AT_ISO a valid date-time');
  process.exit(1);
}

const PROGRAM_PRODUCTS = [
  'pdt_0NfsBdExMhutyEZI9jb69', 'pdt_0NfsBcql0S0RwfIVqQMgh', 'pdt_0NfsBcHAFwBTjsHXCrZhn', // Foundation / Momentum / Mastery — control
  'pdt_0NirP81xjUDwOIJzVguz7', 'pdt_0NirPYjMyH0ig1B3ZBLj8', 'pdt_0NirPh9lXK9f5frHLunhe', // same, A/B test variants
];

(async () => {
  const svc = JSON.parse(execSync(
    'gcloud run services describe dodowebhook --region us-central1 --project rollr-academy --format=json',
    { encoding: 'utf8' }));
  const key = svc.spec.template.spec.containers[0].env.find((e) => e.name === 'DODO_API_KEY').value;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const existing = await (await fetch('https://live.dodopayments.com/discounts?page_size=100', { headers })).json();
  const dup = (existing.items || []).find((d) => d.code === code.toUpperCase());
  if (dup) { console.log(`${code} already exists (${dup.discount_id}, ${dup.amount / 100}% , expires ${dup.expires_at})`); return; }

  const body = {
    type: 'percentage', amount: Math.round(pct * 100), code: code.toUpperCase(),
    name: nameArg || `${code} — ${pct}% off programs`, expires_at: expiresAt, restricted_to: PROGRAM_PRODUCTS,
  };
  const r = await fetch('https://live.dodopayments.com/discounts', { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { console.error('create failed', r.status, j); process.exit(1); }
  console.log(`created ${j.code} (${j.discount_id}): ${j.amount / 100}% off, expires ${j.expires_at}, ${j.restricted_to.length} products`);
})().catch((e) => { console.error(e.message); process.exit(1); });
