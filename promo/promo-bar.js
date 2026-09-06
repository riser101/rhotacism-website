/* Top Speech promo bar — single source of truth for the site-wide sale banner.
   Loaded synchronously from each <product>/includes/nav.html (right after the
   navbar) so the bar exists before first paint.

   - Renders a fixed banner above the navbar with a live countdown + the code.
   - Shifts the navbar down and inserts an in-flow spacer so page content isn't
     covered (see promo-bar.css, --ts-promo-h).
   - Exposes window.TSPromo = { active, code, percent, ends, id } for checkout
     code (lisp pricing/inline checkout pre-apply the Dodo discount code).
   - Auto-retires when PROMO.ends passes. To end early: active:false, bump ?v=.

   Store-side setup this banner relies on (see README-BUILD.md → "Promo bar"):
     • Dodo (lisp web app): percentage discount code = PROMO.code
     • App Store (Rollr iOS): custom offer code = PROMO.code (Subscriptions →
       Offer Codes) — redeemed via the apps.apple.com/redeem deep link below.
     • Google Play (Rollr Android): Play has no %-off promo codes for
       subscriptions, so the discount is a Play *offer* (laborday20 on base
       plan p3m: 3-day trial + 20% off the first 3 months) that RevenueCat
       applies automatically for new subscribers — no code needed in-app. The
       old trial-only offer carries the `rc-ignore-offer` tag for the sale's
       duration so the SDK picks laborday20. rollrAndroid:false hides the bar
       for Android visitors on Rollr pages (use when no Play offer is live). */
