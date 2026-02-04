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
