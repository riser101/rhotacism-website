const functions = require('@google-cloud/functions-framework');
  const Stripe = require('stripe');
  const admin = require('firebase-admin');
  const nodemailer = require('nodemailer');

  admin.initializeApp();
  // Secrets come from env vars (they were hardcoded in the pre-repo deployed
  // source; GitHub push protection is why they moved). Every deploy of
  // sendResetEmail/stripeWebhook MUST pass --set-env-vars with
  // STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SMTP_USER, SMTP_PASS (and
  // HUBSPOT_TOKEN for the lead sync) or those paths break at runtime.
  // Lazy/tolerant: newer stripe versions throw on an empty key at construction,
  // which crashed functions deployed without STRIPE_SECRET_KEY (rollrAuthLead,
  // rollrBaselineLead) at module load. Only stripeWebhook needs it.
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

  const SMTP_USER = process.env.SMTP_USER || 'team@topspeech.health';
  const SMTP_PASS = process.env.SMTP_PASS || '';
  const SMTP_FROM = `"Top Speech Health" <${SMTP_USER}>`;

  const transporter = nodemailer.createTransport({
    host: 'mail.privateemail.com',
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // ── HubSpot lead sync (rhotacism) ─────────────────────────────────
  // Mirrors gcp-function-lisp: a sign-in IS a lead. Firestore
  // `hubspot-leads/{email}` is the cross-product dedupe marker shared with the
  // lisp backend (same rollr-academy Firestore), so a lisp signup is never
  // relabeled rhotacism and vice versa. Free-plan discipline: 2 custom
  // properties, batch upserts, notes for detail.
  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || '';
  const LEAD_STATUS_PROP = 'assessment_status';
  const LEAD_PRODUCT_PROP = 'assessment_product';

  async function hubspotPost(path, body) {
    const resp = await fetch('https://api.hubapi.com' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
    return { ok: resp.ok, status: resp.status, text, json };
  }

  async function hubspotGet(path) {
    const resp = await fetch('https://api.hubapi.com' + path, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
    return { ok: resp.ok, status: resp.status, text, json };
  }

  // Portal's onboarding-created "Speech challenge type" property — introspect
  // its internal name/option values once (crm.schemas.contacts.read; absent
  // scope → silently skipped) so leads also fill the property sales already
  // sees on the record.
  let _challengeProp = null;  // { name, value } | false
  async function rhotacismChallengeProp() {
    if (_challengeProp !== null) return _challengeProp;
    _challengeProp = false;
    try {
      const r = await hubspotGet('/crm/v3/properties/contacts');
      const props = (r.ok && r.json && r.json.results) || [];
      const p = props.find(x => /speech\s*challenge\s*type/i.test(x.label || '') || x.name === 'speech_challenge_type');
      const o = p && (p.options || []).find(o => /rhotacism/i.test(o.label || '') || /rhotacism/i.test(o.value || ''));
      if (p && o) _challengeProp = { name: p.name, value: o.value };
    } catch (e) {
      console.warn('speech-challenge introspection failed:', e.message);
    }
    return _challengeProp;
  }

  // The exec's owner id — assigned contacts fire the "Contact assigned to you"
  // mobile push (the free-plan new-lead alert). Cache only successful resolves.
  const HUBSPOT_OWNER_EMAIL = process.env.HUBSPOT_OWNER_EMAIL || 'founder@topspeech.health';
  let _ownerId = '';
  async function resolveOwnerId() {
    if (_ownerId) return _ownerId;
    try {
      const r = await hubspotGet('/crm/v3/owners/?limit=100');
      if (!r.ok) console.warn('owner resolve failed (leads land unassigned):', r.status, r.text.slice(0, 200));
      const owners = (r.ok && r.json && r.json.results) || [];
      const match = owners.find(o => (o.email || '').toLowerCase() === HUBSPOT_OWNER_EMAIL.toLowerCase()) || owners[0];
      if (match) _ownerId = String(match.id);
    } catch (e) { console.warn('owner resolve error:', e.message); }
    return _ownerId;
  }

  const escLead = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Rich completion note: GRI + survey answers + the scored word table — parity
  // with the lisp lead briefing (minus the PDF).
  function rhotacismNoteBody(survey, results, source) {
    const s = survey || {}, r = results || {};
    let html = `<p>✅ Completed the free rhotacism assessment (${source === 'app' ? 'Rollr app baseline' : 'web test'}).</p>`;
    const gri = Number(r.gri);
    if (Number.isFinite(gri)) html += `<p><strong>GRI: ${Math.round(gri)}/100</strong></p>`;
    const sv = [
      s.age_group && `Age group: ${escLead(s.age_group)}`,
      s.trouble_words && `Trouble words: ${escLead(s.trouble_words)}`,
      s.found_on && `Found via: ${escLead(s.found_on)}`,
      s.phone && `Phone: ${escLead(s.phone)}`
    ].filter(Boolean);
    if (sv.length) html += '<p>' + sv.join(' · ') + '</p>';
    const words = Array.isArray(r.words) ? r.words.slice(0, 15) : [];
    if (words.length) {
      html += '<table><tr><th>Word</th><th>Heard</th><th>Judgment</th><th>Quality</th><th>Observation</th></tr>'
        + words.map(w => `<tr><td>${escLead(w.word)}</td><td>${escLead(w.heard)}</td><td>${escLead(w.judgment)}</td><td>${escLead(w.quality)}</td><td>${escLead(w.observation)}</td></tr>`).join('')
        + '</table>';
    }
    return html;
  }

  async function upsertLeadContact(email, properties) {
    const id = String(email).toLowerCase();
    let up = await hubspotPost('/crm/v3/objects/contacts/batch/upsert', {
      inputs: [{ idProperty: 'email', id, properties }]
    });
    if (!up.ok && up.status === 400) {
      // Custom properties may not exist yet — the contact must land anyway.
      up = await hubspotPost('/crm/v3/objects/contacts/batch/upsert', {
        inputs: [{ idProperty: 'email', id,
                   properties: { email: properties.email, firstname: properties.firstname } }]
      });
    }
    return up;
  }

  async function attachLeadNote(up, html) {
    const contactId = up.json && up.json.results && up.json.results[0] && String(up.json.results[0].id || '');
    if (!contactId) return;
    await hubspotPost('/crm/v3/objects/notes', {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: html },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
    });
  }

  // Shared handler for web-test beacons and the auth trigger.
  // event 'signin' is marker-deduped; 'completed' always flips the status.
  async function pushRhotacismLead({ email, name, event, source, country, survey, results }) {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || !HUBSPOT_TOKEN) return { skipped: true };
    const ref = admin.firestore().collection('hubspot-leads').doc(e);
    const existing = await ref.get();
    if (event === 'signin' && existing.exists) return { skipped: true };
    const status = event === 'completed' ? 'completed' : 'signed_in';
    const challenge = await rhotacismChallengeProp();
    const props = {
      email: e,
      firstname: String(name || '').trim().split(' ')[0] || '',
      lifecyclestage: 'lead',
      [LEAD_STATUS_PROP]: status,
      [LEAD_PRODUCT_PROP]: 'rhotacism',
      [event === 'completed' ? 'assessment_completed_at' : 'signed_in_at']: String(Date.now())
    };
    if (challenge) props[challenge.name] = challenge.value;
    const cc = String(country || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) props.country = cc;
    const phone = String((survey && survey.phone) || '').trim();
    if (phone) props.phone = phone;
    const ownerId = await resolveOwnerId();
    if (ownerId) props.hubspot_owner_id = ownerId;
    const up = await upsertLeadContact(e, props);
    if (!up.ok) {
      console.warn('rhotacism lead upsert failed:', up.status, up.text.slice(0, 200));
      return { error: true };
    }
    await attachLeadNote(up, event === 'completed'
      ? rhotacismNoteBody(survey, results, source)
      : `<p>🔶 Signed in to the free rhotacism assessment (${source === 'app' ? 'Rollr app' : 'web test'}) — full assessment <strong>NOT completed</strong> yet.</p>`);
    await ref.set({ product: 'rhotacism', source: source || 'web', status,
                    [event === 'completed' ? 'completedAt' : 'signupLeadAt']: new Date().toISOString() },
                  { merge: true });
    console.log('🟠 rhotacism lead pushed:', e, status, source || 'web');
    return { ok: true };
  }

  functions.http('stripeWebhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      // req.rawBody provided by Functions Framework
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email;
      if (!email) return res.status(400).send('No email');

      try {
        let user;
        try {
          user = await admin.auth().getUserByEmail(email);
        } catch {
          user = await admin.auth().createUser({ email, emailVerified: true });
        }

        // Entitlement: server-verified proof of purchase. The app gates access
        // on this claim, NOT merely on the account existing or being signed in.
        await admin.auth().setCustomUserClaims(user.uid, { paid: true });

        const fbLink = await admin.auth().generatePasswordResetLink(email, {
          url: 'https://lisp-pwa-9267895976.us-central1.run.app/#/onboarding',
          handleCodeInApp: false,
        });
        const oobCode = new URL(fbLink).searchParams.get('oobCode');
        const link = `https://lisp-pwa-9267895976.us-central1.run.app/?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}#/login`;

        await transporter.sendMail({
          from: SMTP_FROM,
          to: email,
          subject: 'Welcome to Top Speech Health — set your password',
          text: `Thanks for your purchase!\n\nSet your password to access your Top Speech Health account:\n${link}\n\nIf you did not make this purchase, ignore this email.`,
          html: `
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <div style="text-align:center;margin:0 0 20px">
                <img src="https://topspeech.health/favicon.png" alt="Top Speech Health" width="96" style="width:96px;height:96px;display:inline-block;border-radius:12px">
              </div>
              <h2 style="margin:0 0 16px;text-align:center">Welcome to Top Speech Health</h2>
              <p>Thanks for your purchase! Click below to set your password and access your account.</p>
              <p style="margin:24px 0;text-align:center">
                <a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">
                  Set your password
                </a>
              </p>
              <p style="color:#555;font-size:14px">Or paste this link in your browser:<br><span style="word-break:break-all">${link}</span></p>
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#888;font-size:12px">If you did not make this purchase, ignore this email.</p>
              <p style="color:#888;font-size:12px;text-align:center;margin-top:16px">Top Speech Health</p>
            </div>
          `,
        });

        console.log('Password set email sent to', email);
      } catch (err) {
        console.error(err);
        return res.status(500).send('Internal error');
      }
    }

    res.status(200).json({ received: true });
  });

  // ── Forgot-password endpoint ──────────────────────────────────────
  // POST { email } → generates Firebase reset link, sends branded email.
  // Deploy separately:
  //   gcloud functions deploy sendResetEmail \
  //     --gen2 --runtime=nodejs20 --region=us-central1 \
  //     --source=functions/stripe-webhook --entry-point=sendResetEmail \
  //     --trigger-http --allow-unauthenticated
  functions.http('sendResetEmail', async (req, res) => {
    // CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Branch: passwordless sign-in link (assessment login). No paid gate.
    if (req.body && req.body.action === 'signin') {
      const sEmail = (req.body.email || '').trim().toLowerCase();
      const continueUrl = req.body.continueUrl ||
        'https://topspeech.health/lispspeechclinic/assessment.html#login';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sEmail)) {
        return res.status(400).json({ error: 'Invalid email' });
      }
      try {
        console.log('signin branch hit for', sEmail);
        // Generate the Firebase email-link, then re-host it on our own domain
        // instead of emailing the raw firebaseapp.com action URL. We keep every
        // param Firebase set (mode=signIn, oobCode, apiKey, continueUrl, lang)
        // and only swap the host+path to the assessment page, which already
        // handles isSignInWithEmailLink / signInWithEmailLink on load.
        const fbLink = await admin.auth().generateSignInWithEmailLink(sEmail, {
          url: continueUrl,
          handleCodeInApp: true,
        });
        // Re-host onto the SAME assessment page the user came from (continueUrl),
        // not a hardcoded lisp path — otherwise a stutter user lands on lisp.
        const dest = new URL(continueUrl.split('#')[0]);
        new URL(fbLink).searchParams.forEach((v, k) => dest.searchParams.set(k, v));
        dest.hash = 'login';
        const link = dest.toString();
        await transporter.sendMail({
          from: SMTP_FROM,
          to: sEmail,
          subject: 'Verify your email — Top Speech Health',
          text: `Verify your email to continue your assessment.\n\nClick the link below to verify :\n${link}\n\nIf you did not request this, you can ignore this email. The link expires in 1 hour.`,
          html: `
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <div style="text-align:center;margin:0 0 20px">
                <img src="https://topspeech.health/favicon.png" alt="Top Speech Health" width="96" style="width:96px;height:96px;display:inline-block;border-radius:12px">
              </div>
              <h2 style="margin:0 0 16px;text-align:center">Verify your email</h2>
              <p>Verify your email to continue your Top Speech Health speech assessment. Click below to verify and resume.</p>
              <p style="margin:24px 0;text-align:center">
                <a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">
                  Verify email
                </a>
              </p>
              <p style="color:#555;font-size:14px">Or paste this link in your browser:<br><span style="word-break:break-all">${link}</span></p>
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#888;font-size:12px">If you did not request this, you can safely ignore this email. The link expires in 1 hour.</p>
              <p style="color:#888;font-size:12px;text-align:center;margin-top:16px">Top Speech Health</p>
            </div>
          `,
        });
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error('signin email error:', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Branch: HubSpot lead beacon from the rhotacism web test.
    // POST { action:'hubspotLead', event:'signin'|'completed', email, name? }.
    // Unauthenticated by design (same trust level as action:'signin' above);
    // worst case is a marker-deduped contact upsert.
    if (req.body && req.body.action === 'hubspotLead') {
      try {
        const out = await pushRhotacismLead({
          email: req.body.email, name: req.body.name,
          event: req.body.event === 'completed' ? 'completed' : 'signin',
          source: 'web', country: req.body.country,
          survey: req.body.survey || null, results: req.body.results || null
        });
        return res.status(200).json(out);
      } catch (err) {
        console.error('hubspotLead error:', err.message);
        return res.status(200).json({ error: true });  // never break the test flow
      }
    }

    // Branch: mint an app login handoff for the signed-in child. The results page
    // sends the child's Firebase ID token; we verify it and return a one-time
    // custom token the app exchanges via its existing #/handoff/<token> door —
    // so "Start Day 1" needs no re-login despite the origin change.
    if (req.body && req.body.action === 'mintAppHandoff') {
      try {
        const decoded = await admin.auth().verifyIdToken(String(req.body.idToken || ''));
        const custom = await admin.auth().createCustomToken(decoded.uid);
        return res.status(200).json({ token: custom });
      } catch (err) {
        console.error('mintAppHandoff error:', err.message);
        return res.status(401).json({ error: 'Not signed in' });
      }
    }

    // Branch: parent opens a shared report link (report.html?share=<token>).
    // POST { action:'getSharedReport', token } → { name, completedAt, gri, categories }
    if (req.body && req.body.action === 'getSharedReport') {
      const token = String(req.body.token || '');
      if (!/^[a-f0-9]{48}$/.test(token)) return res.status(400).json({ error: 'Invalid link' });
      try {
        const tokSnap = await admin.firestore().collection('share-tokens').doc(token).get();
        if (!tokSnap.exists) return res.status(404).json({ error: 'Link not found or revoked' });
        const tok = tokSnap.data();
        if (tok.expiresAt && Date.now() > tok.expiresAt) {
          return res.status(410).json({ error: 'Link expired' });
        }
        const userSnap = await admin.firestore().collection('lisp-users').doc(String(tok.uid)).get();
        const a = userSnap.exists ? (userSnap.data().latestAssessment || null) : null;
        if (!a) return res.status(404).json({ error: 'Report not available' });
        return res.status(200).json({
          name: tok.teenName || '',
          // Child's email so the parent's checkout prefills it — entitlement is
          // keyed to the checkout email, and it must land on the child's account.
          email: userSnap.data().email || '',
          completedAt: a.completedAt || null,
          gri: a.gri ?? null,
          categories: a.categories || [],
        });
      } catch (err) {
        console.error('getSharedReport error:', err);
        return res.status(500).json({ error: 'Could not load report' });
      }
    }

    // Branch: teen shares assessment report summary with a parent/guardian.
    // POST { action:'shareReport', parentEmail, teenName?, uid?, teenEmail?, gri?, summary?: [{title,total,accurate}] }
    if (req.body && req.body.action === 'shareReport') {
      const pEmail = (req.body.parentEmail || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail)) {
        return res.status(400).json({ error: 'Invalid email' });
      }
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const teenName = esc(String(req.body.teenName || '').slice(0, 80).trim());
      const who = teenName || 'Your teen';
      const griNum = Number(req.body.gri);
      const gri = Number.isFinite(griNum) ? Math.max(0, Math.min(100, Math.round(griNum))) : null;
      const summary = (Array.isArray(req.body.summary) ? req.body.summary : []).slice(0, 10);
      const rowsHtml = summary.map((s) => {
        const total = parseInt(s && s.total, 10) || 0;
        const acc = parseInt(s && s.accurate, 10) || 0;
        return `<tr>
          <td style="padding:10px 12px;border-bottom:1px solid #eee">${esc(s && s.title)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;white-space:nowrap">${acc} / ${total} accurate</td>
        </tr>`;
      }).join('');
      const rowsText = summary.map((s) =>
        `- ${String(s && s.title || '')}: ${parseInt(s && s.accurate, 10) || 0} of ${parseInt(s && s.total, 10) || 0} accurate`).join('\n');
      const griHtml = gri === null ? '' : `
        <p style="text-align:center;margin:20px 0 4px;color:#555;font-size:14px">Overall /s/ sound score</p>
        <p style="text-align:center;margin:0 0 20px;font-size:40px;font-weight:800;color:#1A202C">${gri}<span style="font-size:18px;color:#888">/100</span></p>`;
      // Score-band phrase for the "What do these results mean?" section.
      const bandPhrase = gri === null ? null
        : gri < 35 ? 'a strong lisp pattern'
        : gri < 70 ? 'a noticeable distortion'
        : 'only mild deviations — largely within normal limits';
      const meanHtml = bandPhrase === null ? '' : `
              <h3 style="margin:28px 0 8px">What do these results mean?</h3>
              <p style="margin:0 0 14px">A score in this range indicates ${bandPhrase} in ${who}&rsquo;s speech pattern.</p>
              <p style="margin:0 0 14px">For teenagers, an untreated lisp isn't just a speech hurdle; it can deeply impact their self-esteem, making them self-conscious during classroom presentations, social gatherings, and daily conversations. The fact that ${who} sought out this assessment on their own shows that this is something they are actively thinking about&mdash;and they are looking for a solution.</p>`;
      const meanText = bandPhrase === null ? '' :
        `What do these results mean?\n\nA score in this range indicates ${bandPhrase} in ${who}'s speech pattern.\n\n`
        + `For teenagers, an untreated lisp isn't just a speech hurdle; it can deeply impact their self-esteem, making them self-conscious during classroom presentations, social gatherings, and daily conversations. The fact that ${who} sought out this assessment on their own shows that this is something they are actively thinking about — and they are looking for a solution.\n\n`;
      const PRICING_URL = 'https://topspeech.health/lispspeechclinic/pricing.html';
      // Live report link: mint a share token pointing at the child's Firestore
      // record (lisp-users/{uid}.latestAssessment). Resolve uid directly, or by
      // teenEmail lookup when the page didn't have an auth uid at send time.
      let reportUrl = null;
      try {
        let uid = String(req.body.uid || '').trim();
        const teenEmail = String(req.body.teenEmail || '').trim().toLowerCase();
        if (!uid && teenEmail) {
          const q = await admin.firestore().collection('lisp-users')
            .where('email', '==', teenEmail).get();
          let best = null;
          q.forEach((d) => {
            const data = d.data();
            if (!data.latestAssessment) return;
            const ts = data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : 0;
            if (!best || ts > best.ts) best = { id: d.id, ts };
          });
          if (best) uid = best.id;
        }
        if (uid) {
          const userSnap = await admin.firestore().collection('lisp-users').doc(uid).get();
          if (userSnap.exists && userSnap.data().latestAssessment) {
            const token = require('crypto').randomBytes(24).toString('hex');
            await admin.firestore().collection('share-tokens').doc(token).set({
              uid,
              teenName: teenName || '',
              parentEmail: pEmail,
              createdAt: Date.now(),
              expiresAt: Date.now() + 90 * 24 * 3600 * 1000, // 90 days
            });
            reportUrl = 'https://topspeech.health/lispspeechclinic/assessment.html?share=' + token;
          }
        }
      } catch (err) {
        console.error('share token mint failed (email still sent):', err);
      }
      try {
        await transporter.sendMail({
          from: SMTP_FROM,
          to: pEmail,
          subject: `${who} completed a speech assessment`,
          text: `Hi there,\n\n`
            + `${who} completed a comprehensive lisp speech assessment on Top Speech Health.\n\n`
            + (gri === null ? '' : `${gri}/100\n\n`)
            + (rowsText ? `Results by section:\n${rowsText}\n\n` : '')
            + meanText
            + `The good news? It's highly treatable.\n\n`
            + `Speech patterns can be corrected with targeted, consistent practice. You can help ${who} build lifelong confidence without the hassle, waitlists, or high costs of traditional in-person clinics.\n\n`
            + `Our digital platform provides an effective, private, and engaging way for them to improve their articulation directly from their phone or computer.\n\n`
            + (reportUrl ? `View ${who}'s full report: ${reportUrl}\n\n` : '')
            + `See the guided therapy program: ${PRICING_URL}\n\n`
            + `This automated screening is not a medical diagnosis. If you have concerns, consult a licensed speech-language pathologist.`,
          html: `
            <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
              <div style="text-align:center;margin:0 0 20px">
                <img src="https://topspeech.health/favicon.png" alt="Top Speech Health" width="96" style="width:96px;height:96px;display:inline-block;border-radius:12px">
              </div>
              <h2 style="margin:0 0 16px;text-align:center">${who} completed a speech assessment</h2>
              <p style="margin:0 0 14px">Hi there,</p>
              <p style="margin:0 0 14px">${who} completed a comprehensive lisp speech assessment on Top Speech Health.</p>
              ${griHtml}
              ${rowsHtml ? `
              <table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 20px">
                <tr>
                  <th style="text-align:left;padding:10px 12px;border-bottom:2px solid #ddd">Section</th>
                  <th style="text-align:center;padding:10px 12px;border-bottom:2px solid #ddd">Accuracy</th>
                </tr>
                ${rowsHtml}
              </table>` : ''}
              ${meanHtml}
              <h3 style="margin:28px 0 8px">The good news? It&rsquo;s highly treatable.</h3>
              <p style="margin:0 0 14px">Speech patterns can be corrected with targeted, consistent practice. You can help ${who} build lifelong confidence without the hassle, waitlists, or high costs of traditional in-person clinics.</p>
              <p style="margin:0 0 14px">Our digital platform provides an effective, private, and engaging way for them to improve their articulation directly from their phone or computer.</p>
              ${reportUrl ? `
              <p style="margin:24px 0 8px;text-align:center">
                <a href="${reportUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">
                  View ${who}'s full report
                </a>
              </p>
              <p style="margin:0 0 8px;text-align:center">
                <a href="${PRICING_URL}" style="color:#2563eb;text-decoration:underline;font-weight:600">See the guided therapy program</a>
              </p>` : `
              <p style="margin:24px 0;text-align:center">
                <a href="${PRICING_URL}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">
                  See the guided therapy program
                </a>
              </p>`}
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#888;font-size:12px">This automated screening is not a medical diagnosis. If you have concerns, consult a licensed speech-language pathologist.</p>
              <p style="color:#888;font-size:12px">You received this because someone entered your email when sharing their assessment results. If this wasn't expected, you can ignore this email.</p>
              <p style="color:#888;font-size:12px;text-align:center;margin-top:16px">Top Speech Health</p>
            </div>
          `,
        });
        console.log('shareReport email sent to', pEmail);
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error('shareReport email error:', err);
        return res.status(500).json({ error: 'Could not send report' });
      }
    }

    const email = (req.body && req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    try {
      // Don't reveal whether account exists — succeed silently if not found.
      // Gate on the server-verified `paid` claim: only paying customers may
      // reset. Unpaid Auth records (social sign-in, abandoned checkout) must
      // not receive a reset link.
      try {
        const user = await admin.auth().getUserByEmail(email);
        if (!user.customClaims || user.customClaims.paid !== true) {
          return res.status(200).json({ ok: true });
        }
      } catch {
        return res.status(200).json({ ok: true });
      }

      const fbLink = await admin.auth().generatePasswordResetLink(email, {
        url: 'https://lisp-pwa-9267895976.us-central1.run.app/#/login',
        handleCodeInApp: false,
      });
      const oobCode = new URL(fbLink).searchParams.get('oobCode');
      const link = `https://lisp-pwa-9267895976.us-central1.run.app/?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}#/login`;

      await transporter.sendMail({
        from: SMTP_FROM,
        to: email,
        subject: 'Reset your Top Speech Health password',
        text: `We received a request to reset your Top Speech Health password.\n\nClick the link below to choose a new one:\n${link}\n\nIf you did not request this, you can ignore this email.`,
        html: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
            <div style="text-align:center;margin:0 0 20px">
              <img src="https://topspeech.health/favicon.png" alt="Top Speech Health" width="96" style="width:96px;height:96px;display:inline-block;border-radius:12px">
            </div>
            <h2 style="margin:0 0 16px;text-align:center">Reset your password</h2>
            <p>We received a request to reset your Top Speech Health password. Click below to choose a new one.</p>
            <p style="margin:24px 0;text-align:center">
              <a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">
                Reset password
              </a>
            </p>
            <p style="color:#555;font-size:14px">Or paste this link in your browser:<br><span style="word-break:break-all">${link}</span></p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
            <p style="color:#888;font-size:12px">If you did not request this, you can safely ignore this email. The link expires in 1 hour.</p>
            <p style="color:#888;font-size:12px;text-align:center;margin-top:16px">Top Speech Health</p>
          </div>
        `,
      });

      console.log('Reset email sent to', email);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('sendResetEmail error:', err);
      return res.status(500).json({ error: 'Could not send reset email' });
    }
  });

  // ── Rollr app signups → HubSpot ───────────────────────────────────
  // Gen1 background trigger on Firebase Auth user creation: covers the iOS/
  // Android app (and any flow with no web beacon). Waits, then claims the
  // lead only if no web flow (lisp entitlement check / rhotacism web beacon)
  // wrote the shared marker first — that's what attributes the product.
  // Deploy:
  //   gcloud functions deploy rollrAuthLead --no-gen2 --runtime=nodejs20 \
  //     --region=us-central1 --project=rollr-academy \
  //     --trigger-event=providers/firebase.auth/eventTypes/user.create \
  //     --trigger-resource=rollr-academy --entry-point=rollrAuthLead \
  //     --timeout=180s --set-env-vars HUBSPOT_TOKEN=<token>
  exports.rollrAuthLead = async (user) => {
    try {
      const email = String((user && user.email) || '').trim().toLowerCase();
      if (!email) return;  // anonymous sessions are not leads
      // Give the web flows time to claim this user with product context.
      await new Promise(r => setTimeout(r, 90 * 1000));
      const marked = await admin.firestore().collection('hubspot-leads').doc(email).get();
      if (marked.exists) return;
      await pushRhotacismLead({ email, name: (user && user.displayName) || '', event: 'signin', source: 'app' });
    } catch (e) {
      console.error('rollrAuthLead error:', e.message);
    }
  };

  // ── App baseline completion → HubSpot ─────────────────────────────
  // Gen1 Firestore trigger on users/{uid}: when the Rollr app writes the
  // baselineAssessment (griScore + wordResults), flip the lead to completed
  // with the full scored report in the note — the server-side DB is the
  // source of truth, so no app release is needed. The web test never writes
  // users/{uid}, so this path is app-only; the marker check still skips
  // anyone already completed elsewhere.
  // Deploy:
  //   gcloud functions deploy rollrBaselineLead --no-gen2 --runtime=nodejs20 \
  //     --region=us-central1 --project=rollr-academy --source=. \
  //     --entry-point=rollrBaselineLead \
  //     --trigger-event=providers/cloud.firestore/eventTypes/document.write \
  //     --trigger-resource="projects/rollr-academy/databases/(default)/documents/users/{uid}" \
  //     --timeout=60s --set-env-vars HUBSPOT_TOKEN=<token>
  // Gen1 Firestore events carry protobuf-style typed fields — tiny decoder:
  function fsVal(v) {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.integerValue !== undefined) return Number(v.integerValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.timestampValue !== undefined) return v.timestampValue;
    if (v.mapValue) return fsMap(v.mapValue.fields || {});
    if (v.arrayValue) return (v.arrayValue.values || []).map(fsVal);
    return null;
  }
  function fsMap(fields) { const o = {}; for (const k of Object.keys(fields || {})) o[k] = fsVal(fields[k]); return o; }

  exports.rollrBaselineLead = async (change, context) => {
    try {
      const after = change.value && change.value.fields ? fsMap(change.value.fields) : null;
      const base = after && after.baselineAssessment;
      if (!base || !base.wordResults) return;
      // Fire only when the baseline first appears or is re-taken.
      const before = change.oldValue && change.oldValue.fields ? fsMap(change.oldValue.fields) : {};
      const prev = before.baselineAssessment;
      if (prev && String(prev.createdAt) === String(base.createdAt)) return;
      const res = (context && context.resource) || (change.value && change.value.name) || '';
      const uid = String(res).split('/users/')[1] || '';
      let email = String(after.email || '').trim().toLowerCase();
      let name = String(after.name || after.displayName || '').trim();
      if ((!email || !name) && uid) {
        try {
          const u = await admin.auth().getUser(uid);
          email = email || String(u.email || '').toLowerCase();
          name = name || String(u.displayName || '').trim();
        } catch (e) { /* auth record gone */ }
      }
      if (!email) return;
      // Already completed via another flow — don't double-note.
      const marker = await admin.firestore().collection('hubspot-leads').doc(email).get();
      if (marker.exists && (marker.data() || {}).status === 'completed') return;
      const words = Object.entries(base.wordResults).map(([word, w]) => ({
        word,
        heard: (w || {}).heard, judgment: (w || {}).judgment,
        quality: (w || {}).quality, observation: (w || {}).observation
      }));
      await pushRhotacismLead({
        email, name, event: 'completed', source: 'app',
        results: { gri: base.griScore, words }
      });
    } catch (e) {
      console.error('rollrBaselineLead error:', e.message);
    }
  };
