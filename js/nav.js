// Load navigation HTML
document.addEventListener('DOMContentLoaded', function() {
    // Determine the correct path prefix based on current page location
    const currentPath = window.location.pathname;
    const isInGuideFolder = currentPath.includes('/guide/');
    const pathPrefix = isInGuideFolder ? '../' : '';

    // Load login-modal.js script first, then load navigation
    const loginModalScript = document.createElement('script');
    loginModalScript.src = pathPrefix + 'js/login-modal.js';
    loginModalScript.onload = function() {
        // Load navigation after login-modal.js is ready
        fetch(pathPrefix + 'includes/nav.html')
            .then(response => response.text())
            .then(html => {
                // Insert navigation at the beginning of body
                document.body.insertAdjacentHTML('afterbegin', html);

                // Fix image paths based on current location
                const navLogoImg = document.getElementById('navLogoImg');
                const navAppStoreBadge1 = document.getElementById('navAppStoreBadge1');
                const navAppStoreBadge2 = document.getElementById('navAppStoreBadge2');
                const navLogoLink = document.getElementById('navLogoLink');

                if (navLogoImg) {
                    navLogoImg.src = pathPrefix + 'instagram-icon.jpg';
                }
                if (navAppStoreBadge1) {
                    navAppStoreBadge1.src = pathPrefix + 'Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg';
                }
                if (navAppStoreBadge2) {
                    navAppStoreBadge2.src = pathPrefix + 'Download_on_the_App_Store_Badge_US-UK_RGB_blk_092917.svg';
                }
                if (navLogoLink) {
                    navLogoLink.href = pathPrefix + 'index.html';
                }

                // Fix all navigation links with data-page attribute
                document.querySelectorAll('.nav-link[data-page]').forEach(link => {
                    const page = link.getAttribute('data-page');
                    link.href = pathPrefix + page;
                });

                // Initialize navigation functions after nav is loaded
                initializeNavigation();
            })
            .catch(error => console.error('Error loading navigation:', error));
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
    googleSignInScript.src = pathPrefix + 'js/google-signin-init.js';
    googleSignInScript.onload = function() {
        // After google-signin-init.js is loaded, load the modal HTML
        fetch(pathPrefix + 'includes/login-modal.html')
            .then(response => response.text())
            .then(html => {
                // Insert login modal at the end of body
                document.body.insertAdjacentHTML('beforeend', html);

                // Fix login modal logo path
                const loginModalLogo = document.getElementById('loginModalLogo');
                if (loginModalLogo) {
                    loginModalLogo.src = pathPrefix + 'instagram-icon.jpg';
                }

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
    const pathPrefix = window.location.pathname.includes('/guide/') ? '../' : '';
    window.location.href = pathPrefix + 'index.html';
};
