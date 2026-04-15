require('dotenv').config();
const functions = require('@google-cloud/functions-framework');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const cors = require('cors');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

const corsOptions = {
  origin: [
    'https://www.topspeech.health',
    'https://topspeech.health',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:5502',
    'http://localhost:5502'
  ],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
};
const corsMiddleware = cors(corsOptions);

// Target /s/ band constants (used to describe "difference from targeted region")
const TARGET_MIN_HZ = 5000;
const TARGET_MAX_HZ = 9000;
const TARGET_CENTER_HZ = 7000;

function stripDataUrlPrefix(b64) {
  if (!b64) return '';
  const i = b64.indexOf(',');
  return i >= 0 ? b64.slice(i + 1) : b64;
}

// Concatenate per-word WebM clips into a single 16-kHz mono WAV.
async function combineWordAudioToWav(words, outputWavPath) {
  const tempFiles = [];
  const listPath = `/tmp/concat_${Date.now()}.txt`;
  try {
    for (let i = 0; i < words.length; i++) {
      const base64 = stripDataUrlPrefix(words[i].audio_base64);
      if (!base64) continue;
      const tempPath = `/tmp/word_${Date.now()}_${i}.audio`;
      fs.writeFileSync(tempPath, Buffer.from(base64, 'base64'));
      tempFiles.push(tempPath);
    }
    if (!tempFiles.length) throw new Error('No valid word audio provided');

    fs.writeFileSync(listPath, tempFiles.map(f => `file '${f}'`).join('\n'));

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f concat', '-safe 0'])
        .toFormat('wav')
        .audioCodec('pcm_s16le')
        .audioChannels(1)
        .audioFrequency(16000)
        .on('end', resolve)
        .on('error', reject)
        .save(outputWavPath);
    });
  } finally {
    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
  }
}

// Build a per-word summary the Gemini prompt can read, including the
// client-computed FFT difference from the /s/ target region.
function formatFftSummary(fftData) {
  if (!Array.isArray(fftData) || !fftData.length) return 'No FFT data provided.';

  const lines = fftData.map(w => {
    const peak = Math.round(w.peakHz || 0);
    const centroid = Math.round(w.centroidHz || 0);
    const hf = typeof w.hfRatio === 'number' ? w.hfRatio.toFixed(2) : '—';
    const target = Math.round(w.targetHz || TARGET_CENTER_HZ);
    const diffFromCenter = peak ? (peak - target) : null;

    // Signed distance from the 5–9 kHz target band (0 = inside band).
    let bandDelta = 0;
    if (peak) {
      if (peak < TARGET_MIN_HZ) bandDelta = peak - TARGET_MIN_HZ; // negative: too low
      else if (peak > TARGET_MAX_HZ) bandDelta = peak - TARGET_MAX_HZ; // positive: too high
    }

    const interp =
      !peak ? 'No reliable sibilant frames found — likely omission or very soft production.'
      : bandDelta < -2000 ? 'Peak far BELOW target band — strong /θ/ (interdental) substitution signal.'
      : bandDelta < 0     ? 'Peak below target band — dentalized or frontal lisp likely.'
      : bandDelta > 0     ? 'Peak above target band — may indicate a whistled or palatal production.'
      :                     'Peak inside target band — acoustically consistent with a clean /s/.';

    return `- "${w.word}" (${w.position || '?'}): peak ${peak} Hz, centroid ${centroid} Hz, HF ratio ${hf}, target ${target} Hz, Δcenter ${diffFromCenter !== null ? (diffFromCenter >= 0 ? '+' : '') + diffFromCenter + ' Hz' : '—'}, band Δ ${bandDelta >= 0 ? '+' : ''}${bandDelta} Hz. ${interp}`;
  });

  return lines.join('\n');
}

