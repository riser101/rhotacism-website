// Silence-gate regression: reproduces the iOS starved-tap failure (WebAudio
// recorder tap renders zeros while Silero, on its own AudioContext, hears real
// speech — prod 2026-08-27: 24/24 uploads at RMS −inf) via the ?silentTap=1 QA
// hook, and proves the gate recovers: first blob detected silent → capture
// flips to the raw getUserMedia track → the word is re-recorded with real
// audio and the run proceeds. Fast (~30s), no Gemini spend.

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, '..', 'fixtures', 'lisp-run-20260827');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'manifest.json'), 'utf8'));
const FILES = {};
for (const t of manifest.takes) if (t.file) FILES[t.idx] = t.file;

test('silent recorder tap is detected and capture flips to the raw track', async ({ page }) => {
    test.setTimeout(120_000);

    await page.route('**/__replay-fixtures__/*', route => {
        const name = decodeURIComponent(route.request().url().split('/').pop());
        const p = path.join(FIX_DIR, name);
        if (!fs.existsSync(p)) return route.fulfill({ status: 404, body: 'not found' });
        route.fulfill({ status: 200, contentType: 'audio/webm', body: fs.readFileSync(p) });
    });
    for (const pat of ['**/*posthog.com/**', '**/script.google.com/**',
        '**/*googletagmanager.com/**', '**/*google-analytics.com/**']) {
        await page.route(pat, route => route.abort());
    }

    // Same mic stub as assessment-replay.spec.js: synthesized getUserMedia
    // streams, fixture clip played into every live stream when a take starts.
    await page.addInitScript(({ files }) => {
        const w = window;
        w.__replay = { takes: [], errors: [], plays: [] };
        let ctx = null;
        const dests = [];
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
                w.__replay.plays.push({ idx, f });
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
                setTimeout(() => play(entry.idx), 300);
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
    }, { files: FILES });

    // silentTap=1: the page builds its recorder tap but never connects the mic
    // source to it — the tap emits zeros, exactly the iOS failure.
    await page.goto('/lispspeechclinic/assessment.html?test=1&silentTap=1#skip-login');
    const recordBtn = page.locator('#recordBtn');
    await expect(recordBtn).toBeEnabled({ timeout: 15_000 });
    await recordBtn.click();

    // Gate must trip on the first take and flip to raw capture.
    await page.waitForFunction(() => preferRawCapture === true, null, { timeout: 30_000 })
        .catch(async () => {
            throw new Error('silence gate never tripped. State: ' + await page.evaluate(() =>
                JSON.stringify({ replay: window.__replay, raw: preferRawCapture })).catch(() => 'n/a'));
        });

    // The word is re-recorded on the raw track and the chain proceeds.
    await page.waitForFunction(() => typeof wordRecordings !== 'undefined' && wordRecordings.length >= 3, null, { timeout: 60_000 });

    const state = await page.evaluate(async () => ({
        takes: window.__replay.takes,
        errors: window.__replay.errors,
        accepted: wordRecordings.map(b => b.size),
        firstAudible: await blobHasAudio(wordRecordings[0]),
    }));
    expect(state.errors).toEqual([]);
    // First recorder instance recorded the starved tap → near-empty Opus silence.
    expect(state.takes[0].size, 'first take should be the silent tap').toBeLessThan(5000);
    // Accepted takes are real audio from the raw track.
    for (const [i, size] of state.accepted.entries()) {
        expect(size, `accepted take ${i} too small`).toBeGreaterThan(5000);
    }
    expect(state.firstAudible, 'accepted word 0 blob must contain signal').toBe(true);
    console.log(`silence gate OK — silent tap take ${state.takes[0].size}B discarded, raw-track retakes: ${state.accepted.join(', ')}B`);
});
