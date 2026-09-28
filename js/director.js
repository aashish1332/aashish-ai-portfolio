/* ═══════════════════════════════════════════════════════════════
   director.js — ScrollDirector
   One continuous WebGL film runs behind everything; a master
   ScrollTrigger maps total page progress -> Film3D camera path.
   Each scene pins and choreographs its DOM layer.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Director = (() => {
  const S = {};

  function init() {
    gsap.registerPlugin(ScrollTrigger, Observer);
    setupLenis();
    /* Scenes FIRST: each pinned timeline injects its pin-spacer into '#film',
       which is what gives the page its real height. The master film trigger
       reads that height when it is created, so it must come after them —
       created first it resolved 'bottom bottom' to 4,059px of a 15,159px
       page and the camera hit the end of its path at 35% scroll. */
    heroScene();
    storyScene();
    workScene();
    codirectorScene();
    interludeScene();
    creditsScene();
    endScene();
    masterFilm();
    hud();
    counters();
  }

  /* ---------- smooth scroll ---------- */
  function setupLenis() {
    if (typeof Lenis === 'undefined') return;
    S.lenis = new Lenis({ duration: 1.15, smoothWheel: true });
    S.lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => S.lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  /* `opts.immediate` is for the one caller that must not animate: the AI
     panel's guided tour walks four sections in a row, and under
     `prefers-reduced-motion` four 1.6 s glides are precisely the motion that
     request is about (§11.1 c). Every other caller passes nothing and keeps
     the behaviour this always had. */
  const scrollTo = (target, opts = {}) => {
    const immediate = opts.immediate === true;
    if (S.lenis) S.lenis.scrollTo(target, { duration: immediate ? 0 : 1.6 });
    else if (typeof target === 'number') window.scrollTo({ top: target, behavior: immediate ? 'auto' : 'smooth' });
    else document.querySelector(target)?.scrollIntoView({ behavior: immediate ? 'auto' : 'smooth' });
  };

  /* ---------- MASTER: whole page -> film timeline ---------- */
  function masterFilm() {
    ScrollTrigger.create({
      trigger: '#film',
      start: 'top top',
      /* end = the real page end, and a function so it re-evaluates on
         refresh/resize. The world then lasts the entire film instead of
         being consumed in the first third. */
      end: () => ScrollTrigger.maxScroll(window),
      scrub: 0.9,
      onUpdate: (self) => {
        if (window.Film3D && Film3D.isReady()) Film3D.set(self.progress);
        S.reelUI && S.reelUI(self.progress);
      },
    });
  }

  /* ---------- SCENE 01 · HERO ---------- */
  function heroScene() {
    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-hero',
        start: 'top top',
        end: '+=1800',
        scrub: 0.6,
        pin: true,
        anticipatePin: 1,
        onUpdate: (self) => { S.reelUI && S.reelUI(null, '01 — OPENING', self.progress); },
      },
    })
      .fromTo('.hero__line > span', { yPercent: 115 }, { yPercent: 0, stagger: 0.08, duration: 0.18, ease: 'power3.out' }, 0.02)
      .fromTo('.hero__kicker', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.1 }, 0.02)
      .fromTo('.hero__sub', { opacity: 0 }, { opacity: 1, duration: 0.1 }, 0.14)
      .to('.hero__frame', { yPercent: -30, opacity: 0, ease: 'power2.in', duration: 0.3 }, 0.62)
      .to('.hero__sprockets', { opacity: 0, duration: 0.15 }, 0.6);
  }

  /* ---------- SCENE 02 · STORY ---------- */
  function storyScene() {
    document.querySelectorAll('#scene-story [data-split]').forEach((el) => splitLines(el));

    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-story',
        start: 'top top',
        end: '+=1600',
        scrub: 0.6,
        pin: true,
        onUpdate: (self) => { S.reelUI && S.reelUI(null, '02 — THE STORY', self.progress); },
      },
    })
      .fromTo('.story__act', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.06 }, 0.04)
      .fromTo('.story__title .split-line > span', { yPercent: 115 }, { yPercent: 0, stagger: 0.05, duration: 0.12, ease: 'power3.out' }, 0.08)
      .fromTo('.story__beat', { opacity: 0, x: -30 }, { opacity: 1, x: 0, stagger: 0.08, duration: 0.14 }, 0.24)
      .fromTo('.stat', { opacity: 0, y: 26 }, { opacity: 1, y: 0, stagger: 0.05, duration: 0.12 }, 0.34)
      .fromTo('.polaroid', { opacity: 0, y: 60 }, { opacity: 1, y: 0, stagger: 0.06, duration: 0.14 }, 0.46)
      .to({}, { duration: 0.08 });
  }

  /* ---------- SCENE 03 · WORK ---------- */
  function workScene() {
    S.takeEls = gsap.utils.toArray('.take');
    S.activeTake = -1;

    const count = S.takeEls.length;
    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-work',
        start: 'top top',
        end: `+=${count * 1000}`,
        scrub: 0.6,
        pin: true,
        onUpdate: (self) => {
          const idx = Math.min(count - 1, Math.floor(self.progress * count));
          setTake(idx);
          S.reelUI && S.reelUI(null, `03 — THE WORK · TAKE ${idx + 1}`, self.progress);
        },
      },
    });

    // pre-split take titles (hidden until active)
    S.takeEls.forEach((el) => splitLines(el.querySelector('.take__title')));
  }

  function setTake(idx) {
    if (idx === S.activeTake) return;
    S.activeTake = idx;
    S.takeEls.forEach((el, i) => {
      const on = i === idx;
      el.classList.toggle('is-active', on);
      if (on) {
        const slate = el.querySelector('.slate');
        slate.classList.remove('is-clapping');
        void slate.offsetWidth;
        slate.classList.add('is-clapping');
        gsap.fromTo(el, { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' });
        /* the project title is split into a mask but nothing ever slid it
           out — the h3 sat empty while the facts beside it animated in */
        gsap.fromTo(el.querySelectorAll('.take__title .split-line > span'),
          { yPercent: 110 },
          { yPercent: 0, stagger: 0.06, duration: 0.5, ease: 'power3.out' });
        gsap.fromTo(el.querySelectorAll('.take__facts li'), { opacity: 0, x: -18 }, { opacity: 1, x: 0, stagger: 0.06, duration: 0.4, delay: 0.08 });
      }
    });
  }

  /* ---------- SCENE 04 · THE CO-DIRECTOR (AI LEDGER) ----------
     Same swap machinery as the takes: the header stays pinned and only the
     ledger beneath it changes, so the split is on screen while the film
     plays through all three. Reveals live inside the scrubbed timeline, so
     scrubbing backwards plays them in reverse for free. */
  function codirectorScene() {
    S.ledgerEls = gsap.utils.toArray('.ledger');
    S.activeLedger = -1;
    const count = S.ledgerEls.length || 1;

    splitLines(document.querySelector('.codir__title'));

    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-codir',
        start: 'top top',
        end: `+=${count * 950}`,
        scrub: 0.6,
        pin: true,
        onUpdate: (self) => {
          const idx = Math.min(count - 1, Math.floor(self.progress * count));
          setLedger(idx);
          S.reelUI && S.reelUI(null, `04 — THE CO-DIRECTOR · LEDGER ${idx + 1}`, self.progress);
        },
      },
    })
      .fromTo('.codir__kicker', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.05 }, 0.01)
      .fromTo('.codir__title .split-line > span', { yPercent: 115 }, { yPercent: 0, stagger: 0.05, duration: 0.1, ease: 'power3.out' }, 0.03)
      .fromTo('.codir__sub', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.08 }, 0.12)
      .fromTo('.codir__note', { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.06 }, 0.9);
  }

  function setLedger(idx) {
    if (idx === S.activeLedger) return;
    S.activeLedger = idx;
    S.ledgerEls.forEach((el, i) => {
      const on = i === idx;
      el.classList.toggle('is-active', on);
      if (on) {
        gsap.fromTo(el, { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' });
        gsap.fromTo(el.querySelectorAll('.ledger__col'), { opacity: 0, y: 18 }, { opacity: 1, y: 0, stagger: 0.08, duration: 0.45, delay: 0.05 });
        gsap.fromTo(el.querySelectorAll('.ledger__col li'), { opacity: 0, x: -14 }, { opacity: 1, x: 0, stagger: 0.045, duration: 0.4, delay: 0.1 });
      }
    });
  }

  /* ---------- SCENE 05 · INTERLUDE ---------- */
  function interludeScene() {
    splitLines(document.querySelector('.interlude__title'));
    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-interlude',
        start: 'top top',
        end: '+=1300',
        scrub: 0.6,
        pin: true,
        onUpdate: (self) => {
          S.reelUI && S.reelUI(null, '05 — INTERMISSION', self.progress);
          if (window.Sound) Sound.setMuffle(false);
        },
      },
    })
      .fromTo('.interlude__kicker', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.05 }, 0.02)
      .fromTo('.interlude__title .split-line > span', { yPercent: 115 }, { yPercent: 0, stagger: 0.06, duration: 0.14 }, 0.06)
      .fromTo('.interlude__sub', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.1 }, 0.18)
      .fromTo('.interlude__code', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.1 }, 0.26)
      .fromTo('.interlude__hint', { opacity: 0 }, { opacity: 1, duration: 0.08 }, 0.34);
  }

  /* ---------- SCENE 06 · CREDITS ---------- */
  function creditsScene() {
    const roll = document.getElementById('creditsRoll');
    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-credits',
        start: 'top top',
        end: '+=2800',
        scrub: 0.7,
        pin: true,
        invalidateOnRefresh: true,
        onUpdate: (self) => S.reelUI && S.reelUI(null, '06 — CREDITS', self.progress),
      },
    })
      .fromTo(roll,
        { y: () => window.innerHeight * 0.92 },
        { y: () => -(roll.scrollHeight - window.innerHeight * 0.12), ease: 'none', duration: 1 });
  }

  /* ---------- SCENE 07 · END ---------- */
  function endScene() {
    splitLines(document.querySelector('.end__title'));
    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-end',
        start: 'top top',
        end: '+=600',
        scrub: 0.6,
        pin: true,
        onUpdate: (self) => S.reelUI && S.reelUI(null, '07 — POST-CREDITS', self.progress),
      },
    })
      .fromTo('.end__postcredit', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.06 }, 0.02)
      .fromTo('.end__title .split-line > span', { yPercent: 115 }, { yPercent: 0, stagger: 0.07, duration: 0.14 }, 0.06)
      .fromTo('.end__form', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.12 }, 0.2)
      .fromTo('.end__links .end__link', { opacity: 0, y: 24 }, { opacity: 1, y: 0, stagger: 0.05, duration: 0.1 }, 0.28)
      .fromTo('.end__phone', { opacity: 0 }, { opacity: 1, duration: 0.08 }, 0.36);
  }

  /* ---------- HUD / chapters / counters ---------- */
  function hud() {
    const targets = ['#scene-hero', '#scene-story', '#scene-work', '#scene-codir', '#scene-interlude', '#scene-credits', '#scene-end'];
    document.querySelectorAll('.chapters__dot').forEach((dot) => {
      dot.addEventListener('click', () => scrollTo(targets[+dot.dataset.chapter]));
    });
    targets.forEach((sel, i) => {
      ScrollTrigger.create({
        trigger: sel,
        start: 'top center',
        end: 'bottom center',
        onToggle: (self) => {
          if (self.isActive) {
            document.querySelectorAll('.chapters__dot').forEach((d, k) => d.classList.toggle('is-active', k === i));
            document.body.classList.add('is-cinematic');
          }
        },
      });
    });
  }

  function counters() {
    document.querySelectorAll('.stat').forEach((stat) => {
      const numEl = stat.querySelector('.stat__num');
      const target = +stat.dataset.count;
      const divide = stat.dataset.divide ? +stat.dataset.divide : 1;
      const decimals = +(stat.dataset.decimals || 0);
      const suffix = stat.dataset.suffix || '';
      const obj = { v: 0 };
      ScrollTrigger.create({
        trigger: '#scene-story',
        start: 'top top',
        end: '+=1600',
        onEnter: () => {
          gsap.to(obj, {
            v: target, duration: 2.4, ease: 'power3.out',
            onUpdate: () => { numEl.textContent = (obj.v / divide).toFixed(decimals) + suffix; },
          });
        },
      });
    });
  }

  /* ---------- hooks ---------- */
  function setReelUI(fn) { S.reelUI = fn; }
  function getLenis() { return S.lenis; }

  return { init, setReelUI, scrollTo, getLenis };
})();

/* A top-level `const` in a classic script does NOT attach to `window`, so
   every `window.Director && Director.getLenis()` guard in this project
   (fluidlens, terminal, the AI panel) was silently reading undefined and
   skipping its scroll lock — the guard made a dead path look defensive.
   Exposed explicitly, exactly as js/terminal.js already does for Terminal. */
window.Director = Director;
