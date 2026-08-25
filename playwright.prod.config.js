// Run the same UI suite against production (no local server):
//   npx playwright test --config=playwright.prod.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 45_000,
    reporter: 'list',
    use: {
        baseURL: 'https://topspeech.health',
        screenshot: 'only-on-failure',
    },
});
