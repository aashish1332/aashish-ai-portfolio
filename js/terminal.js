/* ═══════════════════════════════════════════════════════════════
   terminal.js — the post-credit terminal (Ctrl+K)
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Terminal = (() => {
  const el = {
    root: document.getElementById('terminal'),
    body: document.getElementById('terminalBody'),
    input: document.getElementById('terminalInput'),
    open: document.getElementById('terminalOpen'),
    close: document.getElementById('terminalClose'),
  };
  let open = false;

  const PROJECTS = {
    'volunteer': { name: 'Community Volunteer Management', stack: 'React 18 · Node · MySQL · Drizzle', fact: '90+ endpoints, 40+ tables, JWT+Argon2 auth, RBAC' },
    'grocery': { name: 'Smart Grocery List Generator', stack: 'React 19 · Express · MongoDB · Gemini AI', fact: 'AI suggestions across 24 items, affinity analytics' },
    'goal': { name: 'Goal Tracker SaaS', stack: 'Node · MongoDB · Groq Llama 3.3 70B', fact: 'XP system, streaks, offline sync, public share links' },
  };

  const HELP = [
    'help              — this list',
    'whoami            — about the director',
    'skills            — tech credits',
    'projects          — list films',
    'open <project>    — volunteer | grocery | goal',
    'contact           — how to reach the director',
    'sudo hire aashish — the hidden command 👀',
    'lens              — enter the FluidGlass mode (G)',
    'stats             — live render engine telemetry',
    'quality <0-4>     — force render tier (0=cinematic … 4=safe)',
    'districts         — legend: what am I flying through?',
    'clear             — wipe the screen',
  ].join('\n');

  const OUT = {
    whoami:
`Aashish Kumar — Full-Stack Developer, B.Tech CSE @ LPU (CGPA 8.28)
Minor in AI (IIT Ropar × Masai). Directs AI to build his vision:
defines product & systems, AI writes to spec, he reviews hard.`,
    skills:
`LANGS     Python C C++ Java JS HTML CSS
FRONTEND  React Next Tailwind Vite
BACKEND   Node Express REST
DATA      MongoDB MySQL PostgreSQL Drizzle Mongoose
AI        Gemini Groq Llama 3.3 70B
SEC       JWT Argon2 bcrypt CORS rate-limit
TOOLS     Git GitHub VS Code Postman Vercel`,
    contact:
`email     aashishkumarrajut1345@gmail.com
phone     +91 62802 87425
github    github.com/aashish1332
linkedin  linkedin.com/in/aashishkumar13`,
    'sudo hire aashish':
`[sudo] password for recruiter: ********
access granted ✔
examining candidate..................... IMPRESSIVE
scheduling interview.................... OK
→ scroll up and send the pitch. he replies fast.`,
  };

  function print(text, cls = 't-out') {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    el.body.appendChild(p);
    el.body.scrollTop = el.body.scrollHeight;
  }

  function printHTML(html, cls = 't-out') {
    const p = document.createElement('p');
    p.className = cls;
    p.innerHTML = html;
    el.body.appendChild(p);
    el.body.scrollTop = el.body.scrollHeight;
  }

  function run(cmdRaw) {
    const cmd = cmdRaw.trim().toLowerCase();
    if (!cmd) return;
    printHTML(`<span class="t-in">➜ ${cmdRaw}</span>`);
    Sound.blip(660, 0.04, 'square', 0.03);

    if (cmd === 'help') return print(HELP);
    if (cmd === 'clear') { el.body.innerHTML = ''; return; }
    if (OUT[cmd]) return print(OUT[cmd]);

    if (cmd === 'projects') {
      print(Object.keys(PROJECTS).map((k) =>
        `  ${k.padEnd(12)} ${PROJECTS[k].name}`).join('\n'));
      print('type: open <name>', 't-sys');
      return;
    }
    if (cmd.startsWith('open ')) {
      const key = cmd.slice(5).trim();
      const p = PROJECTS[key];
      if (!p) return print(`no film called "${key}". try: projects`, 't-err');
      print(`${p.name} — ${p.stack}\n${p.fact}`, 't-ok');
      return;
    }
    if (cmd === 'open') return print('open what? try: projects', 't-err');

    if (cmd === 'lens') {
      if (!window.FluidGlass) return print('fluidglass module offline', 't-err');
      FluidGlass.toggle();
      return print('entering the lens… (Esc or G to exit)', 't-ok');
    }

    /* render-engine telemetry + manual quality override */
    if (cmd === 'stats') {
      const g = window.Film3D ? window.Film3D.govStatus() : null;
      if (!g) return print('render engine offline — CSS fallback active', 't-err');
      return print(
        `RENDER ENGINE — live telemetry\n` +
        `  fps        ${g.fps}\n` +
        `  tier       ${g.tier} (${g.label})\n` +
        `  resolution ${g.scale} of native\n` +
        `  bloom      ${g.bloom}\n` +
        `  mirror     ${g.mirror}\n` +
        `governor auto-scales to hold 60 fps (floor 30).\n` +
        `override: quality <0-4>`, 't-sys');
    }
    if (cmd.startsWith('quality')) {
      const arg = cmd.slice(7).trim();
      if (!arg) {
        const g = window.Film3D ? window.Film3D.govStatus() : null;
        if (!g) return print('render engine offline — CSS fallback active', 't-err');
        return print(`tier ${g.tier} (${g.label}) · ${g.fps} fps · ${g.scale} · bloom ${g.bloom}`, 't-sys');
      }
      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 0 || n > 4) return print('usage: quality <0-4>', 't-err');
      if (!window.Film3D) return print('render engine offline — CSS fallback active', 't-err');
      window.Film3D.forceTier(n);
      const g = window.Film3D.govStatus();
      return print(`governor overridden → tier ${g.tier} (${g.label}) · ${g.scale} · bloom ${g.bloom}.\nauto-adapt resumes in a few seconds.`, 't-ok');
    }

    if (cmd === 'districts') {
      return print([
        'WHERE YOU ARE FLYING — the city is the stack:',
        '  ◉ three orange rings        API GATEWAY — every request enters here',
        '  ▨ boulevard towers          SERVICES — node/express apps, live windows',
        '  ⌇ orange streams            API CALLS — requests flowing tower→tower',
        '  ◍ cyan monolith + beam      DATABASE — the single source of truth',
        '  ▦ orange pod grids          CONTAINERS — deploys booting in sequence',
        '  ▤ elevated cyan line        EXPRESS.JS METRO — middleware in motion',
        '  ⌐ billboard tickers         LIVE LOGS — GET 200 · builds · SQL · retries',
        '  ▲ cranes + scaffold towers  ALWAYS SHIPPING — construction never stops',
      ].join('\n'));
    }
    return print(`command not found: ${cmd} — try 'help'`, 't-err');
  }

  function lenis() {
    return (window.Director && Director.getLenis) ? Director.getLenis() : null;
  }

  function show() {
    open = true;
    el.root.hidden = false;
    /* author `display:flex` beats the UA `[hidden]` rule — set it
       explicitly so show/hide can never be defeated by CSS */
    el.root.style.display = 'flex';
    if (lenis()) lenis().stop();   // hold the film still while console is open
    gsap.fromTo(el.root, { opacity: 0, y: 30, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out' });
    setTimeout(() => el.input.focus(), 100);
    Sound.blip(520, 0.08, 'sine', 0.05);
  }
  function hide() {
    open = false;
    el.root.hidden = true;
    el.root.style.display = 'none';   // hard close — immune to CSS specificity
    if (lenis()) lenis().start();
    el.input.blur();
  }

  function init() {
    /* repair the initial state: `.terminal { display:flex }` overrides
       the hidden attribute, so the console would ride visible on load */
    if (el.root.hidden) el.root.style.display = 'none';

    el.open.addEventListener('click', show);
    el.close.addEventListener('click', hide);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        run(el.input.value);
        el.input.value = '';
      }
      if (e.key === 'Escape') hide();
    });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open ? hide() : show();
      }
      if (e.key === 'Escape' && open) hide();   // close even if input lost focus
    });
    /* scrolling inside the console must not scroll the film behind it */
    el.root.addEventListener('wheel', (e) => e.stopPropagation());
  }

  return { init, run, show, hide };
})();

/* const at top level of a classic script does NOT attach to window —
   expose it explicitly so cross-script guards (window.Terminal) work */
window.Terminal = Terminal;
