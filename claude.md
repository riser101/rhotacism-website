# Project Instructions

Static multi-site marketing repo (three products: `therollracademy`,
`lispspeechclinic`, `stutterfluencycentre`). Deployed on Vercel. No framework —
plain HTML/CSS/JS. See `README-BUILD.md` for full detail.

## Nav/Footer build system (SEO)

Google doesn't reliably render JS, so nav/footer must be static HTML in each
page for crawlers. They're maintained as a single source in
`<product>/includes/nav.html` and `footer.html`, and injected into every page.

- **Single source of truth:** edit `<product>/includes/nav.html` / `footer.html`
  only. Never hand-edit the injected nav/footer inside individual pages.
- **`build.js`** — replaces `<!-- NAV_PLACEHOLDER -->` / `<!-- FOOTER_PLACEHOLDER -->`
  in every page with the include contents. Vercel runs this on deploy (via
  `vercel.json`), so committed HTML carries placeholders, deployed HTML is inlined.
- **`watch.js`** — local dev: builds once, then rebuilds on include changes.
- **`restore-placeholders.js`** — the inverse of `build.js`; converts inlined
  nav/footer back to placeholders. **Run before every commit** so the repo stays
  clean and diffs stay small:
  ```bash
  node restore-placeholders.js
  ```
  (`lispspeechclinic/index.html` uses a "Purchase Now" nav variant; both scripts
  handle that special case automatically.)

Workflow to change nav/footer: `node watch.js` → edit the include → test →
`node restore-placeholders.js` → commit.

## Cache busting (IMPORTANT)

Local CSS/JS/includes are referenced with a `?v=YYYYMMDD` version query (e.g.
`css/nav.css?v=20260707`). Browsers cache each versioned URL indefinitely and
only re-fetch when `v=` changes. A bug that a **hard reload fixes** = a missed
version bump serving stale CSS/JS.

**Whenever you change any file under `*/css/`, `*/js/`, or `*/includes/*.html`,
bump the stamp on every reference in one sweep** (use today's date):

```bash
# OLD = current stamp, NEW = today's date (YYYYMMDD)
find . -name '*.html' -not -path '*/node_modules/*' -print0 \
  | xargs -0 perl -i -pe 's/\?v=OLD/?v=NEW/g'
perl -i -pe 's/\?v=OLD/?v=NEW/g' */js/nav.js
```

- Only local assets are versioned; leave external CDN URLs (Google, PostHog) alone.
- `nav.js` also versions the `fetch()`ed `nav.html`/`login-modal.html` and the
  injected `login-modal.js`/`google-signin-init.js` — keep those stamps in sync.

## Analytics

App Store link clicks are tracked centrally in `<product>/js/posthog-tracking.js`
via a delegated handler using `{ transport: 'sendBeacon' }` (survives navigation
without delaying it). Do not re-add inline `posthog.capture('app_store_click')`
onclick handlers — that double-counts. Inline `gtag(...)` calls are the GA path
and are expected.

## Testing & Verification
