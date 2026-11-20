// Entry router for the assessment CTA. Returning users who've already used their
// free assessment belong on the $19 retake paywall — send them there directly
// instead of loading assessment.html (which would flash the old report before
// bouncing to retake.html). Cross-device users still get the server-side gate
// inside assessment.html (sign-in entitlement check + analysis 402).
function lispAssessmentDest() {
    var dest = '/lispspeechclinic/assessment.html';
    try {
        var p = new URLSearchParams(location.search);
        var unlocked = p.get('retake') === '1' || p.get('test') === '1'
            || localStorage.getItem('lispRetakePaid') === '1';
        var didBefore = localStorage.getItem('lispHasCompletedAssessment') === '1'
            || localStorage.getItem('assessmentCompleted') === '1';
        if (didBefore && !unlocked) dest = '/lispspeechclinic/retake.html';
    } catch (e) {}
    return dest;
}
// ---- App handoff (Claude Design "Lisp free test → app handoff", 2026-11-21) ----
// First-time takers on iPhone/iPad get an app-first sheet, desktop gets an app-first
// modal with a QR code; the browser test stays one tap away. Android and other
// devices are unchanged. Returning/retake users keep the routing above.
var LISP_APP_URL = 'https://apps.apple.com/app/id6751569088?ppid=25953659-1662-49e0-9bf3-036161ce27df';
var LISP_TEST_URL = '/lispspeechclinic/assessment.html';
function lispPlatform() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Mobi|Tablet|Silk|Kindle|Opera Mini/i.test(ua)) return 'other';
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 900) return 'desktop';
    return 'other';
}
function lispHandoffEligible() {
    var plat = lispPlatform();
    if (plat !== 'ios' && plat !== 'desktop') return false;
    try {
        var p = new URLSearchParams(location.search);
        if (p.get('retake') === '1' || p.get('test') === '1' || p.get('web') === '1') return false;
        if (localStorage.getItem('lispRetakePaid') === '1') return false;
        if (localStorage.getItem('lispHasCompletedAssessment') === '1' || localStorage.getItem('assessmentCompleted') === '1') return false;
        if (sessionStorage.getItem('lispHandoffWeb') === '1') return false;
    } catch (e) {}
    return true;
}
function lispHandoffTrack(name, props, beacon) {
    try { if (window.posthog && posthog.capture) posthog.capture(name, props, beacon ? { transport: 'sendBeacon' } : undefined); } catch (e) {}
}
var LISP_HO_CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FF8B42" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
var LISP_HO_X = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
function lispHandoffCss() {
    if (document.getElementById('lho-css')) return;
    var s = document.createElement('style');
    s.id = 'lho-css';
    s.textContent = [
        '.lho-root{position:fixed;inset:0;z-index:2147483647;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}',
        '.lho-overlay{position:absolute;inset:0;background:rgba(0,0,0,.6);opacity:0;transition:opacity .3s ease}',
        '.lho-open .lho-overlay{opacity:1}',
        '.lho-panel{position:absolute;box-sizing:border-box;background:#141414;color:#fff;border:1px solid rgba(255,255,255,.10);text-align:left}',
        '.lho-panel:focus{outline:none}',
        '.lho-panel h2{margin:0;font-weight:700;color:#fff;letter-spacing:-.01em}',
        '.lho-eyebrow{display:block;font-size:11px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:#FF9800}',
        '.lho-sub{margin:0;color:#ccc;line-height:1.5}',
        '.lho-proof{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px;color:#ccc;line-height:1.4}',
        '.lho-proof li{display:flex;gap:10px;align-items:center;margin:0}',
        '.lho-proof svg{flex:none}',
        '.lho-x{position:absolute;top:8px;right:8px;width:44px;height:44px;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}',
        '.lho-cta{display:block;height:52px;line-height:52px;border-radius:12px;background:#FF8B42;color:#0F172A!important;text-align:center;font-size:16px;font-weight:700;text-decoration:none!important;transition:background .2s ease}',
        '.lho-cta:hover{background:#FF9A5C}',
        '.lho-cap{display:block;font-size:12px;color:#999;text-align:center}',
        '.lho-web{display:inline-block;min-height:44px;line-height:44px;font-size:14px;font-weight:500;color:#ccc!important;text-decoration:underline;text-underline-offset:3px;text-decoration-color:rgba(255,255,255,.35);cursor:pointer}',
        '.lho-web:hover{color:#fff!important}',
        '.lho-fine{margin:0;padding-top:12px;border-top:1px solid rgba(255,255,255,.10);font-size:12px;line-height:1.5;color:#999}',
        // iPhone bottom sheet
        '.lho-sheet{left:0;right:0;bottom:0;max-height:92vh;overflow-y:auto;border-radius:16px 16px 0 0;border-width:1px 0 0;padding:10px 20px calc(24px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:16px;transform:translateY(100%);transition:transform .3s cubic-bezier(.4,0,.2,1)}',
        '.lho-open .lho-sheet{transform:none}',
        '.lho-grab{align-self:center;width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,.2)}',
        '.lho-sheet .lho-head{display:flex;flex-direction:column;gap:8px;padding-right:32px}',
        '.lho-sheet h2{font-size:24px;line-height:1.2}',
        '.lho-sheet .lho-sub{font-size:15px}',
        '.lho-sheet .lho-proof{font-size:14px}',
        '.lho-sheet .lho-actions{display:flex;flex-direction:column;gap:8px}',
        '.lho-sheet .lho-web{align-self:center;padding:0 12px}',
        // Desktop modal
        '.lho-modal{left:50%;top:50%;width:min(880px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow-y:auto;transform:translate(-50%,-48%);opacity:0;transition:opacity .3s ease,transform .3s cubic-bezier(.4,0,.2,1);border-radius:16px;padding:40px 44px 28px;display:flex;flex-direction:column;gap:28px}',
        '.lho-open .lho-modal{opacity:1;transform:translate(-50%,-50%)}',
        '.lho-cols{display:flex;gap:48px;align-items:stretch}',
        '.lho-left{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:14px}',
        '.lho-modal h2{font-size:32px;line-height:1.2}',
        '.lho-modal .lho-sub{font-size:16px;line-height:1.55}',
        '.lho-modal .lho-proof{margin-top:6px;gap:12px;font-size:15px}',
        '.lho-modal .lho-web{margin-top:auto;align-self:flex-start}',
        '.lho-qrpanel{flex:none;width:280px;box-sizing:border-box;border:1px solid rgba(255,255,255,.08);background:#1C1C1C;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);border-radius:16px;padding:24px;display:flex;flex-direction:column;align-items:center;gap:16px}',
        '.lho-qr{width:216px;height:216px;box-sizing:border-box;background:#fff;border-radius:12px;padding:16px;box-shadow:0 8px 24px rgba(0,0,0,.45)}',
        '.lho-qr img{display:block;width:184px;height:184px}',
        '.lho-qrcap{font-size:14px;font-weight:600;color:#fff;text-align:center}',
        '.lho-badge img{display:block;width:120px;height:40px}',
        '@media (max-width:760px){.lho-cols{flex-direction:column}.lho-qrpanel{width:100%}}',
        '@media (prefers-reduced-motion:reduce){.lho-overlay,.lho-sheet,.lho-modal{transition:none}}'
    ].join('');
    document.head.appendChild(s);
}
function lispHandoffMarkup(plat) {
    var proof = function (items) { return '<ul class="lho-proof">' + items.map(function (t) { return '<li>' + LISP_HO_CHECK + '<span>' + t + '</span></li>'; }).join('') + '</ul>'; };
    if (plat === 'ios') {
        return '<section class="lho-panel lho-sheet" id="lisp-app-sheet" role="dialog" aria-modal="true" aria-labelledby="lhoTitle">'
            + '<div class="lho-grab"></div>'
            + '<button type="button" class="lho-x" data-lho-close="x" aria-label="Close">' + LISP_HO_X + '</button>'
            + '<div class="lho-head"><span class="lho-eyebrow">Free lisp test</span>'
            + '<h2 id="lhoTitle">Take the free test in the app</h2>'
            + '<p class="lho-sub">The same kind of word recording, and the full report is free. Your result is saved, so it’s your starting point if you decide to practice.</p></div>'
            + proof(['Sign in with one tap, then record', 'Audio only works. Face video is optional.', 'A report on each word you record'])
            + '<div class="lho-actions"><a class="lho-cta" data-lho-choice="app" href="' + LISP_APP_URL + '">Take the Test in the App</a>'
            + '<span class="lho-cap">Opens the App Store. The test and report are free.</span></div>'
            + '<a class="lho-web" data-lho-choice="browser" href="' + LISP_TEST_URL + '">Continue in browser instead</a>'
            + '<p class="lho-fine">After your report, the app offers a 3-day free trial of the practice program.</p>'
            + '</section>';
    }
    return '<section class="lho-panel lho-modal" id="lisp-app-modal" role="dialog" aria-modal="true" aria-labelledby="lhoTitle">'
        + '<button type="button" class="lho-x" data-lho-close="x" aria-label="Close">' + LISP_HO_X + '</button>'
        + '<div class="lho-cols"><div class="lho-left">'
        + '<span class="lho-eyebrow">Free lisp test · iPhone</span>'
        + '<h2 id="lhoTitle">Scan to take the free test on your iPhone</h2>'
        + '<p class="lho-sub">The test runs in the TopSpeech app. Sign in with one tap, record a set of words, and read your full report free.</p>'
        + proof(['Audio only works. Face video is optional.', 'A report on each word you record', 'Saved to your account as your baseline'])
        + '<a class="lho-web" data-lho-choice="browser" href="' + LISP_TEST_URL + '">No iPhone? Take the test in this browser</a>'
        + '</div><div class="lho-qrpanel">'
        + '<div class="lho-qr"><img src="/lispspeechclinic/images/lisp-app-qr.svg?v=20261121" alt="QR code that opens the TopSpeech app on the App Store" width="184" height="184"></div>'
        + '<span class="lho-qrcap">Point your iPhone camera here</span>'
        + '<a class="lho-badge" data-lho-choice="app_badge" href="' + LISP_APP_URL + '" target="_blank" rel="noopener"><img src="/lispspeechclinic/Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg" alt="Download on the App Store" width="120" height="40"></a>'
        + '</div></div>'
        + '<p class="lho-fine">TopSpeech is available on iPhone. After your report, the app offers a 3-day free trial of the practice program.</p>'
        + '</section>';
}
// Opens the chooser. onBrowser runs when the taker picks the browser test.
// entry: where it was opened from (nav_button | link | test_start).
function lispOpenHandoff(entry, onBrowser) {
    if (document.getElementById('lisp-handoff')) return;
    var plat = lispPlatform();
    var surface = plat === 'ios' ? 'sheet' : 'modal';
    var base = { platform: plat, surface: surface, entry: entry, page: location.pathname };
    lispHandoffCss();
    var root = document.createElement('div');
    root.className = 'lho-root';
    root.id = 'lisp-handoff';
    root.innerHTML = '<div class="lho-overlay" data-lho-close="overlay"></div>' + lispHandoffMarkup(plat);
    var lastFocus = document.activeElement;
    var prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(root);
    requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('lho-open'); }); });
    var panel = root.querySelector('.lho-panel');
    panel.setAttribute('tabindex', '-1');
    try { panel.focus({ preventScroll: true }); } catch (e) {}
    lispHandoffTrack('assessment_chooser_view', base);
    function close(method) {
        document.removeEventListener('keydown', onKey, true);
        document.documentElement.style.overflow = prevOverflow;
        root.classList.remove('lho-open');
        setTimeout(function () { if (root.parentNode) root.parentNode.removeChild(root); }, 300);
        try { if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); } catch (e) {}
        if (method) lispHandoffTrack('assessment_chooser_dismiss', Object.assign({ method: method }, base));
    }
    function onKey(e) {
        if (e.key === 'Escape') { close('esc'); return; }
        if (e.key !== 'Tab') return;
        var f = root.querySelectorAll('a[href],button');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('click', function (e) {
        var c = e.target.closest('[data-lho-close]');
        if (c) { e.preventDefault(); close(c.getAttribute('data-lho-close')); return; }
        var ch = e.target.closest('[data-lho-choice]');
        if (!ch) return;
        var choice = ch.getAttribute('data-lho-choice');
        lispHandoffTrack('assessment_chooser_select', Object.assign({ choice: choice }, base), true);
        try { posthog.register({ lisp_handoff_choice: choice }); } catch (err) {}
        if (choice === 'browser') {
            e.preventDefault();
            try { sessionStorage.setItem('lispHandoffWeb', '1'); } catch (err) {}
            close();
            onBrowser();
        }
        // app / app_badge: the link opens the App Store (posthog-tracking.js also logs app_store_click).
    });
}
window.lispOpenHandoff = lispOpenHandoff;
// assessment.html calls this on the first record tap (direct landings from search
// and social skip the nav button). Returns true when the chooser took the tap.
window.lispHandoffOnStart = function (resume) {
    if (!lispHandoffEligible()) return false;
    lispOpenHandoff('test_start', resume);
    return true;
};

