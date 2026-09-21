require('dotenv').config();
const functions = require('@google-cloud/functions-framework');
const cors = require('cors');

// Gemini Pro 3.1 (non-streaming) holds the socket open with no response headers
// while it "thinks" — up to several minutes on combined 40-clip runs. undici's
// default headersTimeout (~300s) aborts the fetch mid-think (UND_ERR_HEADERS_TIMEOUT).
// AbortSignal does NOT override that internal timeout — only a global dispatcher does.
// Raise headers/body timeouts to 10 min so the call survives long thinking budgets.
const { setGlobalDispatcher, Agent } = require('undici');
// setGlobalDispatcher alone did NOT reach Cloud Run's built-in fetch (symbol-interop
// mismatch between npm undici and the runtime's bundled undici) — timeouts still fired
// at the 300s default. Keep the global set as a belt, but pass this same dispatcher
// EXPLICITLY on the Gemini fetch (see callGemini) so the 600s limit is guaranteed.
const geminiDispatcher = new Agent({ headersTimeout: 600000, bodyTimeout: 600000 });
setGlobalDispatcher(geminiDispatcher);

// Firestore (Admin SDK). This backend writes the lisp-users/{uid} record itself so
// it's guaranteed even when the user leaves before the 1–2 min Gemini call returns
// (the browser used to write it and lost it on early exit). NOTE: this function runs
// in the detache-platform GCP project, but Firestore/Firebase lives in rollr-academy
// — so we MUST pin projectId to rollr-academy (firebase-admin otherwise targets the
// project it runs in). The runtime service account needs roles/datastore.user on
// rollr-academy. Overridable via FIRESTORE_PROJECT_ID. Guarded so local dev without
// credentials degrades gracefully instead of crashing the request.
const admin = require('firebase-admin');
let firestore = null;
try {
  if (!admin.apps.length) admin.initializeApp({ projectId: process.env.FIRESTORE_PROJECT_ID || 'rollr-academy' });
  firestore = admin.firestore();
} catch (e) {
  console.error('firebase-admin init failed (records will be skipped):', e.message);
}

