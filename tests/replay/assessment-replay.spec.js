// Assessment replay regression: drives the real assessment page end-to-end by
// feeding the known-good recorded run (tests/fixtures/lisp-run-20260827 — real
// prod takes, desktop Chrome, deliberate word-level lisp + clean sentences)
// through a stubbed mic. Exercises the FULL pipeline: recorder init → Silero
// VAD → MediaRecorder capture → Firebase upload → MFA+Praat prewarm → Gemini →
// part-2 poll, and flags regressions in capture health and the final report.
//
// Run:  npm run test:replay                       (local page, prod backend)
//       REPLAY_BASE_URL=https://... npm run test:replay   (deployed page)
// Local runs upload to recordings/lisp/local-testing-v3 (isLocal path). Remote
// runs would pollute the lispv3 training prefix, so uploads are stubbed out
// unless ALLOW_UPLOADS=1.
//
// NOT part of the default CI suite (see testIgnore in the main configs): it
// takes ~6-10 min and spends real backend/Gemini compute per run.

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, '..', 'fixtures', 'lisp-run-20260827');
const ANALYZE_HOST = 'analyze-lisp-speech-653307587559.us-central1.run.app';

const manifest = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'manifest.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'analysisResult.json'), 'utf8'));

// idx → fixture file. Take 23 (spontaneous) was recovered from the Storage
// bucket, not localStorage, so it's absent from the manifest takes.
const FILES = {};
for (const t of manifest.takes) if (t.file) FILES[t.idx] = t.file;
FILES[23] = '23-tell_me_about_your_weekend.webm';

const N_TAKES = 24; // 17 words + 6 sentences + 1 spontaneous

// Baseline sentinels. Tolerances are deliberately loose — Gemini judgments
// vary run to run; these only trip on real drift (lisp words suddenly clean,
// clean words suddenly flagged, GRI collapse).
const LISP_WORDS = ['sun', 'sock', 'mouse'];        // baseline: Interdental, quality 20
const CLEAN_WORDS = ['pencil', 'music', 'shoe', 'watch', 'jump']; // baseline: Accurate, 85-90

