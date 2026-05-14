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

function buildLispPrompt(words, fftData, speakerContext) {
  const wordList = words.map((w, i) => `${i + 1}. ${w.word}${w.position ? ' (' + w.position + ')' : ''}`).join(', ');
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const voiceType = speakerContext.voiceType || 'unspecified';
  const band = speakerContext.band;

  const frequencyBlock = formatFftSummary(fftData, band);

  return `You are a speech-language pathologist conducting a sigmatism (lisp) assessment. The patient said ${words.length} words in sequence: ${wordList}.

Speaker context (use this to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}
- Voice type: ${voiceType} (male voices peak lower, female/child voices peak higher in the /s/ band — calibrate expectations accordingly)

Account for regional accent and voice type. Some dialects produce a softer /s/ — do NOT penalise that if it matches the dialect's expected production. Do NOT penalise a male voice for peaking near 4–6 kHz or a female voice for peaking near 6–9 kHz; both are normal for their respective vocal tracts.

You are provided with:
1. Per-word audio clips in order
2. Frequency analysis data for each word's /s/ region:

${frequencyBlock}

Audio is the PRIMARY evidence. Judge from what you hear. Cross-check with FFT data to confirm or refine the call — never override clean audio because of FFT.

- peak Hz = strongest frequency in the sibilant band
- band Δ = signed distance from the ${band.low}–${band.high} Hz target band calibrated for this ${voiceType} voice (0 = inside)

Cross-check guide:
    * Audio clean/crisp + Δ ≈ 0 → Accurate /s/ (confirmed)
    * Audio clean/crisp + Δ off → still Accurate (audio wins)
    * Audio dull/th-like + Δ < −2000 → Interdental /θ/ (confirmed)
    * Audio soft/muffled + mildly negative Δ → Dentalized
    


## Output format
Return a single markdown table with exactly ${words.length} rows (one per word, in the listed order) and these columns:
| Word | Position | Heard | Judgment | Quality | Observation |

   - Word: The target word
   - Position: initial / medial / final
   - Heard: Exact transcription of what you heard. If the /s/ is clean and crisp, write the target word as-is.
   - Judgment: Accurate / Interdental / Lateral / Dentalized / Palatal / Distorted / Omitted
   - Quality: /s/ sound quality score 0-100 (100 = perfect crisp /s/, 0 = no /s/ at all). Clean productions should score 85+.
   - Observation: Brief clinical note (10-15 words)

Only mark a distortion when you can clearly hear it in the audio. The FFT alone is not enough — confirm with the audio. When the audio sounds clean, mark Accurate even if the FFT looks suspicious.

If a word is unclear or missing, put "—" in Heard, "Omitted" in Judgment, and 0 for Quality.

- Do NOT output a clarity score or summary — only the table.
- Respond with ONLY the markdown table. No preamble, no commentary.
- IMPORTANT: Observations must be plain-language clinical notes for a layperson. Do NOT use technical terms like FFT, Hz, formant, spectrogram, phoneme, sibilant band, audio override, etc. Describe what was heard in everyday words.`;
}

async function analyzeWithGemini(words, fftData, speakerContext) {
  const prompt = buildLispPrompt(words, fftData, speakerContext);

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${process.env.GEMINI_API_KEY}`;
  
  const parts = [{ text: prompt }];
  words.forEach((w, i) => {
    const b64 = stripDataUrlPrefix(w.audio_base64);
    if (!b64) return;
    parts.push({ text: `\n--- Clip ${i + 1}: "${w.word}" (${w.position || '?'}) ---` });
    parts.push({ inline_data: { mime_type: 'audio/webm', data: b64 } });
  });

  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 16000 }
  };

  console.log('🤖 Sending request to Gemini...');
  const resp = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('❌ Gemini API error:', errText);
    throw new Error(`Gemini API error: ${resp.status} - ${errText}`);
  }
  const data = await resp.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('Empty Gemini response');

  const usage = data?.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const totalTokens = usage.totalTokenCount || (promptTokens + outputTokens);
  console.log(`📊 Token usage — input: ${promptTokens}, output: ${outputTokens}, total: ${totalTokens}`);
  if (totalTokens > 0) {
    const testsPer1M = Math.floor(1_000_000 / totalTokens);
    console.log(`📈 Tests per 1M tokens (at this rate): ~${testsPer1M}`);
  }
  console.log('✅ Gemini analysis completed');
  return { rawText, usage: { promptTokens, outputTokens, totalTokens } };
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
      word: cells[0],
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

      const { words, fftData, voiceType, sibilantBand } = req.body || {};
      if (!Array.isArray(words) || !words.length) {
        return res.status(400).json({ error: 'words array required' });
      }

      const country = req.headers['x-appengine-country'] || req.headers['x-country'] || 'Unspecified';
      const region = req.headers['x-appengine-region'] || req.headers['x-region'] || 'Unspecified';
      const band = resolveBand(voiceType, sibilantBand);
      const speakerContext = { country, region, voiceType: voiceType || 'unspecified', band };
      console.log(`🎚️  Voice: ${speakerContext.voiceType} | band: ${band.low}–${band.high} Hz (target ${band.target})`);

      const { rawText, usage } = await analyzeWithGemini(words, fftData || [], speakerContext);
      const parsed = parseGeminiTable(rawText, words.length);
      res.status(200).json({ ...parsed, usage });
    } catch (err) {
      console.error('❌ analyzeLispSpeech error:', err);
      res.status(500).json({ error: err.message });
    }
  });
});
