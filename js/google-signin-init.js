// Initialize Google Sign-In - Common function for all pages
function initializeGoogleSignIn() {
    console.log('🔧 Initializing Google Sign-In...');

    // Wait for Google library to load
    let attempts = 0;
    const maxAttempts = 100; // Increased from 50 to 100 (10 seconds total)

    const initialize = () => {
        console.log(`🔍 Attempt ${attempts + 1}: Checking for Google library...`);

        if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
            console.log('✅ Google library loaded successfully');

            // Check if handleCredentialResponse exists
            if (typeof handleCredentialResponse === 'undefined') {
                console.error('❌ handleCredentialResponse function not found');
                return;
            }

            // Initialize Google Sign-In
            google.accounts.id.initialize({
                client_id: '653307587559-bg7qf4p5h70q4kcrdnircer7ht79c4ha.apps.googleusercontent.com',
                callback: handleCredentialResponse,
                auto_select: false,
                cancel_on_tap_outside: true
            });
            console.log('✅ Google Sign-In initialized');

            // Render the button if container exists
            const buttonContainer = document.querySelector('.g_id_signin');
            if (buttonContainer) {
                console.log('✅ Button container found, rendering button...');
                google.accounts.id.renderButton(
                    buttonContainer,
                    {
                        type: 'standard',
                        shape: 'rectangular',
                        theme: 'outline',
                        text: 'continue_with',
                        size: 'large',
                        logo_alignment: 'left',
                        width: 280
                    }
                );
                console.log('✅ Google Sign-In button rendered');
            } else {
                console.error('❌ Button container (.g_id_signin) not found');
            }
        } else if (attempts < maxAttempts) {
            attempts++;
            setTimeout(initialize, 100);
        } else {
            console.error('❌ Google Sign-In library failed to load after', maxAttempts, 'attempts');
        }
    };

    initialize();
}
