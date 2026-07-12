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
    'http://localhost:5501',
    'http://127.0.0.1:5500',
    'http://localhost:5500'
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

// =============================================
// STUTTERING ASSESSMENT PROMPT
// Gemini listens to each speech sample as a human ear would — NO correction,
// NO "what the speaker meant". It transcribes disfluency exactly as heard and
// flags every stutter moment with type, location, and severity.
// =============================================
function buildStutterPrompt(samples, speakerContext) {
  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';

  const sampleList = samples.map((s, i) => {
    const label = s.label || s.id || `Sample ${i + 1}`;
    // Reading passage has a known target text — give it so the model can
    // detect repetitions/blocks against the expected words.
    const target = s.targetText ? `\n   Target text (read aloud): "${s.targetText}"` : '';
    return `Sample ${i + 1} — ${label} (${s.kind || ''})${target}`;
  }).join('\n');

  return `You are a speech-language pathologist (fluency specialist) assessing a person who stutters. You are given ${samples.length} audio recordings, one per speaking condition, in this order:
${sampleList}

Speaker context (use to interpret accent and rate — do NOT mistake a fast or accented natural rate for a disfluency):
- Country: ${country}
- Region: ${region}

## How to listen
Listen to each clip exactly as a human ear hears it — in real time, without mentally "fixing" the speech. Do NOT autocorrect, do NOT report what the speaker intended to say, do NOT clean up the transcript. Capture the disfluency as it actually sounds.

Flag a STUTTER MOMENT (a "disfluency") whenever you hear any of these:
- Part-word repetition — repeating a sound or syllable: "b-b-ball", "ca-ca-cat"
- Whole-word repetition — "I-I-I went", "and-and"
- Prolongation — stretching a sound: "ssssun", "mmmmom"
- Block — a silent stoppage / audible struggle where airflow or voice is stuck before a word comes out
- Broken word — a pause inside a word: "ba...by"
- Audible struggle / tension, pitch rise, or a physical-sounding push to get a word out

Do NOT flag these as stutters (these are NORMAL disfluencies everyone produces):
- Filler words / interjections ("um", "uh", "like") UNLESS they are clearly used to push past a block — note those separately as "interjection"
- Single revisions or rephrasing of a thought
- Natural pausing between sentences or to think

## Output format
For EACH sample, output a section that begins with a heading line in EXACTLY this form:
### SAMPLE <number>: <label>

Immediately under the heading, output ONE summary line in EXACTLY this form:
SUMMARY: severity=<WNL|Mild|Moderate|Severe>; stutter_count=<integer>; percent_syllables_stuttered=<integer 0-100>; dominant_type=<Repetition|Prolongation|Block|Mixed|None>
   (severity: WNL = within normal limits / fluent, no clinically significant stuttering)
   Set severity STRICTLY from percent_syllables_stuttered, using these bands:
     WNL = under 3% | Mild = 3–8% | Moderate = 9–19% | Severe = 20% or more.
   percent_syllables_stuttered must reflect how many syllables in THIS sample carried a stutter moment — count honestly; do not under-report.

Then a markdown table with these columns (one row per stutter moment you heard, in the order they occur):
| Word/Sound | Type | What you heard | Severity | Note |

   - Word/Sound: the word or sound where the stutter happened (e.g. "ball", "the /s/ in sun"). If you cannot make out the exact word, describe its position (e.g. "start of 2nd sentence").
   - Type: Part-word repetition / Whole-word repetition / Prolongation / Block / Broken word / Interjection
   - What you heard: write it exactly as it sounded — "b-b-ball", "ssssun", "[2s silent block]". This is the raw disfluent production, NOT the corrected word.
   - Severity: Mild / Moderate / Severe (based on duration and physical tension you can hear)
   - Note: brief plain-language clinical observation (8-15 words)

If a sample is fluent (no true stutters), output the SUMMARY line with severity=WNL and stutter_count=0, then a single table row: | — | None | Speech was fluent | — | No stuttering detected in this sample |

If a sample contains NO audible speech at all (silence, only background noise, or completely inaudible), do NOT mark it fluent. Instead output: SUMMARY: severity=No Speech; stutter_count=0; percent_syllables_stuttered=0; dominant_type=None — then a single table row: | — | No Speech | [silent / inaudible] | — | The recording appears silent or inaudible |

After all per-sample sections, output ONE final section beginning with this exact heading:
### OVERALL
Then ONE line in EXACTLY this form:
OVERALL: severity=<WNL|Mild|Moderate|Severe>; total_stutters=<integer>; pattern=<one short plain-language sentence describing the overall pattern, e.g. "Blocks dominate under stress; automatic speech and reading are fluent.">

## Rules
- Audio is the ONLY evidence. Judge purely from what you hear.
- Be precise about WHERE each stutter occurs so the user can see their own moments.
- Use everyday language in notes. No jargon (no "disfluency cluster", "fundamental frequency", etc.) — say what a non-expert would understand.
- Respond with ONLY the sample sections and the OVERALL section. No preamble, no extra commentary.`;
}

