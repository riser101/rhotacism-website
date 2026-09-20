// Protocol-v2 recording-flow smoke: drives the 29-item v2 list through the real
// page with a stubbed mic (v1 fixture clips as stand-ins — sustained items get a
// short word and rely on the timer, quick-fire/passage on their caps). Stops at
// "all words recorded"; the backend is blocked. Fast (~3 min), no Gemini spend.
//   npx playwright test --config=playwright.replay.config.js tests/replay/v2-flow.spec.js
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, '..', 'fixtures', 'lisp-run-20260827');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'manifest.json'), 'utf8'));
const byWord = {};
for (const t of manifest.takes) if (t.file) byWord[t.word] = t.file;
const PASSAGE = '23-tell_me_about_your_weekend.webm';
// v2 item index → stand-in clip (v2 word order: see TIERS_V2 in assessment.html)
const V2 = ['sun', 'sock', 'pencil', 'bus', 'mouse', 'zoo', 'nose', 'spoon', 'star', 'nest', 'shoe', 'watch', 'jump',
  'bus', 'box',                       // thumb, bath (th-reference stand-ins)
  'nest', 'nest',                     // sss, zzz (timer commits at 3.5 s)
  "Susan's sister keeps six pairs of scissors.", 'The silly snake slid past the sunny sandbox.', // rapid ×2
  'Sam saw seven small sailboats on the sea.', "Susan's sister keeps six pairs of scissors.",
  'The zebra at the zoo has stripes and a buzzing nose.', 'She washed the shiny dishes and brushed the fish.',
  'Sam saw seven small sailboats on the sea.', "Susan's sister keeps six pairs of scissors.", // (fast) re-reads
  'The silly snake slid past the sunny sandbox.', 'Jack chose a giant orange sandwich for lunch.', 'The zebra at the zoo has stripes and a buzzing nose.', // quick-fire ×3
  null];                              // passage
const FILES = {};
V2.forEach((w, i) => { FILES[i] = w == null ? PASSAGE : byWord[w]; });
const N = V2.length; // 29

