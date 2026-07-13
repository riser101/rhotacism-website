# Nav & Footer Build System

## Problem
Google doesn't always render JavaScript. Nav and footer were loaded via JS, making them invisible to search crawlers.

## Solution
Build script injects nav/footer as static HTML. Single source of truth maintained in `therollracademy/includes/nav.html` and `therollracademy/includes/footer.html`.

---

## Files

| File | Purpose |
|------|---------|
| `therollracademy/includes/nav.html` | Nav source (edit this) |
| `therollracademy/includes/footer.html` | Footer source (edit this) |
| `build.js` | Injects nav/footer into all HTML files |
| `watch.js` | Auto-rebuilds on changes (local dev) |
| `restore-placeholders.js` | Reverts to placeholder state before commit |

---

## Local Development

```bash
# Start watch mode (builds once, then watches for changes)
node watch.js
```

This will:
1. Run initial build (inject nav/footer into all HTML files including 404.html)
2. Watch `therollracademy/includes/nav.html` and `therollracademy/includes/footer.html` for changes
3. Auto-rebuild when changes detected

Open HTML files in browser to test.

### Before Committing

```bash
node restore-placeholders.js
```

This reverts all HTML files back to placeholders so git repo stays clean.

---

## Deployment (staging-first — REQUIRED)

**Never push feature work straight to `main`.** `main` is Vercel's Production
Branch — every push to it deploys to production immediately. All changes go to
**staging first, verify, then promote to prod.**

### Staging

- Deploy staging by pushing to the branch named **`staging`** (fixed name — do
  not use ad-hoc branch names for staging).
- Vercel auto-builds it to a **stable** preview alias that never changes as long
  as the branch is named `staging`:

  ```
  https://rhotacism-website-git-staging-yousuf-syeds-projects.vercel.app
  ```

  (Per-commit hash URLs like `…-6pt6wlsgh-…` change every deploy and predate the
  latest code — always test the `-git-staging-` alias, not a hash URL.)

- This one origin is whitelisted for Google sign-in, so auth works on staging.
  If you ever change the staging branch name the alias changes and Google
  sign-in breaks with `origin_mismatch` — see "OAuth / Firebase" below.

### Promote to production

Once verified on staging, fast-forward `main` and push:

```bash
git checkout main
git merge --ff-only staging
git push origin main   # → production deploy
```

Vercel runs `node build.js` on deploy (both envs), so committed HTML carries
`<!-- *_PLACEHOLDER -->` and deployed HTML has nav/footer inlined. Search
engines see full nav/footer without rendering JavaScript.

### Backend (Cloud Run) is separate

The lisp analysis backend (`gcp-function-lisp/`) is a **Cloud Run service, not
deployed by Vercel**. The frontend hardcodes its prod URL, so staging hits the
**prod** function. Backend changes must be deployed explicitly:

```bash
cd gcp-function-lisp
gcloud run deploy analyze-lisp-speech --source . \
  --region=us-central1 --project=detache-platform
```

There is no separate backend staging env — deploy backend changes only when they
are additive/backward-compatible (they don't alter existing routes/behaviour),
so prod is unaffected until the frontend that uses them is promoted.

### OAuth / Firebase whitelist (one-time, console only)

The staging alias is already whitelisted. If the staging URL ever changes, add
the new origin in both:

- Google Cloud Console → project **rollr-academy** → Credentials → OAuth client
  `9267895976-8ueksa7davc1tasdmkgeu76b34du2rvn` → **Authorized JavaScript
  origins** (origin only, no path/trailing slash).
- Firebase Console → **rollr-academy** → Authentication → Settings →
  **Authorized domains** (host only).

---

## Making Nav/Footer Changes

1. Start local dev: `node watch.js`
2. Edit `therollracademy/includes/nav.html` or `therollracademy/includes/footer.html`
3. Changes auto-injected into all pages (refresh browser to see)
4. Test locally
5. Before commit: `node restore-placeholders.js`
6. Commit and push
7. Vercel auto-deploys with changes

---

## Cache Busting (IMPORTANT)

Local CSS/JS/includes are referenced with a version query string, e.g.
`css/nav.css?v=20260707`. Browsers cache each versioned URL indefinitely and
only re-fetch when the `v=` value changes.

**Symptom if you forget:** returning visitors see a stale asset — e.g. a modal
renders un-hidden until a hard reload pulls the new CSS. Hard reload "fixing" a
bug is the tell-tale sign of a missed version bump.

### Rule
Whenever you change **any** file under `*/css/` or `*/js/`, or the
`*/includes/*.html` fragments, bump the version stamp on every reference in one
sweep. Use today's date (`YYYYMMDD`) as the stamp so it's obvious and monotonic.

```bash
# Replace OLD with the current stamp and NEW with today's date (e.g. 20260707)
find . -name '*.html' -not -path '*/node_modules/*' -print0 \
  | xargs -0 perl -i -pe 's/\?v=OLD/?v=NEW/g'
# nav.js loads includes/injected scripts via fetch()/createElement — bump those too
perl -i -pe 's/\?v=OLD/?v=NEW/g' */js/nav.js
```

Notes:
- Only local assets are versioned; external CDN URLs (Google, PostHog) are left alone.
- The stamp must match across all sites and inside `nav.js` (which versions the
  `fetch()`ed `nav.html` / `login-modal.html` and the injected
  `login-modal.js` / `google-signin-init.js`).