// One Gemini round-trip. Retries on 5xx (transient Google-side errors).
async function callGemini(parts, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.0,
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
    // fetch() throws a generic "fetch failed"; the real reason lives in .cause
    const cause = netErr.cause || {};
    const detail = cause.code || cause.message || netErr.message;
    if (attempt < MAX_ATTEMPTS) {
      const delay = 1000 * attempt;
      console.warn(`⚠️ Gemini fetch failed (${detail}), retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return callGemini(parts, attempt + 1);
    }
    console.error('❌ Gemini fetch failed permanently:', detail, cause);
    throw netErr;
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('❌ Gemini API error:', errText);
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
  const thinkingTokens = usage.thoughtsTokenCount || 0;
  const outputTokens = usage.candidatesTokenCount || 0;
  const totalTokens = usage.totalTokenCount || (promptTokens + thinkingTokens + outputTokens);

  const inputByModality = {};
  (usage.promptTokensDetails || []).forEach(d => { inputByModality[d.modality || 'UNKNOWN'] = d.tokenCount || 0; });
  const audioInput = inputByModality.AUDIO || 0;
  const textInput = inputByModality.TEXT || 0;
  const otherInput = promptTokens - audioInput - textInput;

  const RATE = { textIn: 0.50, audioIn: 1.00, output: 3.00 };
  const inputCost = (textInput * RATE.textIn + audioInput * RATE.audioIn + Math.max(0, otherInput) * RATE.textIn) / 1e6;
  const outputCost = ((thinkingTokens + outputTokens) * RATE.output) / 1e6;
  const reportCost = inputCost + outputCost;

  console.log(`📊 Tokens — input: ${promptTokens} (audio: ${audioInput}, text: ${textInput}${otherInput ? ', other: ' + otherInput : ''}), thinking: ${thinkingTokens}, output: ${outputTokens}, total: ${totalTokens}`);
  console.log(`🏁 finishReason: ${finishReason}${finishReason === 'MAX_TOKENS' ? '  ⚠️ TRUNCATED' : ''}`);
  console.log(`💰 Cost — total: $${reportCost.toFixed(5)}/report  (≈ $${(reportCost * 1000).toFixed(2)} / 1k reports)`);
  console.log('✅ Gemini analysis completed');

  console.log('📄 Gemini raw response:\n' + rawText);
  return { rawText, usage: { promptTokens, audioInput, textInput, thinkingTokens, outputTokens, totalTokens, finishReason, reportCost } };
}

// Build [prompt, clip, clip, …] parts. One clip per speaking condition.
function buildAudioParts(prompt, samples) {
  const parts = [{ text: prompt }];
  samples.forEach((s, i) => {
    const b64 = stripDataUrlPrefix(s.audio_base64);
    if (!b64) return;
    parts.push({ text: `\n--- Sample ${i + 1}: "${s.label || s.id}" (${s.kind || ''}) ---` });
    parts.push({ inline_data: { mime_type: s.mimeType || 'audio/webm', data: b64 } });
  });
  return parts;
}

async function analyzeStutterWithGemini(samples, speakerContext) {
  const prompt = buildStutterPrompt(samples, speakerContext);
  return callGemini(buildAudioParts(prompt, samples));
}

// =============================================
// Standard clinical %SS (percent syllables stuttered) → severity bands.
// Severity is derived here, NOT trusted from the model's freeform guess,
// so a sample with 30% stuttered syllables can never come back "Moderate".
//   WNL < 3% | Mild 3–9% | Moderate 9–20% | Severe ≥ 20%
function severityFromPercent(pct) {
  const p = Number(pct) || 0;
  if (p >= 20) return 'Severe';
  if (p >= 9) return 'Moderate';
  if (p >= 3) return 'Mild';
  return 'WNL';
}

const SEVERITY_RANK = { 'WNL': 0, 'Mild': 1, 'Moderate': 2, 'Severe': 3 };

// PARSING — split Gemini's response into per-sample blocks, pull the SUMMARY
// line + the stutter-moment table for each, plus the OVERALL block.
// =============================================
function parseSummaryLine(block) {
  const m = block.match(/SUMMARY:\s*(.+)/i);
  if (!m) return {};
  const out = {};
  m[1].split(';').forEach(pair => {
    const [k, v] = pair.split('=').map(x => (x || '').trim());
    if (!k) return;
    out[k] = v;
  });
  return {
    severity: out.severity || 'Unknown',
    stutterCount: parseInt(out.stutter_count) || 0,
    percentSyllablesStuttered: parseInt(out.percent_syllables_stuttered) || 0,
    dominantType: out.dominant_type || 'Unknown'
  };
}

function parseMomentTable(block) {
  const rows = [];
  for (const line of block.split('\n')) {
    if (!line.includes('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 2) continue;
    if (cells[0].includes('---')) continue;
    if (/^word\/?sound$/i.test(cells[0])) continue;
    while (cells.length < 5) cells.push('');
    // Skip the "fluent" / "no speech" placeholder row from being counted as a real moment.
    const isPlaceholder = cells[0] === '—' && /^(none|no speech)$/i.test(cells[1]);
    rows.push({
      wordOrSound: cells[0],
      type: cells[1] || '',
      heard: cells[2] || '',
      severity: cells[3] || '',
      note: cells[4] || '',
      placeholder: isPlaceholder
    });
  }
  return rows;
}

function parseStutterResponse(rawText) {
  // Split on "### SAMPLE n: label" headings.
  const sampleRe = /###\s*SAMPLE\s*(\d+)\s*:\s*(.+)/gi;
  const headings = [];
  let m;
  while ((m = sampleRe.exec(rawText)) !== null) {
    headings.push({ index: m.index, num: parseInt(m[1]), label: m[2].trim() });
  }

  const overallIdx = rawText.search(/###\s*OVERALL/i);
  const samples = [];

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length
      ? headings[i + 1].index
      : (overallIdx >= 0 ? overallIdx : rawText.length);
    const block = rawText.slice(start, end);
    const summary = parseSummaryLine(block);
    const moments = parseMomentTable(block).filter(r => !r.placeholder);
    // Derive sample severity from %SS frequency — override the model's guess.
    // Leave "No Speech" (silent/inaudible) untouched.
    const isNoSpeech = /^no\s*speech$/i.test(String(summary.severity || ''));
    if (!isNoSpeech) {
      summary.severity = severityFromPercent(summary.percentSyllablesStuttered);
    }
    samples.push({
      num: headings[i].num,
      label: headings[i].label,
      ...summary,
      moments
    });
  }

  // OVERALL block.
  let overall = {};
  if (overallIdx >= 0) {
    const oBlock = rawText.slice(overallIdx);
    const om = oBlock.match(/OVERALL:\s*(.+)/i);
    if (om) {
      const parts = {};
      // pattern may contain ';' inside the sentence — split only first two keys.
      const segs = om[1].split(';');
      segs.forEach(seg => {
        const eq = seg.indexOf('=');
        if (eq < 0) return;
        const k = seg.slice(0, eq).trim();
        const v = seg.slice(eq + 1).trim();
        parts[k] = v;
      });
      overall = {
        severity: parts.severity || 'Unknown',
        totalStutters: parseInt(parts.total_stutters) || samples.reduce((s, x) => s + (x.stutterCount || 0), 0),
        pattern: parts.pattern || ''
      };
    }
  }
  if (!overall.severity) {
    overall = {
      severity: 'Unknown',
      totalStutters: samples.reduce((s, x) => s + (x.stutterCount || 0), 0),
      pattern: ''
    };
  }

  // Overall severity = worst sample severity (skip No Speech). Keeps the
  // headline consistent with the per-sample %SS bands instead of a free guess.
  const ranked = samples
    .filter(s => !/^no\s*speech$/i.test(String(s.severity || '')))
    .map(s => s.severity)
    .filter(s => s in SEVERITY_RANK);
  if (ranked.length) {
    overall.severity = ranked.reduce((a, b) => SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a);
  }

  return { result: rawText, samples, overall };
}

functions.http('analyzeStutterSpeech', (req, res) => {
  console.log('🚀 Stutter analysis request received');
  corsMiddleware(req, res, async () => {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
      if (!req.headers['content-type']?.includes('application/json')) {
        return res.status(400).json({ error: 'Expected application/json' });
      }

      const { samples } = req.body || {};
      if (!Array.isArray(samples) || !samples.length) {
        return res.status(400).json({ error: 'samples array required' });
      }
      const withAudio = samples.filter(s => s && s.audio_base64);
      if (!withAudio.length) {
        return res.status(400).json({ error: 'no audio in samples' });
      }

      const country = req.headers['x-appengine-country'] || req.headers['x-country'] || 'Unspecified';
      const region = req.headers['x-appengine-region'] || req.headers['x-region'] || 'Unspecified';
      const speakerContext = { country, region };
      console.log(`🎚️  ${withAudio.length} samples | country: ${country}`);

      const { rawText, usage } = await analyzeStutterWithGemini(withAudio, speakerContext);
      const parsed = parseStutterResponse(rawText);
      res.status(200).json({ ...parsed, usage });
    } catch (err) {
      console.error('❌ analyzeStutterSpeech error:', err);
      res.status(500).json({ error: err.message });
    }
  });
});
