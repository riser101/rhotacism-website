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
    'http://localhost:5501'
  ],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
};
const corsMiddleware = cors(corsOptions);

function stripDataUrlPrefix(b64) {
  if (!b64) return '';
  const i = b64.indexOf(',');
  return i >= 0 ? b64.slice(i + 1) : b64;
}

// Compact one-line acoustic summary for ONE measured sibilant window.
function formatSegment(s) {
  const kHz = (hz) => (Number(hz) / 1000).toFixed(1) + 'kHz';
  const num = (x, d = 2) => (x == null ? '?' : Number(x).toFixed(d));
  const cog = s.center_of_gravity ?? s.centroid_hz;
  return [
    `CoG=${kHz(cog)}`,
    s.spectral_std_dev != null ? `spread=${kHz(s.spectral_std_dev)}` : null,
    s.spectral_skewness != null ? `skew=${num(s.spectral_skewness)}` : null,
    s.spectral_kurtosis != null ? `kurtosis=${num(s.spectral_kurtosis)}` : null,
    s.sibilant_peak_hz != null ? `peak(3-14k)=${kHz(s.sibilant_peak_hz)}` : null,
    s.energy_ratio_hi != null ? `E(8-14/3-8)=${num(s.energy_ratio_hi)}` : null,
    s.energy_ratio_low != null ? `E(0.5-4/total)=${num(s.energy_ratio_low)}` : null,
    s.duration_ms != null ? `dur=${Math.round(s.duration_ms)}ms` : null,
    s.rms != null ? `rms=${num(s.rms, 4)}` : null,
  ].filter(Boolean).join(', ');
}

// Acoustic summary from the Praat function (main.py), attached to each clip so
// Gemini can reason over the >8 kHz band it cannot hear. MFA locates each /s/;
// a word has one window, a sentence has one line per /s/ (its 'segments' list).
function formatAcoustics(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.error) return `[acoustics unavailable: ${a.error}]`;
  const segs = Array.isArray(a.segments) ? a.segments : [];
  if (segs.length > 1) {
    // Sentence: one line per sibilant, tagged with its phone + time.
    return '\n' + segs.map((s) =>
      `  · ${s.label || 's'}@${num0(s.start)}s: ${formatSegment(s)}`
    ).join('\n');
  }
  return formatSegment(segs[0] || a);
}
function num0(x) { return x == null ? '?' : Number(x).toFixed(2); }

// Interpretation guide injected once into the word prompt so Gemini knows how to
// weigh the Praat numbers — especially the high-frequency band beyond its hearing.
const ACOUSTIC_GUIDE = `## Acoustic measurements (Praat, computed on the 48 kHz recording)
Each clip below is preceded by a [Praat acoustics] line. The recording captures the full spectrum up to 24 kHz, but your audio hearing rolls off around 8 kHz. These numbers cover the sibilant energy above that limit (peak frequency is searched in the 3–14 kHz range where /s/ energy lives). Treat them as ground-truth for the high-frequency evidence and weigh them against what you hear.
- CoG (centre of gravity): normal /s/ ≈ 6.5–8.5 kHz (male), ≈ 7.5–10 kHz (female). An interdental (th-like) /s/ drops to ≈ 3.5–5.5 kHz.
- kurtosis: a low/flat value means a diffuse, smeared spectrum → lateral (slushy) lisp. A sharp peak (higher kurtosis) is normal. Best single discriminator for lateral.
- E(8-14/3-8): high-frequency energy balance you cannot hear. A low value with an otherwise normal CoG points to a frontal production.
- E(0.5-4/total): elevated low-frequency energy = turbulence leaking low, a lateral marker.
- dur/rms: quality gate — if duration is very short or rms very low, the sibilant was weak; trust your ear over the numbers.
When ear and numbers disagree, favour the acoustic evidence for the high-frequency band and say what you heard in plain language.`;

