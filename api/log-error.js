const ALLOWED_HOSTS = [
  'compliance-analyzer-pearl.vercel.app',
  'compliance-analyzer-hector5olution5s-projects.vercel.app',
  'compliance-analyzer-git-main-hector5olution5s-projects.vercel.app',
  'localhost',
  '127.0.0.1',
];

const LOG_RATE_WINDOW_MS   = 60_000;
const LOG_RATE_MAX_REQUESTS = 20;
const logIpLog = new Map();

function isAllowedReferer(referer) {
  if (!referer) return false;
  try {
    const { hostname } = new URL(referer);
    return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function isLogRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - LOG_RATE_WINDOW_MS;
  const timestamps = (logIpLog.get(ip) || []).filter(t => t > windowStart);
  if (timestamps.length >= LOG_RATE_MAX_REQUESTS) { logIpLog.set(ip, timestamps); return true; }
  timestamps.push(now);
  logIpLog.set(ip, timestamps);
  return false;
}

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAllowedReferer(req.headers.referer)) return res.status(403).end();
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '').trim();
  if (isLogRateLimited(ip)) return res.status(429).end();

  const { message, stack, source, url, userId, role, ts } = req.body || {};
  console.error('[APP ERROR]', JSON.stringify({
    message, source, url, userId, role,
    ts: ts ? new Date(ts).toISOString() : new Date().toISOString(),
    stack: String(stack || '').slice(0, 1000),
  }));

  return res.status(204).end();
}
