/**
 * PostHog Event Tracking for Rhotacism Website
 * Captures detailed event properties for all user interactions
 */

(function() {
    'use strict';

    // Wait for PostHog to be ready
    function initPostHogTracking() {
        if (typeof posthog === 'undefined') {
            console.warn('PostHog not initialized');
            return;
        }

        // Track page view with detailed info
        posthog.capture('$pageview', {
            page_title: document.title,
            page_url: window.location.href,
            page_path: window.location.pathname,
            referrer: document.referrer,
            viewport_width: window.innerWidth,
            viewport_height: window.innerHeight
        });

        // Track all button clicks
        document.addEventListener('click', function(e) {
            const target = e.target.closest('button, a, .btn, [role="button"]');
            if (target) {
                posthog.capture('button_click', {
                    button_text: target.innerText.trim(),
                    button_class: target.className,
                    button_id: target.id,
                    button_href: target.href || null,
                    section: target.closest('section')?.id || target.closest('section')?.className || 'unknown',
                    page_url: window.location.href
                });
            }
        });

        // Track all form input interactions
        const formInputs = document.querySelectorAll('input, textarea, select');
        formInputs.forEach(input => {
            // Track when user focuses on input
            input.addEventListener('focus', function() {
                posthog.capture('form_input_focus', {
                    input_type: this.type,
                    input_name: this.name,
                    input_id: this.id,
                    input_placeholder: this.placeholder,
                    form_id: this.closest('form')?.id || null,
                    page_url: window.location.href
                });
            });

            // Track when user changes input value
            input.addEventListener('change', function() {
                posthog.capture('form_input_change', {
                    input_type: this.type,
                    input_name: this.name,
                    input_id: this.id,
                    has_value: this.value.length > 0,
                    form_id: this.closest('form')?.id || null,
                    page_url: window.location.href
                });
            });
        });

        // Track form submissions
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
            form.addEventListener('submit', function(e) {
                posthog.capture('form_submit', {
                    form_id: this.id,
                    form_action: this.action,
                    form_method: this.method,
                    page_url: window.location.href
                });
            });
        });

        // Track video plays
        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            video.addEventListener('play', function() {
                posthog.capture('video_play', {
                    video_src: this.src,
                    video_duration: this.duration,
                    video_currentTime: this.currentTime,
                    page_url: window.location.href
                });
            });

            video.addEventListener('pause', function() {
                posthog.capture('video_pause', {
                    video_src: this.src,
                    video_currentTime: this.currentTime,
                    video_progress_percent: (this.currentTime / this.duration * 100).toFixed(2),
                    page_url: window.location.href
                });
            });

            video.addEventListener('ended', function() {
                posthog.capture('video_complete', {
                    video_src: this.src,
                    video_duration: this.duration,
                    page_url: window.location.href
                });
            });
        });

        // Track scroll depth
        let maxScrollDepth = 0;
        let scrollCheckpoints = [25, 50, 75, 90, 100];
        let reachedCheckpoints = [];

        window.addEventListener('scroll', function() {
            const scrollPercent = Math.round((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100);

            if (scrollPercent > maxScrollDepth) {
                maxScrollDepth = scrollPercent;
            }

            scrollCheckpoints.forEach(checkpoint => {
                if (scrollPercent >= checkpoint && !reachedCheckpoints.includes(checkpoint)) {
                    reachedCheckpoints.push(checkpoint);
                    posthog.capture('scroll_depth', {
                        depth_percent: checkpoint,
                        page_url: window.location.href,
                        page_title: document.title
                    });
                }
            });
        });

        // Track time on page
        let pageLoadTime = Date.now();
        let timeCheckpoints = [10, 30, 60, 120, 300]; // seconds
        let reachedTimeCheckpoints = [];

        setInterval(function() {
            const timeOnPage = Math.round((Date.now() - pageLoadTime) / 1000);

            timeCheckpoints.forEach(checkpoint => {
                if (timeOnPage >= checkpoint && !reachedTimeCheckpoints.includes(checkpoint)) {
                    reachedTimeCheckpoints.push(checkpoint);
                    posthog.capture('time_on_page', {
                        time_seconds: checkpoint,
                        page_url: window.location.href,
                        page_title: document.title,
                        max_scroll_depth: maxScrollDepth
                    });
                }
            });
        }, 1000);

        // Track page exit with session summary
        window.addEventListener('beforeunload', function() {
            const totalTimeOnPage = Math.round((Date.now() - pageLoadTime) / 1000);
            posthog.capture('page_exit', {
                total_time_seconds: totalTimeOnPage,
                max_scroll_depth: maxScrollDepth,
                page_url: window.location.href,
                page_title: document.title
            });
        });

        // Track navigation clicks
        const navLinks = document.querySelectorAll('nav a, .nav a, [class*="nav"] a');
        navLinks.forEach(link => {
            link.addEventListener('click', function() {
                posthog.capture('navigation_click', {
                    link_text: this.innerText.trim(),
                    link_href: this.href,
                    link_location: 'navigation',
                    page_url: window.location.href
                });
            });
        });

        // Track CTA clicks specifically
        const ctaButtons = document.querySelectorAll('.btn-primary, .cta-button, [class*="cta"]');
        ctaButtons.forEach(button => {
            button.addEventListener('click', function() {
                posthog.capture('cta_click', {
                    cta_text: this.innerText.trim(),
                    cta_class: this.className,
                    cta_href: this.href || null,
                    section: this.closest('section')?.id || this.closest('section')?.className || 'unknown',
                    page_url: window.location.href
                });
            });
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPostHogTracking);
    } else {
        initPostHogTracking();
    }
})();
