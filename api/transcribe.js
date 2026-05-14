export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb'
        }
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { audioData, mimeType, prompt } = req.body;

        if (!audioData) {
            return res.status(400).json({ error: 'Audio data required' });
        }

        const buffer = Buffer.from(audioData, 'base64');
        const type = mimeType || 'audio/webm';
        const ext = type.includes('webm') ? 'webm' : type.includes('mp4') ? 'mp4' : type.includes('wav') ? 'wav' : 'webm';

        const blob = new Blob([buffer], { type });
        const form = new FormData();
        form.append('file', blob, `audio.${ext}`);
        form.append('model', 'whisper-large-v3-turbo');
        form.append('response_format', 'json');
        form.append('language', 'en');
        // temp 0.4 → less autocorrection of lisped pronunciations (preserves th/s substitutions).
        form.append('temperature', '0.4');
        if (prompt) form.append('prompt', prompt);

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
            },
            body: form
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.log('Whisper error:', response.status, errorText);
            return res.status(response.status).json({ error: errorText });
        }

        const data = await response.json();
        res.status(200).json({ text: (data.text || '').trim() });

    } catch (error) {
        console.error('Whisper handler error:', error);
        res.status(500).json({ error: error.message });
    }
}
