/* ═══════════════════════════════════════════════════════════════
   dev-cache-rescue.js v2 — find film3d.js body by CODE CONTENT
   (Simple Cache body blobs don't carry the URL; the code does)
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const LA = process.env.LOCALAPPDATA;
const ROOTS = [
  LA + '/Google/Chrome/User Data/Default/Cache/Cache_Data',
  LA + '/Google/Chrome/User Data/Profile 1/Cache/Cache_Data',
  LA + '/Microsoft/Edge/User Data/Default/Cache/Cache_Data',
  LA + '/Microsoft/Edge/User Data/Profile 1/Cache/Cache_Data',
].filter(fs.existsSyncSync ? fs.existsSync : fs.existsSync);

/* unique-to-film3d content markers */
const MARK = 'CatmullRomCurve3';
const TAIL = /window\.Film3D\s*=\s*Film3D;/;
const HEAD = /\/\*═{10,}|THE FILM|ScrollDirector/;

function scanDir(dir, hits) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scanDir(p, hits); continue; }
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.size < 20000) continue; // our file is ~35-45KB
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    if (!buf.includes(MARK)) continue;
    hits.push({ file: p, size: buf.length, buf });
  }
}

const hits = [];
for (const r of ROOTS) { console.log('scanning', r); scanDir(r, hits); }
console.log('candidate files:', hits.length);

let recovered = 0;
for (const h of hits) {
  const s = h.buf.toString('utf8');
  const tail = TAIL.exec(s);
  if (!tail) { console.log(h.file, '→ has marker, no tail'); continue; }
  /* find the true start: last banner before tail that begins the module */
  let start = s.lastIndexOf('/* ═', tail.index);
  if (start === -1) start = s.lastIndexOf('const Film3D', tail.index);
  if (start === -1) { console.log(h.file, '→ no start marker'); continue; }
  const body = s.slice(start, tail.index + tail[0].length);
  if (body.length < 20000) { console.log(h.file, '→ body too short', body.length); continue; }
  const out = 'film3d_recovered_' + (recovered++) + '.js';
  fs.writeFileSync(out, body, 'utf8');
  console.log('✓ wrote', out, body.length, 'bytes | head:', JSON.stringify(body.slice(0, 70)));
}
if (!recovered) console.log('NOT RECOVERED from these caches');
