// Dodo Payments webhook -> grants app access (faithful port of the old Stripe webhook).
//
// Flow:
//   1. Verify the Dodo signature (Standard Webhooks spec).
//   2. On `payment.succeeded`, read the buyer's email from the payload.
//   3. Find-or-create their Firebase user and stamp a `paid: true` custom claim.
//      The app's entitlement gate (userHasPaid) only opens for this claim, so a
//      plain signed-in account never gets in for free.
//   4. Mirror the purchase to Firestore `lisp-users` for dashboard visibility.
//   5. Send the branded "set your password" email so the buyer can sign in.

require('dotenv').config();
const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { Webhook } = require('standardwebhooks');

if (!admin.apps.length) admin.initializeApp();

// Config is read from environment (.env locally, function env vars in prod).
// Signing secret: Dodo dashboard -> Developer -> Webhooks -> your endpoint.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Branded "set your password" email is sent straight from this webhook
// (same SMTP the Stripe webhook used).
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = `"TopSpeech" <${SMTP_USER}>`;
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://lsc.topspeech.health';

// Dodo REST API key (Live) used server-side to create inline-checkout sessions,
// so the payment renders on our own domain instead of redirecting to Dodo.
const DODO_API_KEY = process.env.DODO_API_KEY;
const DODO_CHECKOUTS_URL = 'https://live.dodopayments.com/checkouts';
const DODO_PAYMENTS_URL = 'https://live.dodopayments.com/payments';
// The $19 assessment-retake product. A purchase here does NOT grant program
// access or send the set-password email (retake buyers are already signed-in
// assessment users) — it credits one retake on their lisp-persons record so the
// analysis function lets them run a second assessment. See gcp-function-lisp.
const RETAKE_PRODUCT = 'pdt_0Nj0v8UWXMwVLyCVuRUk3';

// Allowlist the three real products so the /checkout endpoint can't be used to
// spin up sessions for arbitrary product_ids.
const ALLOWED_PRODUCTS = new Set([
  'pdt_0NfsBcql0S0RwfIVqQMgh', // Momentum  (3-month)  — control
  'pdt_0NfsBcHAFwBTjsHXCrZhn', // Mastery   (6-month)  — control
  'pdt_0NfsBdExMhutyEZI9jb69', // Foundation (1-month) — control
  // Pricing A/B test-variant products (PostHog flag: pricing-tier-test)
  'pdt_0NirPYjMyH0ig1B3ZBLj8', // Momentum  (3-month)  — test  ($49)
  'pdt_0NirPh9lXK9f5frHLunhe', // Mastery   (6-month)  — test  ($79)
  'pdt_0NirP81xjUDwOIJzVguz7', // Foundation (1-month) — test  ($19)
  RETAKE_PRODUCT,              // $19 assessment retake (one-time credit, not a program)
]);

// PostHog — mirror the purchase so the "Lisp Nurturing Sequence" workflow can
// drop buyers out of the drip. Project key is the same public phc_ key the site
// already ships in the client bundle. distinct_id = email matches the client's
// posthog.identify(email), so the event lands on the same person.
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;

async function notifyPostHogPurchase(email, data) {
  try {
    const resp = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_API_KEY,
        event: 'purchase_completed',
        distinct_id: email,
        properties: {
          source: 'dodo',
          dodo_payment_id: data.payment_id || null,
          dodo_product_id: (Array.isArray(data.product_cart) && data.product_cart[0] && data.product_cart[0].product_id) || null,
          amount: data.total_amount || null,
          currency: data.currency || null,
          // $set writes the person property the workflow branches/exits on.
          $set: {
            has_purchased: true,
            purchased_at: new Date().toISOString(),
          },
        },
      }),
    });
    if (!resp.ok) {
      console.error('[dodo->posthog] capture failed', resp.status, await resp.text());
    }
  } catch (err) {
    // Never let a PostHog hiccup fail the grant — a 500 makes Dodo retry, which
    // would re-send the welcome email. Purchase entitlement must not depend on
    // analytics being up.
    console.error('[dodo->posthog] capture error', err.message);
  }
}

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 465,
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// Built lazily so the container still boots if WEBHOOK_SECRET is a placeholder.
let webhook = null;
function getWebhook() {
  if (!webhook) webhook = new Webhook(WEBHOOK_SECRET);
  return webhook;
}

