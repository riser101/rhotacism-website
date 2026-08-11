# PostHog Self-driving setup report

## Summary

PostHog Self-driving has been configured for the topspeech-website monorepo (three products: Lisp Speech Clinic, The Rollr Academy, Stutter Fluency Centre). Session Replay, Error Tracking, and Support (Conversations) signal sources are now wired to the inbox, and a focused scout troop of three is running. Findings will start appearing in your Self-driving inbox within ~30 minutes: https://us.posthog.com/project/266946/inbox

---

## AI data processing

**Approved.** Organisation-level AI data processing consent was verified before this run started.

---

## GitHub

**Connected during this run.** Two GitHub accounts authorised:
- `hanami-engineering` (integration id 186612)
- `riser101` (integration id 186613)

Self-driving can now research findings against your code and open fix PRs.

---

## Products enabled

The `products-enable` API tool was not available in this MCP version; the table reflects what the prior integration and the server state indicate. No `posthog.init` overrides for session recording or exception capture were found — all init calls use `{ api_host: '...', defaults: '2025-11-30' }` with no disabling flags, so the server flip will take effect as-is.

| Product | Status | Notes |
|---|---|---|
| Session Replay | Already enabled | Recordings confirmed in project (active today) |
| Error Tracking | Needs manual enable | No issues yet; see follow-up |
| Support (Conversations) | Needs manual enable | Tickets only arrive once an inbound channel is connected; see follow-up |

---

## Signal sources

| source_product | source_type | Action | Notes |
|---|---|---|---|
| `signals_scout` | `cross_source_issue` | Skipped (default ON) | Scout findings reach the inbox with no config row needed; creating a row would opt out |
| `error_tracking` | `issue_created` | **Enabled** (id `019f6e89-d41c-7691-8bde-d1fbcbc4d99d`) | |
| `error_tracking` | `issue_reopened` | **Enabled** (id `019f6e89-d7e4-74a5-a5be-e054e59b87cf`) | |
| `error_tracking` | `issue_spiking` | **Enabled** (id `019f6e89-da7b-7030-a086-d7faed0cb83c`) | |
| `session_replay` | `session_analysis_cluster` | **Enabled** (id `019f6e89-e81f-7c34-bced-2d95e6eb82b2`) | Sample rate 10% (server default) |
| `conversations` | `ticket` | **Enabled** (id `019f6e89-ebf6-72d7-b8e4-3051f925ecea`) | Dormant until an inbound channel is connected |

---

## Connected tools

| Tool | Status |
|---|---|
| GitHub Issues | Not used (not selected) |
| Linear | Not used (not selected) |
| Zendesk | Not used (not selected) |
| pganalyze | Not used (not selected) |
| Jira | Not used (not selected) |

---

## Scout troop

26 scouts materialised. **3 enabled, 23 disabled.**

### Enabled

| Scout | Reason |
|---|---|
| `signals-scout-general` | Always on — sweeps cross-product correlations and surfaces no specialist covers |
| `signals-scout-product-analytics` | Top surface: active funnel events (`assessment_started`, `assessment_step_completed`, `retake_paywall_viewed`, `pricing_plan_clicked`) and saved funnel insights |
| `signals-scout-surveys` | Top surface: active "Lisp Assessment Survey" popover in production |

### Disabled

| Scout | Reason |
|---|---|
| `signals-scout-error-tracking` | **Intentional** — covered by native `error_tracking` signal source (not a re-enable follow-up) |
| `signals-scout-session-replay` | **Intentional** — covered by native `session_replay` signal source (not a re-enable follow-up) |
| `signals-scout-ai-observability` | No AI/LLM usage in this project |
| `signals-scout-anomaly-detection` | Not in top 2 most-used surfaces; enable if you add dashboards/insights you want anomaly-monitored |
| `signals-scout-apm` | No distributed tracing / OpenTelemetry in this static web project |
| `signals-scout-csp-violations` | No CSP reporting configured |
| `signals-scout-customer-analytics` | No group/B2B analytics |
| `signals-scout-data-pipelines` | No CDP destinations or batch exports configured |
| `signals-scout-data-warehouse` | No external warehouse sources connected |
| `signals-scout-experiments` | No active A/B experiments |
| `signals-scout-feature-flags` | No active feature flags; enable if you add flags |
| `signals-scout-health-checks` | Lower priority than top 2 specialists |
| `signals-scout-inbox-validation` | Fresh setup — no resolved reports to validate yet |
| `signals-scout-ingestion-warnings` | Lower priority than top 2 specialists |
| `signals-scout-insight-alerts` | Lower priority than top 2 specialists |
| `signals-scout-logs` | PostHog logs product not in use |
| `signals-scout-mcp-tool-calls` | No MCP telemetry in this project |
| `signals-scout-observability-gaps` | Lower priority; general scout covers this |
| `signals-scout-replay-vision` | No Replay Vision scanners configured |
| `signals-scout-revenue-analytics` | Dodo payments not synced to PostHog revenue analytics |
| `signals-scout-skills-store` | Not relevant to top surfaces |
| `signals-scout-web-analytics` | Lower priority than product-analytics for this project |
| `signals-scout-web-vitals` | Lower priority than top 2 specialists |