(function () {
    var PROMO = {
        id: 'laborday2026',
        active: true,
        code: 'LABORDAY20',
        percent: 20,
        ends: '2026-09-10T03:59:59Z',   // Tue Sep 9 2026, 11:59 pm ET
        title: 'Labor Day Sale',
        appleAppId: '6751569088',
        rollrAndroid: true
    };

    var endMs = Date.parse(PROMO.ends);
    var live = !!PROMO.active && Date.now() < endMs;
    window.TSPromo = { active: live, code: live ? PROMO.code : '', percent: PROMO.percent, ends: PROMO.ends, id: PROMO.id, title: PROMO.title };
    if (!live) return;

    var path = location.pathname || '/';
    var product = path.indexOf('/lispspeechclinic') === 0 ? 'lisp'
        : path.indexOf('/stutterfluencycentre') === 0 ? 'stutter' : 'rollr';
    // Flows where a fixed bar fights the layout: assessment steps, retake
    // checkout, redirect/utility pages. (TSPromo is still set on these pages so
    // the inline checkout can pre-apply the code.)
    if (/\/(inline-)?assessment\.html|\/retake\.html|\/get-app\.html|\/app-verify|\/delete-account|\/go\//.test(path)) return;

    var ua = navigator.userAgent || '';
    var isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isAndroid = /Android/i.test(ua);
    if (product === 'rollr' && isAndroid && !PROMO.rollrAndroid) return;
    try { if (localStorage.getItem('tsPromoClosed') === PROMO.id) return; } catch (e) {}

    var appleRedeem = 'https://apps.apple.com/redeem?ctx=offercodes&id=' + PROMO.appleAppId + '&code=' + PROMO.code;
    var pct = PROMO.percent + '% Off';
    // Copy mirrors the reference bar: bold lead | plain pills | Use Code chip | countdown.
    // No CTA button — the page's own buttons do the selling.
    var copy;
    if (product === 'lisp') {
        copy = { lead: PROMO.title + ': ' + pct, tail: ' All Programs!', pills: ['7-day Money-Back Guarantee', 'Try Risk-Free Trial'], drop: 0 }; // drop = pill hidden first on narrow laptops
    } else if (product === 'rollr') {
        if (isAndroid) {
            // Play offer applies itself at checkout — nothing to enter.
            copy = { lead: PROMO.title + ': ' + pct, tail: ' The Rollr Academy!', pills: ['Try Risk-Free Trial', '20% off applied automatically in the app'], noCode: true };
        } else {
            // iPhone: tapping the code opens the App Store redemption sheet.
            copy = { lead: PROMO.title + ': ' + pct, tail: ' The Rollr Academy!', pills: ['Try Risk-Free Trial'], codeHref: isIOS ? appleRedeem : '' };
        }
    } else {
        copy = { lead: PROMO.title + ': ' + pct, tail: ' Top Speech Programs!', pills: ['Try Risk-Free Trial'] };
    }

    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function unit(k, label) { return '<span class="ts-promo__unit"><b data-u="' + k + '">00</b><i>' + label + '</i></span>'; }

    var bar = document.createElement('div');
    bar.className = 'ts-promo' + (copy.noCode ? ' ts-promo--nocode' : '');
    bar.id = 'tsPromoBar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', PROMO.title);
    bar.innerHTML =
        '<div class="ts-promo__in">' +
          '<div class="ts-promo__msg">' +
            '<strong class="ts-promo__lead">' + esc(copy.lead) + '<span class="ts-promo__lead-tail">' + esc(copy.tail) + '</span></strong>' +
            copy.pills.map(function (p, i) { return '<span class="ts-promo__item ts-promo__item--' + (i + 1) + (copy.drop === i ? ' ts-promo__item--drop' : '') + '"><span class="ts-promo__sep">|</span><span class="ts-promo__pill">' + esc(p) + '</span></span>'; }).join('') +
            (copy.noCode ? '' : '<span class="ts-promo__item ts-promo__item--code"><span class="ts-promo__sep">|</span><span class="ts-promo__codelabel">Use Code: </span>' +
                (copy.codeHref
                    ? '<a class="ts-promo__code" id="tsPromoCode" href="' + esc(copy.codeHref) + '" rel="noopener" title="Redeem in the App Store">' + esc(PROMO.code) + '</a>'
                    : '<code class="ts-promo__code" id="tsPromoCode" title="Click to copy">' + esc(PROMO.code) + '</code>') + '</span>') +
          '</div>' +
          '<div class="ts-promo__right">' +
            '<div class="ts-promo__timer"><span class="ts-promo__timer-label">Sale ends in:</span>' +
              '<span class="ts-promo__clock">' + unit('d', 'Days') + '<span class="ts-promo__colon">:</span>' + unit('h', 'Hrs') +
              '<span class="ts-promo__colon">:</span>' + unit('m', 'Min') + '<span class="ts-promo__colon">:</span>' + unit('s', 'Sec') + '</span>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="ts-promo__x" id="tsPromoClose" aria-label="Dismiss">&times;</button>' +
        '</div>';

    var spacer = document.createElement('div');
    spacer.className = 'ts-promo__spacer';
    spacer.setAttribute('aria-hidden', 'true');

    var navbar = document.getElementById('mainNavbar');
    var anchor = navbar || document.body.firstChild;
    document.body.insertBefore(bar, anchor);
    document.body.insertBefore(spacer, bar);
    document.body.classList.add('ts-promo-on');

    function setHeight() {
        var h = bar.offsetHeight;
        if (h) document.documentElement.style.setProperty('--ts-promo-h', h + 'px');
    }
    setHeight();
    if (window.ResizeObserver) { new ResizeObserver(setHeight).observe(bar); }
    else { window.addEventListener('resize', setHeight); }
    window.addEventListener('load', setHeight);

    function track(name, props) {
        try { if (window.posthog && posthog.capture) posthog.capture(name, Object.assign({ promo_id: PROMO.id, code: PROMO.code, product: product }, props || {}), { transport: 'sendBeacon' }); } catch (e) {}
        try { if (window.gtag) gtag('event', name, { event_category: 'promo', event_label: PROMO.id }); } catch (e) {}
    }

    var els = { d: bar.querySelector('[data-u="d"]'), h: bar.querySelector('[data-u="h"]'), m: bar.querySelector('[data-u="m"]'), s: bar.querySelector('[data-u="s"]') };
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function retire() {
        clearInterval(timer);
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        if (spacer.parentNode) spacer.parentNode.removeChild(spacer);
        document.body.classList.remove('ts-promo-on');
        window.TSPromo.active = false; window.TSPromo.code = '';
    }
    function tick() {
        var left = endMs - Date.now();
        if (left <= 0) { retire(); return; }
        var s = Math.floor(left / 1000);
        els.d.textContent = pad(Math.floor(s / 86400));
        els.h.textContent = pad(Math.floor(s % 86400 / 3600));
        els.m.textContent = pad(Math.floor(s % 3600 / 60));
        els.s.textContent = pad(s % 60);
    }
    tick();
    var timer = setInterval(tick, 1000);

    document.getElementById('tsPromoClose').addEventListener('click', function () {
        try { localStorage.setItem('tsPromoClosed', PROMO.id); } catch (e) {}
        track('promo_bar_dismiss');
        retire();
    });

    var codeEl = document.getElementById('tsPromoCode');
    if (codeEl && copy.codeHref) {
        codeEl.addEventListener('click', function () { track('promo_bar_redeem_click', { device: 'ios' }); });
    } else if (codeEl) {
        codeEl.addEventListener('click', function () {
            var done = function () {
                codeEl.classList.add('is-copied'); codeEl.textContent = 'Copied!';
                setTimeout(function () { codeEl.classList.remove('is-copied'); codeEl.textContent = PROMO.code; }, 1400);
            };
            try { navigator.clipboard.writeText(PROMO.code).then(done, done); } catch (e) { done(); }
            track('promo_bar_copy_code');
        });
    }

    // iPhone visitors on Rollr pages: the App Store offer code is only honoured
    // through the redemption URL (the plain product page charges full price), so
    // during the sale every "Get the app" App Store link on the page points at
    // the redemption sheet instead — it installs the app and applies the offer.
    // Runs after nav.js's own store routing (DOMContentLoaded + a tick, and load).
    if (product === 'rollr' && isIOS) {
        var rewrite = function () {
            document.querySelectorAll('a[href*="apps.apple.com"][href*="' + PROMO.appleAppId + '"]').forEach(function (a) {
                if (a.id === 'tsPromoCode' || a.getAttribute('href') === appleRedeem) return;
                a.setAttribute('href', appleRedeem);
                a.setAttribute('data-promo-redeem', PROMO.id);
            });
        };
        document.addEventListener('DOMContentLoaded', function () { setTimeout(rewrite, 0); });
        window.addEventListener('load', rewrite);
        rewrite();
    }

    track('promo_bar_view', { device: isIOS ? 'ios' : isAndroid ? 'android' : 'desktop' });
})();
