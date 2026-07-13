/* Lisp Speech Clinic — $19 retake paywall.
   Redirects to Dodo Payments' HOSTED checkout (full page) so Apple Pay / Google
   Pay wallets are offered (Dodo does not support wallets in the inline overlay).
   Reuses the same GCP Cloud Run /checkout session endpoint the assessment program
   checkout uses; only the product differs. After payment Dodo redirects back to
   this page (return_url) with a payment_id, and we reflect success + let the user
   start their assessment. States: idle → processing (redirecting) → done. */
(function () {
  'use strict';

  var RETAKE_PRODUCT = 'pdt_0Nj0v8UWXMwVLyCVuRUk3';
  var DODO_FN_BASE   = 'https://dodowebhook-9267895976.us-central1.run.app';
  var ASSESSMENT_URL = '/lispspeechclinic/assessment.html?retake=1';
  var RETURN_URL     = window.location.origin + '/lispspeechclinic/retake.html?paid=1';

  var root = document.getElementById('retake');
  if (!root) return;
  function setState(s) { root.setAttribute('data-state', s); }
  function track(ev, props) { try { if (window.posthog && window.posthog.capture) window.posthog.capture(ev, props || {}); } catch (e) {} }

  // ── Personalise: time since last assessment, name, baseline label ──
  // Elapsed time is computed from a real timestamp (server `completedAt` is the
  // source of truth; the localStorage full-ISO stamp is the instant-paint / offline
  // fallback), so sub-day gaps render as minutes/hours instead of a floored "1 day".
  var GCP_ANALYZE_URL = 'https://analyze-lisp-speech-653307587559.us-central1.run.app';
  // Days-since-baseline still keyed off the (date-only) baseline label below.
  var lastDateStr = localStorage.getItem('lispLastAssessmentDate') || '2026-07-07';
  var lastDate = new Date(lastDateStr + 'T00:00:00');
  var days = Math.max(1, Math.floor((Date.now() - lastDate.getTime()) / 86400000));

  // Best available full timestamp for the last assessment, in ms (0 = unknown).
  function localLastMs() {
    var iso = localStorage.getItem('lispLastAssessmentAt');
    var t = iso ? Date.parse(iso) : NaN;
    if (!isNaN(t)) return t;
    // Legacy: only the date-only stamp exists — treat as that day's midnight.
    var d = Date.parse(lastDateStr + 'T00:00:00');
    return isNaN(d) ? 0 : d;
  }
  // Noun phrase for the elapsed gap — always reads correctly with the static
  // " ago" already in the HTML: minutes < 1h, hours < 1d, else days.
  function agoText(ms) {
    if (!ms || ms < 0) return 'a few days';
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'moments';
    if (mins < 60) return mins + (mins === 1 ? ' minute' : ' minutes');
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour' : ' hours');
    var d = Math.floor(hrs / 24);
    return d + (d === 1 ? ' day' : ' days');
  }
  function renderElapsed(lastMs) {
    var txt = agoText(Date.now() - lastMs);
    document.querySelectorAll('[data-days-slot]').forEach(function (el) { el.textContent = txt; });
  }
  renderElapsed(localLastMs());

  // Correct against the server's authoritative completedAt (the localStorage stamp
  // is missing on a fresh device / social-only login). Best-effort; UI already shows
  // the local estimate.
  var _uid = (authObjEarly() || {}).id;
  if (_uid) {
    fetch(GCP_ANALYZE_URL + '?uid=' + encodeURIComponent(_uid))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var iso = d && d.latestAssessment && d.latestAssessment.completedAt;
        var t = iso ? Date.parse(iso) : NaN;
        if (!isNaN(t)) { try { localStorage.setItem('lispLastAssessmentAt', iso); } catch (e) {} renderElapsed(t); }
      })
      .catch(function () {});
  }
  function authObjEarly() { try { return JSON.parse(localStorage.getItem('userAuth') || 'null'); } catch (e) { return null; } }

  // Resolve the buyer's identity from every place it might live: the assessment
  // flow (assessmentUser*) OR social login (userAuth / userEmail). Checkout below
  // reuses these so the Dodo form is prefilled even when the user only signed in
  // socially (e.g. a fresh Safari) and never ran the assessment on this device.
  var authObj = null;
  try { authObj = JSON.parse(localStorage.getItem('userAuth') || 'null'); } catch (e) {}
  var authName  = (authObj && authObj.name)  ? String(authObj.name)  : '';
  var buyerEmail = localStorage.getItem('assessmentUserEmail')
    || (authObj && authObj.email ? String(authObj.email) : '')
    || localStorage.getItem('userEmail') || '';
  // Full name comes from the social login: userAuth.name is set from the
  // Google/Apple displayName at sign-in (see assessment.html → obAfterSignIn),
  // with lispUserFirstName (also derived from the real name) as fallback. We do
  // NOT use assessmentUserName — that's synthesised from the email local-part
  // (e.g. "Sy.yousuf9106"), never a real name.
  var buyerName = authName || localStorage.getItem('lispUserFirstName') || '';
  var buyerPhone = localStorage.getItem('assessmentUserPhone') || '';

  // Infer the billing country from Vercel's edge GeoIP (same /api/geo the
  // assessment uses to default the phone country code), so Dodo's checkout
  // pre-selects it. Kicked off now; resolved by the time Pay is clicked.
  var geoCountryPromise = fetch('/api/geo')
    .then(function (r) { return r.json(); })
    .then(function (d) { return (d && d.country) ? String(d.country).toUpperCase() : ''; })
    .catch(function () { return ''; });
  var firstName = (localStorage.getItem('lispUserFirstName') || authName || localStorage.getItem('assessmentUserName') || '').trim().split(' ')[0];
  document.querySelectorAll('[data-name-slot]').forEach(function (el) {
    el.textContent = firstName ? ('Welcome back, ' + firstName) : 'Welcome back';
  });
  document.querySelectorAll('[data-baseline-slot]').forEach(function (el) {
    el.textContent = lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' — baseline · free';
  });

  // ── Success handling ──
  // Crediting is authoritative server-side: the Dodo `payment.succeeded` webhook
  // grants the paid retake credit (see gcp-function-dodo → grantLispRetakeCredit).
  // Here we only reflect success in the UI; the analysis gate reads the credit.
  var succeeded = false;
  function onSuccess() {
    if (succeeded) return;
    succeeded = true;
    try { localStorage.setItem('lispRetakePaid', '1'); } catch (e) {}
    track('lisp_retake_pay_success', {});
    setState('done');
  }
  document.querySelectorAll('[data-start]').forEach(function (btn) {
    btn.addEventListener('click', function () { track('lisp_retake_start_assessment', {}); window.location.href = ASSESSMENT_URL; });
  });

  // ── Return from Dodo's hosted checkout ──
  // On completion Dodo redirects to return_url with ?payment_id=… (and a status).
  // Treat that as success unless the status explicitly says otherwise — the
  // assessment gate re-checks the server-side credit regardless, so an over-
  // optimistic "done" screen can't unlock a run that wasn't actually paid.
  var params = new URLSearchParams(window.location.search);
  var status = (params.get('status') || '').toLowerCase();
  var returned = params.get('paid') === '1' || params.get('payment_id') || params.get('status');
  if (returned && !/fail|cancel|error|declin/.test(status)) {
    onSuccess();
  }

  // ── Pay: redirect to Dodo's hosted checkout ──
  // QA: a hidden ?test=1 on the paywall makes Pay jump the gate instead of opening
  // Dodo, so the full retake flow can be tested without paying (test=1 is forwarded
  // to the analysis server, which allows the gated run). Not discoverable by users.
  var TEST_MODE = params.get('test') === '1';
  var redirecting = false;
  async function startCheckout(method) {
    track('lisp_retake_pay_click', { method: method || 'card' });
    if (TEST_MODE) { window.location.href = ASSESSMENT_URL + '&test=1'; return; }
    if (redirecting) return;
    redirecting = true;
    setState('processing');
    try {
      var billingCountry = '';
      try { billingCountry = await geoCountryPromise; } catch (e) {}
      var resp = await fetch(DODO_FN_BASE + '/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: RETAKE_PRODUCT, email: buyerEmail, name: buyerName, phone: buyerPhone, discount_code: '', return_url: RETURN_URL, billing_country: billingCountry })
      });
      if (!resp.ok) throw new Error('session http ' + resp.status);
      var data = await resp.json();
      if (!data.checkout_url) throw new Error('no checkout_url');
      track('lisp_retake_checkout_open', { days_since_last: days });
      window.location.assign(data.checkout_url);
    } catch (e) {
      try { console.error('[dodo] checkout redirect failed', e); } catch (_) {}
      redirecting = false;
      setState('idle');
    }
  }
  document.querySelectorAll('[data-pay]').forEach(function (btn) {
    btn.addEventListener('click', function () { startCheckout(btn.getAttribute('data-pay')); });
  });
})();
