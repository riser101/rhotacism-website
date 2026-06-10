require('dotenv').config();
const functions = require('@google-cloud/functions-framework');
const cors = require('cors');

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

// Gender-calibrated /s/ band defaults. Frontend usually sends sibilantBand;
// these are fallbacks if the request omits it.
const SIBILANT_BANDS = {
  male:   { low: 4000, high: 8000,  target: 6000 },
  female: { low: 5500, high: 10000, target: 7500 },
  other:  { low: 4000, high: 8000,  target: 6000 }
};

function resolveBand(voiceType, sibilantBand) {
  if (sibilantBand && Number.isFinite(sibilantBand.low) && Number.isFinite(sibilantBand.high)) {
    return {
      low: sibilantBand.low,
      high: sibilantBand.high,
      target: sibilantBand.target || Math.round((sibilantBand.low + sibilantBand.high) / 2)
    };
  }
  const key = (voiceType || '').toLowerCase();
  return SIBILANT_BANDS[key] || SIBILANT_BANDS.other;
}

function stripDataUrlPrefix(b64) {
  if (!b64) return '';
  const i = b64.indexOf(',');
  return i >= 0 ? b64.slice(i + 1) : b64;
}

// Build a per-word summary from client-side FFT, using gender-calibrated band.
function formatFftSummary(fftData, band) {
  if (!Array.isArray(fftData) || !fftData.length) return 'No FFT data provided.';

  const lines = fftData.map(w => {
    const peak = Math.round(w.peakHz || 0);

    // Signed distance from the gender-calibrated target band (0 = inside band).
    let bandDelta = 0;
    if (peak) {
      if (peak < band.low) bandDelta = peak - band.low;
      else if (peak > band.high) bandDelta = peak - band.high;
    }

    return `- "${w.word}" (${w.position || '?'}): peak ${peak} Hz, band Δ ${bandDelta >= 0 ? '+' : ''}${bandDelta} Hz.`;
  });

  return lines.join('\n');
}

// Plain-language tag derived from spectral moments, to help Gemini read the
// numbers. CoG is the primary discriminator; spread catches lateral slush.
function spectralTag(cog, spread, band) {
  const tags = [];
  if (cog >= band.low) tags.push('crisp /s/ placement');
  else if (cog < band.low - 1500) tags.push('low CoG → θ-like / dentalized');
  else tags.push('slightly low CoG → softer /s/');
  if (spread >= 2500) tags.push('broad/diffuse → possible lateral');
  return tags.join(', ');
}

// Per-sentence sibilant spectral summary. Frontend aggregates the /s/-/z/
// frication frames across each sentence clip and attaches one moment set as
// probe.sFft = [{ peakHz, cog, spread }] (CoG = power-2 centre of gravity).
function formatSentenceFftSummary(words, band) {
  const blocks = words.map((w, i) => {
    const fft = Array.isArray(w.sFft) ? w.sFft : [];
    if (!fft.length) return `- Sentence ${i + 1}: no /s/ frequency data.`;

    const items = fft.map(f => {
      const peak = Math.round(f.peakHz || 0);
      const cog = Math.round(f.cog || 0);
      const spread = Math.round(f.spread || 0);
      return `    • CoG ${cog} Hz, spread ${spread} Hz, peak ${peak} Hz — ${spectralTag(cog, spread, band)}`;
    });
    return `- Sentence ${i + 1}:\n${items.join('\n')}`;
  });
  return blocks.join('\n');
}