// Nav "Scan to download" (same button as Rollr): desktop opens the app-first modal
// with the QR code; iPhone/iPad follow the link to the Lisp App Store page; the
// button is hidden on Android (no Lisp app). Delegated: nav markup may be injected later.
(function () {
    if (lispPlatform() === 'android') document.documentElement.classList.add('is-android');
})();
document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('a.desktop-download-btn, a.app-store-cta') : null;
    if (!btn) return;
    var where = btn.classList.contains('app-store-cta') ? 'features_section' : 'nav';
    lispHandoffTrack('nav_download_click', { platform: lispPlatform(), page: location.pathname, source: where });
    if (lispPlatform() === 'ios') return;
    e.preventDefault();
    // Android: no Lisp app, so "Get it Now" runs the web test.
    if (lispPlatform() === 'android') { window.location.href = lispAssessmentDest(); return; }
    lispOpenHandoff(where === 'nav' ? 'nav_download' : 'get_it_now', function () { window.location.href = lispAssessmentDest(); });
});

// Used by the nav "Free Assessment" <button>s (no href to fall back on).
window.lispStartAssessment = function () {
    var dest = lispAssessmentDest();
    if (dest === LISP_TEST_URL && lispHandoffEligible()) {
        lispOpenHandoff('nav_button', function () { window.location.href = dest; });
        return;
    }
    window.location.href = dest;
};