const corsOptions = {
  origin: [
    'https://www.topspeech.health',
    'https://topspeech.health',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:5502',
    'http://localhost:5502',
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'http://127.0.0.1:5501',
    'http://localhost:5501',
    // Vercel preview/staging deploys of this project (ephemeral subdomains:
    // rhotacism-website-git-staging-…, per-commit hashes, etc.). Lets the
    // staging frontend reach this backend for the post-login entitlement gate.
    /^https:\/\/rhotacism-website-[a-z0-9-]+\.vercel\.app$/
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
};
const corsMiddleware = cors(corsOptions);

function stripDataUrlPrefix(b64) {
  if (!b64) return '';
  const i = b64.indexOf(',');
  return i >= 0 ? b64.slice(i + 1) : b64;
}

// ---------------------------------------------------------------------------
// Acoustics. Praat service (gcp-function-lisp-praat) locates every sibilant
// itself (MFA-free since 2026-09-20) and measures each window. EVERY rule below
// is relative to the SAME speaker on the SAME microphone — a token's centre of
// gravity vs the speaker's own /s/ median, its low-band leak vs their clean
// tokens, its tonal narrowness — never an absolute Hz norm (the Aug 25 false
// "Severe Interdental" came from absolute norms on uncalibrated mics). Numbers
// never assert a verdict alone: they become per-clip HYPOTHESES the ear
// (Gemini) confirms or rejects, plus a bounded post-hoc cap (fuseAcoustics)
// when the ear called a token clean but the speaker-level pattern says
// otherwise. Speakers with too few usable tokens fall back to ear-only.
const AC_MIN_SNR_DB = 15;           // window rms above the clip noise floor
const AC_MIN_DUR_MS = 40;
const AC_MIN_CONNECTED_DUR_MS = 60;  // sentence windows: skip bursts / /f/ / /th/ slivers
const AC_MIN_CALIB_TOKENS = 3;       // usable strict /s/ word tokens for a speaker median
const AC_FRONTAL_ELO = 0.15;         // E(0.5-4k)/total effect-size floor (clean /s/ ≈ 0.00-0.06)
const AC_FRONTAL_COG_RATIO = 0.85;   // CoG vs the speaker's own /s/ median
const AC_FRONTAL_SIBVOW_DB = -18;    // /s/ level vs the speaker's vowels …
const AC_FRONTAL_ELO_LEVEL = 0.25;   // … only counts with a stronger leak (final clusters are quiet anyway)
const AC_MIN_CONNECTED_CALIB = 6;    // self-calibrate part 2 from its own /s/ tokens when no word median
const AC_FRONTAL_TH_RATIO = 1.15;    // /s/ CoG within 15% of the speaker's own "th" = interdental signature
const AC_MIN_HF_RATIO = 0.3;         // share of energy ≥4 kHz; below this the window is a vowel/nasal tail, not a sibilant
const AC_MIN_EDGE_HZ = 12000;        // mic bandwidth guard: below this, skip the >8 kHz cues (E-hi, whistle)
const AC_LATERAL_KURT = 1.0;
const AC_LATERAL_MAX_SSH = 1.1;
const AC_WHISTLE = { q: 35, promDb: 10, conc: 0.5, minHz: 6000, sustainedConc: 0.9, sustainedNarrowDb: 12, sustainedMs: 1000 };
const AC_WORD_VERDICT_TOKENS = 2;    // ≥2 flagged single-word tokens → speaker-level pattern
const AC_CONNECTED_RATE = 0.25;      // or ≥25% (and ≥3) of usable connected /s/ tokens
const AC_CONNECTED_MIN = 3;
const AC_CAP_QUALITY = 65;           // cap applied when the ear said clean but the pattern disagrees
// AC_CAP_MODE=on lets a speaker-level acoustic pattern rewrite an ear-clean row to
// Distorted/Whistling 65. Default OFF (design-panel rule: acoustics steer the ear,
// lower confidence via the outcome tier, and add notes — they never assert alone).
const AC_CAP_MODE = process.env.AC_CAP_MODE || 'off';
const AC_QUIET_PEAK_DBFS = -30;

function acNum(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function acCog(seg) { return acNum(seg && (seg.center_of_gravity ?? seg.centroid_hz)) || 0; }
function acSegments(a) {
  if (!a || typeof a !== 'object' || a.error) return [];
  const segs = Array.isArray(a.segments) && a.segments.length ? a.segments : [a];
  return segs.filter(s => s && typeof s === 'object');
}
// Usability gate. New service rows carry snr_db (relative); legacy client rows
// (MFA path) only rms — keep the old absolute gate for those.
function acUsable(seg) {
  if (!seg || acCog(seg) <= 0) return false;
  const dur = acNum(seg.duration_ms);
  if (dur != null && dur < AC_MIN_DUR_MS) return false;
  const hf = acNum(seg.hf_ratio);
  if (hf != null && hf < AC_MIN_HF_RATIO) return false;
  const snr = acNum(seg.snr_db);
  if (snr != null) return snr >= AC_MIN_SNR_DB;
  const rms = acNum(seg.rms);
  return rms == null || rms >= 0.004;
}
function acMedian(arr) { const v = arr.slice().sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; }
const AC_SH_WORDS = /^(shoe|watch|jump|fish|chair|bridge|wash|dish|ship|cheese|church|jam|judge|sheep|shop|chip|shirt|witch|jar)$/i;
const AC_Z_WORDS = /^(zoo|music|nose|zebra|lazy|rose|buzz|zip|zero)$/i;
const AC_TH_WORDS = /^(thumb|think|thin|bath|teeth|thick|three|mouth|math|tooth|thank|thing)$/i;
function acLabelForWord(word, type) {
  const w = String(word || '').trim();
  if (type === 'th' || AC_TH_WORDS.test(w)) return 'TH';
  if (type === 'sustained') return /^z/i.test(w) ? 'Z' : 'S';
  if (/^(watch|chair|cheese|church|chip|witch)$/i.test(w)) return 'CH';
  if (/^(jump|bridge|jam|judge|jar)$/i.test(w)) return 'JH';
  if (AC_SH_WORDS.test(w)) return 'SH';
  if (AC_Z_WORDS.test(w)) return 'Z';
  return 'S';
}
// Sentences whose sibilants are ALL /s,z/ (no sh/ch/j) can be scored per token;
// mixed sentences are measured but not rule-scored (label X).
function acSentenceAllS(text) { return !/sh|ch|j|dg|g[ei]/i.test(String(text || '')); }
// Probe types. Single-word-like (one /s/ window, scored as a word token):
// word, sustained, th. Connected-like (many windows, scored per token):
// sentence (normal or speed:'fast'), rapid (e.g. "Mississippi ×3"), passage,
// quickfire (short timed answers).
function acIsConnected(p) { return p && /^(sentence|passage|rapid|quickfire)$/.test(String(p.type || '')); }
function acIsPassageLike(p) { return p && /^(passage|quickfire)$/.test(String(p.type || '')); }

// Compact one-line acoustic summary for ONE measured sibilant window.
function formatSegment(s) {
  const kHz = (hz) => (Number(hz) / 1000).toFixed(1) + 'kHz';
  const num = (x, d = 2) => (x == null ? '?' : Number(x).toFixed(d));
  return [
    `CoG=${kHz(acCog(s))}` + (s.cog_ratio != null ? ` (${num(s.cog_ratio)}× own /s/ median)` : ''),
    s.energy_ratio_low != null ? `E(0.5-4/total)=${num(s.energy_ratio_low)}` : null,
    s.spectral_kurtosis != null ? `kurtosis=${num(s.spectral_kurtosis, 1)}` : null,
    s.rel_to_sh != null ? `s/sh=${num(s.rel_to_sh)}` : null,
    s.th_ratio != null ? `s/th=${num(s.th_ratio)}` : null,
    s.welch_q != null ? `Q=${num(s.welch_q, 0)}@${kHz(s.welch_peak_hz)}` : null,
    s.sib_vowel_db != null ? `level-vs-vowel=${num(s.sib_vowel_db, 0)}dB` : null,
    s.duration_ms != null ? `dur=${Math.round(s.duration_ms)}ms` : null,
    s.snr_db != null ? `snr=${num(s.snr_db, 0)}dB` : (s.rms != null ? `rms=${num(s.rms, 4)}` : null),
    s.ac && s.ac.hypothesis ? `→ ${s.ac.hypothesis}` : null,
  ].filter(Boolean).join(', ');
}

// Acoustic summary attached to each clip so Gemini can reason over the band it
// cannot hear. A word has one window (the loudest); a sentence one line per
// usable /s/ window.
function formatAcoustics(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.error) return `[acoustics unavailable: ${a.error}]`;
  const segs = acSegments(a);
  if (segs.length > 1) {
    const kept = segs.filter(acUsable);
    if (!kept.length) return '[acoustics unavailable: signal too quiet to measure reliably]';
    return '\n' + kept.map((s) =>
      `  · ${s.label || 's'}@${num0(s.start)}s: ${formatSegment(s)}`
    ).join('\n');
  }
  const seg = segs[0] || a;
  if (!acUsable(seg)) return '[acoustics unavailable: signal too quiet to measure reliably]';
  return formatSegment(seg);
}
function num0(x) { return x == null ? '?' : Number(x).toFixed(2); }

// Within-speaker calibration: the RATIO of each /s,z/ CoG to the same session's
// SH/CH/JH CoG cancels the mic's transfer function. Mutates segments in place
// (adds rel_to_sh). Returns the anchor (Hz) or null.
function annotateRelativeCog(probes) {
  const allSegs = [];
  (probes || []).forEach(p => acSegments(p && p.acoustics).forEach(seg => allSegs.push(seg)));
  const anchors = allSegs.filter(seg => /^(SH|ZH|CH|JH)$/i.test(String(seg.label || '')) && acUsable(seg))
    .map(acCog).sort((a, b) => a - b);
  if (!anchors.length) return null;
  const anchor = anchors[Math.floor(anchors.length / 2)];
  allSegs.forEach(seg => {
    if (/^(S|Z)$/i.test(String(seg.label || '')) && acUsable(seg)) {
      seg.rel_to_sh = Math.round((acCog(seg) / anchor) * 100) / 100;
    }
  });
  return anchor;
}

// Per-token rule scores. `profile.sMedianHz` = this speaker's own clean-/s/
// reference; without it (uncalibrated) only the whistle rule can fire.
function acScoreToken(s, profile, sustained) {
  const cog = acCog(s), elo = acNum(s.energy_ratio_low), kurt = acNum(s.spectral_kurtosis);
  const sv = acNum(s.sib_vowel_db), ratio = profile.sMedianHz ? cog / profile.sMedianHz : null;
  if (ratio != null) s.cog_ratio = Math.round(ratio * 100) / 100;
  const thRatio = profile.thMedianHz ? cog / profile.thMedianHz : null;
  if (thRatio != null) s.th_ratio = Math.round(thRatio * 100) / 100;
  const out = { frontal: false, lateral: false, whistle: false, hypothesis: '' };
  const cues = [];
  const onTh = thRatio != null && thRatio <= AC_FRONTAL_TH_RATIO && elo != null && elo >= AC_FRONTAL_ELO;
  if (profile.calibrated && elo != null && elo >= AC_FRONTAL_ELO &&
      ((ratio != null && ratio <= AC_FRONTAL_COG_RATIO) || (elo >= AC_FRONTAL_ELO_LEVEL && sv != null && sv <= AC_FRONTAL_SIBVOW_DB) || onTh)) {
    out.frontal = true;
    cues.push(onTh ? 'frontal cue (this /s/ measures like this speaker\'s own "th")' : 'frontal cue (energy leaking low, centre well under this speaker\'s own /s/)');
  } else if (profile.calibrated && elo != null && elo >= AC_FRONTAL_ELO && kurt != null && kurt <= AC_LATERAL_KURT &&
      (s.rel_to_sh == null || s.rel_to_sh <= AC_LATERAL_MAX_SSH) && (sv == null || sv > -16)) {
    out.lateral = true;
    cues.push('lateral cue (diffuse, smeared spectrum with low-band leak at normal loudness)');
  }
  const q = acNum(s.welch_q), prom = acNum(s.welch_prom_db), conc = acNum(s.peak_conc), pk = acNum(s.welch_peak_hz);
  const dur = acNum(s.duration_ms), nprom = acNum(s.narrow_prom_db);
  const edge = acNum(s.spectral_edge_hz);
  // A "peak" at or beyond the mic's own roll-off is the roll-off, not a whistle.
  const inBand = edge == null || pk == null || pk <= edge - 500;
  if (inBand && q != null && prom != null && conc != null && pk != null &&
      q >= AC_WHISTLE.q && prom >= AC_WHISTLE.promDb && conc >= AC_WHISTLE.conc && pk >= AC_WHISTLE.minHz) {
    out.whistle = true;
    cues.push(`whistle cue (narrow stable tone near ${(pk / 1000).toFixed(1)} kHz inside the /s/)`);
  } else if (sustained && dur != null && dur >= AC_WHISTLE.sustainedMs && conc != null && nprom != null &&
      conc >= AC_WHISTLE.sustainedConc && nprom >= AC_WHISTLE.sustainedNarrowDb) {
    out.whistle = true;
    cues.push(`whistle cue (steady tone near ${((acNum(s.narrow_peak_hz) || pk) / 1000).toFixed(1)} kHz through the sustained /s/)`);
  }
  out.hypothesis = cues.length ? cues.join('; ') : 'clean (measures like this speaker\'s other /s/ sounds)';
  return out;
}

// Speaker-level acoustic profile over one request's probes. Mutates segments
// (rel_to_sh, cog_ratio, ac) and probes (acToken) so the prompt and the
// post-hoc fuse read the same scores. Returns the profile summary.
function acousticProfile(probes, opts) {
  opts = opts || {};
  const profile = {
    calibrated: false, sMedianHz: null, anchorHz: null, coverage: 0, clips: 0,
    usableTokens: 0, flags: { frontal: 0, lateral: 0, whistle: 0, weak: 0 },
    verdicts: [], capture: { minPeakDbfs: null, quiet: false }, notes: []
  };
  const list = (probes || []).filter(p => p && typeof p === 'object');
  profile.clips = list.length;
  list.forEach(p => {
    const a = p.acoustics;
    if (!a || typeof a !== 'object') return;
    const pk = acNum(a.capture && a.capture.peak_dbfs);
    if (pk != null && (profile.capture.minPeakDbfs == null || pk < profile.capture.minPeakDbfs)) profile.capture.minPeakDbfs = pk;
    if (!a.error) profile.coverage++;
  });
  if (profile.capture.minPeakDbfs != null && profile.capture.minPeakDbfs < AC_QUIET_PEAK_DBFS) profile.capture.quiet = true;
  profile.anchorHz = annotateRelativeCog(list);

  // Primary (loudest usable strict) /s/ window per single-word probe.
  const wordTokens = [];
  list.forEach(p => {
    if (acIsConnected(p)) return;
    const segs = acSegments(p.acoustics).filter(s => /^S$/i.test(String(s.label || '')) && acUsable(s));
    const strict = segs.filter(s => s.kind !== 'weak');
    const pick = (strict.length ? strict : segs).sort((x, y) => (acNum(y.rms) || 0) - (acNum(x.rms) || 0))[0];
    if (pick) { p.acToken = pick; wordTokens.push(pick); }
    else if (acLabelForWord(p.word) === 'S' && p.acoustics && typeof p.acoustics === 'object') {
      // An /s/ word with nothing measurable while the capture itself is fine.
      p.acWeak = true;
    }
  });
  // The speaker's OWN "th" (reference words) = what an interdental /s/ would
  // measure like on this mic. An /s/ that lands on it is the strongest frontal cue.
  const thCogs = [];
  list.forEach(p => { if (acIsConnected(p)) return; acSegments(p.acoustics).forEach(sg => { if (/^TH$/i.test(String(sg.label || '')) && acUsable(sg)) thCogs.push(acCog(sg)); }); });
  if (thCogs.length) profile.thMedianHz = Math.round(acMedian(thCogs));
  const cogs = wordTokens.filter(s => s.kind !== 'weak').map(acCog);
  if (cogs.length >= AC_MIN_CALIB_TOKENS) { profile.calibrated = true; profile.sMedianHz = Math.round(acMedian(cogs)); }
  else if (acNum(opts.sMedianHz) > 0) { profile.calibrated = true; profile.sMedianHz = Math.round(acNum(opts.sMedianHz)); profile.notes.push('calibrated from part 1'); }
  else {
    // Part 2 arrives without the single words: calibrate on the connected /s/
    // tokens themselves (a consistent lisp is caught by part 1; this catches the
    // inconsistent one, where most tokens are clean and a few are not).
    const connCogs = [];
    list.forEach(p => { if (!acIsConnected(p)) return; acSegments(p.acoustics).forEach(s => {
      if (/^S$/i.test(String(s.label || '')) && acUsable(s) && (acNum(s.duration_ms) == null || acNum(s.duration_ms) >= AC_MIN_CONNECTED_DUR_MS)) connCogs.push(acCog(s)); }); });
    if (connCogs.length >= AC_MIN_CONNECTED_CALIB) { profile.calibrated = true; profile.sMedianHz = Math.round(acMedian(connCogs)); profile.notes.push('calibrated from connected speech'); }
  }
  const sustainedProbe = (p) => /^(sustained|sss)/i.test(String(p.type || '')) || /^s{3,}$/i.test(String(p.word || ''));

  // Score word tokens.
  let wordFlags = { frontal: 0, lateral: 0, whistle: 0 };
  list.forEach(p => {
    if (!p.acToken) return;
    const ac = acScoreToken(p.acToken, profile, sustainedProbe(p));
    p.acToken.ac = ac;
    if (ac.frontal) wordFlags.frontal++;
    if (ac.lateral) wordFlags.lateral++;
    if (ac.whistle) wordFlags.whistle++;
    profile.usableTokens++;
  });
  // Weak/absent /s/ only counts once the speaker is calibrated (otherwise it is
  // usually the capture, not the speaker).
  list.forEach(p => { if (p.acWeak && profile.calibrated) profile.flags.weak++; else if (p.acWeak) p.acWeak = false; });

  // Connected tokens: every usable all-/s/ window ≥ 60 ms.
  let connTotal = 0, connFlags = { frontal: 0, lateral: 0, whistle: 0 };
  list.forEach(p => {
    if (!acIsConnected(p)) return;
    acSegments(p.acoustics).forEach(s => {
      if (!/^S$/i.test(String(s.label || '')) || !acUsable(s)) return;
      const dur = acNum(s.duration_ms);
      if (dur != null && dur < AC_MIN_CONNECTED_DUR_MS) return;
      const ac = acScoreToken(s, profile, false);
      s.ac = ac; connTotal++; profile.usableTokens++;
      if (ac.frontal) connFlags.frontal++;
      if (ac.lateral) connFlags.lateral++;
      if (ac.whistle) connFlags.whistle++;
    });
  });
  ['frontal', 'lateral', 'whistle'].forEach(t => {
    profile.flags[t] = wordFlags[t] + connFlags[t];
    const wordHit = wordFlags[t] >= AC_WORD_VERDICT_TOKENS;
    // Sentence windows are labelled by a text heuristic (which sibilant is
    // which is a guess), so place-of-articulation cues from connected speech
    // corroborate a word-level cue rather than carry a verdict alone. A whistle
    // is a tonal event that does not depend on the label.
    const connHit = connTotal >= AC_CONNECTED_MIN && connFlags[t] >= AC_CONNECTED_MIN && connFlags[t] / connTotal >= AC_CONNECTED_RATE
      && (t === 'whistle' || wordFlags[t] >= 1 || acNum(opts.wordFlags && opts.wordFlags[t]) >= 1);
    if (wordHit || connHit) profile.verdicts.push(t);
  });
  if (profile.flags.weak >= AC_WORD_VERDICT_TOKENS) profile.verdicts.push('weak');
  profile.connectedTokens = connTotal;
  // Tell the ear whether a cue is part of a speaker-level pattern or a one-off
  // (one odd token on an otherwise clean speaker is usually the capture).
  const nWords = wordTokens.length;
  const decorate = (ac) => {
    if (!ac) return;
    const t = ['frontal', 'lateral', 'whistle'].find(k => ac[k]);
    if (!t) return;
    const inPattern = profile.verdicts.includes(t);
    const n = wordFlags[t] + connFlags[t], m = nWords + connTotal;
    ac.hypothesis = (inPattern ? `PATTERN (${n} of ${m} measured /s/): ` : t === 'whistle' ? `isolated (${n} of ${m} measured /s/): ` : `isolated (only ${n} of ${m} measured /s/, the rest clean): `) + ac.hypothesis;
  };
  list.forEach(p => { if (p.acToken) decorate(p.acToken.ac); if (acIsConnected(p)) acSegments(p.acoustics).forEach(s => decorate(s.ac)); });
  if (!profile.calibrated) profile.notes.push(`uncalibrated (${cogs.length} usable /s/ tokens)`);
  if (profile.capture.quiet) profile.notes.push(`quiet capture (peak ${profile.capture.minPeakDbfs} dBFS)`);
  return profile;
}

// Bounded post-hoc fuse. Only when the SPEAKER-LEVEL pattern exists (≥2 flagged
// word tokens or ≥25% of connected tokens) and the ear still called a flagged
// token clean: cap the quality and name the measurement in plain words. Never
// raises severity, never rewrites a judgment the ear already gave.
const AC_FUSE_NOTE = {
  frontal: 'Measurement shows the tongue sitting further forward than on your other s-sounds — worth checking live.',
  lateral: 'Measurement shows air spreading sideways on this s-sound — worth checking live.',
  whistle: 'A faint high whistle was measured on this s-sound, above what the listener can hear — typical of a whistling lisp.',
  weak: 'The s-sound here was too faint to measure against your other words.'
};
function fuseAcoustics(rows, probes, profile) {
  if (!profile || !profile.verdicts.length || !Array.isArray(rows)) return 0;
  let capped = 0;
  const byKey = new Map();
  (probes || []).forEach(p => { if (p && p.word != null) byKey.set(String(p.word).trim().toLowerCase(), p); });
  // Rows come back in prompt order; when counts match, order is the reliable
  // join (duplicate words, shortened sentences). Otherwise fall back to the word.
  const byOrder = Array.isArray(probes) && probes.length === rows.length;
  rows.forEach((row, i) => {
    const key = String(row.word ?? row.sentence ?? '').trim().toLowerCase();
    let p = byOrder ? probes[i] : byKey.get(key);
    if (!p && row.sentence) { // model may shorten sentences — prefix match
      for (const [k, v] of byKey) { if (acIsConnected(v) && (k.startsWith(key.replace(/…$/, '').slice(0, 20)) || key.startsWith(k.slice(0, 20)))) { p = v; break; } }
    }
    if (!p) return;
    // Window of the measured /s/ (seconds into the clip) — lets the face-video
    // pass pull frames at the right instant without re-running acoustics.
    if (p.acToken && p.acToken.start != null) { row.s_start = p.acToken.start; row.s_end = p.acToken.end; }
    if (acIsConnected(p)) {
      const flagged = acSegments(p.acoustics).filter(sg => sg.ac && (sg.ac.frontal || sg.ac.lateral || sg.ac.whistle))
        .map(sg => ({ start: sg.start, end: sg.end, type: sg.ac.frontal ? 'frontal' : sg.ac.lateral ? 'lateral' : 'whistle' }));
      if (flagged.length) row.s_windows = flagged.slice(0, 6);
    }
    const types = new Set();
    if (p.acToken && p.acToken.ac) ['frontal', 'lateral', 'whistle'].forEach(t => { if (p.acToken.ac[t]) types.add(t); });
    if (p.acWeak) types.add('weak');
    if (acIsConnected(p)) acSegments(p.acoustics).forEach(s => { if (s.ac) ['frontal', 'lateral', 'whistle'].forEach(t => { if (s.ac[t]) types.add(t); }); });
    const hit = profile.verdicts.find(t => types.has(t));
    if (!hit) {
      // An isolated measured whistle is a real acoustic event (not mic colour):
      // name it without touching the verdict, so the reader and the rep see it.
      if (types.has('whistle') && !/whistl/i.test(String(row.observation || row.mistakes || ''))) {
        const note = 'A faint high whistle was measured on one s-sound here — the kind that shows up on fast or repeated /s/ like "Mississippi".';
        row.acoustic = 'whistle-isolated';
        if (row.observation != null) row.observation = `${row.observation} ${note}`.trim();
        else if (row.mistakes != null) row.mistakes = (/^none/i.test(row.mistakes) ? note : `${row.mistakes} ${note}`).trim();
      }
      return;
    }
    row.acoustic = hit;
    const clean = !row.judgment || /^accurate$/i.test(row.judgment);
    if (clean && (Number(row.quality) || 0) > AC_CAP_QUALITY) {
      const note = AC_FUSE_NOTE[hit];
      if (row.observation != null && !row.observation.includes(note)) row.observation = `${row.observation} ${note}`.trim();
      else if (row.mistakes != null && !row.mistakes.includes(note)) row.mistakes = (/^none/i.test(row.mistakes) ? note : `${row.mistakes} ${note}`).trim();
      if (AC_CAP_MODE === 'on') {
        row.quality = AC_CAP_QUALITY;
        row.judgment = hit === 'whistle' ? 'Whistling' : 'Distorted';
        capped++;
      } else {
        row.acoustic_disagrees = true; // ear clean, speaker-level pattern present → outcome tier handles it
      }
    }
  });
  return capped;
}

// Compact, persistable/loggable view of a profile (no per-token data).
function acousticSummary(profile, capped) {
  if (!profile) return null;
  return {
    calibrated: profile.calibrated, sMedianHz: profile.sMedianHz, anchorHz: profile.anchorHz, thMedianHz: profile.thMedianHz || null,
    coverage: profile.coverage, clips: profile.clips, usableTokens: profile.usableTokens,
    connectedTokens: profile.connectedTokens || 0, flags: profile.flags, verdicts: profile.verdicts,
    capture: profile.capture, notes: profile.notes, capped: capped || 0
  };
}

// Interpretation guide injected once per prompt when at least one clip carries
// measurements. Ear-primary; the hypotheses steer WHERE to listen again.
const ACOUSTIC_GUIDE = `## Acoustic measurements (Praat, 48 kHz recording, self-calibrated)
Each clip below carries a [Praat acoustics] line. Every number is RELATIVE to this same speaker on this same microphone (their own /s/ median, their own "sh", their own vowels) — there are no absolute norms, so microphone colour cancels out. Your audio hearing rolls off near 8 kHz; the measurements cover 0.5–16 kHz.
Method: listen to the clip first, then read its "→ hypothesis" and listen AGAIN for that specific quality. Judge every clip on its own line: a cue on one clip is not evidence about another clip, and a clip marked "clean" is judged by ear alone.
- "frontal cue": this /s/ leaks energy below 4 kHz and its centre sits well under this speaker's own /s/ median — the signature of the tongue too far forward (interdental or dentalized). Listen again for a th-like, dull or muffled /s/. If you hear even a subtle version, mark Interdental or Dentalized with quality 25–60 — do not call it Accurate. Only if the /s/ is clearly crisp on a second listen, keep Accurate.
- "lateral cue": smeared, diffuse spectrum with low-band leak at normal loudness — air escaping over the sides of the tongue. Listen again for a slushy, wet /s/.
- "whistle cue": a narrow, steady tone above 6 kHz inside the /s/ noise — a whistling /s/. It may sit above your hearing range. If you hear ANY whistle or over-sharp, piercing edge, mark Whistling (quality 40–65); if not, keep your judgment but say in the Observation that a faint high whistle was measured.
- "clean": this /s/ measures like the speaker's other /s/ sounds. You remain the judge, but a distortion here must be clearly audible before you mark it.
- "PATTERN" prefix: the same cue appears on several of this speaker's /s/ sounds — treat it as real unless the clip is clearly crisp. "isolated" prefix: only this token measures oddly while the rest are clean — usually the recording, not the speaker; only mark it if you can hear it.
- Missing line: the /s/ was too faint or short to measure — judge by ear alone.
Fields: CoG (centre of gravity and its ratio to this speaker's /s/ median; ≤0.85 is a frontal cue), E(0.5-4/total) (low-band leak; clean /s/ ≈ 0.00–0.06, ≥0.15 is a cue), kurtosis (peakedness; ≤1 is diffuse), s/sh (CoG vs their own sh/ch/j; ≈1.0 or below supports frontal), s/th (CoG vs their own "th" reference words; ≤1.15 = the /s/ sits where their th sits), Q (tonal narrowness; ≥35 whistle-like), level-vs-vowel, dur, snr.
Never transcribe a substitution you did not hear. Never mention numbers or technical terms in the Observation.`;

function buildLispPrompt(words, speakerContext) {
  // Acoustics are optional (client ships ear-only since 2026-08-26); only inject
  // the Praat interpretation guide when at least one clip actually carries numbers.
  const hasAcoustics = (words || []).some(w => w && w.acoustics && typeof w.acoustics === 'object' && !w.acoustics.error);
  const tag = (w) => w.type === 'sustained' ? 'sustained ~3 s' : w.type === 'th' ? 'th-reference' : w.type === 'rapid' ? 'rapid ×3' : (w.position || '');
  const wordList = words.map((w, i) => `${i + 1}. ${w.word}${tag(w) ? ' (' + tag(w) + ')' : ''}`).join(', ');
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';
  const has = (t) => (words || []).some(w => w && w.type === t);
  const elicitation = (has('sustained') || has('th') || has('rapid')) ? `

Special items in this list:${has('sustained') ? `
- "sustained ~3 s": the patient holds a long "sss" (or "zzz") for about three seconds. Judge steadiness and quality across the whole hold — a whistle, a wet/slushy leak, or a th-like dullness is easiest to hear here. Heard = "sss" / "zzz" (or what you actually hear).` : ''}${has('th') ? `
- "th-reference": ordinary words that really contain a "th" sound (thumb, bath…). They are NOT /s/ words. Mark Accurate with quality 90+ when the "th" is normal; use them as the reference for what THIS speaker's tongue-between-teeth sound is like, and compare their /s/ words against it. Never mark a th-reference word as a lisp because it sounds like "th".` : ''}${has('rapid') ? `
- "rapid ×3": a word repeated three times as fast as possible (e.g. Mississippi). Judge whether the /s/ sounds stay clean under speed — a lisp that only appears here is real and should be marked (usually Quality 40–65).` : ''}` : '';

  return `You are a speech-language pathologist conducting a sigmatism (lisp) assessment. The patient said ${words.length} items in sequence: ${wordList}.${elicitation}

Speaker context (use this to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType}

Account for regional accent and voice type. Some dialects produce a softer /s/ — do NOT penalise that if it matches the dialect's expected production.

You are provided with per-word audio clips in order. Judge as an experienced clinician: listen BY EAR${hasAcoustics ? ' and cross-check the acoustic measurements below' : ''}. For each /s/ and /z/, listen for: crisp and well-placed vs. slipping toward "th" (interdental), slushy/sideways airflow (lateral), muffled/dentalized, or whistling. Trust your trained ear${hasAcoustics ? '; the measurements below tell you WHERE to listen again and what to listen for — a cue you cannot confirm on a careful second listen stays Accurate, a cue you can hear even subtly does not' : ''}.
${hasAcoustics ? '\n' + ACOUSTIC_GUIDE + '\n' : ''}
## Output format
Return a single markdown table with exactly ${words.length} rows (one per word, in the listed order) and these columns:
| Word | Position | Heard | Judgment | Quality | Observation |

   - Word: The target word (or item) exactly as listed
   - Position: initial / medial / final (or the item tag: sustained / th-reference / rapid)
   - Heard: Exact transcription of what you heard. If the /s/ is clean and crisp, write the target word as-is.
   - Judgment: Accurate / Interdental / Lateral / Dentalized / Palatal / Whistling / Distorted / Omitted
   - Quality: /s/ sound quality score 0-100 (100 = perfect crisp /s/, 0 = no /s/ at all). Clean productions should score 85+.
   - Observation: Brief clinical note (10-15 words)

Only mark a distortion when you can clearly hear it. When the audio sounds clean and the /s/ is crisp, mark Accurate.

If a clip is silent or you do not actually hear the word, mark "—" Heard, "Omitted" Judgment, 0 Quality — never Accurate.

- Do NOT output a clarity score or summary — only the table.
- Respond with ONLY the markdown table. No preamble, no commentary.
- IMPORTANT: Observations must be plain-language clinical notes for a layperson. Do NOT use technical terms like FFT, Hz, formant, spectrogram, phoneme, sibilant band, audio override, etc. Describe what was heard in everyday words.`;
}

// Simple connected-speech prompt. No FFT, no transcription — just listen and
// tell the patient WHERE the lisp showed up in each sentence.
function buildSentencePrompt(words, speakerContext) {
  const hasAcoustics = (words || []).some(w => w && w.acoustics && typeof w.acoustics === 'object' && !w.acoustics.error);
  const sentenceList = words.map((w, i) => `${i + 1}. "${w.word}"`).join('\n');
  const hasFast = (words || []).some(w => w && w.speed === 'fast');
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';

  return `You are a speech-language pathologist assessing connected speech for a sigmatism (lisp). The patient read these sentences aloud — one audio clip each, in this order:
${sentenceList}
${hasFast ? `
Sentences ending in "(fast)" were read a second time as quickly as possible, under a countdown. Compare each fast reading with the normal reading of the same sentence: a distortion that appears only at speed is a real, mild lisp — mark it (Quality 45–70) and say which words slipped. Do not penalise mere rushing, dropped word endings or breathlessness.
` : ''}
Speaker context (use to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType}

Listen to each clip as a whole. Focus on the sibilant sounds: /s/, /z/, "sh", "ch", "j". Do NOT transcribe the sentence. Judge how clear and natural the sibilants are in running speech, allowing for the speaker's regional accent. Do NOT penalise a softer /s/ if it matches the dialect.
${hasAcoustics ? '\n' + ACOUSTIC_GUIDE + '\nFor sentences the [Praat acoustics] block lists one line per measured /s/ with its time offset — use the offsets to find WHERE to listen again.\n' : ''}
## Output format
Return a single markdown table with exactly ${words.length} rows (one per sentence, in the listed order) and these columns:
| Sentence | Judgment | Quality | Mistakes |

   - Sentence: the target sentence exactly as listed, including a trailing "(fast)" where present
   - Judgment: Accurate / Interdental / Lateral / Dentalized / Palatal / Whistling / Distorted. If you hear more than one distortion type, judge by the most dominant one — never write "Mixed".
   - Quality: overall sibilant clarity for the whole sentence, 0-100 (100 = every sibilant crisp, clean speech should score 85+)
   - Mistakes: plain-language note of WHERE the lisp showed up — name the specific words or sounds the patient struggled with (e.g. "the 's' in 'sells' and 'seashells' sounded slushy"). If the sentence is clean, write "None — all sounds clear".

If a clip is silent or you do not actually hear the sentence, mark "Omitted" Judgment, 0 Quality — never Accurate.

Respond with ONLY the markdown table. No preamble, no commentary.
IMPORTANT: Use everyday language. No technical terms (no Hz, FFT, formant, spectrogram, phoneme, sibilant band).`;
}

// Spontaneous (free-speech monologue) prompt. Highest ecological validity:
// the patient speaks unscripted, so sibilant control reflects everyday speech.
// This is FLAGGED QUALITATIVELY — no per-word scoring, no numeric quality.
function buildSpontaneousPrompt(speakerContext, passageProbes) {
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';
  const quick = (passageProbes || []).filter(p => p && p.type === 'quickfire');
  const intro = quick.length
    ? `The patient answered ${quick.length} rapid-fire question${quick.length > 1 ? 's' : ''} (${quick.map(p => `"${p.word}"`).join(', ')}) with a visible countdown — a few seconds each, no time to prepare. Speaking under time pressure is where a mild or well-hidden lisp shows, so treat these clips as the most revealing sample${(passageProbes || []).length > quick.length ? ', alongside the free monologue' : ''}.`
    : `The patient was given an open prompt ("Tell me about your weekend" or "Describe your favourite meal") and spoke freely for roughly 30–60 seconds. This unscripted monologue is the highest-validity sample because it reflects how the patient's sibilants hold up in real, everyday conversation rather than careful word reading.`;

  return `You are a speech-language pathologist reviewing a SPONTANEOUS speech sample for a sigmatism (lisp). ${intro}

Speaker context (use to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType}

Listen to the whole clip. Focus ONLY on the sibilant sounds in running speech: /s/, /z/, "sh", "ch", "j". Do NOT transcribe what they said. Do NOT score individual words. Allow for the speaker's regional accent and natural conversational reductions — do NOT penalise a softer /s/ if it matches the dialect, and do NOT flag normal filler, pauses, or "um".

Your job is to FLAG SIBILANT ERRORS QUALITATIVELY: note whether a lisp pattern shows up in natural speech, what type it sounds like (e.g. interdental "th"-like /s/, lateral/slushy /s/, dentalized), how often and how consistently it appears, and whether it is better or worse than careful reading. If the sibilants are clean throughout, say so plainly.

## Output format
Return ONLY a markdown section, no table, in this exact shape:

### SPONTANEOUS ANALYSIS
**Summary:** <2–3 plain-language sentences describing overall sibilant control in natural speech, and the dominant lisp type if any.>
- <qualitative flag 1 — a specific moment or recurring pattern, e.g. "the 's' sounded slushy when speaking quickly">
- <qualitative flag 2>
- <qualitative flag 3 (only if present)>

If speech is clean, give the Summary and a single bullet "- No clear lisp in natural speech — sibilants stayed crisp."
IMPORTANT: Use everyday language for a layperson. No technical terms (no Hz, FFT, formant, spectrogram, phoneme, sibilant band). No numeric scores anywhere.`;
}

// One Gemini round-trip. Caller supplies the prompt + audio parts.
// Retries on 5xx (transient Google-side INTERNAL errors) with backoff.
async function callGemini(parts, attempt = 1) {
  const MAX_ATTEMPTS = 1; // fail fast — client drives retries with fresh connections (avoids one long-held socket dying on mobile)
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.0,
      // Output budget is shared with the model's internal "thinking" tokens.
      // Pro 3.1 thinks heavy (~30k on 72 clips); give thinking a wide ceiling
      // AND leave room for the full table so it never truncates.
      maxOutputTokens: 64000,
      thinkingConfig: { thinkingBudget: 40000 }
    }
  };

  console.log(`🤖 Sending request to Gemini...${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ''}`);
  const geminiT0 = Date.now();
  let resp;
  const geminiReq = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    try {
      resp = await fetch(geminiUrl, { ...geminiReq, dispatcher: geminiDispatcher }); // explicit — overrides built-in 300s headersTimeout
    } catch (dispErr) {
      // The bundled undici Agent is not accepted by every Node's built-in fetch
      // (Node 24+: "invalid onError method"). Fall back to the default dispatcher
      // rather than failing the whole report; the 300 s default still covers a
      // normal Gemini round-trip.
      const msg = String((dispErr && dispErr.cause && dispErr.cause.message) || (dispErr && dispErr.message) || '');
      if (!/onError|dispatcher|InvalidArgument/i.test(msg)) throw dispErr;
      console.warn('⚠️ undici dispatcher rejected by this runtime — retrying Gemini with the default fetch dispatcher');
      resp = await fetch(geminiUrl, geminiReq);
    }
  } catch (netErr) {
    // Network/transport failure — retry as transient.
    if (attempt < MAX_ATTEMPTS) {
      const delay = 1000 * attempt;
      console.warn(`⚠️ Gemini fetch failed (${netErr.message}), retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return callGemini(parts, attempt + 1);
    }
    throw netErr;
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('❌ Gemini API error:', errText);
    // 5xx = Google-side transient; back off and retry.
    if (resp.status >= 500 && attempt < MAX_ATTEMPTS) {
      const delay = 1000 * attempt;
      console.warn(`⚠️ Gemini ${resp.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, delay));
      return callGemini(parts, attempt + 1);
    }
    throw new Error(`Gemini API error: ${resp.status} - ${errText}`);
  }
  const data = await resp.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Empty Gemini response');

  const usage = data?.usageMetadata || {};
  const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
  const promptTokens = usage.promptTokenCount || 0;
  const thinkingTokens = usage.thoughtsTokenCount || 0;        // model's internal reasoning
  const outputTokens = usage.candidatesTokenCount || 0;        // visible answer
  const totalTokens = usage.totalTokenCount || (promptTokens + thinkingTokens + outputTokens);

  // Per-modality input split (audio is priced higher than text).
  const inputByModality = {};
  (usage.promptTokensDetails || []).forEach(d => { inputByModality[d.modality || 'UNKNOWN'] = d.tokenCount || 0; });
  const audioInput = inputByModality.AUDIO || 0;
  const textInput = inputByModality.TEXT || 0;
  const otherInput = promptTokens - audioInput - textInput;

  // Standard tier paid pricing, USD per 1M tokens (gemini-3-flash-preview).
  const RATE = { textIn: 0.50, audioIn: 1.00, output: 3.00 };
  const inputCost = (textInput * RATE.textIn + audioInput * RATE.audioIn + Math.max(0, otherInput) * RATE.textIn) / 1e6;
  const outputCost = ((thinkingTokens + outputTokens) * RATE.output) / 1e6;
  const reportCost = inputCost + outputCost;

  console.log(`📊 Tokens — input: ${promptTokens} (audio: ${audioInput}, text: ${textInput}${otherInput ? ', other: ' + otherInput : ''}), thinking: ${thinkingTokens}, output: ${outputTokens}, total: ${totalTokens}`);
  console.log(`🏁 finishReason: ${finishReason}${finishReason === 'MAX_TOKENS' ? '  ⚠️ TRUNCATED — output budget exhausted' : ''}`);
  console.log(`💰 Cost — input: $${inputCost.toFixed(5)}, output: $${outputCost.toFixed(5)}, total: $${reportCost.toFixed(5)}/report  (≈ $${(reportCost * 1000).toFixed(2)} / 1k reports)`);
  console.log(`✅ Gemini analysis completed in ${Date.now() - geminiT0} ms`);
  // Full model output — so failed parses / odd scores are debuggable in Cloud Logging.
  console.log('📄 Gemini raw response:\n' + rawText);
  return { rawText, usage: { promptTokens, audioInput, textInput, thinkingTokens, outputTokens, totalTokens, finishReason, reportCost } };
}

