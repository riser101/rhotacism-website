const functions = require('@google-cloud/functions-framework');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Configure multer for handling audio uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// CORS configuration
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

// Helper function to convert any browser audio format to proper WAV for OpenAI
function convertToProperWav(inputBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const tempInputPath = `/tmp/input_${Date.now()}.audio`;
    
    // Write input buffer to temporary file
    fs.writeFileSync(tempInputPath, inputBuffer);
    
    ffmpeg(tempInputPath)
      .toFormat('wav')
      .audioCodec('pcm_s16le')  // 16-bit PCM (required by OpenAI)
      .audioChannels(1)         // Mono (required by OpenAI)
      .audioFrequency(16000)    // 16kHz sample rate (optimal for OpenAI)
      .on('end', () => {
        console.log('✅ Browser audio converted to proper WAV format');
        // Clean up input file
        fs.unlinkSync(tempInputPath);
        resolve();
      })
      .on('error', (err) => {
        console.error('❌ FFmpeg conversion error:', err);
        // Clean up input file
        if (fs.existsSync(tempInputPath)) {
          fs.unlinkSync(tempInputPath);
        }
        reject(err);
      })
      .save(outputPath);
  });
}

function stripDataUrlPrefix(base64OrDataUrl) {
  if (!base64OrDataUrl) return '';
  const commaIndex = base64OrDataUrl.indexOf(',');
  return commaIndex >= 0 ? base64OrDataUrl.slice(commaIndex + 1) : base64OrDataUrl;
}

async function combineWordAudioToWav(words, outputWavPath) {
  const tempFiles = [];
  const listPath = `/tmp/concat_${Date.now()}.txt`;

  try {
    // Write each word audio to a temp file
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const base64 = stripDataUrlPrefix(word.audio_base64);
      if (!base64) continue;

      const buffer = Buffer.from(base64, 'base64');
      const tempPath = `/tmp/word_${Date.now()}_${i}.audio`;
      fs.writeFileSync(tempPath, buffer);
      tempFiles.push(tempPath);
    }

    if (tempFiles.length === 0) {
      throw new Error('No valid word audio provided');
    }

    // Create concat list file for ffmpeg
    const listBody = tempFiles.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(listPath, listBody);

    // Concatenate and convert to the target WAV format
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
    // Clean up temp files
    tempFiles.forEach((file) => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
    if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
  }
}