// The guide/blog pages link to the assessment with plain <a href> anchors (kept
// for SEO). Intercept those clicks the same way so returning users are routed to
// the paywall without the report flash. Delegated on document, so it also covers
// nav/footer markup injected later.
document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !/\/lispspeechclinic\/assessment\.html$/.test(a.pathname || '')) return;
    if (a.hasAttribute('data-lho-choice')) return; // the chooser's own browser link
    if (a.search) return; // a link carrying its own ?retake=1/?test=1 owns its routing
    if (lispAssessmentDest() === '/lispspeechclinic/retake.html') {
        e.preventDefault();
        window.location.href = '/lispspeechclinic/retake.html';
        return;
    }
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (lispHandoffEligible()) {
        e.preventDefault();
        var href = a.href;
        lispOpenHandoff('link', function () { window.location.href = href; });
    }
});

// Load navigation HTML (or initialize if already in DOM for SEO)
document.addEventListener('DOMContentLoaded', function() {
    // Use absolute paths for all assets
    const basePath = '/lispspeechclinic';

    // Load login-modal.js script first
    const loginModalScript = document.createElement('script');
    loginModalScript.src = basePath + '/js/login-modal.js?v=20260825';
    loginModalScript.onload = function() {
        // Check if navigation already exists in DOM (static HTML for SEO)
        const existingNav = document.getElementById('mainNavbar');
        if (existingNav) {
            // Navigation already in DOM, just initialize behaviors
            initializeNavigation();
        } else {
            // Fallback: Load navigation dynamically if not in DOM
            fetch(basePath + '/includes/nav.html?v=20261121b')
                .then(response => response.text())
                .then(html => {
                    document.body.insertAdjacentHTML('afterbegin', html);
                    // The include ends with the promo bar's <link>/<script> tags; tags inserted via
                    // insertAdjacentHTML never load/execute, so wire them up explicitly here.
                    html.replace(/<link[^>]+href="([^"]*promo-bar\.css[^"]*)"/, function (_, href) {
                        var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); return _;
                    });
                    html.replace(/<script[^>]+src="([^"]*promo-bar\.js[^"]*)"/, function (_, src) {
                        var sc = document.createElement('script'); sc.src = src; document.body.appendChild(sc); return _;
                    });

                    const navAppStoreBadge1 = document.getElementById('navAppStoreBadge1');
                    const navAppStoreBadge2 = document.getElementById('navAppStoreBadge2');
                    const navLogoMobile = document.getElementById('navLogoMobile');
                    const navLogoLink = document.getElementById('navLogoLink');

                    if (navAppStoreBadge1) {
                        navAppStoreBadge1.src = basePath + '/Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg';
                    }
                    if (navAppStoreBadge2) {
                        navAppStoreBadge2.src = basePath + '/Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg';
                    }
                    if (navLogoMobile) {
                        navLogoMobile.src = '/lispspeechclinic/instagram-icon.jpg';
                    }
                    if (navLogoLink) {
                        navLogoLink.href = basePath;
                    }

                    document.querySelectorAll('.nav-link[data-page]').forEach(link => {
                        const page = link.getAttribute('data-page');
                        link.href = basePath + '/' + page;
                    });

                    initializeNavigation();
                })
                .catch(error => console.error('Error loading navigation:', error));
        }
    };
    document.head.appendChild(loginModalScript);

    // Load Google GSI Client library first
    const googleGSIScript = document.createElement('script');
    googleGSIScript.src = 'https://accounts.google.com/gsi/client';
    googleGSIScript.async = true;
    googleGSIScript.defer = true;
    document.head.appendChild(googleGSIScript);

    // Load Google Sign-In initialization script
    const googleSignInScript = document.createElement('script');
    googleSignInScript.src = basePath + '/js/google-signin-init.js?v=20260825';
    googleSignInScript.onload = function() {
        // After google-signin-init.js is loaded, load the modal HTML
        fetch(basePath + '/includes/login-modal.html?v=20260825')
            .then(response => response.text())
            .then(html => {
                // Insert login modal at the end of body
                document.body.insertAdjacentHTML('beforeend', html);

                // Initialize Google Sign-In after modal is loaded
                initializeGoogleSignIn();
            })
            .catch(error => console.error('Error loading login modal:', error));
    };
    document.head.appendChild(googleSignInScript);
});

