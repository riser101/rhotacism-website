// Playwright config for the static-site UI tests (tests/*.spec.js).
// Serves the repo root the same way Vercel does (after `node build.js`).
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 30_000,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    use: {
        baseURL: 'http://localhost:8931',
        screenshot: 'only-on-failure',
    },
    webServer: {
        command: 'python3 -m http.server 8931',
        url: 'http://localhost:8931/lispspeechclinic/assessment.html',
        reuseExistingServer: !process.env.CI,
    },
});
