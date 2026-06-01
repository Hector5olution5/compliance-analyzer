export const config = {
  api: {
    bodyParser:    { sizeLimit: '30mb' },
    responseLimit: '30mb',
  },
};

const ALLOWED_HOSTS = [
  'compliance-analyzer-pearl.vercel.app',
  'compliance-analyzer-hector5olution5s-projects.vercel.app',
  'compliance-analyzer-git-main-hector5olution5s-projects.vercel.app',
  'localhost',
  '127.0.0.1',
];

const MAX_TOKENS_CAP    = 4000;
const RATE_WINDOW_MS    = 60_000;
const RATE_MAX_REQUESTS = 30;

const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
]);

// In-memory sliding window — resets on cold start, acceptable for internal tool
const ipLog = new Map(); // ip -> number[]

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket?.remoteAddress || 'unknown').trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const timestamps = (ipLog.get(ip) || []).filter(t => t > windowStart);
  if (timestamps.length >= RATE_MAX_REQUESTS) {
    ipLog.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  ipLog.set(ip, timestamps);
  // Purge stale IPs to prevent memory leak under IP-rotating attacks
  if (ipLog.size > 2000) {
    for (const [k, ts] of ipLog) {
      if (ts.every(t => t < windowStart)) ipLog.delete(k);
    }
  }
  return false;
}

function isAllowedReferer(referer) {
  if (!referer) return false;
  try {
    const { hostname } = new URL(referer);
    return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, anthropic-version, anthropic-beta');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isAllowedReferer(req.headers.referer)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests — wait a minute and try again.' });
  }

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const body = { ...req.body };
  if ((body.max_tokens || 0) > MAX_TOKENS_CAP) body.max_tokens = MAX_TOKENS_CAP;
  if (!ALLOWED_MODELS.has(body.model)) body.model = 'claude-haiku-4-5-20251001';

  const headers = {
    'Content-Type':      'application/json',
    'x-api-key':         process.env.CLAUDE_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
