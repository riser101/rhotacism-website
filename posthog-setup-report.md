# PostHog post-wizard report

The wizard has completed a targeted PostHog integration across the topspeech-website monorepo (three products: Lisp Speech Clinic, The Rollr Academy, Stutter Fluency Centre). Changes add five new business-critical events, fix a PII violation in all three products' login flows, add `posthog.reset()` on logout across all three products, and add PostHog init to the retake paywall (which previously loaded retake.js event calls but had no init).

| Event name | Description | File |
|---|---|---|
| `pricing_plan_clicked` | User clicks a pricing plan CTA button on the pricing page to begin checkout | `lispspeechclinic/pricing.html` |
| `assessment_started` | User begins the lisp assessment recording step (enters the recording step from the login step) | `lispspeechclinic/assessment.html` |
| `assessment_step_completed` | User completes a numbered step in the lisp assessment wizard | `lispspeechclinic/assessment.html` |
| `retake_paywall_viewed` | User lands on the retake paywall page (top of retake conversion funnel) | `lispspeechclinic/js/retake.js` |
| `user_logout` | User logs out; fires before `posthog.reset()` unlinks future events | `lispspeechclinic/js/login-modal.js`, `therollracademy/js/login-modal.js`, `stutterfluencycentre/js/login-modal.js` |

**Additional fixes:**
- **PII removed** — `user_email` and `user_name` were being sent as `posthog.capture()` properties in `user_login_success` across all three `login-modal.js` files. These are now removed; the values are correctly set via `posthog.identify()` person properties only.
- **PostHog init added to retake.html** — `retake.js` already called `window.posthog.capture()` but the page had no PostHog init script, so all retake events were silently dropped. The standard init snippet is now present.
- **`posthog.reset()` on logout** — All three `logoutUser()` functions now call `posthog.reset()` to unlink future anonymous events from the signed-out user.

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard**: [Analytics basics (wizard)](https://us.posthog.com/project/266946/dashboard/1862720)
- [Retake paywall conversion funnel (wizard)](https://us.posthog.com/project/266946/insights/qUR280Tm)
- [Assessment completion funnel (wizard)](https://us.posthog.com/project/266946/insights/0pL5jtAu)
- [Pricing plan clicks by plan (wizard)](https://us.posthog.com/project/266946/insights/jqi7kHMN)
- [User logins over time (wizard)](https://us.posthog.com/project/266946/insights/6jZwN6NQ)
- [Login modal to login success funnel (wizard)](https://us.posthog.com/project/266946/insights/FDiIWFJZ)

## Verify before merging

- [ ] Run a full production build (the wizard only verified the files it touched) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Confirm the returning-visitor path also calls `identify` — a handler that only identifies on fresh login can leave returning sessions on anonymous distinct IDs.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.
