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

  // ── Personalise: days since last assessment, name, baseline label ──
  var lastDateStr = localStorage.getItem('lispLastAssessmentDate') || '2026-07-07';
  var lastDate = new Date(lastDateStr + 'T00:00:00');
  var days = Math.max(1, Math.floor((Date.now() - lastDate.getTime()) / 86400000));
  var daysText = days + (days === 1 ? ' day' : ' days');
  document.querySelectorAll('[data-days-slot]').forEach(function (el) { el.textContent = daysText; });

  // Prefer the real Google/Apple display name over the email-derived fallback.
  var authName = '';
  try { var _ua = JSON.parse(localStorage.getItem('userAuth') || 'null'); authName = (_ua && _ua.name) ? String(_ua.name) : ''; } catch (e) {}
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
      var email = localStorage.getItem('assessmentUserEmail') || '';
      var phone = localStorage.getItem('assessmentUserPhone') || '';
      var name = '';
      try { var ua = JSON.parse(localStorage.getItem('userAuth') || 'null'); name = (ua && ua.name) || localStorage.getItem('assessmentUserName') || ''; } catch (e) {}

      var resp = await fetch(DODO_FN_BASE + '/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: RETAKE_PRODUCT, email: email, name: name, phone: phone, discount_code: '', return_url: RETURN_URL })
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
