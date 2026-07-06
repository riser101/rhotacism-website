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

## Production Deployment (Vercel)

**Automatic.** No manual steps required.

1. Push to git (HTML files have placeholders)
2. Vercel detects push and starts deployment
3. Vercel runs `node build.js` (configured in `vercel.json`)
4. Nav/footer injected into all HTML files (including 404.html)
5. Site deployed with static nav/footer in source HTML

Search engines now see full nav/footer without needing to render JavaScript.

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