// Allowed browser origins for the /reset endpoint. Anything else gets no CORS
// header back, so the browser blocks the response.
const RESET_ALLOWED_ORIGINS = new Set([
  'https://lsc.topspeech.health',
  'https://topspeech.health',
  'https://www.topspeech.health',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5502',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5502',
]);

// Vercel preview/staging deploys of the marketing repo (ephemeral subdomains:
// rhotacism-website-git-staging-…, per-commit hashes, etc.). Lets the staging
// frontend reach this backend for inline checkout, same as gcp-function-lisp.
const VERCEL_PREVIEW_ORIGIN = /^https:\/\/rhotacism-website-[a-z0-9-]+\.vercel\.app$/;

function applyResetCors(req, res) {
  const origin = req.headers.origin || '';
  if (RESET_ALLOWED_ORIGINS.has(origin) || VERCEL_PREVIEW_ORIGIN.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

functions.http('dodoWebhook', async (req, res) => {
  // Forgot-password helper — folded in so we ship a single Cloud Function.
  // Path is whatever the caller appends to the function URL (e.g. ".../reset").
  if (req.path === '/reset' || req.path === '/reset/') {
    applyResetCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
    return handleResetRequest(req, res);
  }

  // Inline-checkout helper — creates a Dodo checkout session for a plan and hands
  // the browser back a `checkout_url` to render on-site (no redirect to Dodo).
  if (req.path === '/checkout' || req.path === '/checkout/') {
    applyResetCors(req, res); // same browser-origin allowlist as /reset
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
    return handleCreateCheckout(req, res);
  }

  // Auto-login handoff — the browser (which knows its own checkout session_id)
  // exchanges it for the one-time Firebase custom token the webhook minted on
  // payment.succeeded. Only a genuinely paid session has a token, so this can't
  // be used to mint a login for an arbitrary account.
  if (req.path === '/login-token' || req.path === '/login-token/') {
    applyResetCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
    return handleLoginToken(req, res);
  }

  // Signature verification needs the exact raw bytes, not a re-serialized body.
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});

  const headers = {
    'webhook-id': req.headers['webhook-id'] || '',
    'webhook-signature': req.headers['webhook-signature'] || '',
    'webhook-timestamp': req.headers['webhook-timestamp'] || '',
  };

  try {
    await getWebhook().verify(raw, headers);
  } catch (err) {
    console.error('[dodo] signature verification failed:', err.message);
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (err) {
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  // One-time purchase only — ignore everything else.
  if (event.type !== 'payment.succeeded') {
    res.status(200).json({ ignored: event.type });
    return;
  }

  const data = event.data || {};
  const email = data.customer && data.customer.email;
  if (!email) {
    console.error('[dodo] payment.succeeded with no customer email');
    res.status(400).json({ error: 'missing customer email' });
    return;
  }

  const productId = (Array.isArray(data.product_cart) && data.product_cart[0] && data.product_cart[0].product_id) || null;

  try {
    if (productId === RETAKE_PRODUCT) {
      // Retake purchase: credit one retake, don't run the program access flow.
      await grantRetakeCredit(email, data);
    } else {
      await grantAccess(email, data);
    }
    // HubSpot: buyer stops being a lead the moment money lands — flips the
    // record to customer so sales never speed-dials someone who already paid.
    await markHubspotCustomer(email, productId, data);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[dodo] grant failed:', err.message);
    // 500 so Dodo retries — the grant is idempotent, so retries are safe.
    res.status(500).json({ error: 'grant failed' });
  }
});

// Normalize identity keys the SAME way gcp-function-lisp does, so we resolve the
// buyer to the personId the analysis function created on their free assessment.
function normEmailKey(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 1) return '';
  let local = e.slice(0, at), domain = e.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return local && domain ? local + '@' + domain : '';
}
function normPhoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
}

