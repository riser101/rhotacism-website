#!/usr/bin/env node
// Camera-signal evaluation: runs the face-video placement check on a stored (or
// local) session video and prints one line per /s/ take, plus the speaker-level
// signal, so vision can be compared with the ear/acoustics verdicts.
//   node eval-vision.js --video recordings/lisp/.../face.webm [--manifest path.json] [--expect clear|lisp] [--frames DIR]
//   node eval-vision.js --local face.webm --marks marks.json [--expect clear] [--frames DIR]
// --video downloads the .webm and its .json manifest with the same ADC the backend
// uses; --local skips the bucket. Rows are synthesised from the manifest marks
// (word, type, position) — no acoustics, so frame instants come from take timing,
// exactly the fallback path production uses when no /s/ window was measured.
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = k => args.includes('--' + k);
(async () => {
  const frames = opt('frames', '');
  if (frames) process.env.PLACEMENT_DEBUG_DIR = path.resolve(frames);
  const expect = opt('expect', '');
  let manifest, videoPath = opt('video', '');
  if (has('local')) {
    process.env.PLACEMENT_LOCAL_VIDEO = path.resolve(opt('local'));
    manifest = JSON.parse(fs.readFileSync(opt('marks'), 'utf8'));
    videoPath = videoPath || 'local/' + path.basename(opt('local'));
  }
  const idx = require('./index.js');
  const { placementCheck } = idx._placement;
  if (!manifest) {
    const admin = require('firebase-admin');
    const bucket = admin.storage().bucket(process.env.FACE_VIDEO_BUCKET || 'rollr-academy.firebasestorage.app');
    const mp = opt('manifest', videoPath.replace(/\.(webm|mp4)$/, '.json'));
    const [buf] = await bucket.file(mp).download();
    manifest = JSON.parse(buf.toString('utf8'));
  }
  const marks = (manifest.marks || []).filter(m => m && m.kept !== false && m.start != null);
  const video = { path: videoPath, mime: manifest.mime || 'video/webm', recorderLatencyMs: manifest.recorderLatencyMs || 150, marks,
    segments: Array.isArray(manifest.segments) ? manifest.segments.map(sg => ({ path: sg.file || sg.path, startMs: sg.startMs, durationMs: sg.durationMs })) : [] };
  const rows = marks.filter(m => (m.type || 'word') !== 'sentence' && !/passage|quickfire|rapid_sentence/.test(m.type || ''))
    .map(m => ({ word: m.word, type: m.type || 'word', position: m.position || '', judgment: 'Accurate', quality: 95 }));
  const t0 = Date.now();
  const res = await placementCheck(video, rows, []);
  if (!res) { console.log('no result'); process.exit(2); }
  console.log('\n%s  takes=%d checked=%d  forward=%d dental=%d normal=%d lateral=%d unclear=%d  controls=%d failed=%d  reliable=%s  signal=%s  %d ms', videoPath.split('/').pop(), marks.length, res.checked, res.forward, res.dental || 0, res.normal, res.lateral || 0, res.unclear, res.controls || 0, res.controlFails || 0, res.reliable, res.signal, Date.now() - t0);
  console.log('token'.padEnd(22), 'cue'.padEnd(9), 'placement'.padEnd(13), 'conf', 'note');
  (res.tokens || []).forEach(t => console.log(String(t.label).slice(0, 21).padEnd(22), String(t.cue).padEnd(9), t.placement.padEnd(13), t.confidence.toFixed(2), t.note));
  if (res.error) console.log('error:', res.error);
  if (expect) {
    const ok = expect === 'clear' ? res.signal !== 'forward' && res.signal !== 'lateral' : /forward|lateral/.test(res.signal);
    console.log(ok ? `PASS (expected ${expect})` : `FAIL (expected ${expect}, camera signal ${res.signal})`);
    process.exit(ok ? 0 : 1);
  }
})().catch(e => { console.error('eval failed:', e.message); process.exit(2); });
