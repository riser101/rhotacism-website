// Receives the Google Identity Services credential POST (GIS ux_mode:'redirect',
// used on iOS where the popup flow loses the credential when the backgrounded
// tab is discarded) and bounces it back to the assessment page in the URL
// fragment. Fragments never leave the browser, and the page exchanges the
// token for a Firebase session client-side, so nothing is stored here.
export default function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }
    const body = req.body || {};
    // Double-submit CSRF check per Google's sign-in docs.
    const cookieToken = ((req.headers.cookie || '').match(/(?:^|;\s*)g_csrf_token=([^;]+)/) || [])[1];
    if (cookieToken && body.g_csrf_token && cookieToken !== body.g_csrf_token) {
        res.status(400).send('CSRF token mismatch');
        return;
    }
    const credential = typeof body.credential === 'string' ? body.credential : '';
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential)) {
        res.status(400).send('Missing credential');
        return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, '/lispspeechclinic/assessment.html#giscred=' + encodeURIComponent(credential));
}