// Build [prompt, clip, clip, …] parts for a set of probes.
function buildAudioParts(prompt, words) {
  const parts = [{ text: prompt }];
  words.forEach((w, i) => {
    const b64 = stripDataUrlPrefix(w.audio_base64);
    if (!b64) return;
    const acoustics = formatAcoustics(w.acoustics);
    let header = `\n--- Clip ${i + 1}: "${w.word}" (${w.position || '?'}) ---`;
    if (acoustics) header += `\n[Praat acoustics] ${acoustics}`;
    parts.push({ text: header });
    // iOS Safari sends audio/mp4, everyone else audio/webm. Trust the client's
    // reported container so Gemini decodes it correctly instead of assuming webm.
    const mimeType = (w.mime && /^audio\//.test(w.mime)) ? w.mime : 'audio/webm';
    parts.push({ inline_data: { mime_type: mimeType, data: b64 } });
  });
  return parts;
}

// Server-side acoustics: POST the clips that arrived without measurements to
// the Praat service (it locates the sibilants itself). Fail-open: on any error
// the request continues ear-only and the coverage log says so. Hints tell the
// service which sibilant each word carries (S/Z/SH/CH/JH) and whether a
// sentence's sibilants are all /s,z/ (then its windows can be rule-scored).
const PRAAT_URL = process.env.PRAAT_URL || 'https://extract-sibilant-metrics-653307587559.us-central1.run.app';
const PRAAT_TIMEOUT_MS = Number(process.env.PRAAT_TIMEOUT_MS) || 25000; // warm ≈ 5–8 s; budget keeps part 1 < 60 s
async function ensureAcoustics(probes) {
  if (process.env.ACOUSTICS_SERVER === '0') return;
  const need = (probes || []).filter(p => p && p.audio_base64 &&
    !(p.acoustics && typeof p.acoustics === 'object' && !p.acoustics.error && acSegments(p.acoustics).length));
  if (!need.length) return;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRAAT_TIMEOUT_MS);
  try {
    const body = { words: need.map(p => {
      const connected = acIsConnected(p);
      const allS = connected && ((p.type === 'sentence' && acSentenceAllS(p.word)) || p.type === 'rapid');
      return {
        word: p.word, position: p.position || '', audio_base64: stripDataUrlPrefix(p.audio_base64),
        label: connected ? (allS ? 'S' : 'X') : acLabelForWord(p.word, p.type), all_s: allS, expect: true
      };
    }) };
    const resp = await fetch(PRAAT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const rows = await resp.json();
    let attached = 0;
    (Array.isArray(rows) ? rows : []).forEach((r, i) => {
      const p = need[i];
      if (p && r && typeof r === 'object' && String(r.word) === String(p.word)) { p.acoustics = r; attached++; }
    });
    console.log(`🔬 Praat server-side: ${attached}/${need.length} clips measured in ${Date.now() - t0} ms`);
  } catch (e) {
    console.warn(`🔬 Praat server-side FAILED after ${Date.now() - t0} ms (ear-only for ${need.length} clips):`, e.name === 'AbortError' ? 'timeout' : e.message);
  } finally { clearTimeout(timer); }
}

async function analyzeWithGemini(words, speakerContext) {
  annotateRelativeCog(words);
  const prompt = buildLispPrompt(words, speakerContext);
  return callGemini(buildAudioParts(prompt, words));
}

async function analyzeSentencesWithGemini(words, speakerContext) {
  const prompt = buildSentencePrompt(words, speakerContext);
  return callGemini(buildAudioParts(prompt, words));
}

// Single call covering all clips. Reuses the EXISTING word prompt (unchanged,
// just fed all the words) and the sentence prompt, asking for two headed tables.
function buildCombinedPrompt(wordProbes, sentenceProbes, passageProbes, speakerContext) {
  const wordPrompt = buildLispPrompt(wordProbes, speakerContext);
  const sentencePrompt = buildSentencePrompt(sentenceProbes, speakerContext);
  const nW = wordProbes.length, nS = sentenceProbes.length, nP = passageProbes.length;

  let prompt = `You will analyze ${nP ? 'THREE' : 'TWO'} sets of audio clips. The first ${nW} clips are single words; the next ${nS} clips are sentences.${nP ? ` The final ${nP} clip(s) are a spontaneous free-speech monologue.` : ''} Follow the instruction blocks below.

================ PART 1 — SINGLE WORDS (clips 1–${nW}) ================
${wordPrompt}

================ PART 2 — SENTENCES (clips ${nW + 1}–${nW + nS}) ================
${sentencePrompt}
`;

  if (nP) {
    let part3 = buildSpontaneousPrompt(speakerContext, passageProbes);
    // The spontaneous clip is now MFA-aligned (via Cloud STT) + Praat-measured,
    // so it carries the same high-frequency sibilant evidence the words do. Feed
    // it in as ground-truth for the >8 kHz band Gemini cannot hear.
    const acLines = passageProbes.map(p => formatAcoustics(p.acoustics)).filter(Boolean);
    if (acLines.length) {
      part3 += `\n\n[Praat acoustics] Aggregate high-frequency sibilant measurements for the spontaneous clip(s): ${acLines.join(' | ')}. They come from uncalibrated consumer microphones — use them only to corroborate a distortion you already hear, never to overturn clean-sounding speech. Do NOT mention any numbers in your output.`;
    }
    prompt += `
================ PART 3 — SPONTANEOUS SAMPLE (clip${nP > 1 ? 's' : ''} ${nW + nS + 1}–${nW + nS + nP}) ================
${part3}
`;
  }

  prompt += `
================ COMBINED OUTPUT ================
Output PART 1's word table under a heading line "### WORD ANALYSIS", then PART 2's sentence table under a heading line "### SENTENCE ANALYSIS"${nP ? ', then PART 3\'s qualitative section under "### SPONTANEOUS ANALYSIS"' : ''}. Output nothing else — no other commentary.
Do NOT number the table rows. Put ONLY the bare word/sentence in the first column (e.g. "sun", not "1. sun").`;
  return prompt;
}

async function analyzeCombinedWithGemini(wordProbes, sentenceProbes, passageProbes, speakerContext) {
  annotateRelativeCog([...wordProbes, ...sentenceProbes, ...passageProbes]);
  const prompt = buildCombinedPrompt(wordProbes, sentenceProbes, passageProbes, speakerContext);
  // Clip order must match the prompt: words, then sentences, then spontaneous.
  const ordered = [...wordProbes, ...sentenceProbes, ...passageProbes];
  return callGemini(buildAudioParts(prompt, ordered));
}

// Connected-speech-only prompt (sentences + optional spontaneous passage). Mirrors
// buildCombinedPrompt's PART 2/3 blocks WITHOUT the single-word part — used by the
// deferred "connected" (part-2) call so the word results can render first while
// these (clinically most important) sections process in the background. Output
// headings are EXACTLY "### SENTENCE ANALYSIS" then (if a passage) "### SPONTANEOUS
// ANALYSIS" so splitCombinedResponse parses this identically to combined mode.
function buildConnectedPrompt(sentenceProbes, passageProbes, speakerContext) {
  const sentencePrompt = buildSentencePrompt(sentenceProbes, speakerContext);
  const nS = sentenceProbes.length, nP = passageProbes.length;

  let prompt = `You will analyze ${nP ? 'TWO sets of audio clips' : 'a set of audio clips'}. The first ${nS} clips are sentences.${nP ? ` The final ${nP} clip(s) are a spontaneous free-speech monologue.` : ''} Follow the instruction block(s) below.

================ PART 1 — SENTENCES (clips 1–${nS}) ================
${sentencePrompt}
`;

  if (nP) {
    let part2 = buildSpontaneousPrompt(speakerContext, passageProbes);
    // Same passage acoustics aggregate line combined mode feeds in — the >8 kHz
    // sibilant evidence Gemini cannot hear. Kept identical so results match.
    const acLines = passageProbes.map(p => formatAcoustics(p.acoustics)).filter(Boolean);
    if (acLines.length) {
      part2 += `\n\n[Praat acoustics] Aggregate high-frequency sibilant measurements for the spontaneous clip(s): ${acLines.join(' | ')}. They come from uncalibrated consumer microphones — use them only to corroborate a distortion you already hear, never to overturn clean-sounding speech. Do NOT mention any numbers in your output.`;
    }
    prompt += `
================ PART 2 — SPONTANEOUS SAMPLE (clip${nP > 1 ? 's' : ''} ${nS + 1}–${nS + nP}) ================
${part2}
`;
  }

  prompt += `
================ COMBINED OUTPUT ================
Output the sentence table under a heading line "### SENTENCE ANALYSIS"${nP ? ', then the qualitative section under a heading line "### SPONTANEOUS ANALYSIS"' : ''}. Output nothing else — no other commentary.
Do NOT number the table rows. Put ONLY the bare sentence in the first column (e.g. "Sam saw…", not "1. Sam saw…").`;
  return prompt;
}

async function analyzeConnectedWithGemini(sentenceProbes, passageProbes, speakerContext) {
  annotateRelativeCog([...sentenceProbes, ...passageProbes]);
  const prompt = buildConnectedPrompt(sentenceProbes, passageProbes, speakerContext);
  // Clip order must match the prompt: sentences, then spontaneous.
  const ordered = [...sentenceProbes, ...passageProbes];
  return callGemini(buildAudioParts(prompt, ordered));
}

// Split the combined response into word-table, sentence-table, and spontaneous
// (qualitative) parts. Spontaneous is optional — empty string if absent.
function splitCombinedResponse(rawText) {
  // Peel off the spontaneous section first (everything from "### SPONTANEOUS").
  let spontaneousPart = '';
  let body = rawText;
  const sp = rawText.search(/###\s*SPONTANEOUS/i);
  if (sp >= 0) { spontaneousPart = rawText.slice(sp); body = rawText.slice(0, sp); }

  const m = body.search(/###\s*SENTENCE/i);
  if (m >= 0) return { wordPart: body.slice(0, m), sentencePart: body.slice(m), spontaneousPart };
  // Fallback: split at the sentence table's header row.
  const lines = body.split('\n');
  const idx = lines.findIndex(l => /^\s*\|\s*sentence\s*\|/i.test(l));
  if (idx >= 0) return { wordPart: lines.slice(0, idx).join('\n'), sentencePart: lines.slice(idx).join('\n'), spontaneousPart };
  return { wordPart: body, sentencePart: '', spontaneousPart };
}

// Parse the spontaneous section into { summary, notes[] }. No scoring.
function parseSpontaneous(rawText) {
  if (!rawText || !rawText.trim()) return null;
  const lines = rawText.split('\n');
  let summary = '';
  const notes = [];
  for (let line of lines) {
    const t = line.trim();
    if (!t || /^###/.test(t)) continue;
    const sm = t.match(/^\*\*\s*summary\s*:?\s*\*\*\s*(.*)$/i) || t.match(/^summary\s*:\s*(.*)$/i);
    if (sm) { summary = sm[1].trim(); continue; }
    const bullet = t.match(/^[-*•]\s+(.*)$/);
    if (bullet) { notes.push(bullet[1].trim()); continue; }
    // Loose prose before any bullet → treat as summary if none captured yet.
    if (!summary && !notes.length) summary = t.replace(/^\*\*|\*\*$/g, '').trim();
  }
  if (!summary && !notes.length) return null;
  return { summary, notes };
}

// Parse the markdown table and compute a Sibilant Clarity Index (0–100).
function parseGeminiTable(rawText, expectedCount) {
  const rows = [];
  for (const line of rawText.split('\n')) {
    if (!line.includes('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 2) continue;
    if (cells[0].includes('---')) continue;
    if (cells[0].toLowerCase() === 'word') continue;
    while (cells.length < 6) cells.push('');
    rows.push({
      // Strip any "1. " / "12) " numbering the model may prepend so the word
      // matches TEST_WORDS / tier maps downstream.
      word: (cells[0] || '').replace(/^\s*\d+[\.\)]\s*/, ''),
      position: cells[1] || '',
      heard: cells[2] || '',
      judgment: cells[3] || '',
      quality: parseInt(cells[4]) || 0,
      observation: cells[5] || ''
    });
  }
  const total = expectedCount || rows.length || 1;
  const qualitySum = rows.reduce((s, r) => s + r.quality, 0);
  const gri = Math.max(0, Math.min(100, Math.round(qualitySum / total)));
  return { result: rawText, gri, words: rows };
}

// Parse the connected-speech table: | Sentence | Judgment | Quality | Mistakes |
function parseSentenceTable(rawText, expectedCount) {
  const rows = [];
  for (const line of rawText.split('\n')) {
    if (!line.includes('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 2) continue;
    if (cells[0].includes('---')) continue;
    if (cells[0].toLowerCase() === 'sentence') continue;
    while (cells.length < 4) cells.push('');
    rows.push({
      sentence: cells[0],
      judgment: cells[1] || '',
      quality: parseInt(cells[2]) || 0,
      mistakes: cells[3] || ''
    });
  }
  const total = expectedCount || rows.length || 1;
  const qualitySum = rows.reduce((s, r) => s + r.quality, 0);
  const gri = Math.max(0, Math.min(100, Math.round(qualitySum / total)));
  return { result: rawText, gri, rows };
}

// Tier titles — must match the client's ASSESSMENT_TIERS labels so the persisted
// categories are identical to what the results page renders.
const LISP_TIER_LABELS = { 1: 'Core /s/ & /z/', 2: 'Extended sibilants', 3: 'Connected speech', 4: 'Spontaneous sample', 5: 'Fast & sustained /s/' };

// Group word/sentence/spontaneous rows into the tier categories the results page
// renders. Mirrors buildStructuredResult() in assessment.html.
function buildLispCategories(wordRows, sentenceRows, spontaneous) {
  const categories = [];
  [1, 2, 5].forEach(tid => {
    const rows = (wordRows || []).filter(r => r.tier === tid);
    if (!rows.length) return;
    const avg = Math.round(rows.reduce((s, r) => s + (r.quality || 0), 0) / rows.length);
    categories.push({ id: tid, title: LISP_TIER_LABELS[tid] || ('Tier ' + tid), type: 'words', rows, avg });
  });
  if (sentenceRows && sentenceRows.length) {
    const avg = Math.round(sentenceRows.reduce((s, r) => s + (r.quality || 0), 0) / sentenceRows.length);
    categories.push({ id: 3, title: LISP_TIER_LABELS[3], type: 'sentences', rows: sentenceRows, avg });
  }
  if (spontaneous && (spontaneous.summary || spontaneous.notes)) {
    categories.push({ id: 4, title: LISP_TIER_LABELS[4], type: 'spontaneous', spontaneous });
  }
  return categories;
}

// Markdown fallback rendering of the categories. Mirrors structuredToMarkdown() in
// assessment.html so the stored `result` string matches the browser's.
function lispStructuredToMarkdown(categories) {
  return categories.map(cat => {
    if (cat.type === 'spontaneous') {
      const sp = cat.spontaneous || {};
      let md = '## ' + cat.title + '\n\n';
      if (sp.summary) md += sp.summary + '\n\n';
      if (Array.isArray(sp.notes) && sp.notes.length) md += sp.notes.map(n => '- ' + n).join('\n');
      else if (sp.notes) md += sp.notes;
      return md;
    }
    if (cat.type === 'sentences') {
      const head = '## ' + cat.title + '\n\n| Sentence | Judgment | Quality | Mistakes |\n| --- | --- | --- | --- |\n';
      return head + cat.rows.map(r => `| ${r.sentence} | ${r.judgment} | ${r.quality} | ${r.mistakes} |`).join('\n');
    }
    const head = '## ' + cat.title + '\n\n| Word | Position | Heard | Judgment | Quality | Observation |\n| --- | --- | --- | --- | --- | --- |\n';
    return head + cat.rows.map(r => `| ${r.word} | ${r.position || ''} | ${r.heard || ''} | ${r.judgment} | ${r.quality} | ${r.observation || ''} |`).join('\n');
  }).join('\n\n');
}

// Identity fields common to every lisp-users write. Matches the schema the browser
// used to write (product/uid/sessionId/posthogId/authUserId/email/isAnonymous/phone
// /countryCode) so server-written records are indistinguishable from client ones.
function lispIdentityFields(user) {
  return {
    product: 'lisp',
    uid: user.uid,
    sessionId: user.sessionId || '',
    posthogId: user.posthogId || '',
    authUserId: user.authUserId || '',
    email: user.email || '',
    isAnonymous: !!user.isAnonymous,
    phone: user.phone || '',
    countryCode: user.countryCode || ''
  };
}

// Persist the completed analysis to lisp-users/{uid}. Merge-write so app-owned
// fields are preserved (same as the old browser write).
async function writeLispUserRecord(user, analysis, survey) {
  try {
    if (!firestore) { console.warn('Firestore unavailable — skipping record write'); return; }
    if (!user || !user.uid) { console.warn('No uid in payload — skipping Firestore record write'); return; }
    const s = survey || {};
    const surveyFields = (s.trouble_words_response || s.age_group || s.found_on || s.first_name)
      ? { survey: {
          trouble_words_response: s.trouble_words_response || '',
          age_group: s.age_group || '',
          found_on: s.found_on || '',
          first_name: s.first_name || '',
          at: new Date().toISOString()
        } }
      : {};
    await firestore.collection('lisp-users').doc(String(user.uid)).set({
      ...lispIdentityFields(user),
      ...surveyFields,
      latestAssessment: {
        gri: analysis.gri ?? null,
        categories: analysis.categories ?? [],
        result: analysis.result ?? '',
        // partial=true = words-only interim write (user may still be waiting on the
        // deferred connected-speech part). Always written explicitly so the full
        // (connected) write clears it — a merge-write deep-merges the map and would
        // otherwise leave a stale partial:true behind.
        partial: !!analysis.partial,
        // Speaker-level acoustic profile summary (flags/verdicts/capture), no per-token data.
        acoustics: analysis.acoustics ?? null,
        // Consented face video pointer (Storage path + manifest) and the camera
        // placement check result, when the user opted in.
        ...(analysis.outcome !== undefined ? { outcome: analysis.outcome } : {}),
        ...(analysis.video !== undefined ? { video: analysis.video } : {}),
        ...(analysis.placement !== undefined ? { placement: analysis.placement } : {}),
        completedAt: new Date().toISOString()
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log('✅ Wrote Firestore lisp-users/' + user.uid);
  } catch (err) {
    console.error('❌ Firestore record write failed:', err);
  }
}

// Record a failed analysis attempt so the user's record still exists (with the
// same identity schema) and the failure is traceable. Does not touch any prior
// latestAssessment (merge-write), only adds lastAnalysisError.
async function writeLispUserErrorRecord(user, errInfo) {
  try {
    if (!firestore) return;
    if (!user || !user.uid) return;
    await firestore.collection('lisp-users').doc(String(user.uid)).set({
      ...lispIdentityFields(user),
      lastAnalysisError: {
        message: errInfo.message || 'analysis failed',
        mode: errInfo.mode || 'combined',
        at: new Date().toISOString()
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log('⚠️ Wrote Firestore error record lisp-users/' + user.uid);
  } catch (err) {
    console.error('❌ Firestore error-record write failed:', err);
  }
}

// ============================================================================
// RETAKE ENTITLEMENT — free-once enforcement + per-assessment records.
//
// The FIRST completed assessment for a person is free; every later one needs a
// paid $19 retake credit. Sign-in is forced before the report, so a verified
// authUserId is the primary identity — but a returning user can sign in with a
// NEW account to look new. To catch that we resolve every attempt to a canonical
// personId by OR-matching authUserId, normalized email, and normalized phone
// (the survey collects email+phone right before the report, so this is the
// strongest signal we have and it arrives in time for the report request).
//
// Records: lisp-persons/{personId} holds the running count + paidCredits;
// lisp-persons/{personId}/assessments/{sessionId} holds one row per run (tier,
// amount, variant, gri). lisp-identities/{type:value} indexes each identifier to
// its person. Everything here FAILS OPEN: any Firestore error allows the run, so
// a hiccup never blocks a legitimate first assessment.
// ============================================================================

// Gmail ignores dots and +suffix; normalize so alias emails collapse to one key.
function normEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 1) return '';
  let local = e.slice(0, at), domain = e.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return local && domain ? local + '@' + domain : '';
}

// Soft phone key: last 10 digits, tolerant of country-prefix/formatting drift.
// (Client sends intl-tel-input's value; E.164 would be stronger — see NOTES.)
function normPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
}

function identityKeys(user) {
  const keys = [];
  if (user && user.authUserId) keys.push('auth:' + String(user.authUserId));
  const em = normEmail(user && user.email); if (em) keys.push('email:' + em);
  const ph = normPhone(user && user.phone); if (ph) keys.push('phone:' + ph);
  return keys;
}

// Resolve (or create) the canonical personId for this user's identifiers, and
// point every identifier doc at it. First matching identifier wins.
async function resolvePersonId(user) {
  const keys = identityKeys(user);
  if (!firestore || !keys.length) return { personId: (user && (user.authUserId || user.uid)) || null, keys, matched: false };
  let personId = null;
  for (const k of keys) {
    const snap = await firestore.collection('lisp-identities').doc(k).get();
    if (snap.exists && snap.data() && snap.data().personId) { personId = snap.data().personId; break; }
  }
  const matched = !!personId;
  if (!personId) personId = 'p_' + String((user.authUserId || user.uid || '') || Date.now()) + '_' + Math.random().toString(36).slice(2, 8);
  const batch = firestore.batch();
  keys.forEach(k => batch.set(firestore.collection('lisp-identities').doc(k),
    { personId, matchedKey: k, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }));
  await batch.commit();
  return { personId, keys, matched };
}

// Decide, BEFORE spending Gemini tokens, whether this delivery is free, paid
// (a credit is available to consume), or must be paid for (retake_required).
async function checkRetakeEntitlement(user) {
  try {
    if (!firestore) return { allowed: true, tier: 'free', personId: null };
    const { personId } = await resolvePersonId(user);
    const snap = await firestore.collection('lisp-persons').doc(String(personId)).get();
    const p = snap.exists ? snap.data() : {};
    const count = p.assessmentCount || 0;
    const credits = p.paidCredits || 0;
    if (count < 1) return { allowed: true, tier: 'free', personId };
    if (credits > 0) return { allowed: true, tier: 'paid', personId };
    return { allowed: false, tier: 'retake_required', personId };
  } catch (e) {
    console.error('entitlement check failed (fail-open):', e);
    return { allowed: true, tier: 'free', personId: null };
  }
}

// Read-only entitlement lookup for the POST-LOGIN gate. Resolves personId from
// EXISTING identity docs only (never creates/links, unlike resolvePersonId), then
// reads assessmentCount. Lets the client route a returning user straight to the
// paywall the moment they log in — before recording — using the same free-once
// truth the analysis-time gate enforces. Fails open (allowed:true) on any miss.
async function lookupEntitlement(user) {
  try {
    if (!firestore) return { allowed: true, tier: 'free' };
    const keys = identityKeys(user);
    let personId = null;
    for (const k of keys) {
      const snap = await firestore.collection('lisp-identities').doc(k).get();
      if (snap.exists && snap.data() && snap.data().personId) { personId = snap.data().personId; break; }
    }
    if (!personId) return { allowed: true, tier: 'free', name: '' };
    const ref = firestore.collection('lisp-persons').doc(String(personId));
    const snap = await ref.get();
    const p = snap.exists ? snap.data() : {};
    // Persist the real display name the FIRST time we see it (Apple only returns
    // the name on the initial authorization, so the DB is the cross-device source
    // of truth). Never overwrite an already-stored name with a later/blank value.
    let name = (p.name || '').toString();
    const incoming = (user.name || '').toString().trim();
    if (!name && incoming) {
      name = incoming;
      try { await ref.set({ name: incoming, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch (e) {}
    }
    const count = p.assessmentCount || 0;
    const credits = p.paidCredits || 0;
    if (count < 1) return { allowed: true, tier: 'free', name };
    if (credits > 0) return { allowed: true, tier: 'paid', name };
    return { allowed: false, tier: 'retake_required', name };
  } catch (e) {
    console.error('lookupEntitlement failed (fail-open):', e);
    return { allowed: true, tier: 'free' };
  }
}

// Record one completed assessment, idempotent per run (keyed on the client's
// per-assessment sessionId): counts + consumes a credit only the FIRST time a
// run is seen, so the split flow's part-1 and part-2 writes don't double count.
// Called at PART 1 (words+clusters delivered) — the agreed "consumed" point.
async function recordPersonAssessment(user, personId, tier, data) {
  try {
    if (tier === 'test') return; // QA bypass — don't count or consume for test accounts
    if (!firestore || !personId || !user) return;
    const key = String(user.sessionId || user.uid || Date.now());
    const personRef = firestore.collection('lisp-persons').doc(String(personId));
    const asmtRef = personRef.collection('assessments').doc(key);
    await firestore.runTransaction(async (tx) => {
      const [pSnap, aSnap] = await Promise.all([tx.get(personRef), tx.get(asmtRef)]);
      const firstSeen = !aSnap.exists;
      const pUpdate = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(user.email ? { email: user.email } : {}),
        ...(user.phone ? { phone: user.phone } : {})
      };
      if (firstSeen) {
        if (!pSnap.exists) pUpdate.createdAt = admin.firestore.FieldValue.serverTimestamp();
        pUpdate.assessmentCount = admin.firestore.FieldValue.increment(1);
        if (tier === 'paid') pUpdate.paidCredits = admin.firestore.FieldValue.increment(-1);
        else pUpdate.freeUsedAt = admin.firestore.FieldValue.serverTimestamp();
      }
      tx.set(personRef, pUpdate, { merge: true });
      tx.set(asmtRef, {
        tier: tier || 'free',
        variant: (data && data.variant) || (user.variant || null),
        amountCents: tier === 'paid' ? ((data && data.amountCents) || 1900) : 0,
        currency: (data && data.currency) || 'USD',
        gri: (data && data.gri != null) ? data.gri : null,
        partial: !!(data && data.partial),
        uid: user.uid || '', authUserId: user.authUserId || '',
        ...(aSnap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    console.log('🧾 recorded assessment for person ' + personId + ' tier=' + tier);
  } catch (e) {
    console.error('recordPersonAssessment failed:', e);
  }
}

// Credits are granted authoritatively by the Dodo `payment.succeeded` webhook
// (gcp-function-dodo), which resolves this same personId and increments
// paidCredits idempotently. See resolvePersonId — the identity model is shared.

// ============================================================================
// HUBSPOT LEAD SYNC — replaces the tsh-lead-alert Telegram briefing service.
// The finished lead is upserted as a HubSpot contact (lifecycle stage "lead")
// and the full report + every survey answer lands as a Note on the contact, so
// a sales exec opens the record and sees exactly what the lead saw.
//
// Fires in the same request as report completion (right after the Firestore
// write), so a lead is in HubSpot seconds after their results render. Same
// durability model as the old transport: retried in-request, parked on the
// user's doc on failure, re-driven by the Cloud Scheduler sweep
// (?sweep=leads&key=<LEAD_ALERT_SECRET>).
// ============================================================================
const LEAD_ALERT_SECRET = process.env.LEAD_ALERT_SECRET || '';  // sweep-route auth only
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || '';

async function hubspotPost(path, body) {
  const resp = await fetch('https://api.hubapi.com' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
  return { ok: resp.ok, status: resp.status, text, json };
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The sales briefing that becomes the HubSpot note: headline verdict, every
// survey answer, then the per-probe report exactly as scored (word/sentence,
// judgment, quality, observation). hs_note_body allows simple HTML only, so
// this sticks to <p>/<strong>/<br>.
function buildLeadNoteBody(user, survey, report, speakerContext) {
  const u = user || {}, s = survey || {}, r = report || {}, sc = speakerContext || {};
  const sum = r.summary || {};
  const phone = (u.phone || '').trim();
  const fullPhone = phone ? `${(u.countryCode || '').trim()} ${phone}`.trim() : '';
  const geo = [sc.region, sc.country].filter(x => x && x !== 'Unspecified').join(', ');
  const parts = [];
  parts.push('<p><strong>Free lisp assessment completed</strong> — GRI ' +
    (r.gri != null ? r.gri : '—') + '/100' +
    (sum.lispDetected
      ? `, lisp detected on ${sum.lispWordCount} probe${sum.lispWordCount === 1 ? '' : 's'}`
      : ', no lisp detected') +
    (sum.outcome && sum.outcome.tier ? ` · outcome: <b>${escHtml(sum.outcome.tier)}</b>${sum.outcome.type ? ' (' + escHtml(sum.outcome.type) + ')' : ''}${sum.outcome.reasons && sum.outcome.reasons.length ? ' — ' + escHtml(sum.outcome.reasons.join('; ')) : ''}` : '') + '</p>');
  const opener = buildOpener(user, survey, r);
  const wa = waLink(u, opener);
  parts.push('<p><strong>First touch</strong><br>' + escHtml(opener) +
    (wa ? `<br><a href="${escHtml(wa)}">▶ Open WhatsApp with this message pre-typed</a>` : '') + '</p>');
  parts.push('<p><strong>Survey</strong><br>' + [
    `Name: ${escHtml(s.first_name) || '—'}`,
    `Email: ${escHtml(u.email) || '—'}`,
    `Phone: ${escHtml(fullPhone) || '—'}`,
    `Age group: ${escHtml(s.age_group) || '—'}`,
    `Trouble with /s/ words: ${escHtml(s.trouble_words_response) || '—'}`,
    `Found us on: ${escHtml(s.found_on) || '—'}`,
    `Voice type: ${escHtml(sc.voiceType && sc.voiceType !== 'unspecified' ? sc.voiceType : '') || '—'}`,
    `Location: ${escHtml(geo) || '—'}`
  ].join('<br>') + '</p>');
  (r.categories || []).forEach(cat => {
    if (cat.type === 'spontaneous') {
      const sp = cat.spontaneous || {};
      const notes = Array.isArray(sp.notes) ? sp.notes : (sp.notes ? [sp.notes] : []);
      parts.push(`<p><strong>${escHtml(cat.title)}</strong><br>${escHtml(sp.summary || '')}` +
        (notes.length ? '<br>• ' + notes.map(escHtml).join('<br>• ') : '') + '</p>');
      return;
    }
    const rows = (cat.rows || []).map(row => {
      const label = row.word || row.sentence || '';
      const extra = row.observation || row.mistakes || '';
      return `• ${escHtml(label)} — ${escHtml(row.judgment || '')} (${row.quality != null ? row.quality : '—'})` +
        (extra ? ` — ${escHtml(extra)}` : '');
    });
    parts.push(`<p><strong>${escHtml(cat.title)}${cat.avg != null ? ` — avg ${cat.avg}` : ''}</strong><br>${rows.join('<br>')}</p>`);
  });
  return parts.join('');
}

// Guard against double-briefing. Keyed on the assessment's own sessionId rather
// than "has this uid ever been briefed": the old marker was written once per user
// and cleared nowhere in the codebase, so every returning user — including anyone
// who paid $19 for a retake — was silently skipped forever. A part-2 retry within
// the same run reuses the sessionId, so that case is still deduped.
// Checked BEFORE sending; the marker is written only AFTER a successful send
// (see sendLeadAlert). Writing it up-front would bury the lead permanently on any
// transient failure.
async function alreadyAlerted(uid, sessionId) {
  if (!firestore || !uid) return false;  // can't dedupe → send, don't drop the lead
  try {
    const snap = await firestore.collection('lisp-users').doc(String(uid)).get();
    if (!snap.exists) return false;
    const d = snap.data() || {};
    // Legacy marker carries no session. Honour it only for a run that has no
    // sessionId either, so pre-existing users aren't locked out of a retake.
    if (!sessionId) return !!d.leadAlertSentAt;
    return d.leadAlertSentFor === sessionId;
  } catch (e) {
    console.error('leadAlert dedupe check failed (sending anyway):', e.message);
    return false;
  }
}

async function setLeadAlerted(uid, sessionId) {
  if (!firestore || !uid) return;
  try {
    await firestore.collection('lisp-users').doc(String(uid))
      .set({
        leadAlertSentAt: new Date().toISOString(),
        leadAlertSentFor: sessionId || '',
        // Clear the parking slot so the sweep stops re-driving this lead.
        leadAlertPending: admin.firestore.FieldValue.delete()
      }, { merge: true });
  } catch (e) {
    console.error('leadAlert marker write failed (lead may be briefed twice):', e.message);
  }
}

// Park an undeliverable lead on the user's doc so sweepPendingLeadAlerts() can
// re-drive it later. The full payload (survey + report) is stored so the sweep
// can rebuild the note and PDF without the original request.
async function parkLeadAlert(uid, payload, error) {
  if (!firestore || !uid) {
    console.error('❌ lead has nowhere to park (no uid) — WILL be lost:', payload.email);
    return;
  }
  try {
    const rest = JSON.parse(JSON.stringify(payload));
    await firestore.collection('lisp-users').doc(String(uid)).set({
      leadAlertPending: {
        payload: rest, attempts: 0,
        lastError: String(error).slice(0, 500),
        at: new Date().toISOString()
      }
    }, { merge: true });
    console.log('📥 lead parked for retry:', rest.email);
  } catch (e) {
    console.error('leadAlert parking failed (lead WILL be lost):', e.message);
  }
}

// The shareable PDF of the report — what the sales exec forwards to the lead.
// Rendered by the gcp-function-lisp-report Cloud Run service (WeasyPrint —
// the exact clinical design of the product report, extracted from the retired
// tsh-sales-automation service). IAM-authed: we send a Google-signed ID token,
// same pattern the old tsh transport used. Returns null on any failure —
// the lead must land in HubSpot even if the PDF can't be built (loud-logged;
// the note still carries the full report text).
const REPORT_PDF_URL = process.env.REPORT_PDF_URL || '';
// Mint the ID token from the Cloud Run metadata server directly. ADC on this
// service is the rollr-academy Firestore SA key (GOOGLE_APPLICATION_CREDENTIALS),
// which has no run.invoker on the report service — google-auth-library minted
// the token as THAT principal, so every render came back 403 and the completed
// lead parked. The metadata server always signs as the service's own runtime
// SA, which is the one granted invoker on lisp-report-pdf.
async function reportPdfIdToken() {
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(REPORT_PDF_URL), {
      headers: { 'Metadata-Flavor': 'Google' }
    });
    if (!r.ok) throw new Error(`metadata server ${r.status}`);
    const token = (await r.text()).trim();
    return token ? `Bearer ${token}` : '';
  } catch (e) {
    // Local dev against a bare flask instance has no metadata server — send
    // unauthenticated and let the service decide.
    console.warn('report PDF ID token unavailable (sending unauthenticated):', e.message);
    return '';
  }
}

async function buildReportPdf(user, survey, report) {
  if (!REPORT_PDF_URL) { console.warn('REPORT_PDF_URL unset — lead note will have no PDF'); return null; }
  try {
    const u = user || {}, s = survey || {}, r = report || {};
    const headers = { 'Content-Type': 'application/json' };
    const auth = await reportPdfIdToken();
    if (auth) headers.Authorization = auth;
    const resp = await fetch(REPORT_PDF_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: (s.first_name || '').trim() || String(u.email || '').split('@')[0] || 'Patient',
        date: new Date().toISOString().slice(0, 10),
        gri: r.gri,
        categories: r.categories || [],
        result: r.result || '',
        age_group: s.age_group || '',
        uid: u.uid || ''
      })
    });
    if (!resp.ok) {
      console.error('report PDF render failed:', resp.status, (await resp.text()).slice(0, 300));
      return null;
    }
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.error('PDF build failed — lead note will have no PDF:', e.message);
    return null;
  }
}

// Files API upload (multipart — Node 22 global FormData/Blob). Deterministic
// filename + overwrite:true make re-drives replace the file instead of piling
// up copies, so parked-lead retries never grow free-plan storage.
// PUBLIC_NOT_INDEXABLE = unguessable stable URL, hidden from search engines —
// the exec can paste the link or attach the file when contacting the lead.
async function hubspotUploadPdf(pdfBuffer, fileName) {
  const fd = new FormData();
  fd.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName);
  fd.append('options', JSON.stringify({ access: 'PUBLIC_NOT_INDEXABLE', overwrite: true }));
  fd.append('folderPath', '/lisp-assessment-reports');
  const resp = await fetch('https://api.hubapi.com/files/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    body: fd
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
  return { ok: resp.ok, status: resp.status, text, json };
}

// Three HubSpot calls per lead — upsert contact, upload PDF, attach note —
// retried as a unit on transport errors and 5xx. Well inside free-plan API
// limits (100 req/10s, 250k/day) at any plausible assessment volume. The
// upsert is idempotent and the fileId is cached across attempts, so only the
// note can double on an ambiguous retry — same window the old transport had.
const LEAD_ALERT_ATTEMPTS = 3;
async function postLeadAlert(payload) {
  let last = '';
  // When the render service is configured, the PDF is REQUIRED: a failed
  // render fails the attempt so the lead parks and the sweep re-drives it
  // with the PDF once the service recovers. With REPORT_PDF_URL unset
  // (pre-rollout), leads deliver note-only rather than piling up.
  const wantPdf = !!(payload.report && REPORT_PDF_URL);
  const pdfName = `lisp-report-${String(payload.sessionId || payload.email).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
  let pdf = null, fileId = null;
  for (let i = 0; i < LEAD_ALERT_ATTEMPTS; i++) {
    try {
      if (payload.report && !pdf) pdf = await buildReportPdf(payload.user, payload.survey, payload.report);
      if (wantPdf && !pdf) { throw new Error('report PDF render failed'); }
      let up = await hubspotPost('/crm/v3/objects/contacts/batch/upsert', {
        inputs: [{ idProperty: 'email', id: String(payload.email).toLowerCase(), properties: payload.contactProps }]
      });
      if (!up.ok && up.status === 400) {
        // Property validation failure (e.g. a portal that deleted the default
        // "lead" lifecycle stage) — the contact must land anyway. Retry with
        // the minimal guaranteed-valid property set.
        const p = payload.contactProps || {};
        up = await hubspotPost('/crm/v3/objects/contacts/batch/upsert', {
          inputs: [{ idProperty: 'email', id: String(payload.email).toLowerCase(),
                     properties: { email: p.email, firstname: p.firstname, phone: p.phone } }]
        });
      }
      if (!up.ok) {
        last = `upsert ${up.status} ${up.text.slice(0, 300)}`;
      } else {
        const contactId = up.json && up.json.results && up.json.results[0] && up.json.results[0].id;
        if (!contactId) {
          last = 'upsert ok but no contact id: ' + up.text.slice(0, 300);
        } else {
          if (pdf && !fileId) {
            const uploaded = await hubspotUploadPdf(pdf, pdfName);
            if (uploaded.ok && uploaded.json && uploaded.json.id) fileId = String(uploaded.json.id);
            else { last = `file ${uploaded.status} ${uploaded.text.slice(0, 300)}`; throw new Error(last); }
          }
          const noteProps = {
            hs_timestamp: payload.date || new Date().toISOString(),
            hs_note_body: String(payload.noteBody || '').slice(0, 60000)
          };
          if (fileId) noteProps.hs_attachment_ids = fileId;
          const note = await hubspotPost('/crm/v3/objects/notes', {
            properties: noteProps,
            // 202 = HubSpot-defined note→contact association.
            associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
          });
          if (note.ok) return { ok: true, contactId, body: `contact ${contactId}${fileId ? ` pdf ${fileId}` : ''}` };
          last = `note ${note.status} ${note.text.slice(0, 300)}`;
        }
      }
    } catch (e) {
      last = e.message;
    }
    if (i < LEAD_ALERT_ATTEMPTS - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return { ok: false, body: last };
}

// ============================================================================
// FUNNEL LEADS — a signed-in visitor is a lead BEFORE they finish anything.
// Firestore `hubspot-leads/{email}` is the cross-product dedupe marker (also
// read by the rollr-academy auth trigger to attribute app signups).
// assessment_status / assessment_product are custom contact properties
// (2 of the free plan's 10) so sales can filter "signed in, never finished".
// ============================================================================
const LEAD_STATUS_PROP = 'assessment_status';
const LEAD_PRODUCT_PROP = 'assessment_product';
const LEAD_REP_PROP = 'lead_rep';
// ?src=<rep> from the frontend → lowercase slug or ''.
const leadRepSlug = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);

async function hubspotGet(path) {
  const resp = await fetch('https://api.hubapi.com' + path, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
  return { ok: resp.ok, status: resp.status, text, json };
}

// The portal's own onboarding-created "Speech challenge type" property
// (options Rhotacism/Lisp/Stutter). Its internal name/option values are
// portal-defined, so introspect once instead of guessing; when found, every
// lead upsert also fills it. Needs crm.schemas.contacts.read; absent scope →
// silently skipped.
let _challengeProp = null;  // { name, values: { lisp, rhotacism } } | false
async function resolveChallengeProp() {
  if (_challengeProp !== null) return _challengeProp;
  _challengeProp = false;
  try {
    const r = await hubspotGet('/crm/v3/properties/contacts');
    const props = (r.ok && r.json && r.json.results) || [];
    const p = props.find(x => /speech\s*challenge\s*type/i.test(x.label || '') || x.name === 'speech_challenge_type');
    if (p) {
      const find = re => { const o = (p.options || []).find(o => re.test(o.label || '') || re.test(o.value || '')); return o && o.value; };
      const values = { lisp: find(/lisp/i), rhotacism: find(/rhotacism/i) };
      if (values.lisp || values.rhotacism) _challengeProp = { name: p.name, values };
      console.log('speech-challenge property resolved:', JSON.stringify(_challengeProp));
    }
  } catch (e) {
    console.warn('speech-challenge property introspection failed:', e.message);
  }
  return _challengeProp;
}

function challengeProps(product) {
  const c = _challengeProp;
  return (c && c.values[product]) ? { [c.name]: c.values[product] } : {};
}

// Create the two custom properties once per instance. Needs the app scope
// crm.schemas.contacts.write; a 403 just means statuses ride in notes until
// the scope is added. 409 = already exist.
let _hsPropsEnsured = false;
async function ensureHubspotProperties() {
  await resolveChallengeProp();
  if (_hsPropsEnsured || !HUBSPOT_TOKEN) return;
  _hsPropsEnsured = true;
  const defs = [
    { name: LEAD_STATUS_PROP, label: 'Assessment status', type: 'enumeration', fieldType: 'select',
      groupName: 'contactinformation',
      options: [
        { label: 'Signed in — not completed', value: 'signed_in' },
        { label: 'Recorded words — report unfinished', value: 'recorded_words' },
        { label: 'Opened checkout — not paid', value: 'checkout_opened' },
        { label: 'Completed', value: 'completed' },
        { label: 'Asked for a human listen', value: 'review_requested' },
        { label: 'Reviewed by a coach', value: 'reviewed' }
      ] },
    { name: LEAD_PRODUCT_PROP, label: 'Assessment product', type: 'enumeration', fieldType: 'select',
      groupName: 'contactinformation',
      options: [{ label: 'Lisp', value: 'lisp' }, { label: 'Rhotacism', value: 'rhotacism' }] },
    { name: 'signed_in_at', label: 'Assessment signed in at', type: 'datetime', fieldType: 'date',
      groupName: 'contactinformation' },
    { name: 'assessment_completed_at', label: 'Assessment completed at', type: 'datetime', fieldType: 'date',
      groupName: 'contactinformation' },
    // Rep tracking link (?src=<rep>) — which sales rep's outreach brought the lead.
    { name: LEAD_REP_PROP, label: 'Lead rep', type: 'string', fieldType: 'text',
      groupName: 'contactinformation' }
  ];
  for (const d of defs) {
    const r = await hubspotPost('/crm/v3/properties/contacts', d);
    if (!r.ok && r.status === 409 && d.options) {
      // Property exists from an earlier deploy — make sure newer enum options
      // (e.g. checkout_opened) are present.
      await fetch('https://api.hubapi.com/crm/v3/properties/contacts/' + d.name, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HUBSPOT_TOKEN}` },
        body: JSON.stringify({ options: d.options })
      }).catch(() => {});
    } else if (!r.ok && r.status !== 409) {
      console.warn(`HubSpot property ${d.name} not created (${r.status}):`, r.text.slice(0, 200));
    }
  }
}

// The sales exec's owner id — resolved once so tasks land assigned (assigned
// tasks push to the HubSpot mobile app; unassigned ones just sit in the index).
// Needs crm.objects.owners.read; failure → unassigned tasks, never a lost lead.
const HUBSPOT_OWNER_EMAIL = process.env.HUBSPOT_OWNER_EMAIL || 'neil@topspeech.health';
let _ownerId = '';
async function resolveOwnerId() {
  // Cache only a SUCCESSFUL resolve — a 403 (scope missing) must retry on the
  // next lead, not stick until the instance recycles.
  if (_ownerId) return _ownerId;
  try {
    const r = await hubspotGet('/crm/v3/owners/?limit=100');
    if (!r.ok) console.warn('owner resolve failed (leads land unassigned):', r.status, r.text.slice(0, 700));
    const owners = (r.ok && r.json && r.json.results) || [];
    const match = owners.find(o => (o.email || '').toLowerCase() === HUBSPOT_OWNER_EMAIL.toLowerCase());
    if (match) _ownerId = String(match.id);
    else console.warn('owner resolve: no owner matched', HUBSPOT_OWNER_EMAIL, '— got', owners.length, 'owners; raw:', r.text.slice(0, 300));
  } catch (e) { console.warn('owner resolve error (leads land unassigned):', e.message); }
  return _ownerId;
}

// Due-NOW call task on the contact — the exec's phone pings via the HubSpot
// mobile app. This is the speed-to-lead engine on the free plan (no workflows).
async function createLeadTask(contactId, subject, body) {
  try {
    if (!contactId || !HUBSPOT_TOKEN) return;
    const ownerId = await resolveOwnerId();
    const props = {
      hs_timestamp: new Date().toISOString(),
      hs_task_subject: subject.slice(0, 250),
      hs_task_body: String(body || '').slice(0, 5000),
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: 'HIGH',
      hs_task_type: 'CALL',
      // The mobile app only pushes CRM tasks via "Task reminder" (there is no
      // "sales task assigned to you" push) — a near-immediate reminder IS the
      // speed-to-lead phone ping.
      hs_task_reminders: String(Date.now() + 60 * 1000)
    };
    if (ownerId) props.hubspot_owner_id = ownerId;
    const r = await hubspotPost('/crm/v3/objects/tasks', {
      properties: props,
      // 204 = HubSpot-defined task→contact association.
      associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }]
    });
    if (!r.ok) console.warn('lead task create failed:', r.status, r.text.slice(0, 200));
  } catch (e) {
    console.error('lead task error:', e.message);
  }
}

// One-tap WhatsApp deep link with the opener pre-typed. Empty when no phone.
function waLink(user, opener) {
  const digits = `${(user && user.countryCode) || ''}${(user && user.phone) || ''}`.replace(/\D/g, '');
  if (digits.length < 8) return '';
  return `https://wa.me/${digits}?text=${encodeURIComponent(opener)}`;
}

// Two-line first-touch script from the actual findings — zero think-time
// between the task ping and making contact.
function buildOpener(user, survey, report) {
  const first = String((survey && survey.first_name) || '').trim().split(' ')[0] || 'there';
  const sum = (report && report.summary) || {};
  let pattern = '';
  const counts = {};
  ((report && report.categories) || []).forEach(c => (c.rows || []).forEach(r => {
    if (r.judgment && !/^accurate$/i.test(r.judgment)) counts[r.judgment] = (counts[r.judgment] || 0) + 1;
  }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top) pattern = top[0].toLowerCase();
  return sum.lispDetected && pattern
    ? `Hi ${first} — I just reviewed your /s/ assessment. The ${pattern} pattern we detected is very fixable: most people clear it in 8–10 weeks with daily practice. Do you have 5 minutes to walk through your report?`
    : `Hi ${first} — I just reviewed your /s/ assessment results. Do you have 5 minutes to walk through your report and what they mean?`;
}

// Upsert by email; on a 400 (e.g. custom properties not created yet) retry
// with the minimal guaranteed-valid set so the contact always lands.
async function upsertLeadContact(email, properties) {
  const id = String(email).toLowerCase();
  let up = await hubspotPost('/crm/v3/objects/contacts/batch/upsert', {
    inputs: [{ idProperty: 'email', id, properties }]
  });
  if (!up.ok && up.status === 400) {
    up = await hubspotPost('/crm/v3/objects/contacts/batch/upsert', {
      inputs: [{ idProperty: 'email', id,
                 properties: { email: properties.email, firstname: properties.firstname, phone: properties.phone } }]
    });
  }
  return up;
}

function leadContactId(up) {
  return up.json && up.json.results && up.json.results[0] && String(up.json.results[0].id || '');
}

async function attachLeadNote(contactId, html) {
  return hubspotPost('/crm/v3/objects/notes', {
    properties: { hs_timestamp: new Date().toISOString(), hs_note_body: html },
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
  });
}

// Fires from the post-login entitlement check — the first server-visible
// funnel step. A returning identity that already consumed its free run
// (ent.allowed === false) is pushed as completed, which organically backfills
// pre-HubSpot leads. Marker-deduped; a failed push retries on next sign-in.
async function sendSignupLead(user, ent) {
  try {
    const email = String((user && user.email) || '').trim().toLowerCase();
    if (!email || !HUBSPOT_TOKEN || !firestore) return;
    const ref = firestore.collection('hubspot-leads').doc(email);
    const rep = leadRepSlug(user && user.src);
    if ((await ref.get()).exists) {
      // Known contact arriving via a rep's tracking link: stamp the rep only.
      if (rep) { await ensureHubspotProperties(); await upsertLeadContact(email, { email, [LEAD_REP_PROP]: rep }); }
      return;
    }
    await ensureHubspotProperties();
    const completedBefore = ent && ent.allowed === false;
    const status = completedBefore ? 'completed' : 'signed_in';
    const props = {
      email,
      firstname: String((user && user.name) || '').trim().split(' ')[0] || '',
      phone: String((user && user.phone) || '').trim(),
      lifecyclestage: 'lead',
      [LEAD_STATUS_PROP]: status,
      [LEAD_PRODUCT_PROP]: 'lisp',
      signed_in_at: String(Date.now()),
      ...challengeProps('lisp')
    };
    // Assign the contact to the exec: "record assigned to you" is the only
    // free-plan HubSpot mobile push that fires on a NEW lead (tasks only come
    // later, at completion/checkout).
    {
      const ownerId = await resolveOwnerId();
      if (ownerId) props.hubspot_owner_id = ownerId;
    }
    // Vercel edge GeoIP forwarded by the client (standard Country property).
    const country = String((user && user.country) || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) props.country = country;
    if (rep) props[LEAD_REP_PROP] = rep;
    const up = await upsertLeadContact(email, props);
    if (!up.ok) { console.warn('signup lead upsert failed (retries next sign-in):', up.status, up.text.slice(0, 200)); return; }
    const contactId = leadContactId(up);
    if (contactId) {
      await attachLeadNote(contactId, completedBefore
        ? '<p>Signed in to the free lisp assessment — this identity already used its free run earlier (pre-CRM lead, backfilled as completed).</p>'
        : '<p>🔶 Signed in to the free lisp assessment — full assessment <strong>NOT completed</strong> yet.</p>');
    }
    await ref.set({ product: 'lisp', source: 'web', status, signupLeadAt: new Date().toISOString() });
    console.log('🟠 signup lead pushed:', email, status);
  } catch (e) {
    console.error('signup lead error:', e.message);
  }
}

// Cheap status flip (1 upsert) at funnel checkpoints. Self-swallowing.
async function setLeadStatus(user, status) {
  try {
    const email = String((user && user.email) || '').trim().toLowerCase();
    if (!email || !HUBSPOT_TOKEN) return;
    await ensureHubspotProperties();
    await upsertLeadContact(email, { email, [LEAD_STATUS_PROP]: status, [LEAD_PRODUCT_PROP]: 'lisp' });
  } catch (e) {
    console.error('lead status update failed:', e.message);
  }
}

// Back-compat: leads parked by the old tsh-lead-alert transport carry
// {name,email,message}; synthesize the HubSpot shape so the sweep can still
// deliver them.
function normalizeParkedLead(p) {
  if (p.contactProps && p.noteBody) return p;
  return {
    email: p.email,
    contactProps: { email: String(p.email || '').toLowerCase(), firstname: p.name || '', lifecyclestage: 'lead' },
    noteBody: '<p>' + escHtml(p.message || 'Free lisp assessment completed') + '</p>',
    date: p.date || new Date().toISOString(),
    sessionId: p.sessionId || ''
  };
}

// Re-drive every parked lead. This is what makes HubSpot delivery eventually
// guaranteed rather than best-effort: a HubSpot outage now delays a lead
// instead of losing it. Driven by Cloud Scheduler against
// GET ?sweep=leads&key=<LEAD_ALERT_SECRET>.
async function sweepPendingLeadAlerts() {
  if (!firestore) return { error: 'no firestore' };
  if (!HUBSPOT_TOKEN) return { error: 'HUBSPOT_TOKEN unset' };
  // orderBy on the nested field returns only docs that actually carry it.
  const snap = await firestore.collection('lisp-users')
    .orderBy('leadAlertPending.at').limit(25).get();
  let sent = 0, failed = 0;
  const stuck = [];
  for (const doc of snap.docs) {
    const pending = (doc.data() || {}).leadAlertPending;
    if (!pending || !pending.payload) continue;
    const { ok, body, contactId } = await postLeadAlert(normalizeParkedLead(pending.payload));
    if (ok) {
      await setLeadAlerted(doc.id, pending.payload.sessionId || '');
      // Speed-to-lead task, same as the live path — without this, re-driven
      // completions never pinged the exec's phone. Old-style parked payloads
      // ({name,email,message}) carry no user/survey; skip the task for those.
      const p = pending.payload;
      if (p.user || p.survey) {
        const opener = buildOpener(p.user || {}, p.survey || {}, p.report);
        const wa = waLink(p.user || {}, opener);
        const gri = p.report && p.report.gri;
        await createLeadTask(contactId,
          `Call ${((p.survey && p.survey.first_name) || p.email).toString().split(' ')[0]} — just completed lisp assessment${gri != null ? ` (GRI ${gri})` : ''}`,
          opener + (wa ? `\n\nWhatsApp one-tap: ${wa}` : ''));
      }
      sent++;
      console.log('📨 parked lead delivered on retry:', pending.payload.email);
    } else {
      failed++;
      const attempts = (pending.attempts || 0) + 1;
      // Never give up on a lead, but make a chronically stuck one loud.
      if (attempts % 10 === 0) stuck.push({ email: pending.payload.email, attempts, lastError: String(body).slice(0, 200) });
      await doc.ref.set({
        leadAlertPending: { ...pending, attempts, lastError: String(body).slice(0, 500) }
      }, { merge: true });
    }
  }
  if (stuck.length) console.error('⚠️ leads still undelivered after many retries:', JSON.stringify(stuck));
  return { scanned: snap.size, sent, failed, stuck };
}

// Deliver the lead to HubSpot. NEVER throws: this runs after the analysis is
// already persisted, so a HubSpot failure downstream must not turn a successful
// part-2 response into a 500 — that would make the browser call
// markDeferredSectionsFailed() and show "couldn't finish" on a report that
// actually completed.
async function sendLeadAlert(user, survey, report, speakerContext) {
  try {
    const u = user || {};
    if (!u.email) { console.warn('No email — skipping HubSpot lead'); return; }
    if (!HUBSPOT_TOKEN) { console.warn('HUBSPOT_TOKEN unset — skipping HubSpot lead'); return; }

    if (await alreadyAlerted(u.uid, u.sessionId)) {
      console.log('🔁 lead already delivered for this session — skipping', u.email);
      return;
    }

    await ensureHubspotProperties();
    const ownerId = await resolveOwnerId();
    const s = survey || {};
    const phone = (u.phone || '').trim();
    const payload = {
      email: u.email,
      contactProps: {
        email: String(u.email).toLowerCase(),
        firstname: (s.first_name || '').trim(),
        phone: phone ? `${(u.countryCode || '').trim()} ${phone}`.trim() : '',
        lifecyclestage: 'lead',
        [LEAD_STATUS_PROP]: 'completed',
        [LEAD_PRODUCT_PROP]: 'lisp',
        assessment_completed_at: String(Date.now()),
        ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
        ...challengeProps('lisp')
      },
      noteBody: buildLeadNoteBody(user, survey, report, speakerContext),
      // Raw material for the PDF; parked with the payload so a sweep re-drive
      // can rebuild it.
      user: u, survey: s, report: report || null, speakerContext: speakerContext || null,
      date: new Date().toISOString(),
      sessionId: u.sessionId || ''
    };
    const { ok, body, contactId } = await postLeadAlert(payload);
    if (!ok) {
      // Part 2 runs exactly once per assessment, so there is no later attempt to
      // fall back on — park the lead and let the scheduled sweep finish the job.
      console.error(`❌ lead alert failed after ${LEAD_ALERT_ATTEMPTS} attempts:`, body);
      await parkLeadAlert(u.uid, { ...payload, sessionId: u.sessionId || '' }, body);
      return;
    }
    await setLeadAlerted(u.uid, u.sessionId);
    // Speed-to-lead: ping the exec's phone while the lead is still looking at
    // their result. Task body = the first-touch script + one-tap WhatsApp.
    {
      const opener = buildOpener(u, s, report);
      const wa = waLink(u, opener);
      const gri = report && report.gri;
      await createLeadTask(contactId,
        `Call ${(s.first_name || u.email).toString().split(' ')[0]} — just completed lisp assessment${gri != null ? ` (GRI ${gri})` : ''}`,
        opener + (wa ? `\n\nWhatsApp one-tap: ${wa}` : ''));
    }
    // Marker so a later sign-in doesn't re-push this person as a fresh
    // "signed_in" lead over their completed status.
    try {
      if (firestore) await firestore.collection('hubspot-leads').doc(String(u.email).toLowerCase())
        .set({ product: 'lisp', status: 'completed', completedAt: new Date().toISOString() }, { merge: true });
    } catch (e) { /* marker only */ }
    console.log('📨 lead alert sent for', u.email, '→', body.slice(0, 200));
  } catch (err) {
    console.error('❌ lead alert error:', err);
  }
}

// Test-only surface for local smoke scripts — not used by the service itself.
module.exports._leadSync = { buildReportPdf, buildLeadNoteBody, normalizeParkedLead, postLeadAlert };
module.exports._placement = { placementCheck, placementCandidates, placementCropFilter, ffmpegPath };

// A word counts as a lisp hit when its judgment is a distortion type (matches the
// results page Judgment column); Accurate/Unclear/Omitted are NOT hits.
const LISP_HIT_JUDGMENTS = ['Interdental', 'Dentalized', 'Lateral', 'Whistling', 'Distorted'];

// Outcome tier (design panel, 2026-09-20). Turns rows + acoustic profile +
// self-report + capture quality into ONE honest verdict the page can act on,
// instead of asserting "clear" from a single sensor. Tiers: lisp_confident,
// lisp_mild, inconclusive, clear_likely, clear_confident. OUTCOME_MODE:
// off = not computed; shadow (default) = computed, persisted, sent to PostHog,
// returned to the client but not required to render; on = client renders the card.
const OUTCOME_MODE = process.env.OUTCOME_MODE || 'shadow';
function deriveOutcome(wordRows, sentenceRows, acoustics, survey, all95) {
  if (OUTCOME_MODE === 'off') return null;
  const words = (wordRows || []).filter(r => r && r.tier !== 5);
  const sents = sentenceRows || [];
  const hitW = words.filter(r => LISP_HIT_JUDGMENTS.includes(r.judgment));
  const hitS = sents.filter(r => LISP_HIT_JUDGMENTS.includes(r.judgment));
  const stress = (wordRows || []).filter(r => r && r.tier === 5 && LISP_HIT_JUDGMENTS.includes(r.judgment));
  const ac = acoustics && typeof acoustics === 'object' ? acoustics : {};
  const verdicts = Array.isArray(ac.verdicts) ? ac.verdicts : [];
  const flags = ac.flags || {};
  const self = String((survey && survey.trouble_words_response) || '');
  const quiet = !!(ac.capture && ac.capture.quiet);
  const mode = (arr) => { const c = {}; arr.forEach(r => { c[r.judgment] = (c[r.judgment] || 0) + 1; }); return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || null; };
  const out = { tier: null, type: null, reason: null, reasons: [], needs_live_check: false, self_report_conflict: false, capture_quiet: quiet, flat_report: !!all95, ear_hits: hitW.length + hitS.length, stress_hits: stress.length, acoustic_verdicts: verdicts };
  if (hitW.length >= 3 || hitS.length >= 2) {
    out.tier = 'lisp_confident'; out.type = mode(hitW.concat(hitS)); out.reason = 'ear'; out.reasons.push(`${hitW.length} word${hitW.length === 1 ? '' : 's'} and ${hitS.length} sentence${hitS.length === 1 ? '' : 's'} showed a distortion`);
  } else if (hitW.length >= 1 || hitS.length >= 1 || stress.length >= 2) {
    out.tier = 'lisp_mild'; out.type = mode(hitW.concat(hitS, stress)); out.reason = hitW.length || hitS.length ? 'ear' : 'stress'; out.reasons.push(stress.length && !hitW.length && !hitS.length ? 'clean on single words; slipped on the fast and sustained items' : 'a few sounds slipped');
  } else if (verdicts.some(v => /frontal|lateral|weak/.test(v))) {
    out.tier = 'inconclusive'; out.reason = 'acoustic'; out.needs_live_check = true; out.reasons.push('the listener heard clean sounds, but the recording measured a repeated forward or sideways airflow pattern');
  } else if ((flags.whistle || 0) >= 2 || verdicts.includes('whistle')) {
    out.tier = 'inconclusive'; out.reason = 'possible_whistle'; out.needs_live_check = true; out.reasons.push('a high whistle was measured on more than one s-sound');
  } else if (ac.placement && /^(forward|lateral)$/.test(ac.placement.signal || '')) {
    out.tier = 'inconclusive'; out.reason = 'camera'; out.needs_live_check = true;
    out.reasons.push(ac.placement.signal === 'forward' ? `the camera saw the tongue forward on ${ac.placement.forward} of ${ac.placement.checked} s-sounds it checked, though they sounded clean` : `the camera saw a sideways mouth posture on ${ac.placement.lateral} of ${ac.placement.checked} s-sounds it checked`);
  } else if (/noticeable|significant/.test(self)) {
    out.tier = 'inconclusive'; out.reason = 'self_report'; out.needs_live_check = true; out.self_report_conflict = true; out.reasons.push('you said you notice it; these recordings did not show it');
  } else if (quiet || all95) {
    out.tier = 'clear_likely'; out.reason = quiet ? 'quiet_capture' : 'flat_report'; out.reasons.push(quiet ? 'the recording was very quiet' : 'every item scored the same');
  } else if (/slight|not_sure/.test(self)) {
    out.tier = 'clear_likely'; out.reason = 'self_report_unsure'; out.reasons.push('nothing showed in these recordings');
  } else {
    out.tier = 'clear_confident'; out.reason = 'clean'; out.reasons.push('single words, fast items and sentences all stayed clear');
  }
  if (/^lisp_/.test(out.tier) && /none/.test(self)) out.self_report_conflict = true;
  return out;
}

// "I can still hear it" — the results page's escape hatch. Marks the record for
// a human listen, opens a rep task and fires PostHog. QA runs never create tasks.
async function requestHumanReview(body) {
  const user = body.user || {};
  const uid = String(user.uid || body.uid || '').trim();
  const email = String(user.email || body.email || '').trim().toLowerCase();
  const reason = String(body.reason || 'user_disagrees').slice(0, 200);
  const at = new Date().toISOString();
  if (firestore && uid) {
    await firestore.collection('lisp-users').doc(uid).set({ review: { status: 'requested', reason, requestedAt: at } }, { merge: true });
  }
  if (HUBSPOT_TOKEN && email && body.test !== true) {
    try {
      await ensureHubspotProperties();
      const up = await upsertLeadContact(email, { email, [LEAD_STATUS_PROP]: 'review_requested', [LEAD_PRODUCT_PROP]: 'lisp' });
      const contactId = leadContactId(up);
      if (contactId) {
        await attachLeadNote(contactId, `<p>👂 <b>Asked for a human listen</b> — "${escHtml(reason)}". Reply within 24 h with what you hear.</p>`);
        await createLeadTask(contactId, `👂 ${email} says the test missed their lisp — listen and reply within 24 h`,
          `Reason: ${reason}\nOpen the record in lisp-label-ui (uid ${uid}) and listen to the flagged clips; reply by email with what you hear and whether it is worth working on.`);
      }
    } catch (e) { console.warn('review_request HubSpot error:', e.message); }
  }
  try {
    const distinctId = user.posthogId;
    if (distinctId) await fetch(`${POSTHOG_HOST}/capture/`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_KEY, event: 'review_requested', distinct_id: distinctId, properties: { reason, product: 'lisp' } }) });
  } catch (e) { /* best-effort */ }
  return { ok: true, status: 'requested' };
}
function deriveLispSummary(categories, gri, acoustics) {
  let lispDetected = false, lispWordCount = 0, scored = 0, all95 = true;
  const lispWords = [];
  (categories || []).forEach(cat => {
    (cat.rows || []).forEach(row => {
      if (typeof row.quality === 'number') { scored++; if (row.quality !== 95) all95 = false; }
      if (LISP_HIT_JUDGMENTS.includes(row.judgment)) {
        lispDetected = true;
        lispWordCount++;
        const label = row.word || row.sentence;
        if (label) lispWords.push(label);
      }
    });
  });
  const ac = acoustics && typeof acoustics === 'object' ? acoustics : null;
  const flags = ac && ac.flags ? Object.values(ac.flags).reduce((a, b) => a + (Number(b) || 0), 0) : null;
  return {
    lispDetected, lispWordCount, lispWords, lispGri: (typeof gri === 'number' ? gri : null),
    all95: scored > 0 && all95,
    acousticVerdicts: ac ? (ac.verdicts || []) : null,
    acousticFlagCount: flags,
    acousticsCoverage: ac ? `${ac.coverage}/${ac.clips}` : null,
    acousticsCalibrated: ac ? !!ac.calibrated : null,
    capturePeakDbfs: ac && ac.capture ? ac.capture.minPeakDbfs : null,
    faceVideo: !!(ac && ac.placement),
    placementForward: ac && ac.placement ? (ac.placement.forward || 0) : null,
    placementChecked: ac && ac.placement ? (ac.placement.checked || 0) : null,
    placementSignal: ac && ac.placement ? (ac.placement.signal || null) : null
  };
}
function acousticsHasVideo(summary) { return !!(summary && summary.faceVideo); }

// Fire the 'assessment_completed' PostHog event server-side. The browser used to do
// this, but the Gemini call takes 1–2 min and users often leave first, so the client
// capture raced the outcome or never sent. Here we have the outcome + posthogId and
// run to completion regardless of the tab. Also triggers the "Lisp Nurturing Sequence"
// Messaging workflow. Person props are attached via $set.
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const POSTHOG_KEY = process.env.POSTHOG_API_KEY || 'phc_WFJFjSjFujXoTr85nd8fyZ6BdKtdo27RTADMbvnJn2O';
async function sendPosthogAssessmentCompleted(user, survey, summary) {
  try {
    const distinctId = user && user.posthogId;
    if (!distinctId) { console.warn('No posthogId — skipping PostHog assessment_completed'); return; }
    const s = survey || {};
    const properties = {
      trouble_words_response: s.trouble_words_response || '',
      age_group: s.age_group || '',
      found_on: s.found_on || '',
      lisp_detected: summary.lispDetected,
      lisp_word_count: summary.lispWordCount,
      lisp_words: summary.lispWords,
      lisp_gri: summary.lispGri,
      all_95: summary.all95,
      acoustic_verdicts: summary.acousticVerdicts,
      acoustic_flag_count: summary.acousticFlagCount,
      acoustics_coverage: summary.acousticsCoverage,
      acoustics_calibrated: summary.acousticsCalibrated,
      capture_peak_dbfs: summary.capturePeakDbfs,
      face_video: !!(acousticsHasVideo(summary)),
      placement_forward: summary.placementForward,
      placement_checked: summary.placementChecked,
      placement_signal: summary.placementSignal,
      outcome_tier: summary.outcome ? summary.outcome.tier : null,
      outcome_type: summary.outcome ? summary.outcome.type : null,
      outcome_reason: summary.outcome ? summary.outcome.reason : null,
      self_report_conflict: summary.outcome ? summary.outcome.self_report_conflict : null,
      needs_live_check: summary.outcome ? summary.outcome.needs_live_check : null,
      $set: {
        ...(summary.outcome ? { outcome_tier: summary.outcome.tier } : {}),
        lisp_detected: summary.lispDetected,
        lisp_word_count: summary.lispWordCount,
        lisp_gri: summary.lispGri,
        ...(user.email ? { email: user.email } : {}),
        ...(s.first_name ? { first_name: s.first_name } : {})
      }
    };
    const resp = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_KEY, event: 'assessment_completed', distinct_id: distinctId, properties })
    });
    if (!resp.ok) console.error('❌ PostHog capture failed:', resp.status, await resp.text());
    else console.log('✅ PostHog assessment_completed sent for', distinctId);
  } catch (err) {
    console.error('❌ PostHog capture error:', err);
  }
}

// ---------------------------------------------------------------------------
// Calendly: next real opening for the consult event (results-page card).
// GET ?calendly=next → { next: ISO-8601 | null, tz, eventType }. Uses the
// Calendly v2 API with a personal access token (CALENDLY_TOKEN); the event type
// is resolved from CALENDLY_EVENT_URL's slug once, availability is cached 60 s.
const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN || '';
const CALENDLY_EVENT_URL = process.env.CALENDLY_EVENT_URL || 'https://calendly.com/sufi-topspeech/consult';
const calendlyCache = { at: 0, data: null, eventType: '', tz: '' };
async function calendlyGet(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + CALENDLY_TOKEN } });
  if (!r.ok) throw new Error('Calendly ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}
async function calendlyNextOpening() {
  if (!CALENDLY_TOKEN) return { next: null, reason: 'no_token' };
  if (calendlyCache.data && Date.now() - calendlyCache.at < 60000) return calendlyCache.data;
  if (!calendlyCache.eventType) {
    const me = await calendlyGet('https://api.calendly.com/users/me');
    const userUri = me.resource && me.resource.uri;
    calendlyCache.tz = (me.resource && me.resource.timezone) || '';
    const list = await calendlyGet('https://api.calendly.com/event_types?user=' + encodeURIComponent(userUri) + '&active=true&count=100');
    const slug = CALENDLY_EVENT_URL.replace(/\/+$/, '').split('/').pop().toLowerCase();
    const items = list.collection || [];
    const et = items.find(e => String(e.scheduling_url || '').toLowerCase().replace(/\/+$/, '').endsWith('/' + slug)) || items[0];
    if (!et) return { next: null, reason: 'no_event_type' };
    calendlyCache.eventType = et.uri;
  }
  // The available-times endpoint accepts at most a 7-day window.
  const start = new Date(Date.now() + 5 * 60000).toISOString();
  const end = new Date(Date.now() + 7 * 86400000 - 60000).toISOString();
  const r = await calendlyGet('https://api.calendly.com/event_type_available_times?event_type=' + encodeURIComponent(calendlyCache.eventType) + '&start_time=' + start + '&end_time=' + end);
  const first = (r.collection || []).map(x => x.start_time).filter(Boolean).sort()[0] || null;
  calendlyCache.data = { next: first, tz: calendlyCache.tz, eventType: calendlyCache.eventType, fetchedAt: new Date().toISOString() };
  calendlyCache.at = Date.now();
  return calendlyCache.data;
}

// ---------------------------------------------------------------------------
// Face-video placement check ("placement classifier v1", 2026-09-20). The client
// uploads one consented full-face video per session plus per-item marks. For the
// tokens the acoustics flagged, pull three mouth frames at the /s/ instant and
// ask Gemini vision where the tongue is. Camera evidence only ever ADDS a note
// (or, when it agrees with the acoustics on ≥2 tokens, applies the same bounded
// cap fuseAcoustics uses) — it never overrides the ear on its own.
const FACE_BUCKET = process.env.FACE_VIDEO_BUCKET || 'rollr-academy.firebasestorage.app';
// VISION_MODE: 'all' (default) looks at every /s,z/ word take that has a video
// mark — the camera is an independent signal next to the ear and the acoustics,
// not just a confirmation of flagged tokens. 'flagged' restores the v1 behaviour.
const VISION_MODE = (process.env.VISION_MODE || 'all').toLowerCase();
const PLACEMENT_MAX_TOKENS = Math.max(1, Number(process.env.VISION_MAX_TAKES) || (VISION_MODE === 'all' ? 12 : 6));
let _ffmpegPath = null;
function ffmpegPath() {
  if (_ffmpegPath !== null) return _ffmpegPath;
  const fs = require('fs');
  let p = '';
  try { p = require('@ffmpeg-installer/ffmpeg').path || ''; } catch (e) { p = ''; }
  if (!p || !fs.existsSync(p)) {
    // Fallback: a system ffmpeg (local dev, or a base image that ships one).
    try { p = require('child_process').execSync('command -v ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { p = ''; }
    if (!p) p = ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg'].find(x => fs.existsSync(x)) || '';
  }
  _ffmpegPath = p;
  if (!p) console.warn('🎥 ffmpeg not found (installer package + PATH)');
  return _ffmpegPath;
}
function runFfmpeg(args, timeoutMs) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath();
    if (!bin) return reject(new Error('ffmpeg unavailable'));
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs || 20000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(-200))); });
  });
}
// Candidate tokens = acoustically flagged /s/ moments with a known clip window
// and a video mark for that item. Time in the video = mark.start + recorder
// latency + window midpoint.
function placementCandidates(video, wordRows, sentenceProbes) {
  const marks = new Map();
  (video.marks || []).forEach(m => { if (m && m.word != null && m.start != null) marks.set(String(m.word), m); });
  const lat = Number(video.recorderLatencyMs) || 150;
  const out = [];
  (wordRows || []).forEach(r => {
    if (!r || r.word == null) return;
    const m = marks.get(String(r.word)); if (!m) return;
    const flagged = !!(r.acoustic && !/whistle/.test(r.acoustic));
    if (VISION_MODE !== 'all' && !flagged) return;
    // Only /s/ and /z/ targets are informative for placement; th/sh/ch/j words are not.
    if (!flagged && !/^[SZ]$/.test(acLabelForWord(r.word, r.type))) return;
    let sec;
    if (r.s_start != null) sec = (Number(r.s_start) + Number(r.s_end != null ? r.s_end : r.s_start)) / 2;
    else if (m.end != null && m.end > m.start) {
      // No measured window: the /s/ of an initial word sits early in the take, a
      // final one late; the take starts ~0.3 s before the word (VAD lead-in).
      const dur = (m.end - m.start) / 1000, pos = String(r.position || '').toLowerCase();
      sec = pos === 'final' ? Math.max(0.3, dur * 0.7) : pos === 'medial' ? Math.max(0.3, dur * 0.5) : Math.min(dur * 0.45, 0.3 + 0.15);
    } else sec = 0.4;
    out.push({ key: 'w:' + r.word, label: String(r.word), kind: flagged ? r.acoustic : 'none', flagged, tMs: m.start + lat + sec * 1000, row: r, mark: m });
  });
  (sentenceProbes || []).forEach(p => {
    const m = marks.get(String(p.word)); if (!m) return;
    acSegments(p.acoustics).forEach(sg => {
      if (!sg.ac || !(sg.ac.frontal || sg.ac.lateral) || sg.start == null) return;
      const mid = (Number(sg.start) + Number(sg.end != null ? sg.end : sg.start)) / 2;
      out.push({ key: 's:' + p.word + '@' + sg.start, label: `"${String(p.word).slice(0, 40)}" at ${Number(sg.start).toFixed(1)} s`, kind: sg.ac.frontal ? 'frontal' : 'lateral', tMs: m.start + lat + mid * 1000, probe: p, seg: sg });
    });
  });
  // Flagged tokens first (frontal before lateral), then the unflagged /s,z/ takes
  // spread across the list so the sample covers the whole session.
  const rank = c => c.kind === 'frontal' ? 0 : c.kind === 'lateral' ? 1 : c.flagged ? 2 : 3;
  const flaggedC = out.filter(c => c.flagged).sort((a, b) => rank(a) - rank(b));
  const rest = out.filter(c => !c.flagged);
  const room = Math.max(0, PLACEMENT_MAX_TOKENS - flaggedC.length);
  let pick = rest;
  if (rest.length > room) { const step = rest.length / Math.max(1, room); pick = Array.from({ length: room }, (_, i) => rest[Math.floor(i * step)]); }
  return flaggedC.slice(0, PLACEMENT_MAX_TOKENS).concat(pick);
}
// Mouth crop from the live framing metrics the client stores per take
// (MediaPipe box: face height fh, centre cx/cy, mouth y — all normalised).
// Falls back to the lower-middle of the frame when no metrics were kept.
function placementCropFilter(mark) {
  const f = mark && mark.framing && mark.framing.last ? mark.framing.last : null;
  let cx = 0.5, my = 0.68, fh = 0.55;
  if (f && Number.isFinite(f.cx) && Number.isFinite(f.fh)) { cx = f.cx; fh = Math.max(0.25, Math.min(0.9, f.fh)); my = Number.isFinite(f.mouthY) ? f.mouthY : (Number.isFinite(f.cy) ? f.cy + fh * 0.3 : 0.68); }
  // Crop box ≈ 0.95 face widths × 0.5 face heights around the mouth (face width ≈ 0.75 × face height in pixels).
  const wN = Math.min(0.9, Math.max(0.3, fh * 0.75 * 0.95 * 0.75)); // in frame-width units (assumes 4:3)
  const hN = Math.min(0.7, Math.max(0.25, fh * 0.5));
  const x0 = Math.max(0, Math.min(1 - wN, cx - wN / 2)), y0 = Math.max(0, Math.min(1 - hN, my - hN * 0.55));
  return `crop=iw*${wN.toFixed(3)}:ih*${hN.toFixed(3)}:iw*${x0.toFixed(3)}:ih*${y0.toFixed(3)},scale=360:-2:flags=lanczos`;
}
const PLACEMENT_PROMPT = `You are a speech-language pathologist reviewing still frames from a front-facing phone camera. The first image is one full frame for context. Each token below then shows three consecutive frames (about 80 ms apart), cropped to the mouth and enlarged, captured at the instant the speaker produced an /s/ (or /z/) sound in the word or sentence named. Look only at the mouth: tongue tip, front teeth, jaw and lips. Most tokens are NOT flagged by the audio; judge each on what you see and prefer "unclear" over a guess.
Classify the tongue placement for each token. Most speakers, including most of the people in this test, show "behind-teeth"; judge every token separately and on visible evidence only.
- "interdental": the tongue tip is clearly visible between or in front of the upper and lower front teeth. Do not use this when the tongue is merely close to the teeth or you are inferring it.
- "dentalized": teeth slightly apart and the tongue tip visibly pressed against the back of the upper front teeth at the gum line. Use this only when the tongue itself is visible.
- "behind-teeth": teeth close together or slightly apart, tongue not visible — normal /s/ posture.
- "lateral-cue": clear jaw or lip asymmetry, or the tongue visible at one side.
- "unclear": mouth not visible, blurred, hand or phone in the way, closed lips, or the frames are not on an /s/.
Return ONLY a JSON array, one object per token in order: [{"token": 1, "placement": "interdental|dentalized|behind-teeth|lateral-cue|unclear", "confidence": 0.0-1.0, "note": "at most 12 plain words"}]`;
async function placementCheck(video, wordRows, sentenceProbes) {
  const result = { checked: 0, forward: 0, normal: 0, unclear: 0, lateral: 0, tokens: [], error: null };
  if (!video || !video.path) { console.log('🎥 placement check skipped: no video path in request'); return null; }
  const cands = placementCandidates(video, wordRows, sentenceProbes);
  console.log(`🎥 placement check: video=${video.path} marks=${(video.marks || []).length} flagged-candidates=${cands.length}` + (cands.length ? ' [' + cands.map(c => c.label + '@' + Math.round(c.tMs) + 'ms').join(', ') + ']' : ''));
  if (!cands.length) { result.note = 'no flagged /s/ tokens with a video mark'; return result; }
  const fs = require('fs'), os = require('os'), path = require('path');
  const DEBUG_DIR = process.env.PLACEMENT_DEBUG_DIR || '';
  const dir = DEBUG_DIR ? (fs.mkdirSync(DEBUG_DIR, { recursive: true }), DEBUG_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'face-'));
  const t0 = Date.now();
  try {
    const ext = /mp4/.test(String(video.mime || video.path)) ? 'mp4' : 'webm';
    const local = path.join(dir, 'face.' + ext);
    // PLACEMENT_LOCAL_VIDEO: offline evaluation (eval-vision.js) — read a file
    // instead of the bucket. Never set in production.
    if (process.env.PLACEMENT_LOCAL_VIDEO) fs.copyFileSync(process.env.PLACEMENT_LOCAL_VIDEO, local);
    else await admin.storage().bucket(FACE_BUCKET).file(String(video.path)).download({ destination: local });
    const parts = [{ text: PLACEMENT_PROMPT }];
    // One linear decode: pick the frame nearest each wanted instant (t-80, t, t+80 ms)
    // for every candidate. Output files are numbered in time order, so sort the
    // wanted instants and map them back.
    // Negative controls: the first 120 ms of two takes (the lead-in before the word,
    // mouth at rest) go in as ordinary tokens. A model that calls those "interdental"
    // is not reading the frames, and the whole pass is marked unreliable.
    const lat = Number(video.recorderLatencyMs) || 150;
    const ctlMarks = (video.marks || []).filter(m => m && m.start != null && m.end != null && m.end - m.start > 600).slice(0, 8);
    [ctlMarks[1], ctlMarks[Math.min(6, ctlMarks.length - 1)]].filter(Boolean).forEach((m, k) => {
      if (cands.some(c => c.control && c.mark === m)) return;
      cands.push({ key: 'ctl:' + k, label: String(m.word || 'take'), kind: 'none', flagged: false, control: true, tMs: m.start + lat + 120, row: null, mark: m });
    });
    const wants = [];
    cands.forEach((c, ci) => (c.control ? [0, 80] : [-80, 0, 80]).forEach(off => wants.push({ ci, t: Math.max(0, c.tMs + off) / 1000 })));
    wants.sort((a, b) => a.t - b.t);
    const expr = wants.map(w => `lt(abs(t-${w.t.toFixed(3)})\\,0.02)`).join('+');
    try {
      await runFfmpeg(['-y', '-loglevel', 'error', '-err_detect', 'ignore_err', '-i', local, '-vf', `select='${expr}',scale=480:-2`, '-vsync', 'vfr', '-q:v', '5', path.join(dir, 'f%03d.jpg')], 120000);
    } catch (e) { console.warn('🎥 frame extraction failed:', e.message); }
    const produced = fs.readdirSync(dir).filter(f => /^f\d{3}\.jpg$/.test(f)).sort();
    // ffmpeg emits at most one frame per matched instant, in order; align by index.
    // Each kept frame is then cropped to the mouth (framing metrics of that take).
    const byCand = new Map();
    let context = null;
    for (let i = 0; i < produced.length; i++) {
      const f = produced[i], w = wants[i]; if (!w) break;
      const full = path.join(dir, f);
      if (fs.statSync(full).size <= 2000) continue;
      if (!context) context = fs.readFileSync(full).toString('base64');
      const c = cands[w.ci];
      const cropped = path.join(dir, f.replace(/\.jpg$/, 'm.jpg'));
      let b64 = null;
      // Crop only when the take carries live framing metrics (a blind crop can miss
      // the mouth entirely); otherwise the model gets the full frame.
      const hasBox = !!(c.mark && c.mark.framing && c.mark.framing.last && Number.isFinite(c.mark.framing.last.cx));
      if (hasBox) { try { await runFfmpeg(['-y', '-loglevel', 'error', '-i', full, '-vf', placementCropFilter(c.mark), '-q:v', '4', cropped], 15000); b64 = fs.readFileSync(cropped).toString('base64'); } catch (e) { b64 = null; } }
      if (!b64) b64 = fs.readFileSync(full).toString('base64');
      if (!byCand.has(w.ci)) byCand.set(w.ci, []);
      byCand.get(w.ci).push(b64);
    }
    if (context) { parts.push({ text: '\nContext: one full frame from this session.' }); parts.push({ inline_data: { mime_type: 'image/jpeg', data: context } }); }
    let n = 0;
    cands.forEach((c, ci) => {
      const frames = byCand.get(ci) || [];
      if (!frames.length) return;
      n++;
      c.token = n;
      parts.push({ text: `\nToken ${n}: /s/ in ${c.label}` + (c.flagged ? ` (audio cue: ${c.kind})` : ' (no audio cue)') + ` — ${frames.length} mouth frame(s)` });
      if (c.control) c.label = c.label + ' (control)';
      frames.forEach(b64 => parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } }));
    });
    if (!n) { result.note = 'no frames could be extracted'; return result; }
    const { rawText } = await callGemini(parts);
    if (DEBUG_DIR) {
      try {
        fs.writeFileSync(path.join(dir, 'vision-reply.txt'), String(rawText || ''));
        // Which extracted frames went with which token (for contact sheets / audits).
        const fileByCand = new Map();
        produced.forEach((f, i) => { const w = wants[i]; if (!w) return; if (!fileByCand.has(w.ci)) fileByCand.set(w.ci, []); fileByCand.get(w.ci).push(fs.existsSync(path.join(dir, f.replace(/\.jpg$/, 'm.jpg'))) ? f.replace(/\.jpg$/, 'm.jpg') : f); });
        fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify(cands.filter(c => c.token).map(c => ({ token: c.token, label: c.label, control: !!c.control, tMs: Math.round(c.tMs), files: fileByCand.get(cands.indexOf(c)) || [] })), null, 1));
      } catch (e) {}
    }
    console.log('🎥 vision reply:', String(rawText || '').replace(/\s+/g, ' ').slice(0, 600));
    const m = String(rawText || '').match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    const byToken = new Map(); (Array.isArray(arr) ? arr : []).forEach(x => { if (x && x.token != null) byToken.set(Number(x.token), x); });
    cands.filter(c => c.token).forEach(c => {
      const v = byToken.get(c.token) || {};
      const placement = String(v.placement || 'unclear').toLowerCase();
      const conf = Math.max(0, Math.min(1, Number(v.confidence) || 0));
      if (c.control) {
        // Rest-mouth frames: anything but behind-teeth/unclear here is a hallucination.
        result.controls = (result.controls || 0) + 1;
        if (/interdental|dentalized|lateral/.test(placement) && conf >= 0.5) result.controlFails = (result.controlFails || 0) + 1;
        return;
      }
      result.checked++;
      // Only a tongue visibly between the teeth counts as forward evidence; the
      // "dentalized" reading is too easy to over-apply to a normal /s/ and is kept
      // as a note-level observation.
      const forward = placement === 'interdental' && conf >= 0.6;
      const dental = placement === 'dentalized' && conf >= 0.6;
      const normal = placement === 'behind-teeth' && conf >= 0.7;
      if (forward) result.forward++; else if (dental) result.dental = (result.dental || 0) + 1; else if (normal) result.normal++; else if (placement === 'lateral-cue' && conf >= 0.6) result.lateral++; else result.unclear++;
      result.tokens.push({ label: c.label, cue: c.kind, flagged: !!c.flagged, placement, confidence: conf, note: String(v.note || '').slice(0, 120) });
      // Row notes: forward placement is always worth naming; "looked normal" only
      // matters where the audio flagged the token (it argues against the flag).
      const note = forward ? 'Camera: the tongue tip is visible between the teeth on this s-sound.'
        : (dental && c.flagged) ? 'Camera: the tongue looks pressed against the front teeth on this s-sound.'
        : (normal && c.flagged) ? 'Camera: tongue placement looked normal on this s-sound — worth checking live.' : '';
      if (!note) return;
      const target = c.row || null;
      if (target) target.observation = `${target.observation || ''} ${note}`.trim();
      else if (c.probe) { c.probe.placementNote = `${c.probe.placementNote || ''} ${note}`.trim(); }
    });
    // Speaker-level camera signal. 'forward' needs at least two forward tokens
    // and a quarter of what was checked; 'normal' needs a clear majority of
    // readable tokens with at most one forward reading.
    const readable = result.forward + result.normal + result.lateral + (result.dental || 0);
    const notes = result.tokens.map(t => t.note.toLowerCase().trim()).filter(Boolean);
    // A blanket verdict is only suspicious when it is a positive claim: twelve
    // identical "behind-teeth, tongue not visible" readings are what a normal
    // speaker looks like; twelve identical "interdental" readings with the same
    // note are a model that stopped looking.
    const blanket = result.tokens.length >= 8 && new Set(result.tokens.map(t => t.placement + '|' + t.note.toLowerCase().trim())).size === 1 && /interdental|dentalized|lateral/.test(result.tokens[0].placement);
    result.reliable = !(result.controlFails > 0) && !blanket;
    if (!result.reliable) console.warn(`🎥 placement pass unreliable: controls failed ${result.controlFails || 0}/${result.controls || 0}${blanket ? ', identical verdict on every token' : ''}`);
    result.signal = !result.reliable ? 'unclear'
      : (result.forward >= 2 && result.forward >= Math.ceil(result.checked * 0.25)) ? 'forward'
      : (result.lateral >= 2 && result.lateral >= Math.ceil(result.checked * 0.25)) ? 'lateral'
      : (readable >= 3 && (result.normal + (result.dental || 0)) >= Math.ceil(readable * 0.6) && result.forward <= 1) ? 'normal' : 'unclear';
    // Bounded cap (same as fuseAcoustics) only where camera AND acoustics agree on
    // the same token and the ear still said clean. Camera alone never rewrites a
    // row; it surfaces through the outcome (needs a live check) instead.
    if (result.reliable && result.forward >= 2) {
      cands.filter(c => c.row && c.token && c.flagged && /frontal/.test(c.kind)).forEach(c => {
        const t = result.tokens.find(x => x.label === c.label);
        if (!t || !/interdental/.test(t.placement)) return;
        if (/^accurate$/i.test(String(c.row.judgment || '')) && (Number(c.row.quality) || 0) > AC_CAP_QUALITY) { c.row.quality = AC_CAP_QUALITY; c.row.judgment = t.placement === 'interdental' ? 'Interdental' : 'Dentalized'; c.row.acoustic = (c.row.acoustic || '') + '+camera'; }
      });
    }
    result.ms = Date.now() - t0;
    console.log(`🎥 placement check: ${result.checked} tokens (forward ${result.forward}, dental ${result.dental || 0}, normal ${result.normal}, lateral ${result.lateral}, unclear ${result.unclear}; controls ${result.controls || 0}, failed ${result.controlFails || 0}) → ${result.signal}${result.reliable ? '' : ' (unreliable)'} in ${result.ms} ms`);
    return result;
  } catch (e) {
    console.warn('🎥 placement check failed:', e.message);
    result.error = e.message;
    return result;
  } finally {
    if (!DEBUG_DIR) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }
}

