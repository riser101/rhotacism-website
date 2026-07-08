// Returns the visitor's country (ISO-3166 alpha-2) from Vercel's edge GeoIP
// header (x-vercel-ip-country). Same-origin, no third party, no rate limit —
// used to default the phone country code on the lisp assessment. Falls back to
// an empty string when the header is absent (e.g. local dev), and the client
// then uses its timezone/locale default.
export default function handler(req, res) {
    const country = (req.headers['x-vercel-ip-country'] || '').toString().toUpperCase();
    // Don't cache — this is per-visitor and cheap to recompute at the edge.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ country });
}
