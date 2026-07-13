// One-off: reset the free-once retake gate for the given identifiers.
// Usage: node reset-entitlement.js you@gmail.com [+1555... more emails/phones]
// Deletes the person record + assessments so the next run is free again.
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID || 'rollr-academy' });
const db = admin.firestore();

function normEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@'); if (at < 1) return '';
  let local = e.slice(0, at).split('+')[0], domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return local && domain ? local + '@' + domain : '';
}
function normPhone(phone) { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : ''; }

function keysFor(arg) {
  const keys = [];
  const em = normEmail(arg); if (em) keys.push('email:' + em);
  const ph = normPhone(arg); if (ph) keys.push('phone:' + ph);
  if (arg.startsWith('auth:')) keys.push(arg);
  return keys;
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('pass at least one email/phone/auth:UID'); process.exit(1); }
  const personIds = new Set();
  for (const arg of args) {
    for (const k of keysFor(arg)) {
      const snap = await db.collection('lisp-identities').doc(k).get();
      if (snap.exists && snap.data().personId) { personIds.add(snap.data().personId); console.log(`  ${k} -> ${snap.data().personId}`); }
      else console.log(`  ${k} -> (no identity mapping)`);
      await db.collection('lisp-identities').doc(k).delete();
    }
  }
  for (const pid of personIds) {
    const ref = db.collection('lisp-persons').doc(pid);
    const asmts = await ref.collection('assessments').get();
    for (const d of asmts.docs) await d.ref.delete();
    await ref.delete();
    console.log(`deleted person ${pid} (${asmts.size} assessments)`);
  }
  console.log('done — those identities are free again.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
