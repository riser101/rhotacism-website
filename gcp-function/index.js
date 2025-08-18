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
    'https://www.rhotacismtherapy.com',
    'https://rhotacismtherapy.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
};

const corsMiddleware = cors(corsOptions);

// Helper function to convert browser WAV/WebM to proper WAV for OpenAI
function convertToProperWav(inputBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const tempInputPath = `/tmp/input_${Date.now()}.wav`;
    
    // Write input buffer to temporary file
    fs.writeFileSync(tempInputPath, inputBuffer);
    
    ffmpeg(tempInputPath)
      .toFormat('wav')
      .audioCodec('pcm_s16le')  // 16-bit PCM (required by OpenAI)
      .audioChannels(1)         // Mono (required by OpenAI)
      .audioFrequency(16000)    // 16kHz sample rate (optimal for OpenAI)
      .on('end', () => {
        console.log('✅ Browser WAV converted to proper WAV format');
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
  
  const chatRequest = {
    model: 'gpt-4o-audio-preview',
    messages: [
      {
        role: 'system',
        content: "You are a licensed speech-language pathologist with expertise in rhotacism assessment. Analyze the audio recording and provide clinical observations only.\n\nFocus on:\n- Specific R sound substitutions observed (r→w, r→l, r→y, omissions)\n- Accurate phonetic observations for each target word\n- What you hear for each word\n\nDo NOT provide:\n- Clinical recommendations\n- Treatment suggestions\n- Severity ratings\n- Next steps\n\nFormat using simple markdown:\n- Use ## for main headings\n- Use - for bullet points\n- Keep bullet point continuations aligned with proper indentation\n- Use **bold** for emphasis"
      },
      {
        role: 'user',
        content: [
          {
            type: "text",
            text: "Please analyze this speech sample for R sound patterns only. I said these words: red, car, tree, around, forest, problem, girl, world.\n\nProvide ONLY:\n\n## Word-by-Word Analysis\nFor each word, describe what you hear for the R sound.\n\n## Substitution Pattern Summary\nList the consistent patterns you observed.\n\nFormat with proper markdown headers (##) and bullet points (-). Do not include any recommendations, treatment suggestions, or severity ratings."
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
    ]
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
    
    // Convert browser WAV to proper WAV format for OpenAI
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