/* ═══════════════════════════════════════════════════════════════
   main.js — boot orchestration
   WebGL film first (CSS fallback if it fails), then director,
   cursor, terminal, sound, contact form.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ═══════════════ THEME — schematic / screen ═══════════════ */
function initTheme() {
  const btn = document.getElementById('themeToggle');
  const label = document.getElementById('themeLabel');
  const meta = document.getElementById('themeColor');
  const root = document.documentElement;

  const apply = (theme, persist) => {
    const light = theme === 'light';
    root.dataset.theme = light ? 'light' : 'dark';
    if (meta) meta.setAttribute('content', light ? '#e8f0ef' : '#080909');
    if (btn) {
      btn.setAttribute('aria-pressed', String(light));
      btn.setAttribute('aria-label', light ? 'Switch to screen theme' : 'Switch to schematic theme');
    }
    if (label) label.textContent = light ? 'SCREEN' : 'SCHEMATIC';
    if (persist) {
      try { localStorage.setItem('ak-theme', light ? 'light' : 'dark'); } catch { /* private mode */ }
    }
  };

  apply(root.dataset.theme, false);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    apply(next, true);
    if (window.Sound) Sound.blip(next === 'light' ? 520 : 760, 0.06, 'sine', 0.04);
  });
}

/* ═══════════════ SCENE LINKS ═══════════════
   Native anchors work with JS off; with Lenis running they use the
   Director so the glide and the camera stay in sync. */
function initSceneLinks() {
  if (!window.Director || !Director.scrollTo) return;
  document.querySelectorAll('[data-scene-link]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.dataset.sceneLink;
      if (!id || !document.getElementById(id)) return;
      e.preventDefault();
      Director.scrollTo('#' + id, {
        immediate: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      });
    });
  });
}

/* ═══════════════ FORM (graceful without backend) ═══════════════ */
function initContactForm() {
  const form = document.getElementById('contactForm');
  const status = document.getElementById('formStatus');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = { name: fd.get('name'), email: fd.get('email'), message: fd.get('message') };
    status.textContent = 'TRANSMITTING…';
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('bad status');
      status.textContent = '✔ RECEIVED. HE REPLIES FAST.';
    } catch {
      const mail = `mailto:aashishkumarrajut1345@gmail.com?subject=${encodeURIComponent('Portfolio pitch from ' + payload.name)}&body=${encodeURIComponent(payload.message + '\n\n— ' + payload.name + ' (' + payload.email + ')')}`;
      window.location.href = mail;
      status.textContent = 'OPENING YOUR MAIL CLIENT…';
    }
  });
}

/* ═══════════════ CURSOR + MAGNETIC ═══════════════ */
function initCursor() {
  if (window.matchMedia('(hover: none)').matches) return;
  const cursor = document.querySelector('.cursor');
  const dot = cursor.querySelector('.cursor__dot');
  const ring = cursor.querySelector('.cursor__ring');
  const label = cursor.querySelector('.cursor__label');
  let mx = -100, my = -100, rx = -100, ry = -100;

  window.addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; });
  gsap.ticker.add(() => {
    rx = lerp(rx, mx, 0.16);
    ry = lerp(ry, my, 0.16);
    dot.style.transform = `translate(${mx}px, ${my}px)`;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;
    if (label) label.style.transform = `translate(${mx + 18}px, ${my + 18}px)`;
  });

  document.querySelectorAll('[data-cursor]').forEach((elm) => {
    elm.addEventListener('pointerenter', () => {
      if (label) label.textContent = elm.dataset.cursor;
      cursor.classList.add('has-label');
    });
    elm.addEventListener('pointerleave', () => cursor.classList.remove('has-label'));
  });

  document.querySelectorAll('[data-magnetic]').forEach((elm) => {
    elm.addEventListener('pointermove', (e) => {
      const r = elm.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      gsap.to(elm, { x: dx * 0.25, y: dy * 0.25, duration: 0.3 });
      cursor.classList.add('is-hover');
    });
    elm.addEventListener('pointerleave', () => {
      gsap.to(elm, { x: 0, y: 0, duration: 0.5, ease: 'elastic.out(1,0.4)' });
      cursor.classList.remove('is-hover');
    });
  });

  document.querySelectorAll('a, button, .chapters__dot').forEach((elm) => {
    elm.addEventListener('pointerenter', () => cursor.classList.add('is-hover'));
    elm.addEventListener('pointerleave', () => cursor.classList.remove('is-hover'));
  });
}