test('replay recorded assessment and check the generated report', async ({ page }) => {
    test.setTimeout(14 * 60_000);
    for (const f of Object.values(FILES)) {
        expect(fs.existsSync(path.join(FIX_DIR, f)), `fixture missing: ${f}`).toBe(true);
    }

    const remote = !!process.env.REPLAY_BASE_URL;
    const blockUploads = remote && process.env.ALLOW_UPLOADS !== '1';

    // Serve fixtures into the page regardless of target origin.
    await page.route('**/__replay-fixtures__/*', route => {
        const name = decodeURIComponent(route.request().url().split('/').pop());
        const p = path.join(FIX_DIR, name);
        if (!fs.existsSync(p)) return route.fulfill({ status: 404, body: 'not found' });
        route.fulfill({ status: 200, contentType: 'audio/webm', body: fs.readFileSync(p) });
    });
    // Keep test runs out of analytics and the leads sheet.
    for (const pat of ['**/*posthog.com/**', '**/script.google.com/**',
        '**/*googletagmanager.com/**', '**/*google-analytics.com/**']) {
        await page.route(pat, route => route.abort());
    }
    // REPLAY_BACKEND_URL=http://localhost:8080 → exercise a LOCAL backend (e.g.
    // `npm start` in gcp-function-lisp with PRAAT_URL pointed at a local Praat)
    // instead of prod: the page's hardcoded prod host is rewritten in flight.
    const backendOverride = process.env.REPLAY_BACKEND_URL;
    if (backendOverride) {
        await page.route(`**/${ANALYZE_HOST}/**`, async route => {
            const url = route.request().url().replace(/^https?:\/\/[^/]+/, backendOverride.replace(/\/$/, ''));
            const resp = await route.fetch({ url });
            await route.fulfill({ response: resp });
        });
    }
    if (blockUploads) {
        // A 403 makes the Storage SDK fail fast; an aborted request is treated as a
        // network blip and retried for up to 10 minutes, which left every upload
        // "pending" and timed out the settle check (2026-09-21).
        await page.route('**/*firebasestorage.googleapis.com/**', route =>
            route.request().method() === 'GET' ? route.continue()
                : route.fulfill({ status: 403, contentType: 'text/plain', body: 'upload blocked by replay harness' }));
    }

    // Watch backend calls so failures point at the right layer.
    const backend = [];
    page.on('response', r => {
        const u = r.url();
        if (u.includes('run.app')) backend.push({ url: u.slice(0, 110), method: r.request().method(), status: r.status() });
    });
    page.on('pageerror', e => backend.push({ pageerror: String(e).slice(0, 200) }));

    // Mic stub + capture instrumentation, installed before any page script.
    await page.addInitScript(({ files }) => {
        const w = window;
        w.__replay = { takes: [], uploads: [], errors: [], plays: [] };
        let ctx = null;
        const dests = [];
        // Real getUserMedia semantics: every call gets its own live stream (the
        // page AND Silero's vad-web both acquire one), stopping one caller's
        // track must not silence the others, and a re-acquire after teardown
        // gets a fresh live stream. Fixture playback feeds ALL live streams.
        const ensure = () => {
            if (!ctx) ctx = new AudioContext({ sampleRate: 48000 });
            const dest = ctx.createMediaStreamDestination();
            dests.push(dest);
            return dest.stream;
        };
        const liveDests = () => dests.filter(d => d.stream.getTracks().some(t => t.readyState === 'live'));
        const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async c => (c && c.audio) ? ensure() : realGUM(c);

        async function play(idx) {
            try {
                if (!ctx) { w.__replay.errors.push('play before getUserMedia'); return; }
                await ctx.resume();
                const f = files[idx];
                if (!f) { w.__replay.errors.push('no fixture for idx ' + idx); return; }
                const ab = await fetch('/__replay-fixtures__/' + encodeURIComponent(f)).then(r => {
                    if (!r.ok) throw new Error('fixture fetch ' + r.status);
                    return r.arrayBuffer();
                });
                const buf = await ctx.decodeAudioData(ab);
                const targets = liveDests();
                if (!targets.length) { w.__replay.errors.push('play ' + idx + ': no live stream'); return; }
                const src = ctx.createBufferSource();
                src.buffer = buf;
                for (const d of targets) src.connect(d);
                src.start();
                w.__replay.plays.push({ idx, f, dur: +buf.duration.toFixed(2), sinks: targets.length });
            } catch (e) { w.__replay.errors.push('play ' + idx + ': ' + String(e)); }
        }

        const Orig = w.MediaRecorder;
        function Cap(stream, opts) {
            const rec = new Orig(stream, opts);
            const chunks = [];
            const entry = { idx: null, size: 0 };
            rec.addEventListener('start', () => {
                try { entry.idx = currentWordIndex; } catch (e) { entry.idx = null; }
                w.__replay.takes.push(entry);
                setTimeout(() => play(entry.idx), 300); // recorder + VAD are live; speak
            });
            rec.addEventListener('dataavailable', e => { if (e.data && e.data.size) chunks.push(e.data); });
            rec.addEventListener('stop', () => setTimeout(() => {
                entry.size = chunks.reduce((s, c) => s + c.size, 0);
            }, 400));
            return rec;
        }
        Cap.prototype = Orig.prototype;
        Object.setPrototypeOf(Cap, Orig);
        w.MediaRecorder = Cap;

        // Count upload outcomes; the page assigns this global at parse time.
        let realUpload = null;
        const wrapped = async function (blob, word, wordIndex) {
            const rec = { wordIndex, size: blob && blob.size, ok: null };
            w.__replay.uploads.push(rec);
            try { const r = await realUpload.apply(this, arguments); rec.ok = true; return r; }
            catch (e) { rec.ok = false; rec.err = String(e).slice(0, 120); throw e; }
        };
        Object.defineProperty(w, 'uploadRecordingToFirebase', {
            configurable: true,
            get: () => (realUpload ? wrapped : undefined),
            set: fn => { realUpload = fn; },
        });
    }, { files: FILES });

    // ?test=1 → client retake gate + server free-once gate bypassed (payload
    // test:true); #skip-login → seeded tester@local identity, straight to recording.
    await page.goto('/lispspeechclinic/assessment.html?test=1&protocol=v1#skip-login'); // protocol=v1: fixtures are v1 takes
    const recordBtn = page.locator('#recordBtn');
    await expect(recordBtn).toBeVisible({ timeout: 15_000 });
    await expect(recordBtn).toBeEnabled({ timeout: 15_000 });

    // First take needs the tap; the rest hands-free chain. This is also where a
    // broken recorder init shows up: stuck on GETTING READY…, no take ever lands.
    await recordBtn.click();
    const dump = () => page.evaluate(() => JSON.stringify({
        replay: window.__replay,
        label: document.getElementById('recordLabel')?.textContent,
    })).catch(() => 'n/a');

    for (let i = 0; i < N_TAKES; i++) {
        if (i === 23) {
            // Free-speech notice interrupts the chain; confirming starts the take.
            await page.locator('#freeSpeechNoticeBtn').click({ timeout: 20_000 });
            // The spontaneous take never auto-stops on silence (people pause while
            // thinking) — after the clip finishes, tap the button (TAP TO FINISH).
            await page.waitForFunction(() => window.__replay.plays.some(p => p.idx === 23), null, { timeout: 20_000 });
            const dur = await page.evaluate(() => window.__replay.plays.find(p => p.idx === 23).dur);
            await page.waitForTimeout((dur + 1.5) * 1000);
            await recordBtn.click();
        }
        const perTake = i >= 17 ? 45_000 : 30_000;
        await page.waitForFunction(
            n => typeof wordRecordings !== 'undefined' && wordRecordings.length >= n,
            i + 1, { timeout: perTake },
        ).catch(async () => {
            throw new Error(`stuck at take ${i} ("${manifest.takes[i]?.word ?? 'spontaneous'}") — recorder/VAD/auto-chain regression. State: ${await dump()}`);
        });
    }

    // ---- Capture health: the "empty recordings in the bucket" class of bug ----
    const rep = await page.evaluate(() => window.__replay);
    expect(rep.errors, 'in-page replay errors').toEqual([]);
    const accepted = await page.evaluate(() => wordRecordings.map(b => b.size));
    expect(accepted.length).toBe(N_TAKES);
    for (const [i, size] of accepted.entries()) {
        expect(size, `take ${i} blob is empty/near-empty (${size}B) — WebM-header-only capture bug`).toBeGreaterThan(5000);
    }
    await page.waitForFunction(
        n => window.__replay.uploads.length >= n && window.__replay.uploads.every(u => u.ok !== null),
        N_TAKES, { timeout: 60_000 },
    ).catch(async () => {
        // Name the stuck upload(s) instead of a bare timeout.
        const st = await page.evaluate(() => window.__replay.uploads.map(u => `${u.wordIndex}:${u.size}B:${u.ok === null ? 'pending' : u.ok ? 'ok' : 'FAIL ' + (u.err || '')}`).join(' | '));
        throw new Error(`uploads not settled after 60 s (${await page.evaluate(() => window.__replay.uploads.length)} of ${N_TAKES}): ${st}`);
    });
    const uploads = await page.evaluate(() => window.__replay.uploads);
    for (const u of uploads) {
        expect(u.size, `upload for take ${u.wordIndex} is empty`).toBeGreaterThan(5000);
        if (!blockUploads) expect(u.ok, `upload for take ${u.wordIndex} failed: ${u.err}`).toBe(true);
    }

    // ---- Survey wizard (4 steps) — real option clicks, then the CTA ----
    await expect(page.locator('#obwCta')).toBeVisible({ timeout: 20_000 });
    const wizStep = async selector => {
        await page.locator(selector).first().click({ timeout: 15_000 });
        await page.locator('#obwCta').click();
    };
    await wizStep('[data-trouble]');
    await wizStep('[data-age="adult"], [data-age]');
    await wizStep('[data-source]');
    await page.locator('[data-gender="male"], [data-gender]').first().click({ timeout: 15_000 });
    await page.locator('#wizPhone').fill('2015550123');
    await page.locator('#obwCta').click(); // wizFinish → Gemini send

    // ---- Wait for the full report (part 1 + deferred part 2) ----
    await page.waitForFunction(() => {
        try {
            const r = JSON.parse(localStorage.getItem('analysisResult') || 'null');
            return !!(r && !r.partial && Array.isArray(r.categories) && r.categories.length >= 4
                && r.categories[3] && r.categories[3].spontaneous
                && (r.categories[3].spontaneous.summary || '').length > 0);
        } catch (e) { return false; }
    }, { timeout: 9 * 60_000 }).catch(async () => {
        throw new Error(`full report never arrived (part 1 or part 2 pipeline regression). Backend calls: ${JSON.stringify(backend.slice(-15))}. State: ${await dump()}`);
    });
    const gate402 = backend.find(b => b.status === 402);
    expect(gate402, '402 from analyze — ?test=1 gate bypass regressed').toBeUndefined();

    const report = await page.evaluate(() => JSON.parse(localStorage.getItem('analysisResult')));
    const outDir = path.join(__dirname, '..', '..', 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'replay-report.json'), JSON.stringify(report, null, 2));

    // ---- Report structure ----
    expect(typeof report.gri).toBe('number');
    const [core, extended, connected, spontaneous] = report.categories;
    expect(core.rows.length, 'core /s/ & /z/ row count').toBe(14);
    expect(extended.rows.length, 'extended sibilants row count').toBe(3);
    expect(connected.rows.length, 'connected speech row count').toBe(6);
    const wordRows = [...core.rows, ...extended.rows];
    for (const bRow of [...baseline.categories[0].rows, ...baseline.categories[1].rows]) {
        const row = wordRows.find(r => r.word === bRow.word);
        expect(row, `word "${bRow.word}" missing from report`).toBeTruthy();
        expect(typeof row.quality, `quality for "${bRow.word}"`).toBe('number');
        expect(row.judgment, `judgment for "${bRow.word}"`).toBeTruthy();
    }
    expect((spontaneous.spontaneous.summary || '').length).toBeGreaterThan(20);

    // ---- Report signal vs baseline (loose, drift-only) ----
    const q = w => wordRows.find(r => r.word === w)?.quality ?? -1;
    const j = w => wordRows.find(r => r.word === w)?.judgment ?? '';
    const lispFlagged = LISP_WORDS.filter(w => j(w) !== 'Accurate' && q(w) <= 70).length;
    const cleanOk = CLEAN_WORDS.filter(w => q(w) >= 70).length;
    const sentenceAvg = connected.rows.reduce((s, r) => s + (r.quality || 0), 0) / connected.rows.length;
    const detail = () => LISP_WORDS.concat(CLEAN_WORDS)
        .map(w => `${w}: ${j(w)}/${q(w)} (baseline ${[...baseline.categories[0].rows, ...baseline.categories[1].rows].find(r => r.word === w).judgment})`).join(', ');

    expect(report.gri, `GRI drifted far from baseline ${baseline.gri}`).toBeGreaterThanOrEqual(45);
    expect(report.gri, `GRI drifted far from baseline ${baseline.gri}`).toBeLessThanOrEqual(95);
    expect(lispFlagged, `deliberate-lisp words no longer flagged — ear/acoustics regression. ${detail()}`).toBeGreaterThanOrEqual(2);
    expect(cleanOk, `clean words now flagged — false-positive regression. ${detail()}`).toBeGreaterThanOrEqual(4);
    expect(sentenceAvg, 'clean sentences now flagged — connected-speech regression').toBeGreaterThanOrEqual(70);

    console.log(`replay OK — GRI ${report.gri} (baseline ${baseline.gri}); lisp sentinels flagged ${lispFlagged}/3, clean sentinels OK ${cleanOk}/5, sentence avg ${sentenceAvg.toFixed(0)}. Full report: test-results/replay-report.json`);
});
