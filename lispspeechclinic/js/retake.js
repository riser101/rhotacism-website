/* Lisp Speech Clinic — $19 retake paywall.
   Mounts Dodo Payments INLINE checkout (Apple Pay + card) directly in the bento
   box — same-page, minimum friction. Reuses the same GCP Cloud Run /checkout
   session endpoint the assessment program checkout uses; only the product differs.
   States: idle (checkout) → processing → done, via #retake[data-state]. */
(function () {
  'use strict';

  var RETAKE_PRODUCT = 'pdt_0Nj0v8UWXMwVLyCVuRUk3';
  var DODO_FN_BASE   = 'https://dodowebhook-9267895976.us-central1.run.app';
  var ASSESSMENT_URL = '/lispspeechclinic/assessment.html?retake=1';

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

  // ── Dodo inline checkout ──
  function getSdk() {
    if (window.DodoPaymentsCheckout && window.DodoPaymentsCheckout.DodoPayments) return window.DodoPaymentsCheckout.DodoPayments;
    if (window.DodoPayments) return window.DodoPayments;
    return null;
  }
  var sdkPromise = null;
  function loadSdk() {
    if (getSdk()) return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/dodopayments-checkout@latest/dist/index.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  var initDone = false;
  function ensureInit() {
    if (initDone) return;
    getSdk().Initialize({
      mode: 'live',
      displayType: 'inline',
      onEvent: function (ev) {
        var t = ev && (ev.event_type || ev.type);
        try { console.log('[dodo]', t); } catch (e) {}
        if (t === 'checkout.form_ready' || t === 'checkout.opened') hideStatus();
        if (t === 'checkout.payment_succeeded' || t === 'checkout.completed' || t === 'checkout.redirect' || t === 'payment.succeeded') onSuccess();
      }
    });
    initDone = true;
  }

  // Pick the mount container that's actually visible for the current breakpoint.
  function visibleMount() {
    var els = document.querySelectorAll('[data-dodo-mount]');
    for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) return els[i]; }
    return els[0] || null;
  }
  function hideStatus() {
    document.querySelectorAll('[data-dodo-status]').forEach(function (el) { el.style.display = 'none'; });
  }

  async function mountCheckout() {
    var host = visibleMount();
    if (!host) return;
    host.id = 'dodo-inline-checkout';
    try {
      var email = localStorage.getItem('assessmentUserEmail') || '';
      var phone = localStorage.getItem('assessmentUserPhone') || '';
      var name = '';
      try { var ua = JSON.parse(localStorage.getItem('userAuth') || 'null'); name = (ua && ua.name) || localStorage.getItem('assessmentUserName') || ''; } catch (e) {}

      var resp = await fetch(DODO_FN_BASE + '/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: RETAKE_PRODUCT, email: email, name: name, phone: phone, discount_code: '' })
      });
      if (!resp.ok) throw new Error('session http ' + resp.status);
      var data = await resp.json();
      if (!data.checkout_url) throw new Error('no checkout_url');

      await loadSdk();
      ensureInit();
      var sdk = getSdk();
      if (!sdk) throw new Error('sdk missing');
      try { sdk.Checkout.close(); } catch (e) {}
      host.innerHTML = '';
      sdk.Checkout.open({ checkoutUrl: data.checkout_url, elementId: 'dodo-inline-checkout' });
      setTimeout(hideStatus, 3000);
      track('lisp_retake_checkout_open', { days_since_last: days });
    } catch (e) {
      try { console.error('[dodo] mount failed', e); } catch (_) {}
    }
  }

  // ── Buttons: the box stays small (price + Apple Pay + card) until a pay button
  // is pressed; only then does the inline Dodo checkout mount. Both methods open
  // the same Dodo checkout, which presents Apple Pay (express) + card. ──
  var mounted = false;
  function openCheckout(method) {
    track('lisp_retake_pay_click', { method: method || 'card' });
    setState('checkout');
    if (!mounted) { mounted = true; requestAnimationFrame(mountCheckout); }
  }
  document.querySelectorAll('[data-pay]').forEach(function (btn) {
    btn.addEventListener('click', function () { openCheckout(btn.getAttribute('data-pay')); });
  });
  document.querySelectorAll('[data-back]').forEach(function (btn) {
    btn.addEventListener('click', function () { setState('idle'); });
  });

  // QA: a single "skip" control on the paywall jumps the gate so the whole retake
  // flow (gate → assessment) can be tested without paying. The test=1 param tells
  // the analysis server to allow the run. Set SHOW_SKIP = false before launch.
  var SHOW_SKIP = true;
  document.querySelectorAll('[data-skip]').forEach(function (el) {
    if (!SHOW_SKIP) { el.style.display = 'none'; return; }
    el.addEventListener('click', function () {
      track('lisp_retake_test_skip', {});
      window.location.href = ASSESSMENT_URL + '&test=1';
    });
  });
})();
