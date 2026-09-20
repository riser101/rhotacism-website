// Assessment replay regression (tests/replay/) — replays the recorded run in
// tests/fixtures/lisp-run-20260827 through the real page + prod backend.
//   npm run test:replay                                  (local page)
//   REPLAY_BASE_URL=https://rhotacism-website-git-staging-yousuf-syeds-projects.vercel.app npm run test:replay
// Excluded from the default CI suite (testIgnore in the other configs): each
// run takes ~6-10 min and spends real MFA/Praat/Gemini compute.
import { defineConfig } from '@playwright/test';

const remote = !!process.env.REPLAY_BASE_URL;

export default defineConfig({
    testDir: './tests/replay',
    timeout: 14 * 60_000,
    retries: 0,
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: process.env.REPLAY_BASE_URL || 'http://localhost:8000',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        trace: 'retain-on-failure',
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, // never open the real camera from a test run
    },
    ...(remote ? {} : {
        webServer: {
            command: 'python3 -m http.server 8000',
            url: 'http://localhost:8000/lispspeechclinic/assessment.html',
            reuseExistingServer: true,
        },
    }),
});