test('protocol v2 recording flow completes with a stubbed mic', async ({ page }) => {
    test.setTimeout(8 * 60_000);
    for (const f of Object.values(FILES)) expect(fs.existsSync(path.join(FIX_DIR, f)), `fixture missing: ${f}`).toBe(true);

    await page.route('**/__replay-fixtures__/*', route => {
        const name = decodeURIComponent(route.request().url().split('/').pop());
        const p = path.join(FIX_DIR, name);
        if (!fs.existsSync(p)) return route.fulfill({ status: 404, body: 'not found' });
        route.fulfill({ status: 200, contentType: 'audio/webm', body: fs.readFileSync(p) });
    });
    for (const pat of ['**/*posthog.com/**', '**/script.google.com/**', '**/*googletagmanager.com/**', '**/*google-analytics.com/**', '**/*run.app/**']) {
        await page.route(pat, route => route.abort());
    }
    await page.route('**/*firebasestorage.googleapis.com/**', route => route.request().method() === 'GET' ? route.continue() : route.abort());
    page.on('pageerror', e => { throw new Error('page error: ' + String(e).slice(0, 300)); });

    await page.addInitScript(({ files }) => {
        const w = window;
        w.__replay = { takes: [], uploads: [], errors: [], plays: [] };
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
                const ab = await fetch('/__replay-fixtures__/' + encodeURIComponent(f)).then(r => { if (!r.ok) throw new Error('fixture fetch ' + r.status); return r.arrayBuffer(); });
                const buf = await ctx.decodeAudioData(ab);
                const targets = liveDests();
                if (!targets.length) { w.__replay.errors.push('play ' + idx + ': no live stream'); return; }
                const src = ctx.createBufferSource();
                src.buffer = buf;
                for (const d of targets) src.connect(d);
                src.start();
                w.__replay.plays.push({ idx, f, dur: +buf.duration.toFixed(2) });
            } catch (e) { w.__replay.errors.push('play ' + idx + ': ' + String(e)); }
        }
        const Orig = w.MediaRecorder;
        function Cap(stream, opts) {
            const rec = new Orig(stream, opts);
            const entry = { idx: null };
            rec.addEventListener('start', () => {
                try { entry.idx = currentWordIndex; } catch (e) { entry.idx = null; }
                w.__replay.takes.push(entry);
                if (stream.getVideoTracks && stream.getVideoTracks().length) return; // face cam, not the mic
                setTimeout(() => play(entry.idx), 300);
            });
            return rec;
        }
        Cap.prototype = Orig.prototype;
        Object.setPrototypeOf(Cap, Orig);
        Cap.isTypeSupported = Orig.isTypeSupported.bind(Orig);
        w.MediaRecorder = Cap;
        let realUpload = null;
        const wrapped = async function (blob, word, wordIndex) {
            const rec = { wordIndex, size: blob && blob.size, ok: null };
            w.__replay.uploads.push(rec);
            try { const r = await realUpload.apply(this, arguments); rec.ok = true; return r; }
            catch (e) { rec.ok = false; rec.err = String(e).slice(0, 120); throw e; }
        };
        Object.defineProperty(w, 'uploadRecordingToFirebase', { configurable: true, get: () => (realUpload ? wrapped : undefined), set: fn => { realUpload = fn; } });
    }, { files: FILES });

    await page.goto('/lispspeechclinic/assessment.html?test=1#skip-login');
    expect(await page.evaluate(() => TEST_WORDS.length), 'v2 item count').toBe(N);
    expect(await page.evaluate(() => SEG_BOUNDS[SEG_BOUNDS.length - 1].end === TEST_WORDS.length && SEGMENTS.reduce((s, x) => s + x.count, 0) === TEST_WORDS.length), 'SEGMENTS counts sum to the item count').toBe(true);
    const recordBtn = page.locator('#recordBtn');
    await expect(recordBtn).toBeEnabled({ timeout: 15_000 });
    await recordBtn.click();
    const dump = () => page.evaluate(() => JSON.stringify({ replay: window.__replay, label: document.getElementById('recordLabel')?.textContent, live: document.getElementById('liveInstruction')?.textContent, idx: currentWordIndex, isRecording, wordTimedOut })).catch(() => 'n/a');

    const types = await page.evaluate(() => TEST_WORD_META.map(m => m.type || 'word'));
    for (let i = 0; i < N; i++) {
        if (types[i] === 'quickfire' && i === types.indexOf('quickfire')) {
            await page.locator('#freeSpeechNoticeBtn').click({ timeout: 20_000 });
        }
        const perTake = types[i] === 'passage' ? 50_000 : types[i] === 'quickfire' ? 20_000 : 30_000;
        await page.waitForFunction(n => typeof wordRecordings !== 'undefined' && wordRecordings.length >= n, i + 1, { timeout: perTake })
            .catch(async () => { throw new Error(`stuck at take ${i} (${types[i]} "${V2[i] || 'passage'}"). State: ${await dump()}`); });
    }
    const rep = await page.evaluate(() => window.__replay);
    expect(rep.errors, 'in-page replay errors').toEqual([]);
    const sizes = await page.evaluate(() => wordRecordings.map(b => b.size));
    expect(sizes.length).toBe(N);
    sizes.forEach((s, i) => expect(s, `take ${i} blob too small (${s}B)`).toBeGreaterThan(3000));
    await expect(page.locator('#recordLabel')).toHaveText(/ALL WORDS CAPTURED/, { timeout: 10_000 });
    // Probe payload shape the backend expects for the new item types.
    const probes = await page.evaluate(() => buildProbes().map(p => ({ w: p.word, t: p.type, s: p.speed || null, tier: p.tier })));
    expect(probes.filter(p => p.t === 'sustained').length).toBe(2);
    expect(probes.filter(p => p.t === 'rapid').length).toBe(2);
    expect(probes.filter(p => p.t === 'th').length).toBe(2);
    expect(probes.filter(p => p.s === 'fast').length).toBe(2);
    expect(probes.filter(p => p.t === 'quickfire').length).toBe(3);
    expect(probes.filter(p => p.tier === 5).length).toBe(6);
    console.log(`v2 flow OK — ${N} takes, sizes ${Math.min(...sizes)}–${Math.max(...sizes)} B`);
});
