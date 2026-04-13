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

// Helper function to call Gemini API
async function analyzeWithGemini(wavBuffer) {
  const base64Audio = wavBuffer.toString('base64');

  const prompt = `You are a speech-language pathologist conducting a rhotacism assessment.
The patient said 8 words in sequence: red, car, tree, around, forest, problem, girl, world.

Analyze each word's /r/ sound and provide:

1. A markdown table with 8 rows (one per word) with these columns:
   - Word: The target word
   - Heard: Exact transcription of what you heard (e.g., "wed" if /r/ was /w/)
   - Judgment: Accurate / Substituted / Distorted / Omitted
   - Quality: R sound quality score 0-100 (100 = perfect rhotic, 0 = no rhotic quality)
   - Observation: Brief clinical note (10-15 words)

2. After the table, provide a GRI (Global Rhoticity Index) score 0-100 based on:
   - Percentage of accurate productions
   - Severity of errors (substitutions worse than distortions)
   - Consistency across phonetic environments

Be strict in detecting /w/ or /l/ substitutions.
If a word is unclear or missing, put "—" in Heard, "No Audio" in Judgment, and 0 for Quality.

Respond with ONLY the table and GRI score.
GRI: [score]`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'audio/wav', data: base64Audio } }
      ]
    }],
    generationConfig: {
      temperature: 0.3,
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
          await processAudio(audioBuffer, res);
        });
      } else if (req.headers['content-type']?.includes('application/json')) {
        // Handle JSON with base64 audio
        const { audioData } = req.body;

        if (!audioData) {
          return res.status(400).json({ error: 'Audio data required' });
        }

        audioBuffer = Buffer.from(audioData, 'base64');
        await processAudio(audioBuffer, res);
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
async function processAudio(audioBuffer, res) {
  try {
    console.log('🔧 Processing audio buffer of size:', audioBuffer.length);

    const outputWavPath = `/tmp/output_${Date.now()}.wav`;

    // Convert browser audio (whatever format) to proper WAV format for Gemini
    await convertToProperWav(audioBuffer, outputWavPath);

    // Read the converted WAV file
    const wavBuffer = fs.readFileSync(outputWavPath);
    console.log('📁 WAV file size:', wavBuffer.length);

    // Clean up WAV file
    fs.unlinkSync(outputWavPath);

    // Analyze with Gemini
    const result = await analyzeWithGemini(wavBuffer);

    res.status(200).json({ result });

  } catch (error) {
    console.error('❌ Error processing audio:', error);
    res.status(500).json({ error: error.message });
  }
}
