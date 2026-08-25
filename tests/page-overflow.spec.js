// Horizontal-overflow regression checks for pages that had fixed-width
// desktop layouts leaking into tablet/small-laptop widths.
import { test, expect } from '@playwright/test';

const PAGES = [
    '/lispspeechclinic/retake.html',
    '/lispspeechclinic/lisp-guide.html',
    '/lispspeechclinic/pricing.html',
    '/lispspeechclinic/',
];

const WIDTHS = [390, 768, 820, 1024, 1180, 1280, 1440];

for (const path of PAGES) {
    for (const width of WIDTHS) {
        test(`${path} has no horizontal overflow at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(path);
            const overflow = await page.evaluate(
                () => document.scrollingElement.scrollWidth - window.innerWidth
            );
            expect(overflow).toBeLessThanOrEqual(1);
        });
    }
}
