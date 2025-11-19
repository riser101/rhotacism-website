// Check for floating top bar BEFORE DOM loads and add styles immediately
(function() {
    // Check if we're on a page that should have the top bar offset
    // This runs immediately to prevent any flash
    const style = document.createElement('style');
    style.id = 'nav-position-fix';

    // Check if floating top bar exists in the HTML (even before it's fully parsed)
    if (document.documentElement.innerHTML.includes('id="floatingTopBar"')) {
        style.textContent = '.navbar { top: 65px !important; } @media (max-width: 768px) { .navbar { top: 75px !important; } } @media (max-width: 480px) { .navbar { top: 85px !important; } }';
    }

    document.head.appendChild(style);
})();

// Load navigation HTML
document.addEventListener('DOMContentLoaded', function() {
    // Determine the correct path prefix based on current page location
    const currentPath = window.location.pathname;
    const isInGuideFolder = currentPath.includes('/guide/');
    const pathPrefix = isInGuideFolder ? '../' : '';

    // Load navigation
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
    updateProfileDisplay();
}

// Update profile display based on login state
function updateProfileDisplay() {
    const userEmail = localStorage.getItem('userEmail');
    const profileInitial = document.getElementById('profileInitial');

    if (userEmail && profileInitial) {
        // Set profile initial to first letter of email
        profileInitial.textContent = userEmail.charAt(0).toUpperCase();
    }
}

// Logout functionality
window.logout = function() {
    // Clear user data
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userName');
    localStorage.removeItem('userToken');

    // Track logout event
    if (typeof gtag !== 'undefined') {
        gtag('event', 'logout', {
            event_category: 'user_action'
        });
    }

    // Redirect to home page
    window.location.href = '/';
};
