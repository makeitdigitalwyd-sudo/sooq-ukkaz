// Vercel Serverless Function: /api/poet-assistant
// Securely proxies requests to Google Gemini API without exposing GEMINI_API_KEY to the browser.

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Only POST requests are supported.' });
  }

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please wait a minute before trying again.'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'AI_NOT_CONFIGURED',
      message: 'GEMINI_API_KEY is not configured on the Vercel server. Add GEMINI_API_KEY in Vercel Project Settings -> Environment Variables and redeploy.'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
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
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Message must be between 1 and 2000 characters.' });
    }
    if (action === 'evaluate' && (!poem || typeof poem !== 'string' || poem.trim().length < 5 || poem.trim().length > 4000)) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Please enter at least one poetic line to evaluate.' });
    }

    const systemInstruction = `You are "رفيق الشاعر" (The Poet's Companion), an intelligent, warm, and scholarly AI Arabic Poetry Learning & Competition Assistant for the "سوق عكاظ" (Souq Ukaz) Impromptu Arabic Poetry Competition at Darul Huda Islamic University, Chemmad.

CORE RULES:
1. MULTILINGUAL AUTO-DETECTION: Detect the user's language (Arabic, English, or Malayalam) and respond naturally in that exact same language unless they explicitly ask for another language. You may include Arabic poetic terms with simple explanations in English or Malayalam when helpful.
2. COMPETITION INTEGRITY (STRICT):
   - Current Mode: ${mode === 'competition' ? 'COMPETITION MODE' : 'LEARNING MODE'}.
   - NEVER write, generate, or complete an original poem for an official competition submission (especially on the official topic "على أنقاض العدالة" or when the user asks you to write their competition entry).
   - NEVER help disguise AI-generated poetry as original human work.
   - Clearly remind candidates if asked that رفيق الشاعر is a learning and practice companion, not a replacement for their own creativity.
3. OFFICIAL COMPETITION FACTS ONLY:
   Use ONLY the verified official competition context below when answering competition questions. If a specific detail is missing or uncertain, explicitly tell the candidate to contact the organizers (8590409367 / 90725 84470 / arabicdept@dhiu.in) instead of guessing.
   OFFICIAL CONTEXT:
   ${officialContext || 'Souq Ukaz Impromptu Arabic Poetry Competition, Dept. of Arabic Language & Literature, Darul Huda Islamic University, Chemmad. Age: 15-25. Stage 1: Submit 10 lines on "على أنقاض العدالة" by Nov 30, 2026 (free). Top 30 finalists announced Dec 5, 2026. Registration fee of ₹50 applies only to selected 30 finalists. Final round: Dec 20, 2026 at Darul Huda Campus. Prizes
     
