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
    /* Resolve a selector to a NUMBER before handing it to Lenis. A pinned
       section is wrapped in a pin-spacer and has a fixed transform while it
       is active; letting a smooth-scroll library re-resolve the selector
       mid-flight can send the page to the section's end instead of its start.
       ScrollTrigger already knows the real start, so use that first. */
    const resolveY = () => {
      if (typeof target === 'number') return target;
      const el = document.querySelector(target);
      if (!el) return 0;
      const trigger = ScrollTrigger.getAll().find((t) => t.trigger === el && t.vars.pin);
      /* Land just inside the section, not on the exact boundary. Lenis can
         settle a fraction of a pixel before a trigger start, leaving the
         section technically inactive and its entrance callback un-fired. */
      if (trigger && Number.isFinite(trigger.start)) return trigger.start + 2;
      return el.getBoundingClientRect().top + window.scrollY;
    };
    let y = resolveY();
    /* On a cold load the pin-spacers can still be settling when a nav click
       fires. If the requested target is past the document's current maximum,
       Lenis clamps the glide to the old height and the visitor lands a section
       short. Refresh, re-resolve, then move. */
    if (Number.isFinite(y) && y > ScrollTrigger.maxScroll(window) + 2) {
      ScrollTrigger.refresh();
      y = resolveY();
    }
    if (S.lenis) {
      /* Lenis caches its scroll limit when it is constructed. It is built
         before the scene pin-spacers exist, so a cold jump to a later section
         is clamped to the pre-pin height (it landed just before the builds
         section). Refresh the limit before every programmatic move. */
      if (typeof S.lenis.resize === 'function') S.lenis.resize();
      S.lenis.scrollTo(y, { duration: immediate ? 0 : 1.6 });
    } else window.scrollTo({ top: y, behavior: immediate ? 'auto' : 'smooth' });
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
        /* The camera follows the whole page. The HUD does not: each pinned
           scene already reports its own progress and name, and letting the
           master callback write both made the label jump to CONTACT / 100% on
           every section once the page was tall enough. */
        if (window.Film3D && Film3D.isReady()) Film3D.set(self.progress);
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
        onUpdate: (self) => { S.reelUI && S.reelUI(null, '01 / OPEN', self.progress); },
      },
    })
      /* The hero is the one thing that must be readable before any scroll. A
         scrubbed fromTo that starts at yPercent:115 leaves the name hidden at
         progress 0 (the old bug), so the entrance is a one-shot load tween and
         the scrub only owns the exit. */
      .to('.hero__frame', { yPercent: -30, opacity: 0, ease: 'power2.in', duration: 0.3 }, 0.62)
      .to('.hero__sprockets', { opacity: 0, duration: 0.15 }, 0.6);

    gsap.from('.hero__line > span', {
      yPercent: 115, stagger: 0.09, duration: 1.15, ease: 'power4.out', delay: 0.08,
    });
    gsap.from('.hero__kicker, .hero__edition', {
      opacity: 0, y: 12, duration: 0.7, stagger: 0.08, ease: 'power2.out', delay: 0.18,
    });
    gsap.from('.hero__role, .hero__sub, .hero__availability', {
      opacity: 0, y: 12, duration: 0.65, stagger: 0.08, ease: 'power2.out', delay: 0.4,
    });
    gsap.from('.hero__dossier', {
      opacity: 0, y: 20, duration: 0.8, ease: 'power3.out', delay: 0.34,
    });
    gsap.from('.dossier__facts div', {
      opacity: 0, y: 8, stagger: 0.045, duration: 0.45, ease: 'power2.out', delay: 0.55,
    });
  }

  /* ---------- SCENE 02 · STORY ---------- */
  function storyScene() {
    document.querySelectorAll('#scene-story [data-split]').forEach((el) => splitLines(el));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const enter = () => {
      S.reelUI && S.reelUI(null, '02 / PROFILE', 0);
    };

    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-story',
        start: 'top top',
        end: '+=1600',
        scrub: 0.6,
        pin: true,
        onEnter: enter,
        onEnterBack: enter,
        onUpdate: (self) => { S.reelUI && S.reelUI(null, '02 / PROFILE', self.progress); },
      },
    });

    /* A one-shot entrance, not a scrub. Landing on this section via the nav
       or a tour stop must show the content; a scrubbed reveal at progress 0
       leaves the title and every bullet hidden until the visitor scrolls
       again, which is the exact bug this replaces. */
    ScrollTrigger.create({
      trigger: '#scene-story',
      start: 'top 78%',
      once: true,
      onEnter: () => {
        const d = reduced ? 0 : 1;
        gsap.timeline({ defaults: { ease: 'power3.out' } })
          .fromTo('.story__act', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: d * 0.5 })
          .fromTo('.story__title .split-line > span', { yPercent: 115 }, { yPercent: 0, stagger: d * 0.06, duration: d * 0.9 }, 0.05)
          .fromTo('.story__beat', { opacity: 0, x: -24 }, { opacity: 1, x: 0, stagger: d * 0.07, duration: d * 0.7 }, 0.18)
          .fromTo('.stat', { opacity: 0, y: 26 }, { opacity: 1, y: 0, stagger: d * 0.05, duration: d * 0.6 }, 0.26)
          .fromTo('.polaroid', { opacity: 0, y: 46 }, { opacity: 1, y: 0, stagger: d * 0.05, duration: d * 0.6 }, 0.32);
      },
    });
  }

  /* ---------- SCENE 03 · WORK ---------- */
  function workScene() {
    S.takeEls = gsap.utils.toArray('.take');
    S.activeTake = -1;

    const count = S.takeEls.length;
    const enter = () => {
      /* A refresh can call setTake(0) before the scene is visible, and the
         early guard would then skip the redraw when the visitor arrives.
         Reset the index so the active sheet's draw plays on entry. */
      S.activeTake = -1;
      setTake(0);
      S.reelUI && S.reelUI(null, '03 / BUILDS · 01', 0);
    };

    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-work',
        start: 'top top',
        end: `+=${count * 1000}`,
        scrub: 0.6,
        pin: true,
        onEnter: enter,
        onEnterBack: enter,
        onUpdate: (self) => {
          const idx = Math.min(count - 1, Math.floor(self.progress * count));
          setTake(idx);
          S.reelUI && S.reelUI(null, `03 / BUILDS · ${String(idx + 1).padStart(2, '0')}`, self.progress);
        },
      },
    });

    // pre-split take titles (hidden until active)
    S.takeEls.forEach((el) => splitLines(el.querySelector('.take__title')));
  }

  function setTake(idx) {
    if (idx === S.activeTake) return;
    S.activeTake = idx;
    const countEl = document.getElementById('workCount');
    if (countEl) countEl.textContent = String(idx + 1).padStart(2, '0') + ' / ' + String(S.takeEls.length).padStart(2, '0');

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
        drawSheet(el);
      }
    });
  }

  /* Each active build's system map gets a one-shot draw. Wires run first,
     then the nodes resolve, then the live dots settle — the sheet reads as
     a diagram being plotted, not a static image. Once the wiring is in,
     packets keep travelling along it so the map stays a live system. */
  function addPackets(sheet) {
    const svg = sheet.querySelector('svg');
    if (!svg || svg.dataset.packets === 'true') return;
    svg.dataset.packets = 'true';

    const NS = 'http://www.w3.org/2000/svg';
    sheet.querySelectorAll('.bp-wire').forEach((path, i) => {
      const packet = document.createElementNS(NS, 'circle');
      packet.setAttribute('class', 'bp-packet');
      packet.setAttribute('r', i % 3 === 0 ? '2.1' : '1.7');
      packet.setAttribute('aria-hidden', 'true');

      /* SMIL follows the wire's own geometry, so the packet turns corners
         exactly where the diagram does instead of tracing a separate line. */
      const motion = document.createElementNS(NS, 'animateMotion');
      motion.setAttribute('path', path.getAttribute('d'));
      motion.setAttribute('dur', `${2.8 + (i % 4) * .45}s`);
      motion.setAttribute('begin', `${(i * .24).toFixed(2)}s`);
      motion.setAttribute('repeatCount', 'indefinite');
      packet.appendChild(motion);
      svg.appendChild(packet);
    });
  }

  function drawSheet(el) {
    const sheet = el.querySelector('.take__sheet');
    if (!sheet || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const paths = sheet.querySelectorAll('.bp-wire');
    const nodes = sheet.querySelectorAll('.bp-node');
    const dots = sheet.querySelectorAll('.bp-dot');
    if (!paths.length) return;

    paths.forEach((path) => {
      const length = path.getTotalLength();
      gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
    });
    gsap.timeline({ defaults: { ease: 'power2.out' } })
      .to(paths, { strokeDashoffset: 0, duration: .9, stagger: .06 }, 0)
      .fromTo(nodes, { opacity: 0, scale: .9, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: .5, stagger: .07 }, .1)
      .fromTo(dots, { opacity: 0, scale: 0, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: .35, stagger: .08 }, .45)
      .call(() => addPackets(sheet));
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

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const enter = () => {
      setLedger(0);
      S.reelUI && S.reelUI(null, '04 / METHOD · 01', 0);
    };

    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-codir',
        start: 'top top',
        end: `+=${count * 950}`,
        scrub: 0.6,
        pin: true,
        onEnter: enter,
        onEnterBack: enter,
        onUpdate: (self) => {
          const idx = Math.min(count - 1, Math.floor(self.progress * count));
          setLedger(idx);
          S.reelUI && S.reelUI(null, `04 / METHOD · ${String(idx + 1).padStart(2, '0')}`, self.progress);
        },
      },
    });

    ScrollTrigger.create({
      trigger: '#scene-codir',
      start: 'top 78%',
      once: true,
      onEnter: () => {
        const d = reduced ? 0 : 1;
        gsap.timeline({ defaults: { ease: 'power3.out' } })
          .fromTo('.codir__kicker', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: d * 0.5 })
          .fromTo('.codir__title .split-line > span', { yPercent: 115 }, { yPercent: 0, stagger: d * 0.06, duration: d * 0.9 }, 0.04)
          .fromTo('.codir__sub', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: d * 0.7 }, 0.16)
          .fromTo('.codir__note', { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: d * 0.6 }, 0.3);
      },
    });
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

  /* ---------- SCENE 05 · CREDITS ---------- */
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
        onEnter: () => { S.reelUI && S.reelUI(null, '05 / STACK', 0); },
        onEnterBack: () => { S.reelUI && S.reelUI(null, '05 / STACK', 0); },
        onUpdate: (self) => S.reelUI && S.reelUI(null, '05 / STACK', self.progress),
      },
    })
      .fromTo(roll,
        /* Start with the giant STACK word peeking above the fold. A credits
           roll that begins completely off-screen reads as an empty section
           until the visitor happens to keep scrolling. */
        { y: () => window.innerHeight * 0.58 },
        { y: () => -(roll.scrollHeight - window.innerHeight * 0.12), ease: 'none', duration: 1 });
  }

  /* ---------- SCENE 06 · END ---------- */
  function endScene() {
    splitLines(document.querySelector('.end__title'));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const enter = () => { S.reelUI && S.reelUI(null, '06 / CONTACT', 0); };

    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene-end',
        start: 'top top',
        end: '+=600',
        scrub: 0.6,
        pin: true,
        onEnter: enter,
        onEnterBack: enter,
        onUpdate: (self) => S.reelUI && S.reelUI(null, '06 / CONTACT', self.progress),
      },
    });

    ScrollTrigger.create({
      trigger: '#scene-end',
      start: 'top 78%',
      once: true,
      onEnter: () => {
        const d = reduced ? 0 : 1;
        gsap.timeline({ defaults: { ease: 'power3.out' } })
          .fromTo('.end__postcredit', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: d * 0.5 })
          .fromTo('.end__title .split-line > span', { yPercent: 115 }, { yPercent: 0, stagger: d * 0.07, duration: d * 0.9 }, 0.04)
          .fromTo('.end__brief, .end__form', { opacity: 0, y: 24 }, { opacity: 1, y: 0, stagger: d * 0.08, duration: d * 0.8 }, 0.18)
          .fromTo('.end__links .end__link', { opacity: 0, y: 18 }, { opacity: 1, y: 0, stagger: d * 0.05, duration: d * 0.6 }, 0.24)
          .fromTo('.end__phone', { opacity: 0 }, { opacity: 1, duration: d * 0.6 }, 0.3);
      },
    });
  }

  /* ---------- HUD / chapters / counters ---------- */
  function hud() {
    const targets = ['#scene-hero', '#scene-story', '#scene-work', '#scene-codir', '#scene-credits', '#scene-end'];
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
      const final = (target / divide).toFixed(decimals) + suffix;
      /* Paint the true value first. If the visitor lands mid-section (or a
         reduced-motion jump skips the trigger), the number is still evidence,
         not a zero that only looks alive while an animation runs. */
      numEl.textContent = final;
      const obj = { v: target };
      ScrollTrigger.create({
        trigger: '#scene-story',
        start: 'top top',
        end: '+=1600',
        onEnter: () => {
          obj.v = 0;
          gsap.to(obj, {
            v: target, duration: 1.4, ease: 'power3.out',
            onUpdate: () => { numEl.textContent = (obj.v / divide).toFixed(decimals) + suffix; },
            onComplete: () => { numEl.textContent = final; },
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