// Helper function to call Gemini API
async function analyzeWithGemini(wavBuffer, speakerContext = {}) {
  const base64Audio = wavBuffer.toString('base64');

  const country = speakerContext.country || 'Unspecified';
  const region = speakerContext.region || 'Unspecified';
  const f3Data = speakerContext.f3Data || 'No frequency data available.';

  const prompt = `You are a speech-language pathologist conducting a rhotacism assessment. The patient said 8 words in sequence: red, car, tree, around, forest, problem, girl, world.

Speaker context (use this to interpret accent, slang, and acoustic norms):
- Country: ${country}
- Region: ${region}

Account for regional accent and slang from the speaker's country/region. For example, a non-rhotic dialect (e.g. British RP, Australian) may legitimately drop postvocalic /r/ — do NOT penalise that as an error if it matches the dialect's expected production.

You are provided with:
1. The combined audio recording of all 8 words
2. Frequency analysis data for each word, including where the /r/ sound occurs:

${f3Data}

Use BOTH the audio AND the frequency data to make your assessment:
- trough_f3 = lowest F3 found in the word
- trough_f3_f2_gap = distance between F3 and F2 at the same instant the F3 trough occurs. This is the key /r/ marker — it tells you exactly where the dip is:
    * SMALL gap (~<500) → F3 collapsed onto F2 → correct /r/
    * LARGE gap (>1000) → F3 stayed high → likely /w/ substitution or missing /r/
    * In-between → distorted or weak /r/

Analyze each word's /r/ sound and provide a markdown table with 8 rows (one per word) with these columns:
   - Word: The target word
   - Heard: Exact transcription of what you heard (e.g., "wed" if /r/ was /w/)
   - Judgment: Accurate / Substituted / Distorted / Omitted
   - Quality: R sound quality score 0-100 (100 = perfect R, 0 = no R sound at all)
   - Observation: Brief clinical note (10-15 words)

Be strict in detecting /w/ or /l/ substitutions. If you hear "wed" instead of "red", mark Substituted with low Quality score.

If a word is unclear or missing, put "—" in Heard, "No Audio" in Judgment, and 0 for Quality.

IMPORTANT: NO technical terms like formant, Hz, spectrogram, phoneme, etc.
Do NOT output a GRI score — that is computed separately. Respond with ONLY the table.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'audio/wav', data: base64Audio } }
      ]
    }],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 16000
    }
  };

  console.log('🤖 Sending request to Gemini...');

  const response = await fetch(geminiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Gemini API error:', errorText);
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    throw new Error('No response content from Gemini');
  }

  console.log('✅ Gemini analysis completed');
  return rawText;
}

// Main Cloud Function
functions.http('analyzeSpeech', async (req, res) => {
  console.log('🚀 Speech analysis request received');

  // Handle CORS preflight
  corsMiddleware(req, res, async () => {
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      // Extract geo from GCP/Cloud Run headers (set automatically by load balancer)
      const country = req.headers['x-appengine-country'] || req.headers['x-country'] || 'Unspecified';
      const region = req.headers['x-appengine-region'] || req.headers['x-region'] || 'Unspecified';
      const speakerContext = { country, region };
      console.log('🌍 Geo headers — country:', country, 'region:', region);

      // Handle different content types
      let audioBuffer;

      if (req.headers['content-type']?.includes('multipart/form-data')) {
        // Handle multipart form data
        upload.single('audio')(req, res, async (err) => {
          if (err) {
            console.error('❌ Multer error:', err);
            return res.status(400).json({ error: 'File upload error: ' + err.message });
          }

          if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
          }

          audioBuffer = req.file.buffer;
          await processAudio(audioBuffer, res, speakerContext);
        });
      } else if (req.headers['content-type']?.includes('application/json')) {
        // Handle JSON with base64 audio
        const { audioData, f3Data, words } = req.body;

        if (!audioData && (!Array.isArray(words) || words.length === 0)) {
          return res.status(400).json({ error: 'Audio data required' });
        }

        if (f3Data) speakerContext.f3Data = f3Data;

        if (Array.isArray(words) && words.length > 0) {
          await processAudio({ words }, res, speakerContext);
        } else {
          audioBuffer = Buffer.from(audioData, 'base64');
          await processAudio(audioBuffer, res, speakerContext);
        }
      } else {
        return res.status(400).json({ error: 'Unsupported content type' });
      }

    } catch (error) {
      console.error('❌ Error in analyzeSpeech:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// Helper function to process audio
async function processAudio(audioInput, res, speakerContext = {}) {
  try {
    if (audioInput && audioInput.words) {
      console.log('🔧 Processing per-word audio count:', audioInput.words.length);
    } else {
      console.log('🔧 Processing audio buffer of size:', audioInput.length);
    }
    console.log('🌍 Speaker context:', speakerContext);

    const outputWavPath = `/tmp/output_${Date.now()}.wav`;

    // Convert browser audio (whatever format) to proper WAV format for Gemini
    if (audioInput && audioInput.words) {
      await combineWordAudioToWav(audioInput.words, outputWavPath);
    } else {
      await convertToProperWav(audioInput, outputWavPath);
    }

    // Read the converted WAV file
    const wavBuffer = fs.readFileSync(outputWavPath);
    console.log('📁 WAV file size:', wavBuffer.length);

    // Clean up WAV file
    fs.unlinkSync(outputWavPath);

    // Analyze with Gemini
    const result = await analyzeWithGemini(wavBuffer, speakerContext);

    res.status(200).json({ result });

  } catch (error) {
    console.error('❌ Error processing audio:', error);
    res.status(500).json({ error: error.message });
  }
}
