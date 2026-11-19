const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
let modelsOrder = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview'];

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  } else {
    entry.count += 1;
  }
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Only POST requests are supported.' });
  }

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests. Please wait a minute.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'AI_NOT_CONFIGURED',
      message: 'GEMINI_API_KEY is missing in Vercel Environment Variables.'
    });
  }

  try {
    const body = await readJsonBody(req);
    const {
      action = 'chat',
      mode = 'learning',
      message = '',
      history = [],
      poem = '',
      topic = '',
      difficulty = 'intermediate',
      officialContext = ''
    } = body;

    if (action === 'chat' && (!message || typeof message !== 'string' || message.trim().length > 2000)) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Message must be 1-2000 characters.' });
    }
    if (action === 'evaluate' && (!poem || typeof poem !== 'string' || poem.trim().length < 5 || poem.trim().length > 4000)) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Please enter at least one poetic line.' });
    }

    const systemInstruction = `You are "رفيق الشاعر" (The Poet's Companion), an AI Arabic Poetry Learning & Competition Assistant for the "سوق عكاظ" (Souq Ukaz) Competition at Darul Huda Islamic University, Chemmad.
1. Detect the user's language (Arabic, English, or Malayalam) and reply in that same language unless asked otherwise.
2. BREVITY & SIMPLICITY: Always give short, simple, clear answers (2 to 4 short sentences or 3 brief bullet points max, under 80 words unless asked for detail). Avoid long essays.
3. Mode: ${mode === 'competition' ? 'COMPETITION MODE' : 'LEARNING MODE'}. Never write or complete original poems for official competition submissions.
4. Official facts only: ${officialContext || 'Souq Ukaz Impromptu Arabic Poetry Competition, Darul Huda Islamic University, Chemmad. Age 15-25. Stage 1 free poem on "على أنقاض العدالة" due Nov 30, 2026. Top 30 announced Dec 5, 2026. ₹50 fee for selected 30 finalists only. Final round Dec 20, 2026. Prizes ₹7001, ₹5001, ₹3001. Contacts: 8590409367, 90725 84470, arabicdept@dhiu.in.'}
5. Note briefly that AI prosody/عروض feedback is approximate, not an authoritative ruling.`;

    let contents = [];
    if (action === 'evaluate') {
      contents = [{
        role: 'user',
        parts: [{
          text: `Give brief, encouraging feedback (under 110 words) on this PRACTICE Arabic poem for "${topic || 'Arabic Poetry'}" (${difficulty}). Cover in short bullets: Grammar (النحو), Vocabulary (المفردات), Imagery (الصورة), Rhyme (القافية), Approximate Metre (الوزن), and 1 quick tip.\n\n${poem.trim()}`
        }]
      }];
    } else {
      const safeHistory = Array.isArray(history) ? history.slice(-4) : [];
      contents = safeHistory
        .filter(m => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'model'))
        .map(m => ({ role: m.role, parts: [{ text: m.text.slice(0, 1000) }] }));
      contents.push({ role: 'user', parts: [{ text: message.trim() }] });
    }

    const requestBody = JSON.stringify({
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature: mode === 'competition' ? 0.3 : 0.7,
        maxOutputTokens: 350
      }
    });

    let lastErr = '';
    for (const model of modelsOrder) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const upstream = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: controller.signal
        });
        clearTimeout(timer);

        if (upstream.ok) {
          const data = await upstream.json();
          const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (reply) {
            modelsOrder = [model, ...modelsOrder.filter(m => m !== model)];
            return res.status(200).json({ reply, model });
          }
        } else {
          lastErr = await upstream.text();
          if (upstream.status !== 503 && upstream.status !== 429 && upstream.status !== 404) {
            return res.status(502).json({ error: 'UPSTREAM_AI_ERROR', message: lastErr.slice(0, 200) });
          }
        }
      } catch (e) {
        clearTimeout(timer);
        lastErr = e.message || 'Timeout';
      }
    }

    return res.status(502).json({ error: 'UPSTREAM_AI_ERROR', message: lastErr.slice(0, 200) || 'All models busy. Please retry.' });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', message: err?.message || 'Unexpected server error.' });
  }
}
