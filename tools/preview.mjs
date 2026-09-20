#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   tools/preview.mjs — build, then serve exactly what ships

     npm run preview        → build + http://localhost:5580 (dist/)

   A one-file wrapper rather than `ROOT=dist PORT=5580 node …` in the npm
   script, because npm runs scripts through cmd.exe on Windows where that
   prefix syntax is not valid. It reuses the dev server with `ROOT` set, so
   the preview is served by the same MIME table the dev flow already proved —
   the assistant's ES modules included.
   ═══════════════════════════════════════════════════════════════ */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBundle, ROOT } from './build.mjs';

const PORT = process.env.PORT || '5580';
const HERE = dirname(fileURLToPath(import.meta.url));

buildBundle({ out: join(ROOT, 'dist') });

console.log(`\nserving dist/ — this is the production bundle (stripped knowledge.json,\n`
          + `no dev tooling). Ctrl+C to stop.\n`);

const child = spawn(process.execPath, [resolve(HERE, '..', 'dev-server.mjs')], {
  env: { ...process.env, ROOT: 'dist', PORT },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