// Navigation functionality
function initializeNavigation() {
    // Check if floating top bar exists and add class to navbar
    const floatingTopBar = document.getElementById('floatingTopBar');
    const navbar = document.getElementById('mainNavbar');

    if (floatingTopBar && navbar) {
        // Check if top bar is visible (not closed)
        const topBarClosed = localStorage.getItem('topBarClosed');
        if (!topBarClosed || topBarClosed === 'false') {
            navbar.classList.add('with-top-bar');
        }
    }

    // Toggle profile dropdown
    window.toggleProfileDropdown = function() {
        const dropdown = document.getElementById('profileDropdown');
        dropdown.classList.toggle('show');
    };

    // Close profile dropdown when clicking outside
    document.addEventListener('click', function(event) {
        const profileDropdown = document.querySelector('.profile-dropdown');
        const dropdown = document.getElementById('profileDropdown');

        if (profileDropdown && dropdown && !profileDropdown.contains(event.target)) {
            dropdown.classList.remove('show');
        }
    });

    // Toggle mobile menu
    window.toggleMobileMenu = function() {
        const navMenu = document.querySelector('.nav-menu');
        const navToggle = document.querySelector('.nav-toggle');

        navMenu.classList.toggle('active');
        navToggle.classList.toggle('active');
    };

    // Mobile company menu toggle function
    window.toggleMobileCompanyMenu = function() {
        const dropdown = document.getElementById('mobileCompanyDropdown');
        const toggle = document.querySelector('.mobile-hamburger-toggle');

        dropdown.classList.toggle('show');
        toggle.classList.toggle('active');
    };

    // Close mobile company dropdown when clicking outside
    document.addEventListener('click', function(event) {
        const hamburgerMenu = document.querySelector('.mobile-hamburger-menu');
        const dropdown = document.getElementById('mobileCompanyDropdown');
        const toggle = document.querySelector('.mobile-hamburger-toggle');

        if (hamburgerMenu && dropdown && toggle && !hamburgerMenu.contains(event.target)) {
            dropdown.classList.remove('show');
            toggle.classList.remove('active');
        }
    });

    // Transparent navbar scroll effect
    let lastScrollTop = 0;
    window.addEventListener('scroll', function() {
        const navbar = document.querySelector('.navbar');
        const currentScroll = window.scrollY;

        // Add scrolled state when past hero section
        if (currentScroll > 100) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }

        lastScrollTop = currentScroll;
    });

    // Update profile display based on login state
    // Use a more robust approach to wait for elements
    updateProfileDisplay();
}

