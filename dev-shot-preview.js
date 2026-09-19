/* ═══════════════════════════════════════════════════════════════
   dev-shot-preview.js — make probe screenshots readable

   The visual probe writes full-res PNGs (~800 KB), which is larger
   than image readers accept. This downscales any of them to a small
   JPEG using Chrome's own decoder.

   Usage:  node dev-shot-preview.js shots/before/p38.png shots/after2/p55.png
           CROP=0,200,390,220 node dev-shot-preview.js shots/hudfix/p50.png

   CROP=x,y,w,h crops before scaling, so a band of a tall phone shot can
   be blown up past native size to actually read its text.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTH = +(process.env.WIDTH || 960);
const QUALITY = +(process.env.QUALITY || 78);
const CROP = (process.env.CROP || '').split(',').map(Number);

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('usage: node dev-shot-preview.js <png> [more.png ...]');
    process.exit(1);
  }
  fs.mkdirSync('shots/preview', { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-first-run'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  for (const f of files) {
    if (!fs.existsSync(f)) { console.log('missing:', f); continue; }
    const url = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    const jpeg = await page.evaluate(async (src, width, quality, crop) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const on = crop.length === 4 && crop.every((n) => Number.isFinite(n));
      const sx = on ? crop[0] : 0, sy = on ? crop[1] : 0;
      const sw = on ? crop[2] : img.width, sh = on ? crop[3] : img.height;
      const c = document.createElement('canvas');
      const scale = Math.min(3, width / sw);
      c.width = Math.round(sw * scale);
      c.height = Math.round(sh * scale);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality);
    }, url, WIDTH, QUALITY / 100, CROP);

    const suffix = CROP.length === 4 ? '_crop' : '';
    const out = path.join('shots/preview',
      path.basename(path.dirname(f)) + '_' + path.basename(f, '.png') + suffix + '.jpg');
    fs.writeFileSync(out, Buffer.from(jpeg.split(',')[1], 'base64'));
    console.log(out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
  }
  await browser.close();
})().catch((e) => { console.log('preview fail:', e.message); process.exit(1); });
