/* ═══════════════════════════════════════════════════════════════
   film3d.js — THE FILM, peak WebGL (Three.js)
   · The city IS the architecture: gateway rings, service towers,
     data streams, DB monolith, container stacks.
   · PERFORMANCE CONTRACT (adaptive quality governor):
     measures real frame times → scales render resolution + bloom
     to hold 60 fps, never below 30. Reflector (mirror street) is
     the first thing disabled, then bloom, then resolution.
     Zero allocations in the render loop; camera path pre-baked
     into O(1) lookup tables (no arc-length searches per frame).
   · CINEMATOGRAPHY: time-of-day color grade driven by scroll
     (dusk → blue hour → night → cold dawn) + scroll-velocity FOV
     kick (the film "surges" when you scrub fast).
   ═══════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

'use strict';

const Film3D = (() => {
  let renderer, scene, camera, composer, bloomPass, fxaaPass, gradePass;
  let ready = false, raf = null;
  let target = 0, current = 0, prevTarget = 0, fovKick = 0;
  const clock = new THREE.Clock();

  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* deterministic rng so the city is identical every visit */
  let seed = 20260916;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  /* ═════════ ADAPTIVE QUALITY GOVERNOR ═════════
     The contract: hold 60, never dip below 30.
     Order of sacrifice (cheapest wins first):
       tier 0 — full fat: mirror street + bloom + 100% res
       tier 1 — mirror off (scene no longer rendered twice)
       tier 2 — render scale 78%
       tier 3 — render scale 62%
       tier 4 — bloom off + scale 50% (even iGPUs hold 60 here)
     Startup tier: mobile begins at 2 (small screens hide scale),
     desktop at 0. Down-shift on slow-average OR spike ratio;
     up-shift only when avg is comfortably under 13.5 ms. */
  /* Low-end probe: start conservative so the governor doesn't have
     to fight its way down in the first seconds. */
  const LOWEND = (navigator.deviceMemory || 8) <= 4 || (navigator.hardwareConcurrency || 8) <= 4;

  const GOV = {
    tier: isMobile ? 2 : (LOWEND ? 1 : 0),
    scale: 1.0,
    dprCap: isMobile ? 1.5 : 1.75,
    samples: [],
    sum: 0,
    cooldown: 300,   // ~5s grace: never judge during boot jank (city build, font decode, GSAP init)
    warmit: 0,
    last: 0,
    fps: 60,
    display: 60,
    /* RESOLUTION-ONLY LADDER — bloom and reflections NEVER switch
       off (they just soften). Bloom cost scales with resolution, so
       a smaller framebuffer is the cheap sacrifice; the mirror's
       render-target size shrinks instead of disappearing. */
    tiers: [
      { scale: 1.00, mirrorRT: 1024, fxaa: true },
      { scale: 0.85, mirrorRT: 512,  fxaa: true },
      { scale: 0.72, mirrorRT: 384,  fxaa: false },
      { scale: 0.60, mirrorRT: 256,  fxaa: false },
      { scale: 0.50, mirrorRT: 192,  fxaa: false },
    ],
  };
  let mirrorObj = null;
  let mirrorRTNow = 0;

  /* ── §12 temporary quality override ─────────────────────────────
     The AI panel (or the governor's degrade ladder) can ask the scene to
     drop to 'low' while it needs the frame budget: pixel-ratio cap, mirror
     target and post-processing off. It NEVER touches GOV.tier — that is the
     adaptive ladder's own state — and 'normal' restores exactly what was
     there. The portfolio's visual identity is restored, always. */
  const QUALITY_LOW_MIRROR = 192;
  let lowQuality = false;
  let paused = false;
  let timeOffset = 0;
  let pausedAt = 0;

  function govApply() {
    const t = GOV.tiers[GOV.tier];
    GOV.scale = t.scale;
    const rt = lowQuality ? QUALITY_LOW_MIRROR : t.mirrorRT;
    if (mirrorObj && rt !== mirrorRTNow) {
      mirrorRTNow = rt;
      try { mirrorObj.getRenderTarget().setSize(mirrorRTNow, mirrorRTNow); } catch (e) { /* noop */ }
    }
    /* fxaa survives to tier 1 — it is the edge-quality keeper at full res */
    if (fxaaPass) fxaaPass.enabled = !lowQuality && !!t.fxaa;
    applySize();
  }

  function applySize() {
    if (!renderer) return;
    const cap = lowQuality ? Math.min(1, GOV.dprCap) : GOV.dprCap;
    const dpr = Math.min(window.devicePixelRatio || 1, cap) * GOV.scale;
    renderer.setPixelRatio(dpr);
    composer && composer.setPixelRatio(dpr);
    /* keep FXAA's resolution uniform in sync (else it smears) */
    if (fxaaPass) {
      fxaaPass.material.uniforms['resolution'].value.set(
        1 / (window.innerWidth * dpr), 1 / (window.innerHeight * dpr)
      );
    }
    resize();
  }

  function govSample(now) {
    if (GOV.last) {
      const dt = now - GOV.last;
      if (dt > 0 && dt < 250) {
        GOV.samples.push(dt);
        GOV.sum += dt;
        if (GOV.samples.length > 90) GOV.sum -= GOV.samples.shift();
      }
    }
    GOV.last = now;

    if (GOV.warmit > 0) { GOV.warmit--; return; }
    if (GOV.cooldown > 0) { GOV.cooldown--; return; }
    if (GOV.samples.length < 30) return;

    const avg = GOV.sum / GOV.samples.length;
    GOV.fps = 1000 / avg;

    /* spike count over the last 30 frames (no slice allocation):
       catches "average looks fine but the film stutters" cases */
    let spikes = 0;
    for (let i = GOV.samples.length - 1, k = 0; i >= 0 && k < 30; i--, k++) {
      if (GOV.samples[i] > 42) spikes++;
    }

    /* DOWN: slow average or heavy stutter (20% of recent frames) */
    if (avg > 22 || spikes >= 6) {
      if (GOV.tier < GOV.tiers.length - 1) {
        GOV.tier++;
        govApply();
        GOV.warmit = 40; GOV.cooldown = 120; GOV.samples.length = 0; GOV.sum = 0;
      }
    } else if (avg < 18.0 && spikes <= 2 && GOV.tier > 0) {
      /* UP — vsync-aware: on a 60 Hz display a HEALTHY frame is
         ~16.7 ms, so the old 13.5 ms threshold was unreachable and
         tiers never recovered (mirror/bloom stayed off forever). */
      GOV.tier--;
      govApply();
      GOV.warmit = 30; GOV.cooldown = 150; GOV.samples.length = 0; GOV.sum = 0;
    }
  }

  function govStatus() {
    return {
      tier: GOV.tier,
      prog: +target.toFixed(3), current: +current.toFixed(3),
      label: ['CINEMATIC', 'HIGH', 'BALANCED', 'SMOOTH', 'SURVIVAL'][GOV.tier],
      fps: Math.round(GOV.display),
      scale: Math.round(GOV.scale * 100) + '%',
      bloom: 'ON',
      mirror: GOV.tiers[GOV.tier].mirrorRT + 'px',
      camZ: camera ? Math.round(camera.position.z) : -1,
      camY: camera ? Math.round(camera.position.y) : -1,
    };
  }

  /* ═════════ TIME-OF-DAY COLOR GRADE (scroll-driven) ═════════
     0.00 dusk   — warm horizon, orange key      (the opening)
     0.35 blue   — indigo hour, city lights win  (the work)
     0.60 night  — deep night, cyan DB glow      (the monolith)
     0.85 dawn   — cold pre-dawn blue            (credits)
     1.00 night2 — settled night                 (post-credits)
     Every value lerps smoothly as you scrub. */
  const GRADES = [
    { fog: 0x140a14, top: 0x0a0618, mid: 0x351a35, hor: 0xc65a24, key: 0xff7744, keyI: 1.15, exp: 1.18, sun: 0.9 },
    { fog: 0x0b0e20, top: 0x05060f, mid: 0x181a44, hor: 0x5a3a58, key: 0x8899ff, keyI: 0.6,  exp: 1.08, sun: 0.3 },
    { fog: 0x060912, top: 0x04050c, mid: 0x0c1028, hor: 0x243356, key: 0x5577ff, keyI: 0.45, exp: 1.08, sun: 0.12 },
    { fog: 0x0a1018, top: 0x060a14, mid: 0x122036, hor: 0x2f5168, key: 0x66aaff, keyI: 0.55, exp: 1.1,  sun: 0.18 },
    { fog: 0x060810, top: 0x04050b, mid: 0x0c1026, hor: 0x202e50, key: 0x5566ff, keyI: 0.45, exp: 1.07, sun: 0.12 },
  ];
  const gradeNow = {
    fog: new THREE.Color(), top: new THREE.Color(), mid: new THREE.Color(),
    hor: new THREE.Color(), key: new THREE.Color(),
  };
  const _cA = new THREE.Color(), _cB = new THREE.Color();
  let keyLight = null;

  /* Where each grade sits in the film. Uniform spacing stopped being right
     once the reel gained a seventh scene: the beats these grades were
     written for have to line up with where their scenes actually land
     (blue hour over the work reel, deep night on the monolith reveal, cold
     dawn at the credits). Print the scene map — `MAP=1 node
     dev-visual-probe.js` — after any scene is added or resized, then move
     these numbers to match it. */
  const GRADE_AT = [0.00, 0.30, 0.72, 0.88, 1.00];

  function applyGrade(p) {
    if (!scene) return;
    /* segment lookup over the anchored stops */
    let i = 0;
    while (i < GRADE_AT.length - 2 && p >= GRADE_AT[i + 1]) i++;
    const seg = Math.max(1e-6, GRADE_AT[i + 1] - GRADE_AT[i]);
    const f = Math.min(1, Math.max(0, (p - GRADE_AT[i]) / seg));
    const A = GRADES[i], B = GRADES[i + 1];

    gradeNow.fog.copy(_cA.setHex(A.fog)).lerp(_cB.setHex(B.fog), f);
    scene.fog.color.copy(gradeNow.fog);
    if (sky) {
      sky.material.uniforms.top.value.copy(_cA.setHex(A.top)).lerp(_cB.setHex(B.top), f);
      sky.material.uniforms.mid.value.copy(_cA.setHex(A.mid)).lerp(_cB.setHex(B.mid), f);
      sky.material.uniforms.hor.value.copy(_cA.setHex(A.hor)).lerp(_cB.setHex(B.hor), f);
    }
    if (keyLight) {
      keyLight.color.copy(_cA.setHex(A.key)).lerp(_cB.setHex(B.key), f);
      keyLight.intensity = A.keyI + (B.keyI - A.keyI) * f;
    }
    renderer.toneMappingExposure = A.exp + (B.exp - A.exp) * f;
    const sunAmt = A.sun + (B.sun - A.sun) * f;
    if (sun) sun.material.opacity = sunAmt * 0.9;
    /* flares never fully die — a faint anamorphic streak survives night */
    const tB = clock.getElapsedTime();
    if (flareA) flareA.material.opacity = (0.05 + sunAmt * 0.30) * (0.9 + Math.sin(tB * 0.9) * 0.1);
    if (flareB) flareB.material.opacity = 0.03 + sunAmt * 0.15;
    /* neon blooms HARDER at night, like a real city */
    if (bloomPass) bloomPass.strength = (isMobile ? 0.5 : 0.82) * (0.95 + (1 - sunAmt) * 0.4);
    /* let more mirror through when the world goes dark */
    if (wetMesh) wetMesh.material.opacity = 0.74 - (1 - sunAmt) * 0.14;
    /* city skyglow rises as the key drops */
    if (sky) sky.material.uniforms.glow.value = 0.34 + sunAmt * 0.78;
    /* the finish pass follows the same grade (and gives up its chromatic
       aberration at the low tiers — it costs two extra texture taps) */
    if (gradePass) {
      gradePass.material.uniforms.uTime.value = tB;
      gradePass.material.uniforms.uWarm.value = 0.22 + sunAmt * 0.78;
      gradePass.material.uniforms.uChroma.value = GOV.tier >= 3 ? 0 : (isMobile ? 0.0012 : 0.0018);
    }
  }

  /* ═════════ CAMERA PATH — pre-baked LUTs ═════════
     getPointAt/getTangentAt do arc-length binary searches per call.
     Bake 1024 samples at init → per-frame cost is one array index. */
  const LUT_N = 1024;
  const lutPos = new Float32Array(LUT_N * 3);
  const lutLook = new Float32Array(LUT_N * 3);
  const lutTanX = new Float32Array(LUT_N);

  function sampleLut(arr, p, out) {
    const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
    const f = clamped * (LUT_N - 1);
    const i = f | 0;
    const frac = f - i;
    const j = i < LUT_N - 1 ? i + 1 : i;
    out.x = arr[i * 3] + (arr[j * 3] - arr[i * 3]) * frac;
    out.y = arr[i * 3 + 1] + (arr[j * 3 + 1] - arr[i * 3 + 1]) * frac;
    out.z = arr[i * 3 + 2] + (arr[j * 3 + 2] - arr[i * 3 + 2]) * frac;
  }
  function lutTanXat(p) {
    const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
    const f = clamped * (LUT_N - 1);
    const i = f | 0;
    const j = i < LUT_N - 1 ? i + 1 : i;
    const frac = f - i;
    return lutTanX[i] + (lutTanX[j] - lutTanX[i]) * frac;
  }

  /* ---------- procedural textures ----------
     The glass grid and the facade grid are drawn from the SAME column/
     row constants so the frames line up with the panes exactly — that
     alignment is what makes a tower read as architecture up close.
     Both tile seamlessly (RepeatWrapping) because the tower shader
     scales UVs by world size: a 60-unit tower and an 8-unit tower then
     show the SAME window size instead of 12 stretched columns each. */
  const WIN_COLS = 12, WIN_ROWS = 40;

  function windowTexture(warmBias) {
    const W = 256, H = 512;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    /* unlit glass — blue-black, so dark panes read as glass, not holes */
    g.fillStyle = '#05070f';
    g.fillRect(0, 0, W, H);
    const cw = W / WIN_COLS, ch = H / WIN_ROWS;
    const warm = [255, 176, 88], cool = [126, 212, 255];
    for (let r = 0; r < WIN_ROWS; r++) {
      /* whole floors go dark now and then — the single biggest tell of a
         real skyline (100 % lit towers look like wallpaper) */
      const dead = rnd() < 0.09;
      const floorDim = 0.45 + rnd() * 0.5;
      for (let col = 0; col < WIN_COLS; col++) {
        if (dead || rnd() < 0.34) continue;
        const useWarm = rnd() < warmBias;
        const base = useWarm ? warm : cool;
        const a = (0.14 + rnd() * 0.5) * floorDim;
        const x = col * cw + 1, y = r * ch + 1;
        const px = Math.max(1, cw - 2), py = Math.max(1, ch - 2);
        /* a soft interior wash, plus a harder lit band near the ceiling
           (fluorescent strips) — real windows are never one flat block */
        g.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},${(a * 0.32).toFixed(3)})`;
        g.fillRect(x, y, px, py);
        const lit = rnd();
        if (lit > 0.42) {
          g.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},${a.toFixed(3)})`;
          g.fillRect(x, y, px, Math.max(1, py * 0.5));
        }
        if (lit > 0.94) {
          /* a screen / bare bulb — the rare sparkle that makes the city
             alive (kept rare and dim: a bright sparkle is also the
             strongest bloom source, and the whole grid proves it) */
          g.fillStyle = `rgba(255,255,255,${Math.min(0.7, a * 0.55).toFixed(3)})`;
          g.fillRect(x + 1, y + 1, Math.max(1, px * 0.4), Math.max(1, py * 0.26));
        }
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;   /* crisp neon panes */
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function facadeTexture() {
    const W = 128, H = 512;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    /* weathered concrete / dark steel — brighter than pure black so the
       panel work is visible once the key light rakes across it */
    g.fillStyle = '#161a25';
    g.fillRect(0, 0, W, H);
    const cw = W / WIN_COLS, ch = H / WIN_ROWS;
    for (let col = 0; col <= WIN_COLS; col++) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(col * cw - 0.5, 0, 1, H);
      g.fillStyle = 'rgba(150,172,215,0.06)';
      g.fillRect(col * cw + 0.5, 0, 1, H);
    }
    for (let r = 0; r <= WIN_ROWS; r++) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, r * ch - 0.5, W, 1);
      g.fillStyle = 'rgba(160,182,222,0.05)';
      g.fillRect(0, r * ch + 0.5, W, 1);
    }
    /* rain streaks / staining — vertical weathering, never random noise */
    for (let i = 0; i < 110; i++) {
      const x = rnd() * W, y = rnd() * H, hh = 8 + rnd() * 70;
      g.fillStyle = `rgba(0,0,0,${(0.05 + rnd() * 0.15).toFixed(3)})`;
      g.fillRect(x, y, 1 + rnd() * 2, hh);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /* street plate under the city — barely-there asphalt grid that catches
     the mirror and the lamps (one texture sample, sells the ground plane) */
  function streetTexture() {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#0a0b11';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${140 + rnd() * 60 | 0},${150 + rnd() * 60 | 0},${180 + rnd() * 60 | 0},${(rnd() * 0.05).toFixed(3)})`;
      g.fillRect(rnd() * S, rnd() * S, 1, 1);
    }
    g.strokeStyle = 'rgba(150,175,225,0.10)';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = (i * S) / 4;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(26, 26);
    return tex;
  }

  function glowSprite(hex) {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    /* hotter core + a long smooth tail: half of the "bloom" you see at
       night comes from sprite falloff, not from the bloom pass */
    grad.addColorStop(0.00, 'rgba(255,255,255,1)');
    grad.addColorStop(0.10, hex + 'ff');
    grad.addColorStop(0.26, hex + '9a');
    grad.addColorStop(0.52, hex + '3a');
    grad.addColorStop(0.78, hex + '0d');
    grad.addColorStop(1.00, hex + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ---------- world ---------- */
  const streamCurves = [];
  const STREAM_LUT_S = 64;   /* baked samples per route — see buildCity streams */
  let streamPts = null, streamData = [], streamLut = null, monolith = null, monoBeam = null, monoRing = null;
  let gatewayRings = [], podGroups = [], traffic = null, trafficData = [];
  let flareA = null, flareB = null, sun = null, sky = null, wetMesh = null;
  let detailsLive = false;   // film-details layer reports in
  const towersRoot = new THREE.Group();

  /* reusable temps — ZERO allocations in the render loop */
  const _v = new THREE.Vector3();
  const _t = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _dummy = new THREE.Object3D();     // instance matrices (build time only)
  const _tint = new THREE.Color();         // instance colours (build time only)

  /* ── THE SKYLINE ──
     One InstancedMesh instead of one mesh per building: the old build
     drew ~110 separate meshes, this draws 1 for the towers (+2 for the
     roof gear), so the city can be DENSER than before for LESS draw-call
     cost. Per-instance colour varies glass warmth and each whole
     building's exposure, and the facade program pins window size to world
     units + sinks the street level into shadow. All free at runtime. */
  const towerSpecs = [];
  const roofSpecs = [];
  const spireSpecs = [];
  function addTower(x, z, w, d, h, rot, dim) {
    towerSpecs.push({ x, z, w, d, h, rot, dim: dim === undefined ? 1 : dim });
    /* roof gear: a parapet collar always, then a stepped crown and a mast
       on the tall ones — silhouette is what makes a skyline read */
    roofSpecs.push({ x, z, w: w * 1.09, d: d * 1.09, h: 0.9 + h * 0.012, y: h });
    if (h > 46) roofSpecs.push({ x, z, w: w * 0.52, d: d * 0.52, h: h * 0.14, y: h + 1 });
    if (h > 74) spireSpecs.push({ x, z, h: 7 + rnd() * 26, y: h + 1 + h * 0.14 });
  }

  /* facade program patch — three additions, all paid for per-vertex or
     per-fragment with no extra texture lookups:
       1. UVs scale with the instance's world size → identical window size
          on every building (and the seamless tile repeats up the height)
       2. emissive is multiplied by the per-instance tint
       3. vGround grounds the base of every tower (street-canyon shadow) */
  function patchFacade(mat) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWinCell = { value: new THREE.Vector2(WIN_COLS * 1.5, WIN_ROWS * 2.2) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nvarying float vGround;\nuniform vec2 uWinCell;')
        .replace('#include <uv_vertex>',
          '#include <uv_vertex>\n' +
          '#ifdef USE_INSTANCING\n' +
          '  vec2 wScale = vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ) ) / uWinCell;\n' +
          '#ifdef USE_MAP\n  vMapUv *= wScale;\n#endif\n' +
          '#ifdef USE_EMISSIVEMAP\n  vEmissiveMapUv *= wScale;\n#endif\n' +
          '#endif\n' +
          'vGround = smoothstep( -0.5, -0.06, position.y );');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGround;')
        .replace('#include <map_fragment>',
          '#include <map_fragment>\ndiffuseColor.rgb *= mix( 0.42, 1.0, vGround );')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          '#ifdef USE_INSTANCING_COLOR\n  totalEmissiveRadiance *= vColor;\n#endif\n' +
          'totalEmissiveRadiance *= mix( 0.2, 1.0, vGround );');
    };
    mat.customProgramCacheKey = () => 'facade-v1';
  }

  function buildTowers() {
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0xdfe6f5, roughness: 0.58, metalness: 0.34,
      map: facadeTexture(),
      emissive: 0xffffff,
      emissiveMap: windowTexture(0.5),
      emissiveIntensity: 1.0,
    });
    patchFacade(towerMat);

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const N = towerSpecs.length;
    const towers = new THREE.InstancedMesh(boxGeo, towerMat, N);
    towers.frustumCulled = false;              // the city is always in frame
    for (let i = 0; i < N; i++) {
      const s = towerSpecs[i];
      _dummy.position.set(s.x, s.h / 2, s.z);
      _dummy.rotation.set(0, s.rot, 0);
      _dummy.scale.set(s.w, s.h, s.d);
      _dummy.updateMatrix();
      towers.setMatrixAt(i, _dummy.matrix);
      /* glass temperature + whole-building exposure jitter — the thing
         that stops a skyline looking like wallpaper */
      const r = rnd();
      if (r < 0.32) _tint.setRGB(1.0, 0.72 + rnd() * 0.18, 0.42 + rnd() * 0.22);
      else if (r < 0.56) _tint.setRGB(0.7, 0.85, 1.0);
      else if (r < 0.66) _tint.setRGB(0.5, 0.66, 0.92);
      else _tint.setRGB(0.94, 0.96, 1.0);
      _tint.multiplyScalar(0.66 + rnd() * 0.62);
      /* distance dims a facade — the far bands get their own falloff
         instead of glowing as hard as the street they stand behind */
      if (s.dim !== 1) _tint.multiplyScalar(s.dim);
      towers.setColorAt(i, _tint);
    }
    towers.instanceMatrix.needsUpdate = true;
    if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
    towersRoot.add(towers);

    /* roof gear — dark silhouettes stacked on the lit boxes */
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x090b12, roughness: 0.85, metalness: 0.25 });
    const roofs = new THREE.InstancedMesh(boxGeo, roofMat, roofSpecs.length);
    roofs.frustumCulled = false;
    for (let i = 0; i < roofSpecs.length; i++) {
      const s = roofSpecs[i];
      _dummy.position.set(s.x, s.y + s.h / 2, s.z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(s.w, s.h, s.d);
      _dummy.updateMatrix();
      roofs.setMatrixAt(i, _dummy.matrix);
    }
    roofs.instanceMatrix.needsUpdate = true;
    towersRoot.add(roofs);

    if (spireSpecs.length) {
      const spireMat = new THREE.MeshStandardMaterial({ color: 0x0b0e16, roughness: 0.9, metalness: 0.2 });
      const spires = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), spireMat, spireSpecs.length);
      spires.frustumCulled = false;
      for (let i = 0; i < spireSpecs.length; i++) {
        const s = spireSpecs[i];
        _dummy.position.set(s.x, s.y + s.h / 2, s.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(0.7 + rnd() * 0.9, s.h, 0.7 + rnd() * 0.9);
        _dummy.updateMatrix();
        spires.setMatrixAt(i, _dummy.matrix);
      }
      spires.instanceMatrix.needsUpdate = true;
      towersRoot.add(spires);
    }
  }

  function buildCity() {
    scene.add(towersRoot);

    /* boulevards of service towers, both sides */
    for (let i = 0; i < 28; i++) {
      const z = -30 + i * 26;
      for (const side of [-1, 1]) {
        if (rnd() < 0.1) continue;
        const w = 8 + rnd() * 14, d = 8 + rnd() * 14, h = 14 + rnd() * rnd() * 120;
        addTower(side * (22 + rnd() * 55), z + rnd() * 8, w, d, h, 0);
      }
    }
    /* distant skyline silhouettes — two depth bands instead of one, so the
       city reads in atmospheric layers rather than a single flat wall */
    for (let i = 0; i < 96; i++) {
      const z = -80 + rnd() * 900;
      const x = (rnd() < 0.5 ? -1 : 1) * (90 + rnd() * 160);
      addTower(x, z, 10 + rnd() * 22, 10 + rnd() * 22, 20 + rnd() * 150, rnd() * 0.6 - 0.3, 0.55);
    }
    for (let i = 0; i < 54; i++) {
      const z = -200 + rnd() * 1400;
      const x = (rnd() < 0.5 ? -1 : 1) * (250 + rnd() * 340);
      addTower(x, z, 16 + rnd() * 30, 16 + rnd() * 30, 60 + rnd() * 220, rnd() * 0.8 - 0.4, 0.34);
    }
    buildTowers();

    /* ── THE API GATEWAY: three rings the camera flies through ── */
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x1a1206, emissive: 0xff5a1f, emissiveIntensity: 2.4, roughness: 0.3,
    });
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(16 + i * 5, 0.55, 12, 64), ringMat);
      ring.position.set(0, 14 + i * 2, -60 + i * 26);
      ring.rotation.y = 0;
      scene.add(ring);
      gatewayRings.push(ring);
    }

    /* ── THE DB MONOLITH + beacon beam + orbital data ring ── */
    /* emissive fades with height — the base sits dark on the street
       (no more double-glow with its own mirror reflection), the crown
       carries the light like a real tower */
    const monoGrad = document.createElement('canvas');
    monoGrad.width = 2; monoGrad.height = 128;
    const mgg = monoGrad.getContext('2d');
    const mgrad = mgg.createLinearGradient(0, 128, 0, 0);
    mgrad.addColorStop(0.0, '#000000');
    mgrad.addColorStop(0.45, '#0a0a0a');
    mgrad.addColorStop(0.80, '#9be8ff');
    mgrad.addColorStop(1.0, '#ffffff');
    mgg.fillStyle = mgrad;
    mgg.fillRect(0, 0, 2, 128);
    const monoGradTex = new THREE.CanvasTexture(monoGrad);
    monoGradTex.colorSpace = THREE.SRGBColorSpace;
    const monoMat = new THREE.MeshStandardMaterial({
      color: 0x04141a, emissive: 0x59f3ff, emissiveIntensity: 0.6,
      emissiveMap: monoGradTex,
      roughness: 0.2, metalness: 0.6,
    });
    monolith = new THREE.Mesh(new THREE.BoxGeometry(14, 70, 14), monoMat);
    monolith.position.set(0, 35, 330);
    scene.add(monolith);
    /* edge wireframe fades the same way via vertex colors */
    const edgeGeo = new THREE.EdgesGeometry(monolith.geometry);
    const ep = edgeGeo.attributes.position;
    const ecol = new Float32Array(ep.count * 3);
    for (let i = 0; i < ep.count; i++) {
      const hf = (ep.getY(i) + 35) / 70;          // 0 base → 1 crown
      const a = Math.max(0, (hf - 0.35) / 0.65);  // dead below 35%
      ecol[i * 3] = a; ecol[i * 3 + 1] = a; ecol[i * 3 + 2] = a;
    }
    edgeGeo.setAttribute('color', new THREE.BufferAttribute(ecol, 3));
    const edges = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({
        color: 0x59f3ff, vertexColors: true, transparent: true, opacity: 0.5,
      })
    );
    edges.position.copy(monolith.position);
    scene.add(edges);

    const beamGeo = new THREE.CylinderGeometry(2.2, 7, 380, 24, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x59f3ff, transparent: true, opacity: 0.14,
      /* FrontSide on purpose: the end-of-film camera flies straight up through
         this beam, and a DoubleSide wall seen from inside washes the whole
         city behind it cyan. From outside only the near wall is in front of
         the skyline anyway, so the opacity is doubled to keep that look. */
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide, fog: false,
    });
    monoBeam = new THREE.Mesh(beamGeo, beamMat);
    monoBeam.position.set(0, 70 + 190, 330);
    scene.add(monoBeam);

    const ringGeo = new THREE.TorusGeometry(24, 0.35, 8, 96);
    const ringMat2 = new THREE.MeshBasicMaterial({
      color: 0x59f3ff, transparent: true, opacity: 0.38,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    monoRing = new THREE.Mesh(ringGeo, ringMat2);
    monoRing.position.set(0, 58, 330);
    monoRing.rotation.x = Math.PI / 2.25;
    scene.add(monoRing);

    /* ── CONTAINER STACKS (deploys) ──
       Three instanced waves instead of one mesh per pod: 3 draw calls
       where the old build drew ~75, and the boot-loop pulse is 3 uniform
       writes per frame instead of 75 — the old loop was writing one
       SHARED material's emissiveIntensity 75 times per frame (so every
       pod pulsed in unison and the work was pure waste). Now the waves
       ripple as the deploys land, and the yard is denser. */
    const podGeo = new THREE.BoxGeometry(3, 3, 3);
    const POD_WAVES = 3;
    const podCells = [];
    for (let gx = 0; gx < 7; gx++) {
      for (let gy = 0; gy < 5; gy++) {
        for (let gz = 0; gz < 7; gz++) {
          if (rnd() < 0.22) continue;
          podCells.push({
            x: -78 - gx * 5.4, y: 2 + gy * 4.2, z: 372 + gz * 6.2,
            wave: (gx + gy + gz) % POD_WAVES,
            size: 0.72 + rnd() * 0.5,
          });
        }
      }
    }
    for (let w = 0; w < POD_WAVES; w++) {
      const cells = podCells.filter((c) => c.wave === w);
      if (!cells.length) continue;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x140a04, emissive: 0xff8a3d, emissiveIntensity: 1.5, roughness: 0.4,
      });
      const mesh = new THREE.InstancedMesh(podGeo, mat, cells.length);
      mesh.frustumCulled = false;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        _dummy.position.set(c.x, c.y, c.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.setScalar(c.size);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        /* per-pod shell tint — a deploy yard is never one colour */
        _tint.setRGB(0.8 + rnd() * 0.5, 0.78 + rnd() * 0.42, 0.72 + rnd() * 0.4);
        mesh.setColorAt(i, _tint);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      scene.add(mesh);
      podGroups.push(mat);
    }

    /* ── DATA STREAMS: particles flowing along API routes ──
       Each route is baked into a position LUT once, so the per-frame cost
       per particle is an index + a lerp instead of a CatmullRom
       evaluation (~800 curve evaluations per frame before — the biggest
       CPU cost in the loop). Per-particle colour is baked once too: a
       bright head trailing off behind makes a packet read as a request
       in flight instead of a floating dot. */
    const STREAMS = isMobile ? 20 : 34, PTS = 24;
    const total = STREAMS * PTS;
    const positions = new Float32Array(total * 3);
    const streamCols = new Float32Array(total * 3);
    streamLut = new Float32Array(STREAMS * STREAM_LUT_S * 3);
    for (let s = 0; s < STREAMS; s++) {
      const from = new THREE.Vector3(
        (rnd() < 0.5 ? -1 : 1) * (20 + rnd() * 60), 8 + rnd() * 60, -40 + rnd() * 480
      );
      const to = new THREE.Vector3(
        (rnd() < 0.5 ? -1 : 1) * (20 + rnd() * 60), 8 + rnd() * 60, -40 + rnd() * 480
      );
      const mid1 = from.clone().lerp(to, 0.35).add(new THREE.Vector3((rnd() - 0.5) * 40, rnd() * 26, 0));
      const mid2 = from.clone().lerp(to, 0.7).add(new THREE.Vector3((rnd() - 0.5) * 40, rnd() * 26, 0));
      const curve = new THREE.CatmullRomCurve3([from, mid1, mid2, to]);
      streamCurves.push(curve);
      const base = s * STREAM_LUT_S * 3;
      for (let k = 0; k < STREAM_LUT_S; k++) {
        curve.getPoint(k / STREAM_LUT_S, _t);       // wrapping bake: k=S lands on k=0
        streamLut[base + k * 3] = _t.x;
        streamLut[base + k * 3 + 1] = _t.y;
        streamLut[base + k * 3 + 2] = _t.z;
      }
      const warmStream = rnd() < 0.6;
      for (let p = 0; p < PTS; p++) {
        const head = 1 - p / PTS;                   // 1 at the head → 0 at the tail
        streamData.push({ curve: s, base, t: p / PTS, speed: 0.05 + rnd() * 0.09 });
        const k = 0.18 + head * 0.95;
        const i3 = (s * PTS + p) * 3;
        streamCols[i3] = (warmStream ? 1.0 : 0.6) * k;
        streamCols[i3 + 1] = (warmStream ? 0.64 : 0.84) * k;
        streamCols[i3 + 2] = (warmStream ? 0.3 : 1.0) * k;
      }
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    sGeo.setAttribute('color', new THREE.BufferAttribute(streamCols, 3));
    streamPts = new THREE.Points(sGeo, new THREE.PointsMaterial({
      size: 2.9, map: glowSprite('#ff7a2a'), color: 0xffffff, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9,
    }));
    scene.add(streamPts);

    /* ── STREET TRAFFIC ──
       Lanes now carry real light: cars heading away show tail-lights,
       oncoming lanes show headlights. Baked into vertex colour once, so
       the boulevard reads as live traffic instead of a string of identical
       dots at zero per-frame cost. */
    const CAR_LANES = isMobile ? 2 : 4, LANE_PTS = 10;
    const laneXs = [-14, -9, 9, 14];
    const tTotal = CAR_LANES * LANE_PTS;
    const tPos = new Float32Array(tTotal * 3);
    const tCols = new Float32Array(tTotal * 3);
    for (let c = 0; c < CAR_LANES; c++) {
      const dir = c < CAR_LANES / 2 ? 1 : -1;
      for (let p = 0; p < LANE_PTS; p++) {
        trafficData.push({
          x: laneXs[c],
          t: p / LANE_PTS,
          speed: dir * (0.028 + rnd() * 0.02),
        });
        const away = dir > 0;
        const bright = away ? 0.5 + rnd() * 0.18 : 0.85 + rnd() * 0.35;
        const i3 = (c * LANE_PTS + p) * 3;
        tCols[i3] = bright;
        tCols[i3 + 1] = (away ? 0.15 : 0.9) * bright;
        tCols[i3 + 2] = (away ? 0.11 : 1.0) * bright;
      }
    }
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
    tGeo.setAttribute('color', new THREE.BufferAttribute(tCols, 3));
    traffic = new THREE.Points(tGeo, new THREE.PointsMaterial({
      size: 3.4, map: glowSprite('#ffffff'), color: 0xffffff, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.95,
    }));
    scene.add(traffic);

    /* stars */
    const starGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(700 * 3);
    for (let i = 0; i < 700; i++) {
      sp[i * 3] = (rnd() - 0.5) * 1600;
      sp[i * 3 + 1] = 80 + rnd() * 420;
      sp[i * 3 + 2] = -300 + rnd() * 1600;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
      size: 1.6, map: glowSprite('#9fb4ff'), color: 0xbdd0ff,
      transparent: true, depthWrite: false, opacity: 0.7, fog: false,
    })));

    /* ── WET STREET: mirror plane + dark film overlay = reflections ── */
    mirrorObj = new Reflector(new THREE.PlaneGeometry(2400, 2400), {
      clipBias: 0.003,
      textureWidth: isMobile ? 512 : 1024,
      textureHeight: isMobile ? 512 : 1024,
      color: 0x8899aa,
    });
    mirrorObj.rotation.x = -Math.PI / 2;
    mirrorObj.position.y = -0.02;
    scene.add(mirrorObj);

    const wet = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({
        /* the street plate keeps the plane near-black like before, but the
           seams and lane lines show through the mirror — one cheap map,
           and it finally reads as a street rather than a dark sheet */
        color: 0xffffff, map: streetTexture(),
        roughness: 0.82, metalness: 0.42,
        transparent: true, opacity: 0.72,
      })
    );
    wet.rotation.x = -Math.PI / 2;
    wet.position.y = 0.06;
    wetMesh = wet;
    scene.add(wet);

    /* ── SKY DOME ──
       Still one cheap gradient pass, but with the two things a real city
       sky has: light pollution hugging the horizon, and a halo around the
       sun so the disc sits IN light instead of pasted on top of it. Both
       are uniform-driven ALU — no extra samples, no extra passes. */
    const skyGeo = new THREE.SphereGeometry(2000, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x05060f) },
        mid: { value: new THREE.Color(0x1a1440) },
        hor: { value: new THREE.Color(0xb3502a) },
        sunDir: { value: new THREE.Vector3(180, 60, 1500).normalize() },
        glow: { value: 0.9 },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: [
        'varying vec3 vP;',
        'uniform vec3 top; uniform vec3 mid; uniform vec3 hor;',
        'uniform vec3 sunDir; uniform float glow;',
        'void main(){',
        '  vec3 d = normalize(vP);',
        '  float h = d.y;',
        '  vec3 c = h > 0.18 ? mix(mid, top, smoothstep(0.18, 0.9, h))',
        '                     : mix(hor, mid, smoothstep(-0.06, 0.18, h));',
        /* light pollution: the city throws its own skyglow upward */
        '  c += hor * 0.30 * glow * pow(max(0.0, 1.0 - abs(h) * 3.6), 2.2);',
        /* sun halo + the wide warm scatter around it */
        '  float s = max(0.0, dot(d, normalize(sunDir)));',
        '  c += vec3(1.0, 0.52, 0.24) * pow(s, 26.0) * glow * 1.15;',
        '  c += vec3(1.0, 0.58, 0.30) * pow(s, 4.0) * glow * 0.032;',
        '  gl_FragColor = vec4(c, 1.0);',
        '}',
      ].join('\n'),
    });
    sky = new THREE.Mesh(skyGeo, skyMat);
    scene.add(sky);

    /* ── SUN + ANAMORPHIC FLARE ── */
    const sunMat = new THREE.SpriteMaterial({
      map: glowSprite('#ff5a1f'), color: 0xffb37a,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9, fog: false,
    });
    sun = new THREE.Sprite(sunMat);
    sun.scale.set(340, 340, 1);
    sun.position.set(180, 60, 1500);
    scene.add(sun);

    const flareMat = new THREE.SpriteMaterial({
      map: glowSprite('#ff8a4d'), color: 0xff8a4d,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.32, fog: false,
    });
    flareA = new THREE.Sprite(flareMat);
    flareA.scale.set(900, 60, 1);
    flareA.position.copy(sun.position);
    scene.add(flareA);

    flareB = new THREE.Sprite(flareMat.clone());
    flareB.material.opacity = 0.16;
    flareB.scale.set(1400, 26, 1);
    flareB.position.copy(sun.position);
    scene.add(flareB);

    /* lights */
    scene.add(new THREE.HemisphereLight(0x2a3560, 0x0a0a12, 0.8));
    keyLight = new THREE.DirectionalLight(0xff7744, 1.1);
    keyLight.position.set(180, 120, 600);
    scene.add(keyLight);
    const fill = new THREE.DirectionalLight(0x4477ff, 0.25);
    fill.position.set(-200, 80, -200);
    scene.add(fill);
  }

  /* ---------- camera path (chapter keyframes) ---------- */
  let posCurve, lookCurve;
  function buildPath() {
    /* 8 knots = one per story beat (hero, rings, story, work,
       interlude face-off, credits rise, monolith clear, end orbit).
       The world spans z -110..520; the camera spends the WHOLE film
       inside it — monolith reveal lands at the intermission. */
    const P = [
      new THREE.Vector3(-34, 9, -110),   // 01 gateway approach
      new THREE.Vector3(0, 13, -20),     // 01 through the rings
      new THREE.Vector3(10, 20, 90),     // 02 story: entering the boulevard
      new THREE.Vector3(-8, 28, 185),    // 03 work: cruising the towers
      new THREE.Vector3(0, 38, 262),     // 04 interlude: face the monolith
      new THREE.Vector3(0, 78, 300),     // 05 credits: rise over district
      new THREE.Vector3(0, 105, 430),    // 05 clearing the monolith crown
      new THREE.Vector3(0, 150, 500),    // 06 end: high night orbit
    ];
    const L = [
      new THREE.Vector3(0, 16, -40),
      new THREE.Vector3(0, 18, 120),
      new THREE.Vector3(-6, 20, 250),
      new THREE.Vector3(0, 28, 330),
      new THREE.Vector3(0, 40, 336),
      new THREE.Vector3(0, 36, 430),
      new THREE.Vector3(0, 28, 600),
      new THREE.Vector3(0, 20, 760),
    ];
    posCurve = new THREE.CatmullRomCurve3(P, false, 'catmullrom', 0.35);
    lookCurve = new THREE.CatmullRomCurve3(L, false, 'catmullrom', 0.35);

    /* bake LUTs once — O(1) per frame afterwards */
    for (let i = 0; i < LUT_N; i++) {
      const u = i / (LUT_N - 1);
      const p = posCurve.getPointAt(u);
      const l = lookCurve.getPointAt(u);
      const tan = posCurve.getTangentAt(u);
      lutPos[i * 3] = p.x; lutPos[i * 3 + 1] = p.y; lutPos[i * 3 + 2] = p.z;
      lutLook[i * 3] = l.x; lutLook[i * 3 + 1] = l.y; lutLook[i * 3 + 2] = l.z;
      lutTanX[i] = tan.x;
    }
  }

