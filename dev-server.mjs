/* tiny static dev server — no dependencies */
import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const root = process.cwd();
const port = +(process.env.PORT || 5577);

/* ── POST /api/contact ──
   Mirrors server.js's contract (validate, accept, log) so the post-credit
   form works against this dependency-free dev server instead of 404-ing
   (which made the browser fall back to a mailto: navigation). */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function apiContact(req, res) {
  const body = await readBody(req);
  const { name, email, message } = body || {};
  if (!name || !email || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(res, 400, { error: 'Invalid payload.' });
  }
  /* no database in dev — print the pitch so nothing is silently lost */
  console.log(`\n📩 NEW PITCH\n   from    ${name} <${email}>\n   message ${String(message).slice(0, 500)}\n`);
  json(res, 200, { ok: true, stored: 'console' });
}

http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/api/contact') {
      if (req.method === 'POST') return await apiContact(req, res);
      return json(res, 405, { error: 'Method not allowed.' });
    }
    if (urlPath === '/api/health') return json(res, 200, { ok: true });
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`🎬 dev server → http://localhost:${port}`));
