const ALLOWED_HOSTS = [
  'compliance-analyzer-pearl.vercel.app',
  'compliance-analyzer-hector5olution5s-projects.vercel.app',
  'compliance-analyzer-git-main-hector5olution5s-projects.vercel.app',
  'localhost',
  '127.0.0.1',
];

function isAllowedReferer(referer) {
  if (!referer) return false;
  try {
    const { hostname } = new URL(referer);
    return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAllowedReferer(req.headers.referer)) return res.status(403).end();

  const { message, stack, source, url, userId, role, ts } = req.body || {};
  console.error('[APP ERROR]', JSON.stringify({
    message, source, url, userId, role,
    ts: ts ? new Date(ts).toISOString() : new Date().toISOString(),
    stack: String(stack || '').slice(0, 1000),
  }));

  return res.status(204).end();
}