// Credit one paid retake to the buyer's person. Resolves the SAME lisp-persons
// record the analysis gate reads (via the lisp-identities email/phone index that
// the free assessment populated), and is idempotent per payment_id so Dodo
// webhook retries never double-credit. Firestore here is rollr-academy (this
// function runs in that project), the same DB gcp-function-lisp writes to.
// ── HubSpot: lead → customer on payment ─────────────────────────────
// Self-swallowing: a CRM hiccup must never 500 the webhook (Dodo would
// retry the whole grant flow). Token via HUBSPOT_TOKEN env var.
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || '';
async function markHubspotCustomer(rawEmail, productId, data) {
  try {
    if (!HUBSPOT_TOKEN) return;
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!email) return;
    const hs = (path, body, method) => fetch('https://api.hubapi.com' + path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      body: JSON.stringify(body)
    });
    const up = await hs('/crm/v3/objects/contacts/batch/upsert', {
      inputs: [{ idProperty: 'email', id: email, properties: { email, lifecyclestage: 'customer' } }]
    });
    const upJson = await up.json().catch(() => null);
    const contactId = upJson && upJson.results && upJson.results[0] && String(upJson.results[0].id || '');
    if (contactId) {
      const amount = data && data.total_amount != null ? ` — $${(data.total_amount / 100).toFixed(2)}` : '';
      await hs('/crm/v3/objects/notes', {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: `<p>💰 <strong>PAID</strong> via Dodo${amount} (product ${productId || 'unknown'}). Lead closed — do not cold-call; switch to onboarding/success touch.</p>`
        },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
      });
    }
    try {
      await admin.firestore().collection('hubspot-leads').doc(email)
        .set({ status: 'customer', paidAt: new Date().toISOString() }, { merge: true });
    } catch (e) { /* marker only */ }
    console.log('[dodo] HubSpot customer flip:', email);
  } catch (e) {
    console.error('[dodo] HubSpot customer flip failed (payment unaffected):', e.message);
  }
}

