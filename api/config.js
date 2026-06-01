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
  if (!isAllowedReferer(req.headers.referer)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return res.status(200).json({
    supabaseUrl:      process.env.SUPABASE_URL      || '',
    supabaseAnonKey:  process.env.SUPABASE_ANON_KEY || '',
  });
}
