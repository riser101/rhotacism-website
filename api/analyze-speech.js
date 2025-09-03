export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { audioData } = req.body;
        
        if (!audioData) {
            return res.status(400).json({ error: 'Audio data required' });
        }

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
                            text: "Please analyze this speech sample for R sound patterns only. I said these words: red, car, tree, around, forest, problem, girl, world.\n\nProvide ONLY:\n\n## The Rollr Academy Word-by-Word Analysis\nFor each word, describe what you hear for the R sound.\n\n## Substitution Pattern Summary\nList the consistent patterns you observed.\n\nFormat with proper markdown headers (##) and bullet points (-). Do not include any recommendations, treatment suggestions, or severity ratings."
                        },
                        {
                            type: "input_audio",
                            input_audio: {
                                data: audioData,
                                format: "mp3"
                            }
                        }
                    ]
                }
            ]
        };

        console.log('Sending request to OpenAI with model:', chatRequest.model);
        console.log('Request body:', JSON.stringify(chatRequest, null, 2));

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify(chatRequest)
        });

        console.log('OpenAI response status:', response.status);
        console.log('OpenAI response headers:', Object.fromEntries(response.headers.entries()));

        if (!response.ok) {
            const errorText = await response.text();
            console.log('OpenAI error response:', errorText);
            throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error.message);
        }
        
        const result = data.choices?.[0]?.message?.content;
        if (!result) {
            throw new Error('No response content');
        }
        
        res.status(200).json({ result });
        
    } catch (error) {
        console.error('OpenAI API error:', error);
        res.status(500).json({ error: error.message });
    }
}