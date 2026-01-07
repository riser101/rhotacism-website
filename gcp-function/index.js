const functions = require('@google-cloud/functions-framework');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

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
    'http://127.0.0.1:8000'
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

// Helper function to call OpenAI API
async function analyzeWithOpenAI(wavBuffer) {
  const base64Audio = wavBuffer.toString('base64');

  const prompt = `Listen to the attached audio recording and analyze it.

Role & Expertise
You are a certified Speech-Language Pathologist (SLP) with clinical experience in diagnosing and treating rhotacism in adults. You specialize in perceptual phonetic analysis, motor speech patterns, and evidence-based articulation therapy.

Task
You will analyze one baseline (Week 0) audio recording of a patient producing the following words, in this exact order:

red, car, tree, around, forest, problem, girl, world

This recording represents the pre-treatment baseline.

Analysis Instructions (Think Carefully)
For each word, determine:

The type of /r/ being tested
(e.g., prevocalic /r/, post-vocalic /r/, r-blend, vocalic /ɝ/, /ɚ/)

The word position (initial, medial, final)

Whether the /r/ is:

Accurate

Distorted

Substituted

Omitted

A detailed perceptual description of the error quality (15-25 words), describing the acoustic characteristics, timing, tongue position inference, and comparison to target phoneme
(e.g., "Delayed /r/ onset; vowel initiates first, with weak late rhotic coloring rather than a firm consonantal /r/.")

Base judgments strictly on audible evidence. Do not speculate anatomically.

Output Rules (Critical)

Output ONLY a single table

No headings, no paragraphs, no explanations

The table must contain exactly these columns:

| Word | /r/ Type Tested | Position | Accuracy Judgment | Perceptual Error Description |

One row per word

Use detailed, clinician-appropriate language in the Perceptual Error Description column`;

  const chatRequest = {
    model: 'gpt-4o-audio-preview',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: "text",
            text: prompt
          },
          {
            type: "input_audio",
            input_audio: {
              data: base64Audio,
              format: "wav"
            }
          }
        ]
      }
    ],
    max_tokens: 2000,
    temperature: 1.0
  };

  console.log('🤖 Sending request to OpenAI...');
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(chatRequest)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ OpenAI API error:', errorText);
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  if (data.error) {
    throw new Error(data.error.message);
  }
  
  const result = data.choices?.[0]?.message?.content;
  if (!result) {
    throw new Error('No response content from OpenAI');
  }
  
  console.log('✅ OpenAI analysis completed');
  return result;
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
    
    // Convert browser audio (whatever format) to proper WAV format for OpenAI
    await convertToProperWav(audioBuffer, outputWavPath);
    
    // Read the converted WAV file
    const wavBuffer = fs.readFileSync(outputWavPath);
    console.log('📁 WAV file size:', wavBuffer.length);
    
    // Clean up WAV file
    fs.unlinkSync(outputWavPath);
    
    // Analyze with OpenAI
    const result = await analyzeWithOpenAI(wavBuffer);
    
    res.status(200).json({ result });
    
  } catch (error) {
    console.error('❌ Error processing audio:', error);
    res.status(500).json({ error: error.message });
  }
}