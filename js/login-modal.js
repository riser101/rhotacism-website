// Login Modal Functions
function openLoginModal() {
    const loginModal = document.getElementById('loginModal');
    if (loginModal) {
        loginModal.style.display = 'flex';

        // Track with Google Analytics
        if (typeof gtag !== 'undefined') {
            gtag('event', 'login_modal_open', {
                event_category: 'engagement',
                event_label: 'navigation_login_button'
            });
        }

        // Track with PostHog
        if (typeof posthog !== 'undefined') {
            posthog.capture('login_modal_opened', {
                page_url: window.location.href,
                trigger: 'get_started_button'
            });
        }
    }
}

function closeLoginModal() {
    const loginModal = document.getElementById('loginModal');
    if (loginModal) {
        loginModal.style.display = 'none';

        // Track modal close with PostHog
        if (typeof posthog !== 'undefined') {
            posthog.capture('login_modal_closed', {
                page_url: window.location.href
            });
        }
    }
}

// Google OAuth callback function
function handleCredentialResponse(response) {
    try {
        // Decode the JWT token to get user information
        const responsePayload = decodeJwtResponse(response.credential);

        // Store user data
        const userData = {
            id: responsePayload.sub,
            email: responsePayload.email,
            name: responsePayload.name,
            picture: responsePayload.picture,
            loginTime: new Date().toISOString()
        };

        // Store in localStorage
        localStorage.setItem('userAuth', JSON.stringify(userData));
        localStorage.setItem('userEmail', responsePayload.email);

        // Track successful login with Google Analytics
        if (typeof gtag !== 'undefined') {
            gtag('event', 'google_login_success', {
                event_category: 'conversion',
                event_label: 'login_modal',
                user_id: responsePayload.sub
            });
        }

        // Track successful login with PostHog
        if (typeof posthog !== 'undefined') {
            posthog.capture('user_login_success', {
                login_method: 'google_oauth',
                user_email: responsePayload.email,
                user_name: responsePayload.name,
                page_url: window.location.href
            });

            // Identify user in PostHog
            posthog.identify(responsePayload.sub, {
                email: responsePayload.email,
                name: responsePayload.name
            });
        }

        // Submit to FormEasy for email collection
        fetch('https://script.google.com/macros/s/AKfycbzKixpKPkJRuqIKj7p53JSholkMjkcvWrdlLh9Vv9kl1sX6wquSIdiTUqHg1NIG6GwkTA/exec', {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=utf-8'
            },
            body: JSON.stringify({
                email: responsePayload.email,
                name: responsePayload.name,
                source: 'google_oauth_login',
                timestamp: new Date().toISOString(),
                message: 'User authenticated with Google OAuth for R Sound exercises'
            })
        }).catch(error => console.log('Form submission error:', error));

        // Close modal and redirect
        closeLoginModal();

        // Redirect to exercises page immediately
        window.location.href = 'exercises.html';

    } catch (error) {
        console.error('Login error:', error);

        // Track with Google Analytics
        if (typeof gtag !== 'undefined') {
            gtag('event', 'google_login_error', {
                event_category: 'error',
                event_label: 'login_modal'
            });
        }

        // Track with PostHog
        if (typeof posthog !== 'undefined') {
            posthog.capture('user_login_error', {
                login_method: 'google_oauth',
                error_message: error.message || 'Unknown error',
                page_url: window.location.href
            });
        }

        alert('Login failed. Please try again.');
    }
}

// Function to decode JWT token
function decodeJwtResponse(token) {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
}

// Function to check if user is already logged in
function checkAuthStatus() {
    const userAuth = localStorage.getItem('userAuth');
    if (userAuth) {
        try {
            const userData = JSON.parse(userAuth);
            const loginTime = new Date(userData.loginTime);
            const now = new Date();
            const hoursDiff = (now - loginTime) / (1000 * 60 * 60);

            // Session expires after 24 hours
            if (hoursDiff < 24) {
                return userData;
            } else {
                // Clear expired session
                localStorage.removeItem('userAuth');
                localStorage.removeItem('userEmail');
            }
        } catch (error) {
            console.error('Auth check error:', error);
            localStorage.removeItem('userAuth');
            localStorage.removeItem('userEmail');
        }
    }
    return null;
}

// Function to logout user
function logoutUser() {
    localStorage.removeItem('userAuth');
    localStorage.removeItem('userEmail');

    if (typeof gtag !== 'undefined') {
        gtag('event', 'user_logout', {
            event_category: 'engagement',
            event_label: 'manual_logout'
        });
    }

    // Redirect to home page
    window.location.href = 'index.html';
}

function loginWithEmail(event) {
    event.preventDefault();
    const email = document.getElementById('loginEmail').value;

    if (!email || !email.includes('@')) {
        alert('Please enter a valid email address');
        return;
    }

    // Track email login
    if (typeof gtag !== 'undefined') {
        gtag('event', 'email_login', {
            event_category: 'conversion',
            event_label: 'login_modal'
        });
    }

    // Store email in localStorage for exercises page
    localStorage.setItem('userEmail', email);

    // Submit to FormEasy for email collection
    fetch('https://script.google.com/macros/s/AKfycbzKixpKPkJRuqIKj7p53JSholkMjkcvWrdlLh9Vv9kl1sX6wquSIdiTUqHg1NIG6GwkTA/exec', {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify({
            email: email,
            source: 'login_modal',
            timestamp: new Date().toISOString(),
            message: 'User login for R Sound exercises'
        })
    })
    .then(response => {
        // Close modal and show profile dropdown
        closeLoginModal();
        if (typeof showProfileDropdown === 'function') {
            showProfileDropdown();
        }

        // Redirect to exercises page regardless of response
        window.location.href = 'exercises.html';
    })
    .catch(error => {
        console.error('Error:', error);
        // Close modal and show profile dropdown
        closeLoginModal();
        if (typeof showProfileDropdown === 'function') {
            showProfileDropdown();
        }

        // Still redirect to exercises page
        window.location.href = 'exercises.html';
    });
}

// Close login modal when clicking outside
document.addEventListener('click', function(event) {
    const loginModal = document.getElementById('loginModal');
    if (loginModal && event.target === loginModal) {
        closeLoginModal();
    }
});
