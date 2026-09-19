/* ═══════════════════════════════════════════════════════════════
   glass.js — GlassSurface, translated 1:1 from the user-provided
   react-bits source (glasssurface.txt, shadcn JS-CSS variant).

   Preserved verbatim from the original:
   · generateDisplacementMap()      — exact SVG map + data URI
   · the 3× feDisplacementMap + feColorMatrix + screen-blend filter
   · supportsSVGFilters()           — Safari/Firefox + url() probe
   · supportsBackdropFilter()       — CSS.supports check
   · useDarkMode()                  — prefers-color-scheme listener
   · getContainerStyles()           — their exact fallback styling:
       svg mode:    url(#id) saturate(saturation) + color-mix shadows
       dark+bf:     rgba(255,255,255,.1) + blur(12) saturate(1.8) brightness(1.2)
       dark no-bf:  rgba(0,0,0,.4) + 1px border + inset shadows
   · ResizeObserver → setTimeout(updateDisplacementMap, 0)
   Targets: navbar chrome + all .btn buttons.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const GlassSurface = (() => {
  const TARGETS = '.hud__brand, .hud__right, .sound, .perfchip, .btn';

  /* prop defaults — the component's, tuned for visibility.
     borderWidth 0.4  → wide refraction band (default 0.07 was a
                        ~3px sliver on small UI)
     opacity 0.55     → the neutral center rect covers less, so the
                        gradient displacement reaches the middle too
     displace 0.5     → their "Advanced Glass Distortion" example */
  const PROPS = {
    borderWidth: 0.4, brightness: 50, opacity: 0.55, blur: 9,
    displace: 0.5, backgroundOpacity: 0, saturation: 1,
    distortionScale: -180, redOffset: 0, greenOffset: 10, blueOffset: 20,
    xChannel: 'R', yChannel: 'G', mixBlendMode: 'difference',
  };

  let uid = 0;

  /* ── useDarkMode() ── */
  function darkModeNow() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /* ── supportsSVGFilters() — verbatim logic ── */
  function supportsSVGFilters(filterId) {
    const isWebkit = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
    const isFirefox = /Firefox/.test(navigator.userAgent);
    if (isWebkit || isFirefox) return false;
    const div = document.createElement('div');
    div.style.backdropFilter = `url(#${filterId})`;
    return div.style.backdropFilter !== '';
  }

  /* ── supportsBackdropFilter() — verbatim ── */
  function supportsBackdropFilter() {
    return CSS.supports('backdrop-filter', 'blur(10px)');
  }

  /* ── generateDisplacementMap() — verbatim structure ── */
  function generateDisplacementMap(w, h, radius) {
    const { borderWidth, brightness, opacity, blur, mixBlendMode } = PROPS;
    const edgeSize = Math.min(w, h) * (borderWidth * 0.5);
    const redGradId = 'red-grad-' + (++uid);
    const blueGradId = 'blue-grad-' + uid;

    const svgContent =
      `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs>` +
      `<linearGradient id="${redGradId}" x1="100%" y1="0%" x2="0%" y2="0%">` +
      `<stop offset="0%" stop-color="#0000"/>` +
      `<stop offset="100%" stop-color="red"/>` +
      `</linearGradient>` +
      `<linearGradient id="${blueGradId}" x1="0%" y1="0%" x2="0%" y2="100%">` +
      `<stop offset="0%" stop-color="#0000"/>` +
      `<stop offset="100%" stop-color="blue"/>` +
      `</linearGradient>` +
      `</defs>` +
      `<rect x="0" y="0" width="${w}" height="${h}" fill="black"></rect>` +
      `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="url(#${redGradId})" />` +
      `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="url(#${blueGradId})" style="mix-blend-mode: ${mixBlendMode}" />` +
      `<rect x="${edgeSize}" y="${edgeSize}" width="${Math.max(0, w - edgeSize * 2)}" height="${Math.max(0, h - edgeSize * 2)}" rx="${radius}" fill="hsl(0 0% ${brightness}% / ${opacity})" style="filter:blur(${blur}px)" />` +
      `</svg>`;

    return `data:image/svg+xml,${encodeURIComponent(svgContent)}`;
  }

  /* ── the filter: 3 displaced channels → screen blends → blur (verbatim) ── */
  function buildFilter(filterId, mapHref) {
    const ns = 'http://www.w3.org/2000/svg';
    const f = document.createElementNS(ns, 'filter');
    f.setAttribute('id', filterId);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.setAttribute('x', '0%'); f.setAttribute('y', '0%');
    f.setAttribute('width', '100%'); f.setAttribute('height', '100%');

    const feImage = document.createElementNS(ns, 'feImage');
    feImage.setAttribute('x', '0'); feImage.setAttribute('y', '0');
    feImage.setAttribute('width', '100%'); feImage.setAttribute('height', '100%');
    feImage.setAttribute('preserveAspectRatio', 'none');
    feImage.setAttribute('result', 'map');
    feImage.setAttribute('href', mapHref);
    f.appendChild(feImage);

    const channels = [
      { key: 'R', offset: PROPS.redOffset,
        matrix: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0' },
      { key: 'G', offset: PROPS.greenOffset,
        matrix: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0' },
      { key: 'B', offset: PROPS.blueOffset,
        matrix: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' },
    ];
    const results = [];
    for (const ch of channels) {
      const d = document.createElementNS(ns, 'feDisplacementMap');
      d.setAttribute('in', 'SourceGraphic');
      d.setAttribute('in2', 'map');
      d.setAttribute('scale', String(PROPS.distortionScale + ch.offset));
      d.setAttribute('xChannelSelector', PROPS.xChannel);
      d.setAttribute('yChannelSelector', PROPS.yChannel);
      d.setAttribute('result', 'disp' + ch.key);

      const m = document.createElementNS(ns, 'feColorMatrix');
      m.setAttribute('in', 'disp' + ch.key);
      m.setAttribute('type', 'matrix');
      m.setAttribute('values', ch.matrix);
      m.setAttribute('result', ch.key.toLowerCase());

      results.push(ch.key.toLowerCase());
      f.appendChild(d); f.appendChild(m);
    }

    const b1 = document.createElementNS(ns, 'feBlend');
    b1.setAttribute('in', results[0]); b1.setAttribute('in2', results[1]);
    b1.setAttribute('mode', 'screen'); b1.setAttribute('result', 'rg');
    const b2 = document.createElementNS(ns, 'feBlend');
    b2.setAttribute('in', 'rg'); b2.setAttribute('in2', results[2]);
    b2.setAttribute('mode', 'screen'); b2.setAttribute('result', 'output');
    const gb = document.createElementNS(ns, 'feGaussianBlur');
    gb.setAttribute('in', 'output');
    gb.setAttribute('stdDeviation', String(PROPS.displace || 0.7));
    f.appendChild(b1); f.appendChild(b2); f.appendChild(gb);
    return f;
  }

  /* ── getContainerStyles() — verbatim fallback styling (dark theme) ── */
  function svgModeStyles(el, filterId) {
    el.style.background = `hsl(0 0% 0% / ${PROPS.backgroundOpacity})`;
    el.style.backdropFilter = `url(#${filterId}) saturate(${PROPS.saturation})`;
    el.style.webkitBackdropFilter = `url(#${filterId}) saturate(${PROPS.saturation})`;
    el.style.boxShadow =
      `0 0 2px 1px color-mix(in oklch, white, transparent 65%) inset,` +
      `0 0 10px 4px color-mix(in oklch, white, transparent 85%) inset,` +
      `0px 4px 16px rgba(17, 17, 26, 0.05),` +
      `0px 8px 24px rgba(17, 17, 26, 0.05),` +
      `0px 16px 56px rgba(17, 17, 26, 0.05),` +
      `0px 4px 16px rgba(17, 17, 26, 0.05) inset,` +
      `0px 8px 24px rgba(17, 17, 26, 0.05) inset,` +
      `0px 16px 56px rgba(17, 17, 26, 0.05) inset`;
  }

  function cssFallbackStyles(el) {
    if (supportsBackdropFilter()) {
      el.style.background = 'rgba(255, 255, 255, 0.1)';
      el.style.backdropFilter = 'blur(12px) saturate(1.8) brightness(1.2)';
      el.style.webkitBackdropFilter = 'blur(12px) saturate(1.8) brightness(1.2)';
      el.style.border = '1px solid rgba(255, 255, 255, 0.2)';
      el.style.boxShadow =
        `inset 0 1px 0 0 rgba(255, 255, 255, 0.2), inset 0 -1px 0 0 rgba(255, 255, 255, 0.1)`;
    } else {
      el.style.background = 'rgba(0, 0, 0, 0.4)';
      el.style.border = '1px solid rgba(255, 255, 255, 0.2)';
      el.style.boxShadow =
        `inset 0 1px 0 0 rgba(255, 255, 255, 0.2), inset 0 -1px 0 0 rgba(255, 255, 255, 0.1)`;
    }
  }

  /* ── mount: container + inline filter svg (their DOM structure) ── */
  function upgrade(el) {
    const filterId = 'glass-filter-' + (++uid);
    const cs = getComputedStyle(el);
    let radius = parseFloat(cs.borderRadius);
    if (!radius || isNaN(radius)) radius = 20;   // their borderRadius default

    /* their container classes: relative + overflow-hidden + transition */
    if (cs.position === 'static') el.style.position = 'relative';
    el.style.overflow = 'hidden';
    el.style.transition = 'opacity 260ms ease-out';

    /* their inline svg holder: absolute, full-size, opacity-0, -z-10 */
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('xmlns', ns);
    svg.style.cssText = 'width:100%;height:100%;pointer-events:none;position:absolute;inset:0;opacity:0;z-index:-10;';
    const defs = document.createElementNS(ns, 'defs');
    const rect = el.getBoundingClientRect();
    defs.appendChild(buildFilter(filterId, generateDisplacementMap(
      Math.max(8, Math.round(rect.width)), Math.max(8, Math.round(rect.height)), radius
    )));
    svg.appendChild(defs);
    el.appendChild(svg);

    /* styles per their getContainerStyles()
       BUGFIX: the original gates only the SHADOW TINT on dark mode,
       never the filter itself. My earlier `&& darkModeNow()` here
       silently disabled the displacement filter entirely on light-
       scheme systems — everything got the plain blur fallback. */
    if (supportsSVGFilters(filterId)) {
      el.style.background = `hsl(0 0% 0% / ${PROPS.backgroundOpacity})`;
      el.style.backdropFilter = `url(#${filterId}) saturate(${PROPS.saturation})`;
      el.style.webkitBackdropFilter = `url(#${filterId}) saturate(${PROPS.saturation})`;
      /* their exact shadow stack, dark-scheme tint */
      el.style.boxShadow = darkModeNow()
        ? `0 0 2px 1px color-mix(in oklch, white, transparent 65%) inset,` +
          `0 0 10px 4px color-mix(in oklch, white, transparent 85%) inset,` +
          `0px 4px 16px rgba(17,17,26,.05), 0px 8px 24px rgba(17,17,26,.05),` +
          `0px 16px 56px rgba(17,17,26,.05), 0px 4px 16px rgba(17,17,26,.05) inset,` +
          `0px 8px 24px rgba(17,17,26,.05) inset, 0px 16px 56px rgba(17,17,26,.05) inset`
        : `0 0 2px 1px color-mix(in oklch, black, transparent 85%) inset,` +
          `0 0 10px 4px color-mix(in oklch, black, transparent 90%) inset,` +
          `0px 4px 16px rgba(17,17,26,.05), 0px 8px 24px rgba(17,17,26,.05),` +
          `0px 16px 56px rgba(17,17,26,.05), 0px 4px 16px rgba(17,17,26,.05) inset,` +
          `0px 8px 24px rgba(17,17,26,.05) inset, 0px 16px 56px rgba(17,17,26,.05) inset`;
    } else {
      cssFallbackStyles(el);
    }

    /* their ResizeObserver → updateDisplacementMap */
    const feImage = svg.querySelector('feImage');
    const ro = new ResizeObserver(() => {
      setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (feImage) feImage.setAttribute('href', generateDisplacementMap(
          Math.max(8, Math.round(r.width)), Math.max(8, Math.round(r.height)), radius
        ));
      }, 0);
    });
    ro.observe(el);
  }

  function applyAll() {
    document.querySelectorAll(TARGETS).forEach((el) => {
      if (el.__glassDone) return;
      el.__glassDone = true;
      upgrade(el);
    });
  }

  return { applyAll };
})();

window.GlassSurface = GlassSurface;
