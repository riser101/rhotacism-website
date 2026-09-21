// Book-a-call consult card (assessment.html) — layout contract on BOTH views
// (results + inline pricing) across phone / tablet / desktop viewports.
//
// Phones/tablets (touch): the production card — single row with the outlined button
// on the right, or ≤640px heads+copy row with a full-width button underneath.
// Laptops/desktops (mouse, ≥960px): the results card sits top-right of the report in a
// rail (approved Claude Design, 2026-09-21) — eyebrow, lead, checklist, full-width
// button, next opening, coach heads with the availability note.
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
    { name: 'phone (iPhone 14)', width: 390, height: 844, stacked: true, touch: true },
    { name: 'phone landscape', width: 740, height: 390, stacked: false, touch: true },
    { name: 'tablet portrait (iPad Air)', width: 820, height: 1180, stacked: false, touch: true },
    { name: 'tablet landscape (iPad Air)', width: 1180, height: 820, stacked: false, touch: true },
    { name: 'small laptop', width: 1280, height: 800, stacked: false, rail: true },
    { name: 'desktop', width: 1467, height: 812, stacked: false, rail: true },
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

async function assertCardShape(page, card, stacked, rail) {
    await expect(card).toBeVisible();
    const btn = card.locator('.book-call-btn');
    await expect(btn).toBeVisible();
    await expect(card.locator('.book-call-heads img')).toHaveCount(3);
    const cardBox = await card.boundingBox();
    const btnBox = await btn.boundingBox();
    if (rail) {
        // Desktop rail card: full-width button, eyebrow + checklist + heads note visible.
        expect(btnBox.width).toBeGreaterThan(cardBox.width * 0.8);
        await expect(card.locator('.book-call-eyebrow')).toBeVisible();
        await expect(card.locator('.book-call-checks li')).toHaveCount(3);
        await expect(card.locator('.book-call-heads-note')).toHaveText('3 speech coaches available this week');
    } else if (stacked) {
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
        test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch === true });

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
            await assertCardShape(page, card, vp.stacked, vp.rail);
            // Hidden variant spans (bc-mob / bc-desk) must not leak into the visible title.
            await expect(card.locator('.book-call-title')).toHaveText(
                vp.rail ? 'Walk through your report with a speech coach' : 'Not sure? Walk through your report with our speech coach',
                { useInnerText: true });
            const ctaBox = await results.locator('.asmt-results-cta').boundingBox();
            const cardBox = await card.boundingBox();
            const subnote = results.locator('#asmtPlansSubnote');
            if (vp.rail) {
                // Top-right rail: card starts at the top of the report, right of the content column.
                const resultsBox = await results.boundingBox();
                expect(cardBox.y).toBeLessThan(ctaBox.y);
                expect(cardBox.x).toBeGreaterThan(resultsBox.x + resultsBox.width * 0.5);
                const noteBox = await subnote.boundingBox();
                expect(noteBox.y).toBeGreaterThan(ctaBox.y);
            } else {
                // Order: Continue CTA above the card, subnote below it.
                expect(cardBox.y).toBeGreaterThan(ctaBox.y);
                // Plans subnote: desktop-only (hidden ≤640px), sits between CTA and card.
                if (vp.stacked) {
                    await expect(subnote).toBeHidden();
                } else {
                    const noteBox = await subnote.boundingBox();
                    expect(noteBox.y).toBeGreaterThan(ctaBox.y);
                    expect(noteBox.y).toBeLessThan(cardBox.y);
                }
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