/* ═══════════════ HERO DEPTH ═══════════════
   A few pixels of pointer-led parallax give the title and dossier actual
   depth without turning the hero into a toy. Pointer devices only. */
function initHeroMotion() {
  if (!window.gsap || window.matchMedia('(hover: none)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const scene = document.getElementById('scene-hero');
  if (!scene) return;
  const title = scene.querySelector('.hero__title');
  const dossier = scene.querySelector('.hero__dossier');
  if (!title) return;

  gsap.set(title, { transformPerspective: 900, transformStyle: 'preserve-3d' });
  if (dossier) gsap.set(dossier, { transformPerspective: 900 });

  const titleX = gsap.quickTo(title, 'x', { duration: .7, ease: 'power3.out' });
  const titleY = gsap.quickTo(title, 'y', { duration: .7, ease: 'power3.out' });
  const titleRY = gsap.quickTo(title, 'rotationY', { duration: .8, ease: 'power3.out' });
  const titleRX = gsap.quickTo(title, 'rotationX', { duration: .8, ease: 'power3.out' });
  const cardX = dossier && gsap.quickTo(dossier, 'x', { duration: .8, ease: 'power3.out' });
  const cardY = dossier && gsap.quickTo(dossier, 'y', { duration: .8, ease: 'power3.out' });

  const move = (e) => {
    const nx = e.clientX / window.innerWidth - .5;
    const ny = e.clientY / window.innerHeight - .5;
    titleX(nx * 20);
    titleY(ny * 10);
    titleRY(nx * 3.5);
    titleRX(ny * -2.5);
    if (cardX && cardY) {
      cardX(nx * -12);
      cardY(ny * -6);
    }
  };
  const reset = () => {
    titleX(0); titleY(0); titleRY(0); titleRX(0);
    if (cardX && cardY) { cardX(0); cardY(0); }
  };
  scene.addEventListener('pointermove', move, { passive: true });
  scene.addEventListener('pointerleave', reset, { passive: true });
}

/* ═══════════════ BOOT SEQUENCE ═══════════════ */
window.addEventListener('DOMContentLoaded', () => {
  initTheme();

  /* If the CDN fails (offline / blocked), still deliver the page:
     static DOM + CSS neon fallback, no GSAP choreography. */
  if (!window.gsap) {
    document.documentElement.classList.add('no-gsap');
    document.documentElement.classList.add('no-webgl');
    const b = document.getElementById('boot');
    if (b) b.classList.add('is-done');
    document.body.classList.add('is-cinematic');
    if (window.GlassSurface) GlassSurface.applyAll();
    if (window.Terminal) Terminal.init();
    return;
  }

  const boot = document.getElementById('boot');
  const bootNum = document.getElementById('bootNumber');
  const bootFill = document.getElementById('bootFill');
  const bootPct = document.getElementById('bootPct');
  const bootStatus = document.getElementById('bootStatus');

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    boot.classList.add('is-done');
    document.body.classList.add('is-cinematic');
  }

  const stages = ['COMPILING PORTFOLIO …', 'SETTING THE GRID …', 'BUILDING THE CITY …', 'READY TO SHIP …'];
  let pct = 0;
  const tick = setInterval(() => {
    pct = Math.min(99, pct + Math.random() * 14 + 4);
    bootFill.style.width = pct + '%';
    bootPct.textContent = Math.floor(pct) + '%';
    bootNum.textContent = String(Math.max(0, 3 - Math.floor(pct / 34)));
    bootStatus.textContent = stages[Math.min(stages.length - 1, Math.floor(pct / 26))];
  }, 130);

  window.addEventListener('load', () => {
    setTimeout(() => {
      clearInterval(tick);
      bootFill.style.width = '100%';
      bootPct.textContent = '100%';
      boot.classList.add('is-done');
      document.body.classList.add('is-cinematic');
      Boot.start();
    }, 420);
  });
});

/* ═══════════════ PERF HUD ═══════════════
   Press P (or click the chip) — live quality-governor telemetry:
   fps, adaptive tier, resolution scale, bloom/mirror state. */
function initPerfHUD() {
  const chip = document.getElementById('perfChip');
  if (!chip) return;
  const elFps = document.getElementById('perfFps');
  const elTier = document.getElementById('perfTier');

  let visible = false;
  gsap.ticker.add(() => {
    if (!visible || !window.Film3D || !Film3D.isReady()) return;
    const g = Film3D.govStatus();
    elFps.textContent = g.fps;
    elFps.style.color = g.fps >= 55 ? '#7dff9a' : g.fps >= 30 ? '#e8c15a' : '#ff2d55';
    elTier.textContent = g.tier + '·' + g.label;
  });

  const toggle = () => {
    visible = !visible;
    chip.classList.toggle('is-visible', visible);
    Sound.blip(visible ? 740 : 420, 0.05, 'square', 0.03);
  };
  chip.addEventListener('click', toggle);
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !/INPUT|TEXTAREA/.test((document.activeElement && document.activeElement.tagName) || '')) toggle();
  });
}

