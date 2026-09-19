/* ═══════════════════════════════════════════════════════════════
   fluidlens.js — FluidGlass, translated 1:1 from the user-provided
   react-bits source (fluidglass.txt).

   The original is NOT a cursor — it is a full-screen WebGL
   experience: content lives INSIDE the scene, and a big lens with
   MeshTransmissionMaterial refracts it in the same render pass.
   That is the only way to get the real look (WebGL cannot read
   DOM pixels). So this is their component, verbatim in structure:

     Canvas { camera [0,0,20] fov 15, NoToneMapping, alpha }
     ├─ background plane #120F17 (z -5, vp*2)
     ├─ Typography  "AASHISH"   (z 12, fontSize .6/.4/.2, ls -0.05)
     ├─ Images ×5   (their exact positions/scales + scroll zoom)
     ├─ scroll group (wheel → damped progress, their range windows)
     └─ lens: CylinderGeometry rotated x=π/2, scale 0.25,
        MeshPhysicalMaterial{ transmission 1, ior 1.15, thickness 2,
        roughness 0, dispersion 0.05 (= chromaticAberration) }
        position damp3-follows the pointer at z 15 (rate 9/s)

   drei equivalents used: three r170 built-in transmission pass
   (replaces their FBO + MeshTransmissionMaterial buffer),
   troika-three-text (the text engine drei <Text> wraps).

   Toggle: press G (or terminal `lens`) · Esc/G exits · wheel scrolls
   ═══════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

'use strict';

const FluidGlass = (() => {
  /* ── their constants ── */
  const FOV = 15, CAMZ = 20, LENSZ = 15;
  const BG = 0x120F17;
  const LENS_SCALE = 0.25;              // their example lensProps.scale
  const RATE = 9;                       // easing.damp3(...,0.15) ≈ 9/s
  const IMAGE_URLS = [
    'https://images.unsplash.com/photo-1783394327207-acf441e37dda?w=900&auto=format&fit=crop&q=60',
    'https://images.unsplash.com/photo-1782977389500-dd7adad33ebe?w=900&auto=format&fit=crop&q=60',
    'https://images.unsplash.com/photo-1782094002386-7d9ae1f49f50?w=900&auto=format&fit=crop&q=60',
    'https://images.unsplash.com/photo-1781242629922-6f39cc3671cd?w=900&auto=format&fit=crop&q=60',
    'https://images.unsplash.com/photo-1779684474703-5c0519bcf7e8?w=900&auto=format&fit=crop&q=60',
  ];

  /* viewport height at z=0 for camera (0,0,20) fov 15 */
  const VH = 2 * Math.tan((FOV * Math.PI) / 360) * CAMZ;   // ≈ 5.27
  const halfH15 = Math.tan((FOV * Math.PI) / 360) * (CAMZ - LENSZ);

  let renderer = null, scene = null, camera = null, lens = null;
  let scrollGroup = null, images = [];
  let built = false, active = false, raf = null, last = 0;
  let tx = 0, ty = 1, lx = 0, ly = 0;      // pointer ndc + damped world pos
  let pTarget = 0, p = 0;                  // scroll progress 0..1 (3 pages)
  let exitChip = null;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const win = (p, a, len) => clamp01((p - a) / len);   // drei useScroll.range

  /* ── build the scene once (their ModeWrapper + content) ── */
  async function build() {
    if (built) return;
    built = true;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.NoToneMapping;        // their gl option
    renderer.domElement.className = 'fluidglass-stage';
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.1, 50);
    camera.position.set(0, 0, CAMZ);                    // their camera

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    /* background plane — their z -5, scale vp*2 */
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: BG, toneMapped: false })
    );
    bg.position.z = -5;
    bg.scale.set(VH * camera.aspect * 2, VH * 2, 1);
    scene.add(bg);

    /* scroll group — their <Scroll> content */
    scrollGroup = new THREE.Group();
    scene.add(scrollGroup);

    /* Typography — their Text: z 12, ls -0.05, sizes .6/.4/.2 */
    const fontSize = innerWidth <= 639 ? 0.2 : innerWidth <= 1023 ? 0.4 : 0.6;
    try {
      const { Text } = await import('troika-three-text');
      const title = new Text();
      title.text = 'AASHISH';
      title.fontSize = fontSize;
      title.letterSpacing = -0.05;
      title.color = 0xffffff;
      title.anchorX = 'center';
      title.anchorY = 'middle';
      title.position.set(0, 0, 12);
      scrollGroup.add(title);
      title.sync();
    } catch (e) {
      /* troika CDN failed → canvas-texture fallback text */
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 256;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.font = '700 190px "Bebas Neue", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('AASHISH', 512, 132);
      const tex = new THREE.CanvasTexture(c);
      const fallback = new THREE.Mesh(
        new THREE.PlaneGeometry(fontSize * 6.4, fontSize * 1.6),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false })
      );
      fallback.position.set(0, 0, 12);
      scrollGroup.add(fallback);
    }

    /* Images — their exact positions/scales */
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    const defs = [
      { pos: [-2, 0, 0],           scale: [3, VH / 1.1, 1] },
      { pos: [2, 0, 3],            scale: [3, 3, 1] },
      { pos: [-2.05, -VH, 6],      scale: [1, 3, 1] },
      { pos: [-0.6, -VH, 9],       scale: [1, 2, 1] },
      { pos: [0.75, -VH, 10.5],    scale: [1.5, 1.5, 1] },
    ];
    defs.forEach((d, i) => {
      const tex = loader.load(IMAGE_URLS[i], (t) => { t.colorSpace = THREE.SRGBColorSpace; });
      tex.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
      );
      m.position.set(...d.pos);
      m.scale.set(...d.scale);
      scrollGroup.add(m);
      images.push(m);
    });

    /* THE LENS — their geometry + material, three's transmission
       pass renders the scene and refracts it (their FBO pipeline) */
    lens = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 0.22, 64),
      new THREE.MeshPhysicalMaterial({
        transmission: 1,          // theirs
        roughness: 0,             // theirs
        ior: 1.15,                // theirs
        thickness: 2,             // theirs
        dispersion: 0.05,         // their chromaticAberration: 0.05
        color: 0xffffff,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
      })
    );
    lens.rotation.x = Math.PI / 2;                    // their rotation-x
    lens.scale.setScalar(LENS_SCALE);
    lens.position.set(0, 0, LENSZ);
    scene.add(lens);

    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!renderer) return;
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }

  /* ── open / close / loop ── */
  async function open() {
    if (active) return;
    await build();
    active = true;
    pTarget = 0; p = 0;
    renderer.domElement.classList.add('is-active');
    document.documentElement.classList.add('lens-active');
    if (window.Director && Director.getLenis) { const l = Director.getLenis(); l && l.stop(); }
    if (!exitChip) {
      exitChip = document.createElement('button');
      exitChip.className = 'lensmode-exit';
      exitChip.textContent = '✕ EXIT LENS — ESC';
      exitChip.addEventListener('click', close);
      document.body.appendChild(exitChip);
    }
    exitChip.classList.add('is-visible');
    start();
  }

  function close() {
    if (!active) return;
    active = false;
    renderer.domElement.classList.remove('is-active');
    document.documentElement.classList.remove('lens-active');
    exitChip && exitChip.classList.remove('is-visible');
    if (window.Director && Director.getLenis) { const l = Director.getLenis(); l && l.start(); }
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function toggle() { active ? close() : open(); }

  function start() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function loop(now) {
    if (!active) { raf = null; return; }
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const a = 1 - Math.exp(-RATE * dt);

    /* their useFrame: dest = pointer mapped to z=15 viewport */
    const vW15 = 2 * halfH15 * camera.aspect, vH15 = 2 * halfH15;
    const destX = (tx * vW15) / 2, destY = (ty * vH15) / 2;
    lx += (destX - lx) * a;
    ly += (destY - ly) * a;
    lens.position.x = lx;
    lens.position.y = ly;
    lens.position.z = LENSZ;

    /* their auto-scale (when no explicit scale) — kept for fidelity */
    /* scale is fixed at their example value 0.25 */

    /* damped scroll + their zoom windows */
    p += (pTarget - p) * a;
    scrollGroup.position.y = p * VH * 0.9;
    const z0 = 1 + win(p, 0, 1 / 3) / 3;
    const z2 = 1 + win(p, 1.15 / 3, 1 / 3) / 2;
    [0, 1].forEach((i) => applyZoom(images[i], z0));
    [2, 3, 4].forEach((i) => applyZoom(images[i], z2));

    renderer.render(scene, camera);
  }

  /* drei <Image zoom> = texture crop, not plane scale */
  function applyZoom(mesh, z) {
    const map = mesh.material.map;
    if (!map || z === mesh.userData.z) return;
    mesh.userData.z = z;
    map.repeat.set(1 / z, 1 / z);
    map.offset.set((1 - 1 / z) / 2, (1 - 1 / z) / 2);
    map.needsUpdate = true;
  }

  /* ── global controls ── */
  /* lens mode needs a pointer — skip registration on touch devices */
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;

  window.addEventListener('pointermove', (e) => {
    tx = (e.clientX / innerWidth) * 2 - 1;
    ty = -(e.clientY / innerHeight) * 2 + 1;
  });
  window.addEventListener('wheel', (e) => {
    if (!active) return;
    e.preventDefault();
    pTarget = clamp01(pTarget + e.deltaY * 0.0006);
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) close();
    if ((e.key === 'g' || e.key === 'G') &&
        !e.ctrlKey && !e.metaKey && !e.altKey &&
        !/INPUT|TEXTAREA/.test((document.activeElement && document.activeElement.tagName) || '')) {
      toggle();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; }
    else if (active) start();
  });

  return { toggle, open, close, isActive: () => active };
})();

window.FluidGlass = FluidGlass;