function buildLispPrompt(words, speakerContext) {
  const wordList = words.map((w, i) => `${i + 1}. ${w.word}${w.position ? ' (' + w.position + ')' : ''}`).join(', ');
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';

  return `You are a speech-language pathologist conducting a sigmatism (lisp) assessment. The patient said ${words.length} words in sequence: ${wordList}.

Speaker context (use this to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType}

Account for regional accent and voice type. Some dialects produce a softer /s/ — do NOT penalise that if it matches the dialect's expected production.

You are provided with per-word audio clips in order. Judge as an experienced clinician: listen BY EAR and cross-check the acoustic measurements below. For each /s/ and /z/, listen for: crisp and well-placed vs. slipping toward "th" (interdental), slushy/sideways airflow (lateral), muffled/dentalized, or whistling. Trust your trained ear, corrected by the numbers for the high-frequency band you cannot hear.

${ACOUSTIC_GUIDE}

## Output format
Return a single markdown table with exactly ${words.length} rows (one per word, in the listed order) and these columns:
| Word | Position | Heard | Judgment | Quality | Observation |

   - Word: The target word
   - Position: initial / medial / final
   - Heard: Exact transcription of what you heard. If the /s/ is clean and crisp, write the target word as-is.
   - Judgment: Accurate / Interdental / Lateral / Dentalized / Palatal / Distorted / Omitted
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
  const sentenceList = words.map((w, i) => `${i + 1}. "${w.word}"`).join('\n');
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';

  return `You are a speech-language pathologist assessing connected speech for a sigmatism (lisp). The patient read these sentences aloud — one audio clip each, in this order:
${sentenceList}

Speaker context (use to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType}

Listen to each clip as a whole. Focus on the sibilant sounds: /s/, /z/, "sh", "ch", "j". Do NOT transcribe the sentence. Judge how clear and natural the sibilants are in running speech, allowing for the speaker's regional accent. Do NOT penalise a softer /s/ if it matches the dialect.

## Output format
Return a single markdown table with exactly ${words.length} rows (one per sentence, in the listed order) and these columns:
| Sentence | Judgment | Quality | Mistakes |

   - Sentence: the target sentence (you may shorten with … if long)
   - Judgment: Accurate / Interdental / Lateral / Dentalized / Palatal / Distorted. If you hear more than one distortion type, judge by the most dominant one — never write "Mixed".
   - Quality: overall sibilant clarity for the whole sentence, 0-100 (100 = every sibilant crisp, clean speech should score 85+)
   - Mistakes: plain-language note of WHERE the lisp showed up — name the specific words or sounds the patient struggled with (e.g. "the 's' in 'sells' and 'seashells' sounded slushy"). If the sentence is clean, write "None — all sounds clear".

If a clip is silent or you do not actually hear the sentence, mark "Omitted" Judgment, 0 Quality — never Accurate.

Respond with ONLY the markdown table. No preamble, no commentary.
IMPORTANT: Use everyday language. No technical terms (no Hz, FFT, formant, spectrogram, phoneme, sibilant band).`;
}

// Spontaneous (free-speech monologue) prompt. Highest ecological validity:
// the patient speaks unscripted, so sibilant control reflects everyday speech.
// This is FLAGGED QUALITATIVELY — no per-word scoring, no numeric quality.
function buildSpontaneousPrompt(speakerContext) {
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';

  return `You are a speech-language pathologist reviewing a SPONTANEOUS speech sample for a sigmatism (lisp). The patient was given an open prompt ("Tell me about your weekend" or "Describe your favourite meal") and spoke freely for roughly 30–60 seconds. This unscripted monologue is the highest-validity sample because it reflects how the patient's sibilants hold up in real, everyday conversation rather than careful word reading.

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
  let resp;
  try {
    resp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher: geminiDispatcher // explicit — overrides built-in 300s headersTimeout
    });
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
  console.log('✅ Gemini analysis completed');
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