function buildLispPrompt(words, fftData, speakerContext) {
  const wordList = words.map((w, i) => `${i + 1}. ${w.word}${w.position ? ' (' + w.position + ')' : ''}`).join(', ');
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const fftBlock = formatFftSummary(fftData);

  return `You are a speech-language pathologist conducting a sigmatism (lisp) screening.
The patient read these target words aloud, in order: ${wordList}.

Speaker context (use this to interpret accent and acoustic norms):
- Country: ${country}
- Region: ${region}

You are given:
1. The combined audio recording (all words concatenated in order). This is the PRIMARY evidence.
2. Per-word FFT metrics computed on the client. These tell you exactly how far each word's sibilant energy peak is from the expected /s/ target region (5000–9000 Hz, center 7000 Hz).

## Per-word FFT metrics (differences are from the /s/ target region)
${fftBlock}

## How to use the FFT data
- "band Δ" is the signed distance in Hz from the nearest edge of the 5–9 kHz target band. 0 means the peak sits inside the band (good /s/).
- A strongly NEGATIVE band Δ (< −2000 Hz) almost always means /θ/ substitution ("sun" → "thun"). Listen specifically for a "th"-like quality.
- A mildly negative band Δ (between −2000 and 0 Hz) suggests dentalized or frontal production — softer, duller /s/.
- HF ratio < 0.3 with low centroid reinforces frontal/interdental lisp. HF ratio in 0.25–0.5 with mid centroid hints at a lateral (slushy) lisp.
- The FFT flags can be wrong — always trust the audio if it clearly contradicts the metric.

## Transcription rules for the "Heard" column
- Write exactly what you hear as a phonetic spelling a parent would understand.
- If /s/ sounds like /θ/, write the word with "th" — e.g., "sun" → "thun", "bus" → "buth", "pencil" → "penthil".
- If /s/ is slushy or wet, append "(slushy)" — e.g., "sun (slushy)".
- If /s/ is soft/dull but not replaced, append "(soft s)" — e.g., "sun (soft s)".
- If /s/ is clean and crisp, write the target word with no annotation.
- If the word is unclear or missing, write "—".
- NEVER default to the target word when you hear a distortion.

## Output format
Return a single markdown table with exactly ${words.length} rows (one per word, in the listed order) and these columns:
| Word | Position | Heard | Judgment | Quality | Observation |

- Word: the target word.
- Position: initial / medial / final.
- Heard: exact transcription (see rules above).
- Judgment: one of Accurate / Interdental / Lateral / Dentalized / Palatal / Distorted / Omitted.
- Quality: 0–100 (100 = perfect crisp sibilant, 0 = no /s/ at all).
- Observation: 10–15 plain-language words. No technical terms (no Hz, formant, spectrogram, phoneme).

## Critical rules
- Do NOT assume the patient said the word correctly — your job is to catch distortions.
- When the FFT flags a distortion AND you hear something off, mark it. Don't second-guess both signals.
- Do NOT output a clarity score or summary — only the table.
- Respond with ONLY the markdown table. No preamble, no commentary.`;
}

async function analyzeWithGemini(wavBuffer, words, fftData, speakerContext) {
  const base64Audio = wavBuffer.toString('base64');
  const prompt = buildLispPrompt(words, fftData, speakerContext);

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'audio/wav', data: base64Audio } }
      ]
    }],
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
  console.log('✅ Gemini analysis completed');
  return rawText;
}

// Parse the markdown table and compute a Sibilant Clarity Index (0–100).
function parseGeminiTable(rawText, expectedCount) {
  const rows = [];
  for (const line of rawText.split('\n')) {
    const cells = line.split('|').map(c => c.trim()).filter(c => c);
    if (cells.length < 5) continue;
    if (cells[0].includes('---')) continue;
    if (cells[0].toLowerCase() === 'word') continue;
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

functions.http('analyzeLispSpeech', async (req, res) => {
  console.log('🚀 Lisp analysis request received');
  corsMiddleware(req, res, async () => {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
      if (!req.headers['content-type']?.includes('application/json')) {
        return res.status(400).json({ error: 'Expected application/json' });
      }

      const { words, fftData } = req.body || {};
      if (!Array.isArray(words) || !words.length) {
        return res.status(400).json({ error: 'words array required' });
      }

      const country = req.headers['x-appengine-country'] || req.headers['x-country'] || 'Unspecified';
      const region = req.headers['x-appengine-region'] || req.headers['x-region'] || 'Unspecified';
      const speakerContext = { country, region };

      const outputWavPath = `/tmp/output_${Date.now()}.wav`;
      await combineWordAudioToWav(words, outputWavPath);
      const wavBuffer = fs.readFileSync(outputWavPath);
      fs.unlinkSync(outputWavPath);

      const raw = await analyzeWithGemini(wavBuffer, words, fftData || [], speakerContext);
      const parsed = parseGeminiTable(raw, words.length);
      res.status(200).json(parsed);
    } catch (err) {
      console.error('❌ analyzeLispSpeech error:', err);
      res.status(500).json({ error: err.message });
    }
  });
});