async function transcribeWithWhisper(audioB64, mimeType, prompt) {
  const buf = Buffer.from(stripDataUrlPrefix(audioB64), 'base64');
  const type = mimeType || 'audio/webm';
  const ext = type.includes('webm') ? 'webm' : type.includes('mp4') ? 'mp4' : type.includes('wav') ? 'wav' : 'webm';

  const form = new FormData();
  form.append('file', new Blob([buf], { type }), `audio.${ext}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'en');
  form.append('temperature', '0');
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt);

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: form
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq Whisper ${resp.status} — ${errText}`);
  }
  const data = await resp.json();
  return (data.text || '').trim();
}

functions.http('transcribeAudio', (req, res) => {
  corsMiddleware(req, res, async () => {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { audioData, mimeType, prompt } = req.body || {};
      if (!audioData) return res.status(400).json({ error: 'audioData required' });
      const text = await transcribeWithWhisper(audioData, mimeType, prompt);
      console.log(`🗣️  Whisper transcript: "${text}" (target prompt: "${prompt || ''}")`);
      res.status(200).json({ text });
    } catch (err) {
      console.error('❌ transcribeAudio error:', err);
      res.status(500).json({ error: err.message });
    }
  });
});

functions.http('analyzeLispSpeech', async (req, res) => {
  console.log('🚀 Lisp analysis request received');
  corsMiddleware(req, res, async () => {
    if (req.method === 'OPTIONS') return res.status(200).end();

    // GET — durable result rehydration. The full analysis is persisted server-side
    // to lisp-users/{uid} the moment it finishes, so the browser can recover it
    // after a refresh / iOS tab discard (which wipes the in-memory part-2 promise)
    // instead of falsely showing "couldn't finish". Returns { status, latestAssessment? }.
    if (req.method === 'GET' && req.query && req.query.calendly === 'next') {
      try { return res.status(200).json(await calendlyNextOpening()); }
      catch (e) { console.warn('calendly next-opening error:', e.message); return res.status(200).json({ next: null, reason: 'error' }); }
    }
    if (req.method === 'GET') {
      try {
        // Scheduled retry sweep for parked lead alerts (Cloud Scheduler).
        if (req.query && req.query.sweep === 'leads') {
          if (!LEAD_ALERT_SECRET || req.query.key !== LEAD_ALERT_SECRET) {
            return res.status(401).json({ error: 'unauthorized' });
          }
          return res.status(200).json(await sweepPendingLeadAlerts());
        }
        // Post-login gate: has this identity already used its free assessment?
        // ?check=entitlement&email=&authUserId=&phone= → { allowed, tier }.
        if (req.query && req.query.check === 'entitlement') {
          const identity = {
            authUserId: ((req.query.authUserId) || '').toString().trim(),
            email: ((req.query.email) || '').toString().trim(),
            phone: ((req.query.phone) || '').toString().trim(),
            name: ((req.query.name) || '').toString().trim(),
            country: ((req.query.country) || '').toString().trim(),
            src: ((req.query.src) || '').toString().trim()
          };
          const ent = await lookupEntitlement(identity);
          // Sign-in IS the lead: push to HubSpot now, not at completion.
          // Awaited so Cloud Run doesn't throttle it away after the response.
          await sendSignupLead(identity, ent);
          return res.status(200).json(ent);
        }
        const uid = ((req.query && req.query.uid) || '').toString().trim();
        if (!uid) return res.status(400).json({ error: 'uid required' });
        if (!firestore) return res.status(200).json({ status: 'unknown' });
        const snap = await firestore.collection('lisp-users').doc(uid).get();
        if (!snap.exists) return res.status(200).json({ status: 'missing' });
        const d = snap.data() || {};
        const a = d.latestAssessment || null;
        if (a && !a.partial && Array.isArray(a.categories) && a.categories.length) {
          return res.status(200).json({
            status: 'ready',
            latestAssessment: { gri: a.gri ?? null, categories: a.categories, result: a.result || '', completedAt: a.completedAt || null, outcome: a.outcome || null, acoustics: a.acoustics || null },
            review: d.review || null
          });
        }
        // Report a genuine failure only when it's newer than the current partial write
        // (a stale error from a prior attempt must not fail a fresh in-progress run).
        if (d.lastAnalysisError && d.lastAnalysisError.mode !== 'words') {
          const errAt = Date.parse(d.lastAnalysisError.at || '') || 0;
          const partAt = a ? (Date.parse(a.completedAt || '') || 0) : 0;
          if (errAt >= partAt) return res.status(200).json({ status: 'failed', error: d.lastAnalysisError });
        }
        return res.status(200).json({ status: a ? 'partial' : 'pending' });
      } catch (err) {
        console.error('❌ getLispAssessment (GET) error:', err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
      if (!req.headers['content-type']?.includes('application/json')) {
        return res.status(400).json({ error: 'Expected application/json' });
      }

      // Buy-intent beacon: the browser reports an opened checkout. The hottest
      // call an exec can make is within minutes of an abandoned checkout, so
      // this flips status AND pings the exec's phone via a due-now task
      // (deduped to once per 6h — checkout modals reopen a lot).
      if (req.body && req.body.beacon === 'checkout_open') {
        try {
          const email = String((req.body.user && req.body.user.email) || req.body.email || '').trim().toLowerCase();
          if (email && HUBSPOT_TOKEN && req.body.test !== true) {
            await ensureHubspotProperties();
            const up = await upsertLeadContact(email, { email, [LEAD_STATUS_PROP]: 'checkout_opened', [LEAD_PRODUCT_PROP]: 'lisp' });
            const contactId = leadContactId(up);
            let notify = true;
            if (firestore) {
              const ref = firestore.collection('hubspot-leads').doc(email);
              const d = (await ref.get()).data() || {};
              if (Date.now() - (Date.parse(d.checkoutNotifiedAt || '') || 0) < 6 * 3600 * 1000) notify = false;
              else await ref.set({ checkoutNotifiedAt: new Date().toISOString() }, { merge: true });
            }
            if (contactId && notify) {
              await attachLeadNote(contactId, '<p>🔥 Opened the $79 checkout — has not paid. Call/WhatsApp now.</p>');
              await createLeadTask(contactId, `🔥 ${email} opened checkout — call now if no payment`,
                'Opened the $79 checkout. If no payment lands in the next few minutes, this is the highest-intent call of the day.');
            }
          }
        } catch (e) { console.error('checkout beacon error:', e.message); }
        return res.status(200).json({ ok: true });
      }

      // "I can still hear it" beacon from the results page → human review queue.
      if (req.body && req.body.beacon === 'review_request') {
        try { return res.status(200).json(await requestHumanReview(req.body)); }
        catch (e) { console.error('review beacon error:', e.message); return res.status(200).json({ ok: false }); }
      }

      const { words, voiceType, mode } = req.body || {};
      if (!Array.isArray(words) || !words.length) {
        return res.status(400).json({ error: 'words array required' });
      }

      const country = req.headers['x-appengine-country'] || req.headers['x-country'] || 'Unspecified';
      const region = req.headers['x-appengine-region'] || req.headers['x-region'] || 'Unspecified';
      const speakerContext = { country, region, voiceType: voiceType || 'unspecified' };
      console.log(`🎚️  Mode: ${mode || 'words'} | ${words.length} probes | voice: ${speakerContext.voiceType}`);

      // Free-once enforcement — gate the value-delivering PART-1 modes BEFORE any
      // Gemini spend. 'connected'/'sentences' are part-2/aux of an already-allowed
      // run and are never gated. Identity is resolved by authUserId OR email OR
      // phone (survey email+phone arrive with this request). Fails open.
      let entTier = 'free', personId = null;
      if (req.body && req.body.test === true) {
        // QA bypass — one simple signal (from the paywall "skip" control) to jump
        // the gate and test the full flow. Not counted/consumed.
        entTier = 'test';
      } else if (mode === 'combined' || mode === 'words' || mode == null) {
        const ent = await checkRetakeEntitlement(req.body && req.body.user);
        if (!ent.allowed) {
          console.log('🔒 retake_required — person', ent.personId);
          return res.status(402).json({ retake_required: true });
        }
        entTier = ent.tier; personId = ent.personId;
      }

      // Praat coverage: shows in Cloud logs whether acoustic metrics reached Gemini,
      // how many clips carried them, and a sample line. If Praat was down the client
      // falls back to ear-only silently — this makes that visible here.
      const acClient = words.filter(w => w.acoustics && !w.acoustics.error).length;
      if (mode !== 'sentences') await ensureAcoustics(words);
      const part1Ac = (req.body && req.body.part1 && req.body.part1.acoustics) || {};
      const acProfile = acousticProfile(words, { sMedianHz: part1Ac.sMedianHz, wordFlags: part1Ac.flags });
      const acWith = words.filter(w => w.acoustics && !w.acoustics.error).length;
      const acErr = words.filter(w => w.acoustics && w.acoustics.error).length;
      console.log(
        acWith
          ? `🔬 Praat acoustics: ${acWith}/${words.length} clips (${acClient} from client${acErr ? `, ${acErr} errored` : ''}) | profile: ${JSON.stringify(acousticSummary(acProfile))}`
          : `🔬 Praat acoustics MISSING on all ${words.length} clips — Gemini running EAR-ONLY`
      );

      if (mode === 'combined') {
        const wordProbes = words.filter(w => !acIsConnected(w) || w.type === 'rapid');
        const sentenceProbes = words.filter(w => w.type === 'sentence');
        const passageProbes = words.filter(w => acIsPassageLike(w));
        const { rawText, usage } = await analyzeCombinedWithGemini(wordProbes, sentenceProbes, passageProbes, speakerContext);
        const { wordPart, sentencePart, spontaneousPart } = splitCombinedResponse(rawText);
        const wordParsed = parseGeminiTable(wordPart, wordProbes.length);
        const sentenceParsed = parseSentenceTable(sentencePart, sentenceProbes.length);
        const spontaneous = passageProbes.length ? parseSpontaneous(spontaneousPart) : null;
        const acCapped = fuseAcoustics(wordParsed.words, wordProbes, acProfile) + fuseAcoustics(sentenceParsed.rows, sentenceProbes, acProfile);
        const acoustics = acousticSummary(acProfile, acCapped);
        // Attach each word's tier (from the probe metadata) so rows group into the
        // same category structure the results page renders and persists.
        const tierByWord = {};
        wordProbes.forEach(p => { if (p.word != null) tierByWord[p.word] = p.tier || 1; });
        const wordRows = wordParsed.words.map(r => ({ ...r, tier: tierByWord[r.word] || 1 }));
        // GRI from scored probes only (core words + sentences); the stress set
        // (tier 5) and the spontaneous sample are excluded.
        const allQ = wordRows.filter(r => r.tier !== 5).concat(sentenceParsed.rows).map(r => r.quality || 0);
        const gri = allQ.length ? Math.max(0, Math.min(100, Math.round(allQ.reduce((a, b) => a + b, 0) / allQ.length))) : 0;
        const categories = buildLispCategories(wordRows, sentenceParsed.rows, spontaneous);
        const result = lispStructuredToMarkdown(categories);

        // Write the Firestore record + fire the PostHog event HERE (server-side) so
        // both land even if the user already closed the tab — the browser no longer
        // does either. Awaited before the response so they complete regardless of the
        // client still listening.
        const lispSummary = deriveLispSummary(categories, gri, acoustics);
        const outcome = deriveOutcome(wordRows, sentenceParsed.rows, acoustics, req.body && req.body.survey, lispSummary.all95);
        lispSummary.outcome = outcome;
        await writeLispUserRecord(req.body && req.body.user, { gri, categories, result, acoustics, outcome }, req.body && req.body.survey);
        await sendPosthogAssessmentCompleted(req.body && req.body.user, req.body && req.body.survey, lispSummary);
        // Consume the assessment (combined delivers part 1 in one shot).
        await recordPersonAssessment(req.body && req.body.user, personId, entTier, { gri, partial: false });
        // Combined delivers a complete assessment in one shot, so the lead is
        // final here too. This branch had no briefing at all — any traffic that
        // took it vanished. Deduped by sessionId against the split flow.
        // QA runs (?test=1 / replay suite) are never leads — keeps the CRM clean.
        if (!(req.body && req.body.test === true)) {
          await sendLeadAlert(req.body && req.body.user, req.body && req.body.survey,
            { gri, categories, result, summary: lispSummary }, speakerContext);
        }

        return res.status(200).json({ words: wordRows, rows: sentenceParsed.rows, spontaneous, gri, acoustics, outcome, mode: 'combined', usage });
      }

      // Part 2 of the split flow: connected speech (sentences) + spontaneous sample.
      // The word rows were already scored by the earlier mode:'words' call and are
      // handed back to us in req.body.part1.words so the persisted record + summary
      // are complete. THIS is where the Firestore record is finalized (partial→full)
      // and where the 'assessment_completed' PostHog event fires — with the full,
      // sentence-informed summary.
      if (mode === 'connected') {
        const sentenceProbes = words.filter(w => w.type === 'sentence');
        const passageProbes = words.filter(w => acIsPassageLike(w));
        const { rawText, usage } = await analyzeConnectedWithGemini(sentenceProbes, passageProbes, speakerContext);
        const { sentencePart, spontaneousPart } = splitCombinedResponse(rawText);
        const sentenceParsed = parseSentenceTable(sentencePart, sentenceProbes.length);
        const spontaneous = passageProbes.length ? parseSpontaneous(spontaneousPart) : null;
        const acCapped = fuseAcoustics(sentenceParsed.rows, sentenceProbes, acProfile);
        const acoustics = acousticSummary(acProfile, acCapped);
        // Part-1 acoustics summary (words) rides along from the client so the
        // persisted record carries both halves.
        if (req.body.part1 && req.body.part1.acoustics && typeof req.body.part1.acoustics === 'object') acoustics.part1 = req.body.part1.acoustics;

        const part1Rows = (req.body.part1 && Array.isArray(req.body.part1.words)) ? req.body.part1.words : [];
        // Consented face video: keep the pointer, then (if anything was flagged)
        // look at the mouth at those instants. Best-effort, never blocks the report.
        const videoIn = req.body.video && typeof req.body.video === 'object' && req.body.video.path ? req.body.video : null;
        const video = videoIn ? { path: String(videoIn.path), manifest: String(videoIn.manifest || ''), mime: String(videoIn.mime || ''), width: videoIn.width || null, height: videoIn.height || null, fps: videoIn.fps || null, consentVersion: String(videoIn.consentVersion || ''), marks: Array.isArray(videoIn.marks) ? videoIn.marks.length : 0 } : null;
        let placement = null;
        if (videoIn) {
          placement = await placementCheck(videoIn, part1Rows, sentenceProbes);
          // Sentence-level camera notes land in the Mistakes column.
          sentenceProbes.forEach((p, i) => { const r = sentenceParsed.rows[i]; if (p.placementNote && r) r.mistakes = (/^none/i.test(r.mistakes || '') ? p.placementNote : `${r.mistakes || ''} ${p.placementNote}`).trim(); });
          if (acoustics) acoustics.placement = placement;
        }
        const categories = buildLispCategories(part1Rows, sentenceParsed.rows, spontaneous);
        // GRI over scored probes (core words + sentences); stress set + spontaneous excluded.
        const allQ = part1Rows.filter(r => r && r.tier !== 5).concat(sentenceParsed.rows).map(r => r.quality || 0);
        const gri = allQ.length ? Math.max(0, Math.min(100, Math.round(allQ.reduce((a, b) => a + b, 0) / allQ.length))) : 0;
        const result = lispStructuredToMarkdown(categories);

        const lispSummary = deriveLispSummary(categories, gri, acoustics);
        // Part 2 re-derives the outcome with sentences + camera evidence; the
        // client can show "updated" when the tier moved.
        const outcome = deriveOutcome(part1Rows, sentenceParsed.rows, acoustics, req.body && req.body.survey, lispSummary.all95);
        if (outcome && req.body.part1 && req.body.part1.outcome && req.body.part1.outcome.tier) outcome.changedFromPart1 = req.body.part1.outcome.tier !== outcome.tier;
        lispSummary.outcome = outcome;
        // Full record — clears the partial flag set by the mode:'words' persist write.
        await writeLispUserRecord(req.body && req.body.user, { gri, categories, result, acoustics, outcome, video, placement }, req.body && req.body.survey);
        // PostHog fires HERE (part-2 completion) with sentence-level detections included.
        await sendPosthogAssessmentCompleted(req.body && req.body.user, req.body && req.body.survey, lispSummary);
        // HubSpot lead sync: contact + report note + PDF. Self-swallowing — see
        // sendLeadAlert. QA runs (?test=1 / replay suite) are never leads.
        if (!(req.body && req.body.test === true)) {
          await sendLeadAlert(req.body && req.body.user, req.body && req.body.survey,
            { gri, categories, result, summary: lispSummary }, speakerContext);
        }

        return res.status(200).json({ rows: sentenceParsed.rows, spontaneous, gri, acoustics, placement, outcome, words: part1Rows, mode: 'connected', usage });
      }

      if (mode === 'sentences') {
        const { rawText, usage } = await analyzeSentencesWithGemini(words, speakerContext);
        const parsed = parseSentenceTable(rawText, words.length);
        return res.status(200).json({ ...parsed, mode: 'sentences', usage });
      }

      // Words mode (default) — part 1 of the split flow (single words, tiers 1–2).
      const { rawText, usage } = await analyzeWithGemini(words, speakerContext);
      const parsed = parseGeminiTable(rawText, words.length);
      const acCapped = fuseAcoustics(parsed.words, words, acProfile);
      const acoustics = acousticSummary(acProfile, acCapped);
      // Attach each word's tier from the probe metadata so rows group into the same
      // tier categories the results page renders (mirrors the combined branch).
      const tierByWord = {};
      words.forEach(p => { if (p.word != null) tierByWord[p.word] = p.tier || 1; });
      const wordRows = parsed.words.map(r => ({ ...r, tier: tierByWord[r.word] || 1 }));
      // Part-1 GRI over core words only (stress set excluded), recomputed after the fuse.
      {
        const q = wordRows.filter(r => r.tier !== 5).map(r => r.quality || 0);
        parsed.gri = q.length ? Math.max(0, Math.min(100, Math.round(q.reduce((a, b) => a + b, 0) / q.length))) : parsed.gri;
      }
      const outcome = deriveOutcome(wordRows, [], acoustics, req.body && req.body.survey, wordRows.length > 0 && wordRows.every(r => r.quality === 95));

      // Opt-in persist: write a PARTIAL Firestore record now so a record exists even
      // if the user bails before the deferred part-2 (connected) call completes. The
      // part-2 write replaces this with the full record and clears the partial flag.
      // NO PostHog here — that fires on part-2 completion with the full summary.
      if (req.body && req.body.persist === true) {
        const wordsOnlyCategories = buildLispCategories(wordRows, [], null);
        const wq = wordRows.map(r => r.quality || 0);
        const wgri = wq.length ? Math.max(0, Math.min(100, Math.round(wq.reduce((a, b) => a + b, 0) / wq.length))) : 0;
        await writeLispUserRecord(req.body && req.body.user, {
          gri: wgri,
          categories: wordsOnlyCategories,
          result: lispStructuredToMarkdown(wordsOnlyCategories),
          acoustics,
          outcome,
          partial: true
        }, req.body && req.body.survey);
      }

      // PART 1 delivered (words + clusters) → the agreed "assessment consumed"
      // point. Idempotent per run, so the later part-2 (connected) call won't
      // double count. If the user quits before part 2, this still counts.
      {
        const wq2 = wordRows.map(r => r.quality || 0);
        const wgri2 = wq2.length ? Math.round(wq2.reduce((a, b) => a + b, 0) / wq2.length) : null;
        await recordPersonAssessment(req.body && req.body.user, personId, entTier, { gri: wgri2, partial: true });
      }

      // Funnel checkpoint: words recorded, report not yet finished.
      if (!(req.body && req.body.test === true)) {
        await setLeadStatus(req.body && req.body.user, 'recorded_words');
      }

      res.status(200).json({ ...parsed, words: wordRows, acoustics, outcome, mode: 'words', usage });
    } catch (err) {
      // Attach request context so failures are traceable (req.body vars are out of catch scope).
      const { mode: failMode, words: failWords, voiceType: failVoice } = req.body || {};
      const ctx = {
        mode: failMode || 'words',
        probes: Array.isArray(failWords) ? failWords.length : 0,
        voiceType: failVoice || 'unspecified',
        country: req.headers['x-appengine-country'] || req.headers['x-country'] || 'Unspecified'
      };
      console.error('❌ analyzeLispSpeech error:', err, '| context:', JSON.stringify(ctx));
      // Still create/annotate the user's record so a failed attempt is tracked and
      // the record exists even though Gemini produced no analysis to store.
      await writeLispUserErrorRecord(req.body && req.body.user, { message: err.message, mode: failMode || 'combined' });
      res.status(500).json({ error: err.message });
    }
  });
});

