// Book-a-call consult card (assessment.html) — layout contract on BOTH views
// (results + inline pricing) across phone / tablet / desktop viewports.
//
// Desktop/tablet: single row — avatar stack, copy, outlined button on the right.
// ≤640px: heads+copy row with a full-width button underneath (mobile design).
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = '/lispspeechclinic/assessment.html';
const baseline = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'lisp-run-20260827', 'analysisResult.json'), 'utf8')
);

const VIEWPORTS = [
    { name: 'phone (iPhone 14)', width: 390, height: 844, stacked: true },
    { name: 'phone landscape', width: 740, height: 390, stacked: false },
    { name: 'tablet portrait (iPad Air)', width: 820, height: 1180, stacked: false },
    { name: 'tablet landscape (iPad Air)', width: 1180, height: 820, stacked: false },
    { name: 'small laptop', width: 1280, height: 800, stacked: false },
    { name: 'desktop', width: 1467, height: 812, stacked: false },
];

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

async function assertCardShape(page, card, stacked) {
    await expect(card).toBeVisible();
    const btn = card.locator('.book-call-btn');
    await expect(btn).toBeVisible();
    await expect(card.locator('.book-call-heads img')).toHaveCount(3);
    const cardBox = await card.boundingBox();
    const btnBox = await btn.boundingBox();
    if (stacked) {
        // Full-width button on its own line below the copy.
        expect(btnBox.width).toBeGreaterThan(cardBox.width * 0.8);
    } else {
        // Row layout: button sits right of the copy, not on its own line.
        expect(btnBox.width).toBeLessThan(cardBox.width * 0.6);
        const copyBox = await card.locator('.book-call-copy').boundingBox();
        expect(btnBox.x).toBeGreaterThan(copyBox.x + copyBox.width - 2);
    }
    // The page never scrolls horizontally because of the card.
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
}

for (const vp of VIEWPORTS) {
    test.describe(`${vp.name} ${vp.width}x${vp.height}`, () => {
        test.use({ viewport: { width: vp.width, height: vp.height } });

        test.beforeEach(async ({ page }) => {
            await page.addInitScript((r) => {
                localStorage.setItem('analysisResult', JSON.stringify(r));
                localStorage.setItem('assessmentCompleted', '1');
                localStorage.setItem('userAuth', JSON.stringify({ email: 'tester@local', id: 'test-skip', provider: 'test' }));
            }, baseline);
            await page.goto(PAGE);
        });

        test('results view: card under Continue, above plans subnote', async ({ page }) => {
            const results = page.locator('#asmtResults');
            await expect(results).toBeVisible();
            const card = results.locator('.book-call-card');
            await card.scrollIntoViewIfNeeded();
            await assertCardShape(page, card, vp.stacked);
            await expect(card.locator('.book-call-title')).toHaveText('Not sure? Walk through your report with our speech coach');
            // Order: Continue CTA above the card, subnote below it.
            const ctaBox = await results.locator('.asmt-results-cta').boundingBox();
            const cardBox = await card.boundingBox();
            expect(cardBox.y).toBeGreaterThan(ctaBox.y);
            // Plans subnote: desktop-only (hidden ≤640px), sits between CTA and card.
            const subnote = results.locator('#asmtPlansSubnote');
            if (vp.stacked) {
                await expect(subnote).toBeHidden();
            } else {
                const noteBox = await subnote.boundingBox();
                expect(noteBox.y).toBeGreaterThan(ctaBox.y);
                expect(noteBox.y).toBeLessThan(cardBox.y);
            }
            // Retake link is gone from the results view entirely.
            await expect(results.locator('.asmt-results-retake')).toHaveCount(0);
        });

        test('pricing view: card between plan CTA and testimonial', async ({ page }) => {
            await openPricing(page);
            const pricing = page.locator('#asmtPricing');
            const card = pricing.locator('.book-call-card');
            await card.scrollIntoViewIfNeeded();
            await assertCardShape(page, card, vp.stacked);
            // Title mirrors the active card's displayed price — currency-agnostic so
            // the same spec passes against prod, where /api/geo localizes prices.
            const expected = await page.evaluate(() => {
                const act = document.querySelector('.asmt-pricing-view .pricing-card.active');
                return 'Not ready to commit ' + (window.lispCurrencySym || '$')
                    + act.querySelector('.price-amount').textContent.trim() + '?';
            });
            await expect(card.locator('.book-call-title')).toHaveText(expected);
            const ctaBox = await pricing.locator('#asmtGlobalCta').boundingBox();
            const cardBox = await card.boundingBox();
            expect(cardBox.y).toBeGreaterThan(ctaBox.y);
        });

        test('book-call handler is wired', async ({ page }) => {
            expect(await page.evaluate(() => typeof window.openBookCall)).toBe('function');
        });

        test('localized pricing rewrites cards, subnote and book-call title', async ({ page }) => {
            await openPricing(page);
            await page.evaluate(() => window.__applyLocalPricing('GBP'));
            const amounts = await page.locator('.asmt-pricing-view .price-amount').allTextContents();
            expect(amounts).toEqual(['79', '199', '349']);
            const symbols = await page.locator('.asmt-pricing-view .price-currency').allTextContents();
            expect(symbols).toEqual(['£', '£', '£']);
            await expect(page.locator('#asmtPricing .book-call-card .book-call-title'))
                .toHaveText('Not ready to commit £349?');
            expect(await page.locator('#asmtPlansSubnote').textContent()).toBe('From £58/month · Cancel anytime');
        });
    });
}
