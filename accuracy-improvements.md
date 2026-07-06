# Lisp Assessment — Accuracy Improvement Backlog

Each item is standalone and can be picked independently.  
**Constraint:** preserve the `localStorage.analysisResult` shape (`gri`, `categories`, `words`/`rows`) — `assessment-results.html` reads it.

---

## BUGS (break accuracy today — fix first)

### B1 · Voice type always `"male"` when Gemini fires
**Impact:** Female speakers get male-band prompt. Female /s/ peaks ~2 kHz higher; wrong context causes false dentalized/interdental calls on clean female speech.  
**Root cause:** Survey (where gender is collected) runs *after* recording. `handleRecordTap` and `validateCurrentStep` both reset `userGender = 'male'` at lines 3173 and 2892 in `assessment.html`. `wizFinish()` sets it too late (line 4690) — the Gemini call has already fired.  
**Fix options (pick one):**
- Ask voice type on a single tap *before* recording starts (zero survey friction, highest accuracy).
- Send `'unspecified'` instead of hardcoding `'male'` — Gemini infers from audio, never wrong.
- Auto-detect from live AnalyserNode: median F0 < ~165 Hz → male band.

---

### B2 · iOS audio container mislabeled as WebM
**Impact:** Every iPhone user's clips are `audio/mp4` (AAC), wrapped as `audio/webm` blob, sent to Gemini as `mime_type: 'audio/webm'`. Gemini usually sniffs the real container but can silently mis-decode, degrading quality on likely majority of traffic.  
**Root cause:** `new Blob(audioChunks, { type: 'audio/webm' })` (line 3467) ignores `mediaRecorder.mimeType`. Backend hardcodes `mime_type: 'audio/webm'` (index.js:341).  
**Fix:** Read `mediaRecorder.mimeType` on recording start, carry it per-probe, pass it through to `inline_data.mime_type`.

---

### B3 · Any single distorted row = `lispDetected: true`
**Impact:** One noisy clip or one VAD-clipped final /s/ out of 39 probes flags the user as having a lisp in PostHog and triggers the nurture sequence.  
**Root cause:** `lispDetected` flips true inside a `forEach` the moment one row matches a distortion judgment (assessment.html:4244). Also: `parseInt(cells[4]) || 0` silently converts any malformed table cell to quality 0, dragging GRI down without any error signal (index.js:448).  
**Fix:** Require a threshold (e.g., ≥ 3 distorted rows, or ≥ 25% of /s,z/ probes) before setting `lispDetected: true`. Replace `|| 0` fallback with an explicit null/flag for bad parses.

---

## QUICK WINS (days, high ROI)

### Q1 · Structured JSON output (kills the markdown parser)
**Impact:** Eliminates quality-0 failures from table misalignment, unlocks `confidence` field that everything else builds on.  
**What:** Use Gemini `responseSchema` (JSON mode) to return per-clip structured objects:
```
{ heard, judgment, quality, confidence (0–1), evidence (one plain cue), audio_quality (ok|noisy|truncated|wrong_word) }
```
Deletes `parseGeminiTable`, `parseSentenceTable`, and the fragile `parseInt || 0` path.  
**Files:** `gcp-function-lisp/index.js` — remove `buildAudioParts` + parse functions, add schema to `generationConfig`.

---

### Q2 · Identity gate using the Whisper endpoint (already exists, unused)
**Impact:** Stops Gemini grading clips where the user mumbled, got cut off, or said the wrong word entirely. Those clips currently produce low quality scores that drag GRI down as if they were lisp events.  
**What:** After recording completes, fire `transcribeAudio` (Groq Whisper) per clip in parallel. If transcript doesn't fuzzy-match the target word → mark clip `audio_quality: wrong_word`, exclude from scoring, flag for re-record.  
**Note:** Whisper normalises lisped /s/ → correct word (e.g., "thun" → "sun") so it can't detect lisp — that's the *right* use here. It's purely an identity/quality gate.  
**Files:** `assessment.html` — add parallel Whisper calls in `sendAudioToBackend`; `index.js` — filter excluded clips before building prompt.

---

