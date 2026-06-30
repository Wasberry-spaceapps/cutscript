export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const today = new Date().toISOString().split('T')[0];
    const rlKey = `rl:${ip}:${today}`;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // GET /api/status
      if (request.method === 'GET' && url.pathname === '/api/status') {
        let used = 0;
        if (env.KV_STORE) {
          const usedStr = await env.KV_STORE.get(rlKey);
          if (usedStr) used = parseInt(usedStr, 10);
        }
        return new Response(JSON.stringify({
          transcriptions: { used, limit: 3, resetsAt: "midnight UTC" }
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // POST /api/transcribe
      if (request.method === 'POST' && url.pathname === '/api/transcribe') {
        let used = 0;
        if (env.KV_STORE) {
          const usedStr = await env.KV_STORE.get(rlKey);
          if (usedStr) used = parseInt(usedStr, 10);
          if (used >= 3) {
            return new Response(JSON.stringify({
              error: "Daily limit reached",
              message: "You've used your 3 free transcriptions for today. Resets at midnight UTC."
            }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        const body = await request.json();
        const { audioBase64, mimeType } = body;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`;
        const geminiReq = {
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: audioBase64 } },
              { text: "Transcribe this audio with word-level timestamps. Return ONLY a JSON array where each element is: { word: string, start: number, end: number } Times in seconds, 2 decimal places. No markdown, no explanation, no code fences." }
            ]
          }],
          generationConfig: { responseMimeType: "application/json" }
        };

        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'X-goog-api-key': env.GEMINI_KEY
          },
          body: JSON.stringify(geminiReq)
        });

        if (!response.ok) {
           const errBody = await response.text();
           return new Response(errBody, { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const data = await response.json();
        if (!data.candidates || data.candidates.length === 0) {
           return new Response(JSON.stringify({ error: "Empty candidates in Gemini response" }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        
        const parts = data.candidates[0].content.parts || [];
        const textPart = parts.find(p => p.text !== undefined);
        let textContent = textPart ? textPart.text : '[]';
        textContent = textContent.replace(/```json/gi, '').replace(/```/g, '').trim();
        const words = JSON.parse(textContent);

        if (env.KV_STORE) {
          await env.KV_STORE.put(rlKey, (used + 1).toString());
        }

        return new Response(JSON.stringify({ words, remaining: 3 - (used + 1) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // POST /api/enhance
      if (request.method === 'POST' && url.pathname === '/api/enhance') {
        const body = await request.json();
        const { words } = body;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`;
        const geminiReq = {
          contents: [{
            parts: [
              { text: `Here are words with timestamps from a video transcript: ${JSON.stringify(words)}\nIdentify ALL filler words (um, uh, like, you know, basically, literally, right, so, actually) and return ONLY a JSON array of {start, end} ranges to cut. No other text. No markdown, no explanation, no code fences.` }
            ]
          }],
          generationConfig: { responseMimeType: "application/json" }
        };

        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'X-goog-api-key': env.GEMINI_KEY
          },
          body: JSON.stringify(geminiReq)
        });
        
        if (!response.ok) {
           const errBody = await response.text();
           return new Response(errBody, { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const data = await response.json();
        if (!data.candidates || data.candidates.length === 0) {
           return new Response(JSON.stringify({ error: "Empty candidates in Gemini response" }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const parts = data.candidates[0].content.parts || [];
        const textPart = parts.find(p => p.text !== undefined);
        let textContent = textPart ? textPart.text : '[]';
        textContent = textContent.replace(/```json/gi, '').replace(/```/g, '').trim();
        const cuts = JSON.parse(textContent);

        return new Response(JSON.stringify({ cuts }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({error: 'Not Found'}), { status: 404, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
