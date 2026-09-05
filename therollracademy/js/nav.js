// Load navigation HTML (or initialize if already in DOM for SEO)
document.addEventListener('DOMContentLoaded', function() {
    // Use absolute paths for all assets
    const basePath = '/therollracademy';

    // Load login-modal.js script first
    const loginModalScript = document.createElement('script');
    loginModalScript.src = basePath + '/js/login-modal.js?v=20260908';
    loginModalScript.onload = function() {
        // Check if navigation already exists in DOM (static HTML for SEO)
        const existingNav = document.getElementById('mainNavbar');
        if (existingNav) {
            // Navigation already in DOM, just initialize behaviors
            initializeNavigation();
        } else {
            // Fallback: Load navigation dynamically if not in DOM
            fetch(basePath + '/includes/nav.html?v=20260908')
                .then(response => response.text())
                .then(html => {
                    document.body.insertAdjacentHTML('afterbegin', html);

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
                        navLogoMobile.src = basePath + '/instagram-icon.jpg';
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
    googleSignInScript.src = basePath + '/js/google-signin-init.js?v=20260908';
    googleSignInScript.onload = function() {
        // After google-signin-init.js is loaded, load the modal HTML
        fetch(basePath + '/includes/login-modal.html?v=20260908')
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

// Detect iOS / iPadOS (iPadOS 13+ reports as "Macintosh" but is touch-capable)
function isIOSDevice() {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua);
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return iOS || iPadOS;
}

// Detect Android (legacy Windows Phone UAs spoof "Android"; exclude them)
function isAndroidDevice() {
    const ua = navigator.userAgent || '';
    return /Android/i.test(ua) && !/Windows Phone/i.test(ua);
}

// On Android, swap the nav "Download on the App Store" badge for Google's official
// "Get it on Google Play" badge and point it at the Play listing.
function applyAndroidStoreBadges() {
    if (!isAndroidDevice()) return;
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.rollr.academy';
    const playBadgeSrc = '/therollracademy/GetItOnGooglePlay_Badge_Web_color_English.svg';
    document.querySelectorAll('.desktop-download-btn, .mobile-download-btn').forEach(function(btn) {
        const label = btn.getAttribute('data-download-label') || 'nav';
        btn.href = playStoreUrl;
        btn.setAttribute('rel', 'noopener');
        // Replaces the inline App Store onclick; PostHog play_store_click is captured by posthog-tracking.js
        btn.onclick = function() {
            if (window.gtag) gtag('event', 'play_store_click', { event_category: 'conversion', event_label: label });
            if (label === 'mobile_nav' && window.posthog && typeof posthog.capture === 'function') posthog.capture('mobile_nav_download', { section: 'mobile_navigation', store: 'google_play' });
        };
        const img = btn.querySelector('img');
        if (img) {
            img.src = playBadgeSrc;
            img.alt = 'Get it on Google Play';
        }
    });
}

// App Store QR modal controls
window.openQrModal = function() {
    const overlay = document.getElementById('qrModalOverlay');
    if (!overlay) return;
    overlay.hidden = false;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
};
window.closeQrModal = function() {
    const overlay = document.getElementById('qrModalOverlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.hidden = true;
    document.body.style.overflow = '';
};

// Every other App Store CTA on a page (trial buttons, post-assessment badge, etc.):
//  - Android: point at Google Play and swap a badge image if present
//  - desktop: open the QR modal instead of a dead-end App Store web page
//  - iOS: unchanged
// Links marked data-store="apple" (footer + QR-modal badges) always stay direct.
function routeStoreCtas() {
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.rollr.academy';
    const playBadgeSrc = '/therollracademy/GetItOnGooglePlay_Badge_Web_color_English.svg';
    const selector = 'a[href*="apps.apple.com"]:not([data-store="apple"]):not(.desktop-download-btn):not(.mobile-download-btn)';
    const labelOf = function(link) {
        const m = /event_label:\s*'([^']*)'/.exec(link.getAttribute('onclick') || '');
        return m ? m[1] : 'page_cta';
    };
    if (isAndroidDevice()) {
        document.querySelectorAll(selector).forEach(function(link) {
            const label = labelOf(link);
            link.href = playStoreUrl;
            link.setAttribute('rel', 'noopener');
            link.onclick = function() {
                if (window.gtag) gtag('event', 'play_store_click', { event_category: 'conversion', event_label: label });
            };
            const img = link.querySelector('img[src*="App_Store"]');
            if (img) {
                img.src = playBadgeSrc;
                img.alt = 'Get it on Google Play';
            }
            const appleIcon = link.querySelector('svg[data-store-icon="apple"]');
            if (appleIcon) {
                const play = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                ['width', 'height', 'class', 'style', 'aria-hidden'].forEach(function(attr) {
                    if (appleIcon.hasAttribute(attr)) play.setAttribute(attr, appleIcon.getAttribute(attr));
                });
                // Official Google Play icon: the coloured triangle artwork from Google's badge SVG
                play.setAttribute('viewBox', '17.56 12.64 40.76 45.57');
                play.setAttribute('data-store-icon', 'google-play');
                play.innerHTML = '<path fill="#ea4335" d="M36.6,34.41l-18.86,20.02s0,0,0,.01c.58,2.17,2.56,3.77,4.92,3.77.94,0,1.83-.26,2.58-.7l.06-.04,21.23-12.25-9.94-10.82Z"></path><path fill="#fbbc04" d="M55.68,31h-.02s-9.17-5.33-9.17-5.33l-10.33,9.19,10.36,10.36,9.12-5.26c1.6-.86,2.68-2.55,2.68-4.49s-1.07-3.61-2.65-4.47h0Z"></path><path fill="#4285f4" d="M17.73,16.44c-.11.42-.17.86-.17,1.31v35.38c0,.45.06.89.17,1.31l19.51-19.51-19.51-18.49Z"></path><path fill="#34a853" d="M36.74,35.43l9.76-9.76-21.21-12.3c-.77-.46-1.67-.73-2.63-.73-2.36,0-4.34,1.6-4.92,3.78h0s19,19,19,19h0Z"></path>';
                appleIcon.replaceWith(play);
            }
        });
        return;
    }
    if (isIOSDevice()) return;
    document.addEventListener('click', function(e) {
        const link = e.target.closest(selector);
        if (!link || !document.getElementById('qrModalOverlay')) return;
        e.preventDefault();
        window.openQrModal();
    });
}

// Navigation functionality
function initializeNavigation() {
    // Store download: iOS opens the App Store, Android opens Google Play, desktop shows the QR modal
    applyAndroidStoreBadges();
    routeStoreCtas();
    document.querySelectorAll('.desktop-download-btn, .mobile-download-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            if (isIOSDevice() || isAndroidDevice()) return; // let the link open the store
            e.preventDefault();
            window.openQrModal();
        });
    });
    const qrOverlay = document.getElementById('qrModalOverlay');
    if (qrOverlay) {
        qrOverlay.addEventListener('click', function(e) {
            if (e.target === qrOverlay) window.closeQrModal();
        });
    }
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') window.closeQrModal();
    });

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

        if ((!loginButton || !profileDropdown) && attempts < maxAttempts) {
            attempts++;
            setTimeout(update, 100);
            return;
        }

        if (loginButton && profileDropdown) {
            if (isLoggedIn) {
                // User logged in - hide login, show profile
                loginButton.style.setProperty('display', 'none', 'important');
                profileDropdown.style.setProperty('display', 'flex', 'important');

                if (profileInitial) {
                    const email = userEmail || (userAuth ? JSON.parse(userAuth).email : '');
                    profileInitial.textContent = email ? email.charAt(0).toUpperCase() : 'U';
                }
            } else {
                // User logged out - show login, hide profile
                loginButton.style.setProperty('display', 'flex', 'important');
                profileDropdown.style.setProperty('display', 'none', 'important');
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
    window.location.href = '/therollracademy';
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