async function grantRetakeCredit(rawEmail, data) {
  const db = admin.firestore();
  const paymentId = data.payment_id || null;
  const amountCents = data.total_amount || 1900;
  const emailKey = normEmailKey(rawEmail);
  const phoneKey = normPhoneKey(data.customer && (data.customer.phone_number || data.customer.phone));

  // Resolve personId from the identity index (email first, then phone). If none
  // exists yet (paid before a free assessment — unusual), mint one and index it.
  let personId = null;
  for (const k of [emailKey ? 'email:' + emailKey : '', phoneKey ? 'phone:' + phoneKey : ''].filter(Boolean)) {
    const snap = await db.collection('lisp-identities').doc(k).get();
    if (snap.exists && snap.data() && snap.data().personId) { personId = snap.data().personId; break; }
  }
  if (!personId) {
    personId = 'p_' + (emailKey || String(Date.now())) + '_' + Math.random().toString(36).slice(2, 8);
    const batch = db.batch();
    if (emailKey) batch.set(db.collection('lisp-identities').doc('email:' + emailKey), { personId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (phoneKey) batch.set(db.collection('lisp-identities').doc('phone:' + phoneKey), { personId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
  }

  const personRef = db.collection('lisp-persons').doc(String(personId));
  const payRef = db.collection('lisp-payments').doc(String(paymentId || ('nopmt_' + Date.now())));
  const credited = await db.runTransaction(async (tx) => {
    const paySnap = await tx.get(payRef);
    if (paySnap.exists) return false; // already processed (Dodo retry)
    tx.set(payRef, { personId, amountCents, product: RETAKE_PRODUCT, at: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(personRef, {
      paidCredits: admin.firestore.FieldValue.increment(1),
      lastPaidAt: admin.firestore.FieldValue.serverTimestamp(),
      lastPaymentId: paymentId || null,
      lastPaidAmountCents: amountCents,
      ...(emailKey ? { email: rawEmail.trim().toLowerCase() } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  });
  console.log('[dodo] retake ' + (credited ? 'credited' : 'already-credited') + ' person ' + personId + ' (payment ' + paymentId + ')');
  try { await notifyPostHogPurchase(rawEmail.trim().toLowerCase(), data); } catch (e) {}
}

async function grantAccess(rawEmail, data) {
  const email = rawEmail.trim().toLowerCase();

  // Find-or-create the Firebase user. `userExisted` = they already had an account
  // (i.e. signed in on the marketing assessment) → auto-login only, no email.
  let user;
  let userExisted = true;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      user = await admin.auth().createUser({ email, emailVerified: true });
      userExisted = false;
    } else {
      throw err;
    }
  }

  // Entitlement: server-verified proof of purchase. The app gates access on
  // this claim, NOT merely on the account existing or being signed in.
  await admin.auth().setCustomUserClaims(user.uid, { paid: true });

  const userDocRef = admin.firestore().collection('lisp-users').doc(user.uid);

  // Read the current doc so we never clobber a returning user's real progress and
  // can reuse the marketing assessment they already ran (latestAssessment).
  let existing = {};
  try { const snap = await userDocRef.get(); if (snap.exists) existing = snap.data() || {}; } catch (e) {}

  const patch = {
    email,
    paid: true,
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
    dodoCustomerId: (data.customer && data.customer.customer_id) || null,
    dodoPaymentId: data.payment_id || null,
    dodoProductId: (Array.isArray(data.product_cart) && data.product_cart[0] && data.product_cart[0].product_id) || null,
    amountTotal: data.total_amount || null,
    currency: data.currency || null,
  };

  // Assessment-origin buyers already did onboarding + recorded their baseline on
  // the marketing site (proven by latestAssessment on their record), so seed both
  // as done → land on Day 1 (phase-1). Direct pricing-page buyers did neither, so
  // seed them at phase-0 with onboarding + baseline PENDING → the app walks them
  // through onboarding and the in-app baseline first. Only seed when the user has
  // no progress yet — never overwrite a returning user's real state.
  if (!existing.progressState) {
    patch.progressState = buildSeedProgressState(email, !!existing.latestAssessment);
  }
  // Carry the marketing assessment into the app's phase-0 baseline snapshot so the
  // in-app results/"where you were" view resolves. Only if not already present.
  const hasPhase0Snap = existing.phaseSnapshots && existing.phaseSnapshots['phase-0'];
  if (!hasPhase0Snap && existing.latestAssessment) {
    // Nested object (not a 'phaseSnapshots.phase-0' dotted key): .set(merge:true)
    // deep-merges maps, so other phase snapshots are preserved. Dotted keys only
    // expand as field paths under .update(), not .set().
    patch.phaseSnapshots = {
      'phase-0': {
        gemini: {
          gri: existing.latestAssessment.gri ?? null,
          categories: existing.latestAssessment.categories ?? [],
          result: existing.latestAssessment.result ?? '',
        },
        local: null,
        savedAt: Date.now(),
      },
    };
  }

  await userDocRef.set(patch, { merge: true });

  // Tell PostHog so the nurture workflow drops this buyer out of the drip.
  await notifyPostHogPurchase(email, data);

  // Mint a one-time auto-login token bound to this checkout session, so the
  // success screen can drop the buyer straight into the app (no password step).
  await writeLoginHandoff(user.uid, data);

  // Only brand-new accounts (never signed in on the site) need the set-password
  // email as their fallback credential. Users who already signed in on the
  // assessment page can just sign in normally, so skip the email for them.
  if (!userExisted) {
    await sendSetPasswordEmail(email);
    console.log('[dodo] granted + set-password email (new account):', email);
  } else {
    console.log('[dodo] granted (existing account, auto-login):', email);
  }
}

// Seeds a fresh app progress blob (matches Lisp-pwa js/progress.js defaultState)
// with onboarding + baseline marked done so the buyer lands on phase-1 Day 1.
function buildSeedProgressState(email, didAssessment) {
  // didAssessment = the buyer already ran the marketing assessment (signed in +
  // recorded), so onboarding + baseline are genuinely done → skip straight to
  // phase-1 Day 1. Otherwise (direct pricing-page buyer) leave onboarding +
  // baseline PENDING at phase-0 so the app makes them do both before Day 1.
  return {
    completedDrills: didAssessment ? { 'phase-0': { 'p0-baseline': true } } : {},
    checklistProgress: {},
    sessions: [],
    repCounts: {},
    currentPhase: didAssessment ? 'phase-1' : 'phase-0',
    currentWeek: 1,
    lastActivityDate: null,
    streakDays: 0,
    userProfile: {
      email,
      goal: null,
      // Pending onboarding routes pricing buyers through the in-app onboarding →
      // baseline flow; assessment buyers already completed it on the site.
      onboardingComplete: !!didAssessment,
      // signedIn stays true either way so the paid buyer is never bounced to login
      // (access is already granted via the custom claim + auto-login token).
      signedIn: true,
      provider: didAssessment ? 'website-assessment' : 'website-pricing',
    },
    dailyAnalyses: null,
    lastDayCompletedTs: null,
    practiceDayLog: {},
    dayProgress: {},
    lastDrill: null,
    _updatedAt: Date.now(),
  };
}

// Mints a one-time Firebase custom token and stores it keyed by the checkout
// session id, so the browser (which knows its own session_id) can exchange it.
async function writeLoginHandoff(uid, data) {
  try {
    let sessionId = data.checkout_session_id || (data.checkout && data.checkout.session_id) || null;
    const paymentId = data.payment_id || null;
    // Fall back to resolving the session id from the payment record.
    if (!sessionId && paymentId) {
      try {
        const pr = await fetch(`${DODO_PAYMENTS_URL}/${encodeURIComponent(paymentId)}`, {
          headers: { 'Authorization': `Bearer ${DODO_API_KEY}` },
        });
        if (pr.ok) { const pd = await pr.json(); sessionId = pd.checkout_session_id || null; }
      } catch (e) { /* best effort */ }
    }
    // Need at least one key the browser can present back on return.
    if (!sessionId && !paymentId) {
      console.warn('[dodo/handoff] no session id or payment id — skipping auto-login token');
      return;
    }

    const token = await admin.auth().createCustomToken(uid);
    const rec = {
      token,
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAtMs: Date.now() + 15 * 60 * 1000, // 15-min window; consumed once
    };
    // Key the token by BOTH ids so either return path can claim it:
    //  - inline checkout: the browser knows its own checkout session_id
    //  - redirect / 3DS: Dodo's return_url only carries payment_id
    // Same token in both docs; one-time-use deletes whichever is claimed, the
    // twin just expires. Both writes are best-effort but at least one must land.
    const writes = [];
    if (sessionId) {
      writes.push(admin.firestore().collection('login-handoffs').doc(String(sessionId)).set(rec));
    }
    if (paymentId) {
      writes.push(admin.firestore().collection('login-handoffs').doc('pay_' + String(paymentId)).set(rec));
    }
    await Promise.all(writes);
    console.log('[dodo/handoff] wrote login token', { sessionId, paymentId });
  } catch (err) {
    console.error('[dodo/handoff] failed:', err.message);
  }
}

// Sends the branded "set your password" email (fallback credential for accounts
// created at purchase time — i.e. buyers who never signed in on the site).
async function sendSetPasswordEmail(email) {
  const fbLink = await admin.auth().generatePasswordResetLink(email, {
    url: `${APP_ORIGIN}/#/onboarding`,
    handleCodeInApp: false,
  });
  const oobCode = new URL(fbLink).searchParams.get('oobCode');
  const link = `${APP_ORIGIN}/?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}#/login`;

  await transporter.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: 'Welcome to Lisp Speech Clinic — set your password',
    text: `Thanks for your purchase!\n\nSet your password to access your Lisp Speech Clinic account:\n${link}\n\nIf you did not make this purchase, ignore this email.`,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
        <div style="text-align:center;margin:0 0 20px">
          <img src="${APP_ORIGIN}/icons/lisp-speech-clinic.png" alt="Lisp Speech Clinic" width="120" style="width:120px;height:auto;display:inline-block">
        </div>
        <h2 style="margin:0 0 16px;text-align:center">Welcome to Lisp Speech Clinic</h2>
        <p>Thanks for your purchase! Click below to set your password and access your account.</p>
        <p style="margin:24px 0;text-align:center">
          <a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">
            Set your password
          </a>
        </p>
        <p style="color:#555;font-size:14px">Or paste this link in your browser:<br><span style="word-break:break-all">${link}</span></p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#888;font-size:12px">If you did not make this purchase, ignore this email.</p>
        <p style="color:#888;font-size:12px;text-align:center;margin-top:16px">Lisp Speech Clinic</p>
      </div>
    `,
  });
}

// POST /login-token { session_id | payment_id } -> { token } (one-time) or
// { pending: true }. Returns the custom token the webhook minted for this paid
// session, then deletes it so it can't be replayed. No token = payment not
// processed yet (client polls). session_id = inline-checkout path; payment_id =
// redirect/3DS path (return_url only carries payment_id).
async function handleLoginToken(req, res) {
  const body = req.body || {};
  const sessionId = body.session_id ? String(body.session_id) : '';
  const paymentId = body.payment_id ? String(body.payment_id) : '';
  const docId = sessionId || (paymentId ? 'pay_' + paymentId : '');
  if (!docId) { res.status(400).json({ error: 'missing session_id or payment_id' }); return; }
  try {
    const ref = admin.firestore().collection('login-handoffs').doc(docId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(200).json({ pending: true }); return; }
    const rec = snap.data() || {};
    if (rec.expiresAtMs && Date.now() > rec.expiresAtMs) {
      await ref.delete().catch(() => {});
      res.status(410).json({ error: 'expired' });
      return;
    }
    await ref.delete().catch(() => {}); // one-time use
    res.status(200).json({ token: rec.token });
  } catch (err) {
    console.error('[dodo/login-token] failed:', err.message);
    res.status(500).json({ error: 'login-token error' });
  }
}

// ---------- Forgot-password endpoint ----------
// POST /reset { email } -> sends branded reset mail via the same SMTP transport.
// Mirrors the previous standalone `sendresetemail` function so we deploy one
// Cloud Function instead of two. Auth-only — does NOT touch payment claims.
async function handleResetRequest(req, res) {
  const email = (req.body && req.body.email ? String(req.body.email) : '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'invalid email' });
    return;
  }

  try {
    // Avoid account enumeration: always return 200 if the user does not exist.
    let user;
    try {
      user = await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        res.status(200).json({ sent: true });
        return;
      }
      throw err;
    }

    // Only paid accounts get reset mail. Unpaid accounts silently 200 so we
    // don't leak which emails have purchased and don't waste SMTP on accounts
    // the app would reject at the entitlement gate anyway.
    const paid = !!(user.customClaims && user.customClaims.paid === true);
    if (!paid) {
      console.log('[dodo/reset] skip — unpaid:', email);
      res.status(200).json({ sent: true });
      return;
    }

    const fbLink = await admin.auth().generatePasswordResetLink(email, {
      url: `${APP_ORIGIN}/#/login`,
      handleCodeInApp: false,
    });
    const oobCode = new URL(fbLink).searchParams.get('oobCode');
    if (!oobCode) throw new Error('reset link missing oobCode');
    const link = `${APP_ORIGIN}/?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}#/login`;

    await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: 'Reset your Lisp Speech Clinic password',
      text: `We received a request to reset your Lisp Speech Clinic password.\n\nClick the link below to choose a new one:\n${link}\n\nIf you did not request this, ignore this email.`,
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
          <div style="text-align:center;margin:0 0 20px">
            <img src="${APP_ORIGIN}/icons/lisp-speech-clinic.png" alt="Lisp Speech Clinic" width="120" style="width:120px;height:auto;display:inline-block">
          </div>
          <h2 style="margin:0 0 16px;text-align:center">Reset your password</h2>
          <p>We received a request to reset your Lisp Speech Clinic password. Click below to choose a new one.</p>
          <p style="margin:24px 0;text-align:center">
            <a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">
              Reset password
            </a>
          </p>
          <p style="color:#555;font-size:14px">Or paste this link in your browser:<br><span style="word-break:break-all">${link}</span></p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#888;font-size:12px">If you did not request this, ignore this email — your password will not change.</p>
          <p style="color:#888;font-size:12px;text-align:center;margin-top:16px">Lisp Speech Clinic</p>
        </div>
      `,
    });

    console.log('[dodo/reset] reset mail sent to', email);
    res.status(200).json({ sent: true });
  } catch (err) {
    console.error('[dodo/reset] failed:', err.message);
    res.status(500).json({ error: 'send failed' });
  }
}

// ---------- Inline checkout endpoint ----------
// POST /checkout { product_id, email? } -> { checkout_url }
// Creates a Dodo checkout session server-side (needs the secret API key) so the
// browser can render the checkout inline via the dodopayments-checkout SDK.
// Entitlement is still granted by the webhook above on payment.succeeded — the
// returned session is only the UI; it is never proof of payment.
async function handleCreateCheckout(req, res) {
  const productId = req.body && req.body.product_id ? String(req.body.product_id) : '';
  if (!ALLOWED_PRODUCTS.has(productId)) {
    res.status(400).json({ error: 'unknown product' });
    return;
  }

  const email = req.body && req.body.email ? String(req.body.email).trim().toLowerCase() : '';
  // Prefill the buyer's name/phone captured during the assessment.
  const name = req.body && req.body.name ? String(req.body.name).trim().slice(0, 120) : '';
  const phone = req.body && req.body.phone ? String(req.body.phone).trim().slice(0, 32) : '';
  // Optional discount code — the inline frame has no coupon field, so the site
  // collects it and we pre-apply it to the session here.
  const discountCode = req.body && req.body.discount_code
    ? String(req.body.discount_code).trim().toUpperCase() : '';
  // Optional caller-supplied return URL (hosted-checkout redirect flow). Only
  // honoured when its origin is on our allowlist, so it can't be used as an open
  // redirect. Falls back to APP_ORIGIN otherwise.
  const requestedReturn = req.body && req.body.return_url ? String(req.body.return_url) : '';
  let returnUrl = APP_ORIGIN;
  try {
    const o = new URL(requestedReturn).origin;
    if (RESET_ALLOWED_ORIGINS.has(o) || VERCEL_PREVIEW_ORIGIN.test(o)) returnUrl = requestedReturn;
  } catch (e) { /* keep default */ }
  const payload = {
    product_cart: [{ product_id: productId, quantity: 1 }],
    return_url: returnUrl,
    // Absolute-minimum checkout: as Merchant of Record, Dodo only needs email +
    // billing country + card. Disable phone and business/tax id, collapse the
    // billing address to zip-only, and keep the prefilled email/name editable
    // (without allow_customer_editing_*, Dodo locks any prefilled `customer` field).
    feature_flags: {
      allow_discount_code: true,
      allow_phone_number_collection: false,
      allow_tax_id: false,
      minimal_address: true,
      allow_customer_editing_email: true,
      allow_customer_editing_name: true,
    },
  };
  if (discountCode) payload.discount_codes = [discountCode];
  // Prefill customer details the site already knows (from the assessment).
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    payload.customer = { email };
    if (name) payload.customer.name = name;
    // Phone intentionally omitted — phone collection is disabled (minimal checkout).
  }
  // Prefill the billing country from the caller's edge-geo signal (Vercel's
  // x-vercel-ip-country, same source that defaults the assessment phone code).
  // With minimal_address the buyer is then left with at most a ZIP. Partial
  // billing_address is fine — Dodo keeps it editable and collects the rest.
  const billingCountry = req.body && req.body.billing_country
    ? String(req.body.billing_country).trim().toUpperCase() : '';
  if (/^[A-Z]{2}$/.test(billingCountry)) payload.billing_address = { country: billingCountry };

  try {
    const resp = await fetch(DODO_CHECKOUTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DODO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error('[dodo/checkout] create session failed', resp.status, text);
      // A 4xx when a discount code was supplied is almost always a bad/ineligible
      // code — surface that distinctly so the UI can say "invalid code" instead of
      // a generic failure.
      if (discountCode && resp.status >= 400 && resp.status < 500) {
        res.status(422).json({ error: 'invalid_discount' });
        return;
      }
      res.status(502).json({ error: 'checkout session failed' });
      return;
    }

    const data = JSON.parse(text);
    res.status(200).json({
      checkout_url: data.checkout_url,
      session_id: data.session_id,
    });
  } catch (err) {
    console.error('[dodo/checkout] error:', err.message);
    res.status(500).json({ error: 'checkout error' });
  }
}
