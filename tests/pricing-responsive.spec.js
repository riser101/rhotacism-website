// Inline pricing view (assessment.html step 4) — responsive layout contract.
//
// The pricing carousel is a one-card-per-screen swipe track on phones; on
// tablet + desktop (>=768px) the track is capped at 600px, the card is
// content-height, and the header+card+CTA cluster is vertically centred.
// These tests pin that contract across phone / tablet / desktop viewports.
import { test, expect } from '@playwright/test';

const PAGE = '/lispspeechclinic/assessment.html';

const VIEWPORTS = [
    { name: 'phone (iPhone 14)', width: 390, height: 844, capped: false },
    { name: 'phone landscape', width: 740, height: 390, capped: false },
    { name: 'tablet portrait (iPad Air)', width: 820, height: 1180, capped: true },
    { name: 'tablet landscape (iPad Air)', width: 1180, height: 820, capped: true },
    { name: 'small laptop', width: 1280, height: 800, capped: true },
    { name: 'desktop', width: 1467, height: 812, capped: true },
];

// The view is display:none behind the assessment flow; drive it the same way
// goToPricing() is reached in production (no recording needed for layout).
async function openPricing(page) {
    await page.evaluate(() => {
        document.querySelectorAll('.assessment-step.active').forEach((e) => e.classList.remove('active'));
        document.getElementById('step4').classList.add('active');
        window.goToPricing();
        const loader = document.querySelector('#step4 .asmt-loader');
        if (loader) loader.style.display = 'none';
    });
    await expect(page.locator('#asmtPricing')).toBeVisible();
}

for (const vp of VIEWPORTS) {
    test.describe(`${vp.name} ${vp.width}x${vp.height}`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height } });

        test.beforeEach(async ({ page }) => {
            await page.goto(PAGE);
            await openPricing(page);
        });

        test('cards are ordered Foundation, Momentum, Mastery', async ({ page }) => {
            const titles = page.locator('.asmt-pricing-view .plan-title');
            await expect(titles).toHaveText([
                'Foundation Program',
                'Momentum Program',
                'Mastery Program',
            ]);
        });

        test('Mastery is selected and shown by default', async ({ page }) => {
            const active = page.locator('.asmt-pricing-view .pricing-card.active');
            await expect(active.locator('.plan-title')).toHaveText('Mastery Program');
            await expect(page.locator('#asmtGlobalCta')).toHaveText('Start 6-month program');
            // The carousel must open snapped to Mastery, not the first card.
            const centred = await page.evaluate(() => {
                const track = document.querySelector('.asmt-pricing-view .pricing-grid');
                const wrap = document.querySelectorAll('.asmt-pricing-view .card-wrap')[2];
                const mid = (el) => el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
                return Math.abs(mid(wrap) - mid(track));
            });
            expect(centred).toBeLessThan(24);
        });

        test('no horizontal page overflow', async ({ page }) => {
            const overflow = await page.evaluate(
                () => document.scrollingElement.scrollWidth - window.innerWidth
            );
            expect(overflow).toBeLessThanOrEqual(0);
        });

        test('card width and height are sane for the viewport', async ({ page }) => {
            const box = await page
                .locator('.asmt-pricing-view .pricing-card.active')
                .boundingBox();
            if (vp.capped) {
                // Tablet/desktop: capped track — the card never spans the panel.
                expect(box.width).toBeLessThanOrEqual(604);
                // Content-height card — no viewport-filling stretch.
                const contentHeight = await page.evaluate(() => {
                    const card = document.querySelector('.asmt-pricing-view .pricing-card.active');
                    let bottom = 0;
                    for (const child of card.children) {
                        bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
                    }
                    return bottom - card.getBoundingClientRect().top;
                });
                expect(box.height - contentHeight).toBeLessThan(80);
            } else {
                // Phone: the card fills the track width (one card per screen).
                const track = await page
                    .locator('.asmt-pricing-view .pricing-grid')
                    .boundingBox();
                expect(box.width).toBeGreaterThan(track.width * 0.9);
            }
        });

        test('review card sits below the CTA; photo-panel note is not duplicated', async ({ page }) => {
            const strip = page.locator('#asmtPricing .testimonial-strip');
            await expect(strip).toBeVisible();
            const stripBox = await strip.boundingBox();
            const ctaBox = await page.locator('#asmtGlobalCta').boundingBox();
            expect(stripBox.y).toBeGreaterThan(ctaBox.y + ctaBox.height);
            await expect(page.locator('#step4 .ob-photo-testimonial')).toBeHidden();
        });

        test('swiping to another card updates selection, dots and CTA', async ({ page }) => {
            await page.evaluate(() => {
                document.querySelector('.asmt-pricing-view .pricing-grid').scrollTo({ left: 0 });
            });
            await expect(
                page.locator('.asmt-pricing-view .pricing-card.active .plan-title')
            ).toHaveText('Foundation Program');
            await expect(page.locator('#asmtGlobalCta')).toHaveText('Start 1-month program');
            await expect(
                page.locator('.asmt-pricing-view .carousel-dots span').first()
            ).toHaveClass('active');
        });
    });
}