async function analyzeWithGemini(words, speakerContext) {
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
    let part3 = buildSpontaneousPrompt(speakerContext);
    // The spontaneous clip is now MFA-aligned (via Cloud STT) + Praat-measured,
    // so it carries the same high-frequency sibilant evidence the words do. Feed
    // it in as ground-truth for the >8 kHz band Gemini cannot hear.
    const acLines = passageProbes.map(p => formatAcoustics(p.acoustics)).filter(Boolean);
    if (acLines.length) {
      part3 += `\n\n[Praat acoustics] Aggregate high-frequency sibilant measurements for the spontaneous clip(s): ${acLines.join(' | ')}. Treat these as ground-truth for the >8 kHz sibilant energy you cannot hear and weigh them against what you hear. Do NOT mention any numbers in your output.`;
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
    let part2 = buildSpontaneousPrompt(speakerContext);
    // Same passage acoustics aggregate line combined mode feeds in — the >8 kHz
    // sibilant evidence Gemini cannot hear. Kept identical so results match.
    const acLines = passageProbes.map(p => formatAcoustics(p.acoustics)).filter(Boolean);
    if (acLines.length) {
      part2 += `\n\n[Praat acoustics] Aggregate high-frequency sibilant measurements for the spontaneous clip(s): ${acLines.join(' | ')}. Treat these as ground-truth for the >8 kHz sibilant energy you cannot hear and weigh them against what you hear. Do NOT mention any numbers in your output.`;
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
const LISP_TIER_LABELS = { 1: 'Core /s/ & /z/', 2: 'Extended sibilants', 3: 'Connected speech', 4: 'Spontaneous sample' };

// Group word/sentence/spontaneous rows into the tier categories the results page
// renders. Mirrors buildStructuredResult() in assessment.html.
function buildLispCategories(wordRows, sentenceRows, spontaneous) {
  const categories = [];
  [1, 2].forEach(tid => {
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
async function writeLispUserRecord(user, analysis) {
  try {
    if (!firestore) { console.warn('Firestore unavailable — skipping record write'); return; }
    if (!user || !user.uid) { console.warn('No uid in payload — skipping Firestore record write'); return; }
    await firestore.collection('lisp-users').doc(String(user.uid)).set({
      ...lispIdentityFields(user),
      latestAssessment: {
        gri: analysis.gri ?? null,
        categories: analysis.categories ?? [],
        result: analysis.result ?? '',
        // partial=true = words-only interim write (user may still be waiting on the
        // deferred connected-speech part). Always written explicitly so the full
        // (connected) write clears it — a merge-write deep-merges the map and would
        // otherwise leave a stale partial:true behind.
        partial: !!analysis.partial,
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

// Record one completed assessment, idempotent per run (keyed on the client's
// per-assessment sessionId): counts + consumes a credit only the FIRST time a
// run is seen, so the split flow's part-1 and part-2 writes don't double count.
// Called at PART 1 (words+clusters delivered) — the agreed "consumed" point.
async function recordPersonAssessment(user, personId, tier, data) {
  try {
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

// A word counts as a lisp hit when its judgment is a distortion type (matches the
// results page Judgment column); Accurate/Unclear/Omitted are NOT hits.
const LISP_HIT_JUDGMENTS = ['Interdental', 'Dentalized', 'Lateral', 'Distorted'];
function deriveLispSummary(categories, gri) {
  let lispDetected = false, lispWordCount = 0;
  const lispWords = [];
  (categories || []).forEach(cat => {
    (cat.rows || []).forEach(row => {
      if (LISP_HIT_JUDGMENTS.includes(row.judgment)) {
        lispDetected = true;
        lispWordCount++;
        const label = row.word || row.sentence;
        if (label) lispWords.push(label);
      }
    });
  });
  return { lispDetected, lispWordCount, lispWords, lispGri: (typeof gri === 'number' ? gri : null) };
}

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
      $set: {
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
    if (req.method === 'GET') {
      try {
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
            latestAssessment: { gri: a.gri ?? null, categories: a.categories, result: a.result || '' }
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
      if (mode === 'combined' || mode === 'words' || mode == null) {
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
      const acWith = words.filter(w => w.acoustics && !w.acoustics.error).length;
      const acErr = words.filter(w => w.acoustics && w.acoustics.error).length;
      const acSample = words.find(w => w.acoustics && !w.acoustics.error);
      console.log(
        acWith
          ? `🔬 Praat acoustics RECEIVED: ${acWith}/${words.length} clips` +
            (acErr ? `, ${acErr} errored` : '') +
            ` | sample: ${formatAcoustics(acSample.acoustics)}`
          : `🔬 Praat acoustics MISSING on all ${words.length} clips — Gemini running EAR-ONLY`
      );

      if (mode === 'combined') {
        const wordProbes = words.filter(w => w.type !== 'sentence' && w.type !== 'passage');
        const sentenceProbes = words.filter(w => w.type === 'sentence');
        const passageProbes = words.filter(w => w.type === 'passage');
        const { rawText, usage } = await analyzeCombinedWithGemini(wordProbes, sentenceProbes, passageProbes, speakerContext);
        const { wordPart, sentencePart, spontaneousPart } = splitCombinedResponse(rawText);
        const wordParsed = parseGeminiTable(wordPart, wordProbes.length);
        const sentenceParsed = parseSentenceTable(sentencePart, sentenceProbes.length);
        const spontaneous = passageProbes.length ? parseSpontaneous(spontaneousPart) : null;
        // GRI from scored probes only (words + sentences); spontaneous excluded.
        const allQ = wordParsed.words.concat(sentenceParsed.rows).map(r => r.quality || 0);
        const gri = allQ.length ? Math.max(0, Math.min(100, Math.round(allQ.reduce((a, b) => a + b, 0) / allQ.length))) : 0;

        // Attach each word's tier (from the probe metadata) so rows group into the
        // same category structure the results page renders and persists.
        const tierByWord = {};
        wordProbes.forEach(p => { if (p.word != null) tierByWord[p.word] = p.tier || 1; });
        const wordRows = wordParsed.words.map(r => ({ ...r, tier: tierByWord[r.word] || 1 }));
        const categories = buildLispCategories(wordRows, sentenceParsed.rows, spontaneous);
        const result = lispStructuredToMarkdown(categories);

        // Write the Firestore record + fire the PostHog event HERE (server-side) so
        // both land even if the user already closed the tab — the browser no longer
        // does either. Awaited before the response so they complete regardless of the
        // client still listening.
        const lispSummary = deriveLispSummary(categories, gri);
        await writeLispUserRecord(req.body && req.body.user, { gri, categories, result });
        await sendPosthogAssessmentCompleted(req.body && req.body.user, req.body && req.body.survey, lispSummary);
        // Consume the assessment (combined delivers part 1 in one shot).
        await recordPersonAssessment(req.body && req.body.user, personId, entTier, { gri, partial: false });

        return res.status(200).json({ words: wordRows, rows: sentenceParsed.rows, spontaneous, gri, mode: 'combined', usage });
      }

      // Part 2 of the split flow: connected speech (sentences) + spontaneous sample.
      // The word rows were already scored by the earlier mode:'words' call and are
      // handed back to us in req.body.part1.words so the persisted record + summary
      // are complete. THIS is where the Firestore record is finalized (partial→full)
      // and where the 'assessment_completed' PostHog event fires — with the full,
      // sentence-informed summary.
      if (mode === 'connected') {
        const sentenceProbes = words.filter(w => w.type === 'sentence');
        const passageProbes = words.filter(w => w.type === 'passage');
        const { rawText, usage } = await analyzeConnectedWithGemini(sentenceProbes, passageProbes, speakerContext);
        const { sentencePart, spontaneousPart } = splitCombinedResponse(rawText);
        const sentenceParsed = parseSentenceTable(sentencePart, sentenceProbes.length);
        const spontaneous = passageProbes.length ? parseSpontaneous(spontaneousPart) : null;

        const part1Rows = (req.body.part1 && Array.isArray(req.body.part1.words)) ? req.body.part1.words : [];
        const categories = buildLispCategories(part1Rows, sentenceParsed.rows, spontaneous);
        // GRI over scored probes (words + sentences); spontaneous excluded.
        const allQ = part1Rows.concat(sentenceParsed.rows).map(r => r.quality || 0);
        const gri = allQ.length ? Math.max(0, Math.min(100, Math.round(allQ.reduce((a, b) => a + b, 0) / allQ.length))) : 0;
        const result = lispStructuredToMarkdown(categories);

        // Full record — clears the partial flag set by the mode:'words' persist write.
        await writeLispUserRecord(req.body && req.body.user, { gri, categories, result });
        // PostHog fires HERE (part-2 completion) with sentence-level detections included.
        await sendPosthogAssessmentCompleted(req.body && req.body.user, req.body && req.body.survey, deriveLispSummary(categories, gri));

        return res.status(200).json({ rows: sentenceParsed.rows, spontaneous, gri, mode: 'connected', usage });
      }

      if (mode === 'sentences') {
        const { rawText, usage } = await analyzeSentencesWithGemini(words, speakerContext);
        const parsed = parseSentenceTable(rawText, words.length);
        return res.status(200).json({ ...parsed, mode: 'sentences', usage });
      }

      // Words mode (default) — part 1 of the split flow (single words, tiers 1–2).
      const { rawText, usage } = await analyzeWithGemini(words, speakerContext);
      const parsed = parseGeminiTable(rawText, words.length);
      // Attach each word's tier from the probe metadata so rows group into the same
      // tier categories the results page renders (mirrors the combined branch).
      const tierByWord = {};
      words.forEach(p => { if (p.word != null) tierByWord[p.word] = p.tier || 1; });
      const wordRows = parsed.words.map(r => ({ ...r, tier: tierByWord[r.word] || 1 }));

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
          partial: true
        });
      }

      // PART 1 delivered (words + clusters) → the agreed "assessment consumed"
      // point. Idempotent per run, so the later part-2 (connected) call won't
      // double count. If the user quits before part 2, this still counts.
      {
        const wq2 = wordRows.map(r => r.quality || 0);
        const wgri2 = wq2.length ? Math.round(wq2.reduce((a, b) => a + b, 0) / wq2.length) : null;
        await recordPersonAssessment(req.body && req.body.user, personId, entTier, { gri: wgri2, partial: true });
      }

      res.status(200).json({ ...parsed, words: wordRows, mode: 'words', usage });
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

