const ALLOWED_HOSTS = [
  'compliance-analyzer-pearl.vercel.app',
  'compliance-analyzer-hector5olution5s-projects.vercel.app',
  'compliance-analyzer-git-main-hector5olution5s-projects.vercel.app',
  'localhost',
  '127.0.0.1',
];

export const config = {
  api: {
    bodyParser: { sizeLimit: '30mb' },
    responseLimit: '30mb',
  },
};

function isAllowedReferer(referer) {
  if (!referer) return false;
  try {
    const { hostname } = new URL(referer);
    return ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
  } catch { return false; }
}

export default async function handler(req, res) {
  if (!isAllowedReferer(req.headers.referer)) return res.status(403).json({ error: 'Forbidden' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Storage not configured on server' });
  }

  const sbHeaders = {
    'Authorization': `Bearer ${serviceKey}`,
    'apikey': serviceKey,
  };

  // ── Generate signed upload URL (browser uploads directly to Supabase) ────
  if (req.method === 'POST') {
    const { path, contentType } = req.body || {};
    if (!path || !contentType) {
      return res.status(400).json({ error: 'Missing path or contentType' });
    }

    const signRes = await fetch(
      `${supabaseUrl}/storage/v1/object/sign/upload/evidencias/${path}`,
      { method: 'POST', headers: { ...sbHeaders, 'Content-Type': 'application/json' }, body: '{}' }
    );

    if (!signRes.ok) {
      const err = await signRes.json().catch(() => ({}));
      return res.status(signRes.status).json({ error: err.message || err.error || 'Failed to generate upload URL' });
    }

    const { signedURL } = await signRes.json();
    const signedUrl = `${supabaseUrl}${signedURL}`;
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/evidencias/${path}`;
    return res.status(200).json({ signedUrl, publicUrl });
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { path } = req.body || {};
    if (!path) return res.status(400).json({ error: 'Missing path' });

    await fetch(
      `${supabaseUrl}/storage/v1/object/evidencias/${path}`,
      { method: 'DELETE', headers: sbHeaders }
    ).catch(() => {});

    return res.status(204).end();
  }

  return res.status(405).end();
}
