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

  // ── Upload (base64 body from browser) ────────────────────────────────────
  if (req.method === 'POST') {
    const { path, data, contentType } = req.body || {};
    if (!path || !data || !contentType) {
      return res.status(400).json({ error: 'Missing path, data or contentType' });
    }

    const ALLOWED_TYPES = ['application/pdf','image/jpeg','image/png','image/gif','image/webp'];
    if (!ALLOWED_TYPES.includes(contentType)) {
      return res.status(400).json({ error: 'Tipo de archivo no permitido' });
    }
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(path) || path.includes('..')) {
      return res.status(400).json({ error: 'Path inválido' });
    }

    const buffer = Buffer.from(data, 'base64');
    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/evidencias/${path}`,
      { method: 'POST', headers: { ...sbHeaders, 'Content-Type': contentType }, body: buffer }
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      return res.status(uploadRes.status).json({ error: err.message || err.error || 'Upload failed' });
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/evidencias/${path}`;
    return res.status(200).json({ publicUrl, path });
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
