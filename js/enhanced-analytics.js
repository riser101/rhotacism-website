/**
 * Enhanced Analytics Tracking for Rhotacism Website
 * Captures detailed event properties for all user interactions
 */

(function() {
    'use strict';

    // Initialize enhanced tracking
    const EnhancedAnalytics = {

        // Configuration
        config: {
            trackScrollDepth: true,
            trackTimeOnPage: true,
            trackClicks: true,
            trackFormInteractions: true,
            scrollDepthIntervals: [25, 50, 75, 90, 100],
            scrollDepthTracked: new Set()
        },

        // Initialize all tracking
        init: function() {
            this.trackPageView();
            if (this.config.trackClicks) this.setupClickTracking();
            if (this.config.trackScrollDepth) this.setupScrollTracking();
            if (this.config.trackTimeOnPage) this.setupTimeTracking();
            if (this.config.trackFormInteractions) this.setupFormTracking();
        },

        // Enhanced page view tracking
        trackPageView: function() {
            const pageData = this.getPageContext();

            if (typeof gtag === 'function') {
                gtag('event', 'page_view', {
                    page_title: pageData.pageTitle,
                    page_location: pageData.pageUrl,
                    page_path: pageData.pagePath,
                    page_referrer: pageData.referrer,
                    viewport_width: pageData.viewportWidth,
                    viewport_height: pageData.viewportHeight,
                    screen_width: pageData.screenWidth,
                    screen_height: pageData.screenHeight,
                    device_type: pageData.deviceType,
                    browser: pageData.browser,
                    timestamp: pageData.timestamp
                });
            }
        },

        // Setup enhanced click tracking
        setupClickTracking: function() {
            const self = this;

            document.addEventListener('click', function(e) {
                const element = e.target;
                const clickData = self.getElementDetails(element, e);

                // Track the click with detailed properties
                if (typeof gtag === 'function') {
                    gtag('event', 'click', {
                        event_category: 'engagement',
                        event_label: clickData.eventLabel,
                        // Element identification
                        element_id: clickData.elementId,
                        element_class: clickData.elementClass,
                        element_type: clickData.elementType,
                        element_tag: clickData.elementTag,
                        element_text: clickData.elementText,
                        element_href: clickData.elementHref,
                        element_name: clickData.elementName,
                        // Element hierarchy
                        parent_id: clickData.parentId,
                        parent_class: clickData.parentClass,
                        parent_tag: clickData.parentTag,
                        section_name: clickData.sectionName,
                        // Click details
                        click_x: clickData.clickX,
                        click_y: clickData.clickY,
                        click_page_x: clickData.clickPageX,
                        click_page_y: clickData.clickPageY,
                        // Context
                        page_url: clickData.pageUrl,
                        page_path: clickData.pagePath,
                        timestamp: clickData.timestamp,
                        // Interaction type
                        is_button: clickData.isButton,
                        is_link: clickData.isLink,
                        is_form_element: clickData.isFormElement,
                        // Additional attributes
                        data_attributes: clickData.dataAttributes
                    });
                }

                // Also track specific element types with custom events
                if (clickData.isButton) {
                    self.trackButtonClick(clickData);
                } else if (clickData.isLink) {
                    self.trackLinkClick(clickData);
                } else if (clickData.isFormElement) {
                    self.trackFormElementClick(clickData);
                }
            }, true);
        },

        // Get detailed element information
        getElementDetails: function(element, event) {
            const details = {
                // Basic element info
                elementId: element.id || 'none',
                elementClass: element.className || 'none',
                elementType: element.type || 'none',
                elementTag: element.tagName.toLowerCase(),
                elementText: this.getElementText(element),
                elementHref: element.href || element.closest('a')?.href || 'none',
                elementName: element.name || element.getAttribute('aria-label') || 'none',

                // Parent info
                parentId: element.parentElement?.id || 'none',
                parentClass: element.parentElement?.className || 'none',
                parentTag: element.parentElement?.tagName.toLowerCase() || 'none',
                sectionName: this.getSectionName(element),

                // Click coordinates
                clickX: event.clientX,
                clickY: event.clientY,
                clickPageX: event.pageX,
                clickPageY: event.pageY,

                // Page context
                pageUrl: window.location.href,
                pagePath: window.location.pathname,
                timestamp: new Date().toISOString(),

                // Element type flags
                isButton: element.tagName === 'BUTTON' || element.type === 'button' || element.type === 'submit',
                isLink: element.tagName === 'A' || element.closest('a') !== null,
                isFormElement: ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName),

                // Data attributes
                dataAttributes: this.getDataAttributes(element),

                // Event label
                eventLabel: this.generateEventLabel(element)
            };

            return details;
        },

        // Get visible text from element
        getElementText: function(element) {
            let text = element.innerText || element.textContent || element.value || element.alt || element.title || '';
            text = text.trim().substring(0, 100); // Limit to 100 chars
            return text || 'no_text';
        },

        // Get section name from closest section or container
        getSectionName: function(element) {
            const section = element.closest('section, header, footer, nav, main, aside');
            if (section) {
                return section.id || section.className.split(' ')[0] || section.tagName.toLowerCase();
            }
            return 'unknown_section';
        },

        // Get all data-* attributes
        getDataAttributes: function(element) {
            const dataAttrs = {};
            Array.from(element.attributes).forEach(attr => {
                if (attr.name.startsWith('data-')) {
                    dataAttrs[attr.name] = attr.value;
                }
            });
            return Object.keys(dataAttrs).length > 0 ? JSON.stringify(dataAttrs) : 'none';
        },

        // Generate meaningful event label
        generateEventLabel: function(element) {
            const text = this.getElementText(element);
            const id = element.id;
            const section = this.getSectionName(element);

            if (id) return `${section}_${id}`;
            if (text && text !== 'no_text') return `${section}_${text.toLowerCase().replace(/\s+/g, '_').substring(0, 30)}`;
            return `${section}_${element.tagName.toLowerCase()}`;
        },

        // Track button clicks specifically
        trackButtonClick: function(clickData) {
            if (typeof gtag === 'function') {
                gtag('event', 'button_click', {
                    event_category: 'button_interaction',
                    button_text: clickData.elementText,
                    button_id: clickData.elementId,
                    button_location: clickData.sectionName,
                    button_type: clickData.elementType,
                    page_path: clickData.pagePath
                });
            }
        },

        // Track link clicks specifically
        trackLinkClick: function(clickData) {
            if (typeof gtag === 'function') {
                const isExternal = clickData.elementHref && clickData.elementHref !== 'none' &&
                                  !clickData.elementHref.includes(window.location.hostname);

                gtag('event', 'link_click', {
                    event_category: 'navigation',
                    link_text: clickData.elementText,
                    link_url: clickData.elementHref,
                    link_domain: this.getDomain(clickData.elementHref),
                    link_type: isExternal ? 'external' : 'internal',
                    link_location: clickData.sectionName,
                    page_path: clickData.pagePath
                });
            }
        },

        // Track form element clicks
        trackFormElementClick: function(clickData) {
            if (typeof gtag === 'function') {
                gtag('event', 'form_field_interaction', {
                    event_category: 'form_engagement',
                    field_name: clickData.elementName,
                    field_id: clickData.elementId,
                    field_type: clickData.elementType,
                    field_tag: clickData.elementTag,
                    form_location: clickData.sectionName,
                    page_path: clickData.pagePath
                });
            }
        },

        // Setup scroll depth tracking
        setupScrollTracking: function() {
            const self = this;
            let scrollTimeout;

            window.addEventListener('scroll', function() {
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(function() {
                    const scrollPercentage = self.getScrollPercentage();

                    self.config.scrollDepthIntervals.forEach(function(interval) {
                        if (scrollPercentage >= interval && !self.config.scrollDepthTracked.has(interval)) {
                            self.config.scrollDepthTracked.add(interval);

                            if (typeof gtag === 'function') {
                                gtag('event', 'scroll_depth', {
                                    event_category: 'engagement',
                                    event_label: `${interval}%`,
                                    scroll_depth: interval,
                                    page_path: window.location.pathname,
                                    page_height: document.documentElement.scrollHeight,
                                    viewport_height: window.innerHeight,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                    });
                }, 150);
            });
        },

        // Calculate scroll percentage
        getScrollPercentage: function() {
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
            return scrollHeight > 0 ? Math.round((scrollTop / scrollHeight) * 100) : 0;
        },

        // Setup time on page tracking
        setupTimeTracking: function() {
            const self = this;
            const startTime = new Date();
            const intervals = [10, 30, 60, 120, 300]; // seconds
            const tracked = new Set();

            intervals.forEach(function(interval) {
                setTimeout(function() {
                    if (!tracked.has(interval)) {
                        tracked.add(interval);

                        if (typeof gtag === 'function') {
                            gtag('event', 'time_on_page', {
                                event_category: 'engagement',
                                event_label: `${interval}s`,
                                time_seconds: interval,
                                page_path: window.location.pathname,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                }, interval * 1000);
            });

            // Track when user leaves
            window.addEventListener('beforeunload', function() {
                const timeSpent = Math.round((new Date() - startTime) / 1000);

                if (typeof gtag === 'function') {
                    gtag('event', 'page_exit', {
                        event_category: 'engagement',
                        time_on_page: timeSpent,
                        page_path: window.location.pathname,
                        scroll_depth: self.getScrollPercentage(),
                        timestamp: new Date().toISOString()
                    });
                }
            });
        },

        // Setup form tracking
        setupFormTracking: function() {
            document.addEventListener('submit', function(e) {
                const form = e.target;

                if (typeof gtag === 'function') {
                    gtag('event', 'form_submit', {
                        event_category: 'form',
                        form_id: form.id || 'unnamed_form',
                        form_name: form.name || 'unnamed_form',
                        form_action: form.action || 'none',
                        form_location: EnhancedAnalytics.getSectionName(form),
                        page_path: window.location.pathname,
                        timestamp: new Date().toISOString()
                    });
                }
            }, true);

            // Track form field changes
            document.addEventListener('change', function(e) {
                const element = e.target;

                if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) {
                    if (typeof gtag === 'function') {
                        gtag('event', 'form_field_change', {
                            event_category: 'form_engagement',
                            field_name: element.name || 'unnamed_field',
                            field_id: element.id || 'no_id',
                            field_type: element.type || 'unknown',
                            form_id: element.form?.id || 'no_form',
                            page_path: window.location.pathname
                        });
                    }
                }
            }, true);
        },

        // Get page context
        getPageContext: function() {
            return {
                pageTitle: document.title,
                pageUrl: window.location.href,
                pagePath: window.location.pathname,
                referrer: document.referrer || 'direct',
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                screenWidth: window.screen.width,
                screenHeight: window.screen.height,
                deviceType: this.getDeviceType(),
                browser: this.getBrowser(),
                timestamp: new Date().toISOString()
            };
        },

        // Detect device type
        getDeviceType: function() {
            const width = window.innerWidth;
            if (width < 768) return 'mobile';
            if (width < 1024) return 'tablet';
            return 'desktop';
        },

        // Detect browser
        getBrowser: function() {
            const ua = navigator.userAgent;
            if (ua.includes('Firefox')) return 'Firefox';
            if (ua.includes('Chrome')) return 'Chrome';
            if (ua.includes('Safari')) return 'Safari';
            if (ua.includes('Edge')) return 'Edge';
            return 'Other';
        },

        // Get domain from URL
        getDomain: function(url) {
            try {
                const urlObj = new URL(url);
                return urlObj.hostname;
            } catch (e) {
                return 'invalid_url';
            }
        }
    };

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            EnhancedAnalytics.init();
        });
    } else {
        EnhancedAnalytics.init();
    }

    // Expose to global scope if needed
    window.EnhancedAnalytics = EnhancedAnalytics;

})();