/* ═══════════════ MAIN BOOT ═══════════════ */
const Boot = {
  started: false,
  start() {
    if (this.started) return;
    this.started = true;

    /* 1) WebGL film — module import may fail (offline CDN) or WebGL
       may be unavailable; either way we add the CSS neon fallback. */
    if (window.Film3D) {
      Film3D.init(document.getElementById('filmgl'));
    } else {
      document.documentElement.classList.add('no-webgl');
    }

    /* 2) director choreography */
    let lastScene = null;
    Director.setReelUI((globalP, sceneName, sceneP) => {
      const p = sceneP !== undefined ? sceneP : globalP || 0;
      document.getElementById('reelFill').style.width = (p * 100).toFixed(1) + '%';
      document.getElementById('reelPct').textContent = Math.round(p * 100);
      if (sceneName) document.getElementById('sceneName').textContent = sceneName;
      const tc = document.getElementById('timecode');
      if (tc) tc.textContent = timecode((globalP || 0) * 92, 24);
      /* film-cut flash on chapter change (skipped for reduced motion) */
      if (sceneName && sceneName !== lastScene) {
        lastScene = sceneName;
        const fl = document.getElementById('filmflash');
        if (fl && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          fl.style.transition = 'none';
          fl.style.opacity = '0.12';
          requestAnimationFrame(() => {
            fl.style.transition = 'opacity .45s ease-out';
            fl.style.opacity = '0';
          });
        }
      }
    });
    Director.init();
    initSceneLinks();

    /* 3) sound + UI */
    initCursor();
    initHeroMotion();
    if (window.GlassSurface) GlassSurface.applyAll();
    /* FluidGlass (js/fluidlens.js) self-registers — press G to toggle */
    Terminal.init();
    initContactForm();
    initPerfHUD();

    /* touch devices: floating ❯_ launcher opens the terminal */
    const touchTerm = document.getElementById('touchTerm');
    if (touchTerm) {
      const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
      if (isTouch) touchTerm.classList.add('is-touch');
      touchTerm.addEventListener('click', () => window.Terminal && Terminal.show());
    }

    const soundBtn = document.getElementById('soundToggle');
    soundBtn.addEventListener('click', () => {
      const on = Sound.toggle();
      soundBtn.classList.toggle('is-on', on);
      soundBtn.querySelector('.sound__label').textContent = on ? 'SOUND ON' : 'SOUND OFF';
    });

    console.log('%cAK / SYSTEM 001 — SPEC · BUILD · SHIP — Ctrl+K for the terminal', 'color:#ff4a16;font-family:monospace;font-size:12px');
  },
};
