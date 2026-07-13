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

## Deployment: staging-first (MANDATORY)

`main` is Vercel's Production Branch — **any push to `main` deploys to production
immediately.** Never push feature work to `main`. The flow is always: **staging →
verify → promote to prod.** (Full detail in `README-BUILD.md` → "Deployment".)

- **Deploy staging** by pushing to the branch named **`staging`** (fixed name).
  Vercel auto-builds it to a stable alias that only stays valid while the branch
  is named `staging`:
  `https://rhotacism-website-git-staging-yousuf-syeds-projects.vercel.app`
  (Per-commit hash URLs change every deploy and are usually stale — verify the
  `-git-staging-` alias, never a hash URL.)
- **Do not rename the staging branch or use ad-hoc staging branch names.** The
  staging alias is the only Vercel origin whitelisted for Google sign-in; a
  different name → new alias → sign-in fails with `origin_mismatch`.
- **Promote to prod** only after the user verifies staging:
  ```bash
  git checkout main && git merge --ff-only staging && git push origin main
  ```
- **Backend is NOT on Vercel.** `gcp-function-lisp/` is a Cloud Run service; the
  frontend hardcodes its prod URL, so staging hits the prod function. Deploy
  backend changes explicitly and only when additive/backward-compatible (so prod
  is unaffected until the frontend is promoted):
  ```bash
  cd gcp-function-lisp && gcloud run deploy analyze-lisp-speech --source . \
    --region=us-central1 --project=detache-platform
  ```
- **Pushing is outward-facing:** confirm with the user before pushing `staging`
  and before promoting to `main`.

## Testing & Verification

- **Stuck behind the retake paywall?** The free-once gate is server-side in
  Firestore (`rollr-academy`), keyed on identity — not localStorage. To take the
  full free assessment again, reset your person record:
  `cd gcp-function-lisp && node reset-entitlement.js you@gmail.com`. See
  README-BUILD.md → "Resetting the retake (free-once) gate for testing".
