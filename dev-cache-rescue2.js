/* ═══════════════════════════════════════════════════════════════
   dev-cache-rescue2.js — hunt the FIRST HALF of film3d.js
   unique markers: 'SURVIVAL' governor labels, 'applyGrade', 'GOV'
   scans: OneDrive trees, recycle bins, all browser cache profiles
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const NEEDLES = ['survival ladder', 'RESOLUTION-ONLY LADDER', 'boot grace', 'gradeNow'];
const ROOTS = [];

/* oneDrive + user trees that might hold copies */
const home = process.env.USERPROFILE || process.env.HOME;
for (const p of [
  home + '/OneDrive',
  home + '/OneDrive/Desktop',
  home + '/OneDrive/Documents',
  home + '/Downloads',
  home + '/Desktop',
]) if (fs.existsSync(p)) ROOTS.push(p);

/* recycle bins on all drives */
for (const d of ['C', 'D', 'E']) {
  const rb = d + ':/$RECYCLE.BIN';
  if (fs.existsSync(rb)) ROOTS.push(rb);
}

/* all browser cache profiles */
const LA = process.env.LOCALAPPDATA;
const cacheBase = [
  LA + '/Google/Chrome/User Data',
  LA + '/Microsoft/Edge/User Data',
];
for (const base of cacheBase) {
  if (!fs.existsSync(base)) continue;
  for (const prof of fs.readdirSync(base)) {
    const c = base + '/' + prof + '/Cache/Cache_Data';
    if (fs.existsSync(c)) ROOTS.push(c);
    const cc = base + '/' + prof + '/Code Cache/js';
    if (fs.existsSync(cc)) ROOTS.push(cc);
  }
}

function scanDir(dir, hits, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { scanDir(p, hits, depth + 1); continue; }
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.size < 4000 || st.size > 2000000) continue;
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    const s = buf.toString('utf8');
    let score = 0;
    for (const n of NEEDLES) if (s.includes(n)) score++;
    if (score >= 2) hits.push({ file: p, size: st.size, score, s });
  }
}

const hits = [];
for (const r of ROOTS) { console.log('scanning', r); scanDir(r, hits, 0); }
console.log('candidates:', hits.length);
for (const h of hits) {
  console.log('---', h.file, h.size, 'bytes, score', h.score);
  const out = 'film3d_firsthalf_' + path.basename(h.file).replace(/[^a-z0-9]/gi, '_') + '.txt';
  fs.writeFileSync(out, h.s, 'utf8');
  console.log('   dumped →', out);
}
if (!hits.length) console.log('NO first-half copies found');