function buildLispPrompt(words, fftData, speakerContext) {
  const wordList = words.map((w, i) => `${i + 1}. ${w.word}${w.position ? ' (' + w.position + ')' : ''}`).join(', ');
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';
  const band = speakerContext.band;

  const hasFft = Array.isArray(fftData) && fftData.some(w => w && w.peakHz);

  // With FFT: give the acoustic block + cross-check guide. Without: pure
  // by-ear SLP judgment — no instrument data, just the audio.
  const evidenceBlock = hasFft ? `
You are provided with:
1. Per-word audio clips in order
2. Frequency analysis data for each word's /s/ region:

${formatFftSummary(fftData, band)}

Audio is the PRIMARY evidence. Judge from what you hear. Cross-check with FFT data to confirm or refine the call — never override clean audio because of FFT.

- peak Hz = strongest frequency in the sibilant band
- band Δ = signed distance from the ${band.low}–${band.high} Hz target band calibrated for this ${voiceType} voice (0 = inside)

Cross-check guide:
    * Audio clean/crisp + Δ ≈ 0 → Accurate /s/ (confirmed)
    * Audio clean/crisp + Δ off → still Accurate (audio wins)
    * Audio dull/th-like + Δ < −2000 → Interdental /θ/ (confirmed)
    * Audio soft/muffled + mildly negative Δ → Dentalized` : `
You are provided with per-word audio clips in order. Judge entirely BY EAR, as an experienced clinician listening in the room — there is no instrument data, only the audio. For each /s/ and /z/, listen for: crisp and well-placed vs. slipping toward "th" (interdental), slushy/sideways airflow (lateral), muffled/dentalized, or whistling. Trust your trained ear.`;

  const closingAudioNote = hasFft
    ? 'Only mark a distortion when you can clearly hear it in the audio. The FFT alone is not enough — confirm with the audio. When the audio sounds clean, mark Accurate even if the FFT looks suspicious.'
    : 'Only mark a distortion when you can clearly hear it. When the audio sounds clean and the /s/ is crisp, mark Accurate.';

  return `You are a speech-language pathologist conducting a sigmatism (lisp) assessment. The patient said ${words.length} words in sequence: ${wordList}.

Speaker context (use this to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType} (male voices peak lower, female/child voices peak higher in the /s/ band — calibrate expectations accordingly)

Account for regional accent and voice type. Some dialects produce a softer /s/ — do NOT penalise that if it matches the dialect's expected production. Do NOT penalise a male voice for peaking near 4–6 kHz or a female voice for peaking near 6–9 kHz; both are normal for their respective vocal tracts.
${evidenceBlock}

## Output format
Return a single markdown table with exactly ${words.length} rows (one per word, in the listed order) and these columns:
| Word | Position | Heard | Judgment | Quality | Observation |

   - Word: The target word
   - Position: initial / medial / final
   - Heard: Exact transcription of what you heard. If the /s/ is clean and crisp, write the target word as-is.
   - Judgment: Accurate / Interdental / Lateral / Dentalized / Palatal / Distorted / Omitted
   - Quality: /s/ sound quality score 0-100 (100 = perfect crisp /s/, 0 = no /s/ at all). Clean productions should score 85+.
   - Observation: Brief clinical note (10-15 words)

${closingAudioNote}

If a word is unclear or missing, put "—" in Heard, "Omitted" in Judgment, and 0 for Quality.

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
  const band = speakerContext.band || SIBILANT_BANDS.other;

  // Per-sentence /s/-word frequency data (if the frontend split + FFT'd the clip).
  const hasFft = words.some(w => Array.isArray(w.sFft) && w.sFft.length);
  const frequencyBlock = formatSentenceFftSummary(words, band);

  const fftSection = hasFft ? `

You are also given a sibilant spectral summary for each sentence's /s/ and /z/ frication, calibrated for this ${voiceType} voice (target band ${band.low}–${band.high} Hz):

${frequencyBlock}

- CoG (centre of gravity) = where the sibilant's energy is centred. High CoG (≥ ${band.low} Hz) = crisp, well-placed /s/. Low CoG (well below ${band.low} Hz) = energy slipped down, typical of interdental /θ/ or dentalized /s/.
- spread = how wide the energy is smeared. A broad/diffuse spread suggests sideways (lateral) airflow — "slushy" /s/.
- peak Hz = strongest single frequency in the sibilant band.

Audio is the PRIMARY evidence — judge from what you hear. Use these moments only to confirm or refine:
    * Audio clean/crisp + high CoG → those sibilants are accurate (confirmed)
    * Audio clean/crisp + low CoG → still accurate (audio wins)
    * Audio dull/th-like + low CoG → interdental /θ/ or dentalized (confirmed)
    * Audio slushy + broad spread → lateral (confirmed)
Never override clean audio because of the numbers.` : '';

  return `You are a speech-language pathologist assessing connected speech for a sigmatism (lisp). The patient read these sentences aloud — one audio clip each, in this order:
${sentenceList}

Speaker context (use to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType}

Listen to each clip as a whole. Focus on the sibilant sounds: /s/, /z/, "sh", "ch", "j". Do NOT transcribe the sentence. Judge how clear and natural the sibilants are in running speech, allowing for the speaker's regional accent. Do NOT penalise a softer /s/ if it matches the dialect.${fftSection}

## Output format
Return a single markdown table with exactly ${words.length} rows (one per sentence, in the listed order) and these columns:
| Sentence | Judgment | Quality | Mistakes |

   - Sentence: the target sentence (you may shorten with … if long)
   - Judgment: Accurate / Interdental / Lateral / Dentalized / Palatal / Distorted / Mixed
   - Quality: overall sibilant clarity for the whole sentence, 0-100 (100 = every sibilant crisp, clean speech should score 85+)
   - Mistakes: plain-language note of WHERE the lisp showed up — name the specific words or sounds the patient struggled with (e.g. "the 's' in 'sells' and 'seashells' sounded slushy"). If the sentence is clean, write "None — all sounds clear".

Respond with ONLY the markdown table. No preamble, no commentary.
IMPORTANT: Use everyday language. No technical terms (no Hz, FFT, formant, spectrogram, phoneme, sibilant band).`;
}

// Spontaneous (free-speech monologue) prompt. Highest ecological validity:
// the patient speaks unscripted, so sibilant control reflects everyday speech.
// This is FLAGGED QUALITATIVELY — no per-word scoring, no numeric quality.
function buildSpontaneousPrompt(speakerContext) {
  const band = speakerContext.band;
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
  const MAX_ATTEMPTS = 3;
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
      body: JSON.stringify(body)
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
    parts.push({ text: `\n--- Clip ${i + 1}: "${w.word}" (${w.position || '?'}) ---` });
    parts.push({ inline_data: { mime_type: 'audio/webm', data: b64 } });
  });
  return parts;
}

async function analyzeWithGemini(words, fftData, speakerContext) {
  const prompt = buildLispPrompt(words, fftData, speakerContext);
  return callGemini(buildAudioParts(prompt, words));
}

async function analyzeSentencesWithGemini(words, speakerContext) {
  const prompt = buildSentencePrompt(words, speakerContext);
  return callGemini(buildAudioParts(prompt, words));
}

// Single call covering all clips. Reuses the EXISTING word prompt (unchanged,
// just fed all the words) and the sentence prompt, asking for two headed tables.
function buildCombinedPrompt(wordProbes, sentenceProbes, passageProbes, fftData, speakerContext) {
  const wordPrompt = buildLispPrompt(wordProbes, fftData, speakerContext);
  const sentencePrompt = buildSentencePrompt(sentenceProbes, speakerContext);
  const nW = wordProbes.length, nS = sentenceProbes.length, nP = passageProbes.length;

  let prompt = `You will analyze ${nP ? 'THREE' : 'TWO'} sets of audio clips. The first ${nW} clips are single words; the next ${nS} clips are sentences.${nP ? ` The final ${nP} clip(s) are a spontaneous free-speech monologue.` : ''} Follow the instruction blocks below.

================ PART 1 — SINGLE WORDS (clips 1–${nW}) ================
${wordPrompt}

================ PART 2 — SENTENCES (clips ${nW + 1}–${nW + nS}) ================
${sentencePrompt}
`;

  if (nP) {
    prompt += `
================ PART 3 — SPONTANEOUS SAMPLE (clip${nP > 1 ? 's' : ''} ${nW + nS + 1}–${nW + nS + nP}) ================
${buildSpontaneousPrompt(speakerContext)}
`;
  }

  prompt += `
================ COMBINED OUTPUT ================
Output PART 1's word table under a heading line "### WORD ANALYSIS", then PART 2's sentence table under a heading line "### SENTENCE ANALYSIS"${nP ? ', then PART 3\'s qualitative section under "### SPONTANEOUS ANALYSIS"' : ''}. Output nothing else — no other commentary.
Do NOT number the table rows. Put ONLY the bare word/sentence in the first column (e.g. "sun", not "1. sun").`;
  return prompt;
}

async function analyzeCombinedWithGemini(wordProbes, sentenceProbes, passageProbes, fftData, speakerContext) {
  const prompt = buildCombinedPrompt(wordProbes, sentenceProbes, passageProbes, fftData, speakerContext);
  // Clip order must match the prompt: words, then sentences, then spontaneous.
  const ordered = [...wordProbes, ...sentenceProbes, ...passageProbes];
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
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
      if (!req.headers['content-type']?.includes('application/json')) {
        return res.status(400).json({ error: 'Expected application/json' });
      }

      const { words, fftData, voiceType, sibilantBand, mode } = req.body || {};
      if (!Array.isArray(words) || !words.length) {
        return res.status(400).json({ error: 'words array required' });
      }

      const country = req.headers['x-appengine-country'] || req.headers['x-country'] || 'Unspecified';
      const region = req.headers['x-appengine-region'] || req.headers['x-region'] || 'Unspecified';
      const band = resolveBand(voiceType, sibilantBand);
      const speakerContext = { country, region, voiceType: voiceType || 'unspecified', band };
      console.log(`🎚️  Mode: ${mode || 'words'} | ${words.length} probes | voice: ${speakerContext.voiceType} | band: ${band.low}–${band.high} Hz`);

      if (mode === 'combined') {
        const wordProbes = words.filter(w => w.type !== 'sentence' && w.type !== 'passage');
        const sentenceProbes = words.filter(w => w.type === 'sentence');
        const passageProbes = words.filter(w => w.type === 'passage');
        const { rawText, usage } = await analyzeCombinedWithGemini(wordProbes, sentenceProbes, passageProbes, fftData || [], speakerContext);
        const { wordPart, sentencePart, spontaneousPart } = splitCombinedResponse(rawText);
        const wordParsed = parseGeminiTable(wordPart, wordProbes.length);
        const sentenceParsed = parseSentenceTable(sentencePart, sentenceProbes.length);
        const spontaneous = passageProbes.length ? parseSpontaneous(spontaneousPart) : null;
        // GRI from scored probes only (words + sentences); spontaneous excluded.
        const allQ = wordParsed.words.concat(sentenceParsed.rows).map(r => r.quality || 0);
        const gri = allQ.length ? Math.max(0, Math.min(100, Math.round(allQ.reduce((a, b) => a + b, 0) / allQ.length))) : 0;
        return res.status(200).json({ words: wordParsed.words, rows: sentenceParsed.rows, spontaneous, gri, mode: 'combined', usage });
      }

      if (mode === 'sentences') {
        const { rawText, usage } = await analyzeSentencesWithGemini(words, speakerContext);
        const parsed = parseSentenceTable(rawText, words.length);
        return res.status(200).json({ ...parsed, mode: 'sentences', usage });
      }

      const { rawText, usage } = await analyzeWithGemini(words, fftData || [], speakerContext);
      const parsed = parseGeminiTable(rawText, words.length);
      res.status(200).json({ ...parsed, mode: 'words', usage });
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
      res.status(500).json({ error: err.message });
    }
  });
});
