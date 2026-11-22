/* POST /api/contact — Vercel serverless function.
   Sends the brief through Resend when RESEND_API_KEY is configured.
   The site keeps its mailto fallback for local development and for a
   deployment where the key has not been added yet. */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (limited(ip)) return json(res, 429, { error: 'Too many briefs. Try again later.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const name = String(body?.name || '').trim();
  const email = String(body?.email || '').trim();
  const message = String(body?.message || '').trim();

  if (!name || name.length > 120 || !EMAIL_RE.test(email) || email.length > 200
    || !message || message.length > 4000) {
    return json(res, 400, { error: 'Invalid payload.' });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return json(res, 503, {
      error: 'Email delivery is not configured.',
      code: 'email_not_configured',
    });
  }

  const to = process.env.CONTACT_TO || 'aashishkumarrajut1345@gmail.com';
  const from = process.env.CONTACT_FROM || 'Portfolio <onboarding@resend.dev>';
  const safe = {
    name: escapeHtml(name),
    email: escapeHtml(email),
    message: escapeHtml(message).replace(/\n/g, '<br>'),
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: `Portfolio brief from ${name.replace(/[\r\n]+/g, ' ')}`,
        text: `${message}\n\n— ${name} (${email})`,
        html: `<h2>New portfolio brief</h2>
          <p><strong>${safe.name}</strong> &lt;${safe.email}&gt;</p>
          <p>${safe.message}</p>`,
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      console.error('contact delivery failed', response.status, detail?.message || 'unknown error');
      return json(res, 502, { error: 'Email delivery failed.' });
    }
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('contact delivery error', error?.message || error);
    return json(res, 502, { error: 'Email delivery failed.' });
  }
}
