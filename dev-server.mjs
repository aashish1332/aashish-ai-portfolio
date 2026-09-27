/* tiny static dev server — no dependencies */
import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize, resolve } from 'path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  /* .mjs MUST be JavaScript: served as application/octet-stream the browser
     refuses to execute it as a module, so the whole lazy AI chunk fails to
     load. (Express's static handler in server.js already maps it correctly.) */
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* `ROOT` lets the same server preview the production bundle:
     npm run build && ROOT=dist PORT=5580 node dev-server.mjs
   Previewing what actually ships (stripped knowledge.json included) is the
   only way to notice that a build step changed behaviour. */
const root = resolve(process.env.ROOT || process.cwd());
const port = +(process.env.PORT || 5577);
const label = process.env.ROOT ? `preview (${process.env.ROOT})` : 'dev server';

/* `FAIL_MODEL=1` 404s everything under /ai/model-export/, so the model's
   download-failure path can be driven for real (dev-degrade-probe.js §2).
   Fault injection has to happen HERE and not in the browser: the weights are
   fetched from inside a module Worker, and CDP's Network.setBlockedURLs on
   the page session does not intercept a dedicated worker's requests — a
   browser-side block silently reported a healthy download as a passing test.
   Nothing about this touches shipped code; it is a dev-server knob. */
const failModel = process.env.FAIL_MODEL === '1';

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
    if (failModel && urlPath.startsWith('/ai/model-export/')) {
      res.writeHead(404); return res.end('not found (FAIL_MODEL)');
    }
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, () => console.log(`🎬 ${label} → http://localhost:${port}`
  + (failModel ? '  [FAIL_MODEL: /ai/model-export/ 404s]' : '')));