### Q3 · Reinstate sibilant acoustics (without `decodeAudioData`)
**Impact:** Provides physics-based evidence for each clip, especially valuable for female voices (7–10 kHz /s/ energy that Gemini's ~32 tok/s audio pipeline may not resolve reliably). Backend already has full FFT prompt + cross-check paths (`fftData`, `probe.sFft`) that are currently dead code.  
**What:** Tap the live `AnalyserNode` during each word recording (already running). Compute per-clip: CoG, spread, peak in the gender-calibrated sibilant band — all in real time from the 48 kHz stream. No blob decoding, works on Safari.  
**Files:** `assessment.html` — collect in `onWordRecordingStopped`; re-enable `fftData` in payload to backend. Everything on the backend side is already written.

---

## STRUCTURAL (1–2 weeks)

### S1 · Chunk the mega-call into parallel batches
**Impact:** 40 clips + 3 instruction blocks in one call creates alignment drift and halo bias (first impression bleeds into all rows). Parallel batches give each clip real attention and drop wall-clock latency.  
**What:** Words in parallel batches of ~8–10 per call, sentences as one call, spontaneous as one call. Merge results server-side before returning.  
**Files:** `index.js` — replace `analyzeCombinedWithGemini` with a batched parallel dispatch.

---

### S2 · Self-consistency voting (2-pass + tie-break)
**Impact:** Vote disagreement between two passes is the most honest low-confidence signal — much better calibrated than asking the model to rate its own confidence.  
**What:** Run each word batch twice (shuffled clip order second pass, or temp ~0.5). For clips where passes agree → high confidence. Disagree → run a third tie-break pass. Per-clip confidence = vote agreement × model `confidence` field × audio-quality flag.  
**Files:** `index.js` — wrap batch call in a 2-pass loop; add `confidence` field to response schema.

---

### S3 · Deterministic verdict layer (code, not LLM)
**Impact:** This is where false positives die. Removes the last LLM from the yes/no decision. The model scores clips; code decides the overall verdict.  
**What:**
```
lisp(type) detected   → ≥ 30–40% of /s,z/ probes share a type AND (sentences OR spontaneous agree)
clean                 → ≥ 90% accurate, no connected-speech flags
borderline            → everything else → emits type as "suspected" with explicit low-confidence flag
```
Severity from quality deficit on affected probes only.  
`lispDetected` in PostHog comes from this layer's verdict, not a per-row scan.  
**Files:** New `buildVerdict(wordRows, sentenceRows, spontaneous)` function in `index.js`. `assessment.html` reads `verdict.status` (`detected|clean|borderline`) alongside existing `gri`.

---

### S4 · Borderline user-input loop
**Prerequisite:** S3 (confidence field) and Q1 (structured output).  
**Impact:** Captures reliable clinical signal for ambiguous cases without adding friction to clear cases. Turns borderline sessions into a second nurture touchpoint.  
**What:**
- `borderline` clips on results page get a playback button + one-tap: *"sounded crisp / sounded off"*.
- Self-report feeds as a small tie-breaker weight into the S3 verdict rule and re-renders the verdict inline.
- Also wire the existing comfort question (*slight/noticeable/significant/none/not sure*) as a prior: on a borderline overall verdict, bias toward user's self-assessment.
- **HITL option:** Route borderline sessions to an async review queue (clips are already in Firebase Storage). Internal page: listen to 3–5 disputed clips, click verdict, "detailed results ready" email follows. Minimal effort (only borderline cases), adds SLP credibility to a high-ticket offer.

---

## PROBE UPGRADES

### P1 · Sustained /s/ probe
Add a single "hold *ssss* for 3 seconds" probe. Steady-state frication removes coarticulation noise — cleanest single measurement for type classification for both spectral analysis and Gemini. Low recording friction.

---

### P2 · Minimal pairs
Add 3–4 pairs: sink/think, mouse/mouth, sum/thumb. If both members of a pair sound identical in the clip → near-conclusive interdental evidence. A clean contrast is strong negative evidence. Easy to add to Tier 1 word bank.

---

### P3 · Intra-session reliability probe
Repeat one word from Tier 1 (e.g., "sun") at the end of the session. Judgment disagreement between early and late = lower confidence on that clip. Agreement = higher reliability signal.

---

### P4 · Few-shot audio exemplars in prompt
Include 1–2 second reference clips (accurate, interdental, lateral, dentalized /s/) as inline audio parts in the Gemini prompt. Best single calibration lever for an audio LLM judge. Source from labeled Firebase recordings once the eval set (E1) exists, or from SLP-verified imitations.

---

## EVAL HARNESS (prerequisite for knowing what actually works)

### E1 · Labeled evaluation set
**Why first:** Without this, every change is a guess. "Accuracy is not good" can't be decomposed — is it false positives on clean speakers? interdental/lateral confusion? female voices? — without ground truth.  
**What:**
1. Pull 30–50 real sessions from `recordings/lispv2/` in Firebase Storage — covering clean speakers, each lisp type, female and male voices.
2. Label each clip (you + ideally one SLP pass): `Accurate | Interdental | Lateral | Dentalized | Omitted`.
3. Write a small offline script that replays stored audio through any pipeline variant (via `callGemini` directly) and reports:
   - Sensitivity / specificity per lisp type
   - Type confusion matrix (interdental vs lateral is the hardest pair)
   - False positive rate on clean speakers
4. Gate every prompt/architecture change on these numbers.

The function already logs `📄 Gemini raw response` to Cloud Logging — use that to bootstrap labels from real traffic before doing a clean collection pass.

---

## SUGGESTED ORDER

| Phase | Items | Effort |
|---|---|---|
| 1 · Fix now | B1, B2, B3 | 1–2 days |
| 2 · High ROI | Q1 (structured output), E1 (eval harness) | 3–5 days |
| 3 · Core accuracy | S3 (verdict layer), S1 (chunk calls) | 1 week |
| 4 · Confidence layer | S2 (voting), Q2 (identity gate), Q3 (acoustics) | 1 week |
| 5 · UX + borderline | S4 (user input loop) | 3–5 days |
| 6 · Probe upgrades | P1, P2, P3, P4 | 1–2 days each |