// Update profile display based on login state
function updateProfileDisplay() {
    const userEmail = localStorage.getItem('userEmail');
    const userAuth = localStorage.getItem('userAuth');
    const isLoggedIn = !!(userEmail || userAuth);

    let attempts = 0;
    const maxAttempts = 50;

    const update = () => {
        const loginButton = document.querySelector('.login-nav');
        const profileDropdown = document.querySelector('.profile-dropdown');
        const profileInitial = document.getElementById('profileInitial');
        const userLoginNodes = document.querySelectorAll('.user-login-nav');

        if ((!loginButton || !profileDropdown) && attempts < maxAttempts) {
            attempts++;
            setTimeout(update, 100);
            return;
        }

        if (loginButton && profileDropdown) {
            if (isLoggedIn) {
                loginButton.style.setProperty('display', 'none', 'important');
                profileDropdown.style.setProperty('display', 'flex', 'important');
                userLoginNodes.forEach(n => n.style.setProperty('display', 'none', 'important'));

                if (profileInitial) {
                    const email = userEmail || (userAuth ? JSON.parse(userAuth).email : '');
                    profileInitial.textContent = email ? email.charAt(0).toUpperCase() : 'U';
                }
            } else {
                loginButton.style.setProperty('display', 'flex', 'important');
                profileDropdown.style.setProperty('display', 'none', 'important');
                userLoginNodes.forEach(n => n.style.removeProperty('display'));
            }
        }
    };

    update();
}