/* ═════════ THE FINISH PASS ═════════
     OutputPass already ends the chain (tone map → colour space), so the
     grade is injected INTO it rather than added as another fullscreen
     pass: split-tone, a film S-curve, lens vignette, radial chromatic
     aberration and a 1-LSB dither. Identical pass count and identical
     tone-mapping maths to before — just a finished frame. The chromatic
     aberration is two extra taps and the governor switches it off at the
     low tiers, so the performance contract still holds. */
  function makeOutputPass() {
    const pass = new OutputPass();
    const u = pass.material.uniforms;
    u.uWarm = { value: 0.7 };
    u.uVignette = { value: isMobile ? 0.26 : 0.32 };
    u.uChroma = { value: isMobile ? 0.0012 : 0.0018 };
    u.uTime = { value: 0 };
    pass.material.fragmentShader = pass.material.fragmentShader
      .replace('uniform sampler2D tDiffuse;',
        'uniform sampler2D tDiffuse;\nuniform float uWarm;\nuniform float uVignette;\nuniform float uChroma;\nuniform float uTime;')
      .replace('gl_FragColor = texture2D( tDiffuse, vUv );',
        'vec2 q = vUv - 0.5;\n' +
        'vec3 src;\n' +
        'if ( uChroma > 0.0 ) {\n' +
        '  vec2 off = q * uChroma;\n' +
        '  src = vec3( texture2D( tDiffuse, vUv + off ).r, texture2D( tDiffuse, vUv ).g, texture2D( tDiffuse, vUv - off ).b );\n' +
        '} else {\n' +
        '  src = texture2D( tDiffuse, vUv ).rgb;\n' +
        '}\n' +
        'gl_FragColor = vec4( src, 1.0 );')
      .replace('#ifdef SRGB_TRANSFER',
        'float glum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );\n' +
        'vec3 lShadow = mix( vec3( 0.93, 0.97, 1.08 ), vec3( 1.03, 0.98, 0.92 ), uWarm );\n' +
        'vec3 lHigh = mix( vec3( 0.97, 0.99, 1.06 ), vec3( 1.13, 1.02, 0.87 ), uWarm );\n' +
        'gl_FragColor.rgb *= mix( lShadow, lHigh, smoothstep( 0.1, 0.75, glum ) );\n' +
        'vec3 gcur = clamp( gl_FragColor.rgb, 0.0, 1.0 );\n' +
        'gl_FragColor.rgb = mix( gl_FragColor.rgb, gcur * gcur * ( 3.0 - 2.0 * gcur ), 0.34 );\n' +
        'gl_FragColor.rgb *= clamp( 1.0 - uVignette * dot( q, q ) * 1.9, 0.0, 1.0 );\n' +
        '#ifdef SRGB_TRANSFER')
      .replace('gl_FragColor = sRGBTransferOETF( gl_FragColor );',
        'gl_FragColor = sRGBTransferOETF( gl_FragColor );\n' +
        'float dn = fract( sin( dot( vUv * vec2( 1237.0, 853.0 ), vec2( 12.9898, 78.233 ) ) + uTime * 0.37 ) * 43758.5453 );\n' +
        'gl_FragColor.rgb += ( dn - 0.5 ) / 255.0;');
    pass.material.needsUpdate = true;
    return pass;
  }

  /* ---------- init ---------- */
  function init(canvas) {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: 'high-performance' });
    } catch (e) {
      console.warn('WebGL unavailable — film falls back to gradient', e);
      document.documentElement.classList.add('no-webgl');
      return false;
    }
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    /* sharper shadows for the same fill cost: PCFSoft over the default */
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06070d);
    scene.fog = new THREE.FogExp2(0x06070d, 0.0062);

    camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4200);

    buildCity();
    buildPath();

    /* small cinematic details layer (moon, cranes, billboards, metro,
       dust, lamps…) — guarded: film works without it */
    try {
      if (window.FilmDetails) {
        window.THREE_FILM_OK = true;
        window.FilmDetails.init(scene, camera);
        detailsLive = !!window.FilmDetails.isLive();
      }
    } catch (e) { console.warn('[film] details layer failed (non-fatal)', e); }

    /* post-processing bloom — the neon kick */
    try {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), isMobile ? 0.52 : 0.82, 0.5, 0.24);
      composer.addPass(bloomPass);
      /* FXAA at the top tiers — the composer pipeline disables the
         context's own antialias, so this is what keeps neon edges crisp.
         One fullscreen pass, only at tiers 0–1; off when the governor
         scales down (its smoothing budget goes further at low res). */
      fxaaPass = new ShaderPass(FXAAShader);
      composer.addPass(fxaaPass);
      gradePass = makeOutputPass();
      composer.addPass(gradePass);
    } catch (e) {
      composer = null;
      console.warn('bloom off', e);
    }

    govApply();
    applyGrade(0);
    window.addEventListener('resize', applySize);

    /* GPU context loss (dual-GPU laptops / driver resets) — recover
       instead of going permanently dark. */
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[film] WebGL context lost — pausing render');
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[film] WebGL context restored — rebuilding composer');
      try {
        if (composer) composer.dispose();
        composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), isMobile ? 0.52 : 0.82, 0.5, 0.24);
        composer.addPass(bloomPass);
        fxaaPass = new ShaderPass(FXAAShader);
        composer.addPass(fxaaPass);
        gradePass = makeOutputPass();
        composer.addPass(gradePass);
        mirrorRTNow = 0;          // force mirror RT re-init on next govApply
        govApply();
        animate();
      } catch (e) {
        console.warn('[film] composer rebuild failed', e);
      }
    });

    /* pointer parallax */
    let mx = 0, my = 0;
    window.addEventListener('pointermove', (e) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
    });
    parallax = { mx, my, get x() { return mx; }, get y() { return my; } };

    ready = true;
    animate();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; }
      else { GOV.last = 0; animate(); }
    });
    return true;
  }

  let parallax = { x: 0, y: 0 };

  function resize() {
    if (!renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer && composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* ---------- public: scrub ---------- */
  function set(p) { target = Math.min(1, Math.max(0, p)); }

  /* ---------- loop ---------- */
  function animate() {
    if (raf || !ready) return;
    raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    govSample(now);
    GOV.display += (GOV.fps - GOV.display) * 0.05;
    /* timeOffset absorbs a pause so animation does not jump forward on resume */
    const t = clock.getElapsedTime() - timeOffset;

    /* smooth scrub */
    current += (target - current) * 0.075;
    if (Math.abs(target - current) < 0.0002) current = target;

    /* scroll-velocity FOV kick — the film surges when you scrub fast */
    const scrollVel = Math.abs(target - prevTarget);
    prevTarget = target;
    fovKick += (scrollVel * 900 - fovKick) * 0.08;
    const fov = (isMobile ? 60 : 55) + Math.min(14, fovKick);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }

    /* camera along the baked LUT + banking (zero allocations) */
    const pe = current < 0 ? 0 : current > 1 ? 1 : current;
    sampleLut(lutPos, pe, _v);
    camera.position.set(
      _v.x + Math.sin(t * 0.22) * 1.6 + parallax.x * 4,
      _v.y + Math.sin(t * 0.35) * 0.8 - parallax.y * 3,
      _v.z
    );
    sampleLut(lutLook, pe, _v);
    const roll = Math.max(-0.09, Math.min(0.09, -lutTanXat(pe) * 0.35));
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    camera.lookAt(_v);
    camera.up.copy(_up);

    /* the grade follows the journey */
    applyGrade(pe);

    /* gateway rings slowly rotate */
    gatewayRings.forEach((r, i) => { r.rotation.z = t * (0.1 + i * 0.05) * (i % 2 ? -1 : 1); });

    /* monolith pulse + beam shimmer + orbital ring */
    if (monolith) monolith.material.emissiveIntensity = 0.5 + Math.sin(t * 1.6) * 0.14;
    if (monoBeam) monoBeam.material.opacity = 0.14 + Math.sin(t * 2.3) * 0.05;
    if (monoRing) monoRing.rotation.z = t * 0.4;

    /* data streams flow — baked-LUT lookup, zero allocations
       (was: one CatmullRom evaluation per particle per frame) */
    if (streamPts) {
      const attr = streamPts.geometry.attributes.position;
      const arr = attr.array;
      for (let i = 0; i < streamData.length; i++) {
        const d = streamData[i];
        d.t += d.speed * 0.016;
        if (d.t > 1) d.t -= 1;
        const f = d.t * STREAM_LUT_S;
        const i0 = f | 0;
        const frac = f - i0;
        const a = d.base + (i0 % STREAM_LUT_S) * 3;
        const b = d.base + ((i0 + 1) % STREAM_LUT_S) * 3;
        arr[i * 3] = streamLut[a] + (streamLut[b] - streamLut[a]) * frac;
        arr[i * 3 + 1] = streamLut[a + 1] + (streamLut[b + 1] - streamLut[a + 1]) * frac;
        arr[i * 3 + 2] = streamLut[a + 2] + (streamLut[b + 2] - streamLut[a + 2]) * frac;
      }
      attr.needsUpdate = true;
      streamPts.material.opacity = 0.55 + Math.sin(t * 2.1) * 0.2;
    }

    /* street traffic */
    if (traffic) {
      const attr = traffic.geometry.attributes.position;
      const arr = attr.array;
      for (let i = 0; i < trafficData.length; i++) {
        const d = trafficData[i];
        d.t += d.speed * 0.016;
        if (d.t > 1) d.t -= 1;
        if (d.t < 0) d.t += 1;
        arr[i * 3] = d.x;
        arr[i * 3 + 1] = 1.4;
        arr[i * 3 + 2] = -140 + d.t * 700;
      }
      attr.needsUpdate = true;
    }

    /* container waves boot-loop (deploys) — 3 uniform writes, not 75 */
    for (let i = 0; i < podGroups.length; i++) {
      podGroups[i].emissiveIntensity = 1.15 + Math.sin(t * 2.4 + i * 2.1) * 0.75;
    }

    /* small-details layer — one shared call, same rAF, zero extra loops */
    if (detailsLive) window.FilmDetails.perFrame(t, pe);

    /* post-processing is skipped entirely in low quality (§12): the composer's
       bloom pass is the single biggest per-frame cost after the mirror */
    (lowQuality || !composer) ? renderer.render(scene, camera) : composer.render();
  }

  return {
    init, set,
    isReady: () => ready,
    govStatus,
    detailsLive: () => detailsLive,
    forceTier: (i) => {
      GOV.tier = Math.min(GOV.tiers.length - 1, Math.max(0, i | 0));
      govApply();
      GOV.warmit = 40; GOV.cooldown = 240; GOV.samples.length = 0; GOV.sum = 0;
    },

    /* ── §12 hooks for the AI panel and the governor ─────────────
       setQuality('low'|'normal') and pause()/resume() are deliberately dumb:
       they change only what they promise, and 'normal'/resume always restore. */
    setQuality: (mode) => {
      const want = mode === 'low';
      if (want === lowQuality) return;
      lowQuality = want;
      govApply();
    },
    quality: () => (lowQuality ? 'low' : 'normal'),
    pause: () => {
      if (paused || !ready) return;
      paused = true;
      pausedAt = clock.getElapsedTime();
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      /* skip the paused span so the city does not teleport */
      timeOffset += clock.getElapsedTime() - pausedAt;
      GOV.last = 0;          /* first frame after resume must not read as a hitch */
      animate();
    },
    isPaused: () => paused,
  };
})();

window.Film3D = Film3D;