---

## Custom scouts

The wizard encountered a technical issue (stale pending request after timeout) that prevented the user approval prompt from appearing after 4 retries. Both candidates are recorded here as follow-ups with full design rationale.

### Surfaces considered and ruled out

| Surface | Filter that ruled it out |
|---|---|
| Assessment funnel rates | Covered by `signals-scout-product-analytics` (watches saved "Assessment completion funnel" for rate regressions) |
| Retake paywall conversion | Covered by `signals-scout-product-analytics` (watches saved "Retake paywall conversion funnel") |
| Pricing plan clicks trend | Covered by saved "Pricing plan clicks by plan" insight; general would catch anomalies |
| Video/scroll/time events | Not business-critical; noise risk outweighs value |

### Proposed (not yet created — blocked by wizard issue)

**`signals-scout-app-store-cta`** — Watch app store clicks for silent drops across all three products  
- **Surface**: `app_store_click` event, tracked via delegated `sendBeacon` handler in all three `posthog-tracking.js` files — the primary mobile conversion CTA for every product
- **Gap**: Not part of any saved funnel; `product-analytics` watches rate regressions while entrants hold, not standalone CTA volume. `web-analytics` disabled. `general` sweeps broadly but doesn't specialise here
- **Discriminator**: `app_store_click` weekly volume per product falls more than ~30% below its prior 4-week rolling average, *and* `$pageview` volume on the same product did not fall proportionally (ruling out a traffic-wide drop)
- **Explore patterns**: (1) `query-trends` last 7d vs prior 7d for `app_store_click` broken down by product/page; (2) ratio of `app_store_click` to `$pageview` per product vs baseline; (3) check for device/browser skew if the drop is partial

**`signals-scout-assessment-entry`** — Watch for drops in assessment starts on the lisp clinic  
- **Surface**: `assessment_started` event at `lispspeechclinic/assessment.html` — the gate to the lisp assessment revenue funnel
- **Gap**: `product-analytics` fires on *rate* regressions "while entrants hold" — it would not catch a drop in `assessment_started` volume itself (fewer users reaching or beginning the assessment). That drop would empty the funnel without triggering a rate alarm
- **Discriminator**: `assessment_started` weekly count falls more than ~25% vs prior 4-week rolling average, and `$pageview` on the assessment page did not fall proportionally
- **Explore patterns**: (1) `query-trends` for `assessment_started` last 7d vs prior 7d; (2) compare to `$pageview` on `/lispspeechclinic/assessment.html`; (3) check browser/device breakdown for partial failures

**Noise escape hatch**: once created, set `emit: false` on a scout's config in PostHog to switch it to dry-run if it turns out noisy.

---

## Follow-ups

- [ ] **Enable Error Tracking** — go to [Project settings → Products](https://us.posthog.com/project/266946/settings/environment-integrations) and turn on Exception autocapture / Error Tracking. No code changes needed (no `capture_exceptions: false` override in `posthog.init`).
- [ ] **Enable Session Replay** — same settings page; confirm Session Replay recording is ON. Recordings are already arriving so it may already be on; verify in the UI.
- [ ] **Enable Support (Conversations)** — same settings page; turn on Conversations, then connect an inbound channel (email, inbox, or Slack) so tickets can reach the Self-driving inbox.
- [ ] **Create `signals-scout-app-store-cta`** — see design rationale in Custom scouts section above. Create via PostHog → [Skills store](https://us.posthog.com/project/266946/pipeline/new/source) or re-run this setup after the wizard_ask issue is resolved.
- [ ] **Create `signals-scout-assessment-entry`** — see design rationale in Custom scouts section above.
- [ ] **Enable `signals-scout-web-analytics`** — if you want traffic/channel/bounce monitoring on the marketing sites, enable this scout in PostHog → Self-driving → Scout troop.
- [ ] **Enable `signals-scout-feature-flags`** — if you introduce PostHog feature flags, enable this scout.
- [ ] **Enable `signals-scout-experiments`** — if you run A/B experiments, enable this scout.
- [ ] **Enable `signals-scout-revenue-analytics`** — if you connect Dodo payments data to PostHog revenue analytics, enable this scout.
- [ ] **Enable `signals-scout-inbox-validation`** — after resolving your first Self-driving reports, turn this on so it verifies fixes actually held.

---

## What happens next

The scout coordinator picks up fresh configs within ~30 minutes. Scouts will run on their 24-hour interval and file reports into [your Self-driving inbox](https://us.posthog.com/project/266946/inbox). Session replay clusters and error tracking issues will surface there too as native sources. Immediately-actionable reports can be turned into coding tasks directly from the inbox.