// Logout functionality
window.logout = function() {
    // Clear all user data from localStorage
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userName');
    localStorage.removeItem('userToken');
    localStorage.removeItem('userAuth');

    // Track logout event
    if (typeof gtag !== 'undefined') {
        gtag('event', 'logout', {
            event_category: 'user_action'
        });
    }

    // Redirect to home page (the page will automatically update the display on load)
    window.location.href = '/lispspeechclinic';
};

// Auto-collapse Sources/References/Citations sections into accordions
(function() {
    function initSourceAccordions() {
        var pattern = /\b(sources|references|citations)\b/i;
        document.querySelectorAll('.content-section').forEach(function(section) {
            var title = section.querySelector(':scope > .section-title');
            var content = section.querySelector(':scope > .section-content');
            if (!title || !content) return;
            if (!pattern.test(title.textContent)) return;
            section.classList.add('is-accordion');
            title.setAttribute('role', 'button');
            title.setAttribute('tabindex', '0');
            title.setAttribute('aria-expanded', 'false');
            var toggle = function() {
                var open = section.classList.toggle('is-open');
                title.setAttribute('aria-expanded', open ? 'true' : 'false');
            };
            title.addEventListener('click', toggle);
            title.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                }
            });
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSourceAccordions);
    } else {
        initSourceAccordions();
    }
})();
