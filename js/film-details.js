/* ═══════════════════════════════════════════════════════════════
   film-details.js — THE SMALL STUFF
   The layer that makes a good render feel like a finished film.
   Everything here is cheap by construction: sprites, static
   instanced meshes, small canvas textures. Runs inside film3d's
   single rAF via one perFrame(t, pe) call — never its own loop.
   The city still reads as full-stack architecture; these details
   make it feel INHABITED and ENGINEERED.
   ═══════════════════════════════════════════════════════════════ */
import * as THREE from 'three';

'use strict';

(function () {
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* deterministic rng — same city every visit */
  let seed = 20260917;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  /* per-frame updaters registered by each builder */
  const updaters = [];
  let inited = false;

  /* ---------- tiny texture helpers (mirror film3d's, cheap) ---------- */
  let _glowCache = {};
  function glowSprite(hex) {
    if (_glowCache[hex]) return _glowCache[hex];
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, hex + 'cc');
    grad.addColorStop(1, hex + '00');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    _glowCache[hex] = tex;
    return tex;
  }

  function sprite(hex, scale, opacity) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowSprite(hex), color: 0xffffff, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, opacity, fog: false,
    }));
    s.scale.set(scale, scale, 1);
    return s;
  }

  /* ═════════ 1 · THE MOON ═════════ */
  function addMoon(scene) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(118, 118, 40, 128, 128, 128);
    grad.addColorStop(0, '#fff8ea');
    grad.addColorStop(0.72, '#f0e3c4');
    grad.addColorStop(1, '#dcc9a0');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    /* maria */
    for (let i = 0; i < 16; i++) {
      const x = 34 + rnd() * 188, y = 34 + rnd() * 188, r = 9 + rnd() * 30;
      const mg = g.createRadialGradient(x, y, 0, x, y, r);
      mg.addColorStop(0, 'rgba(125,116,98,.38)');
      mg.addColorStop(1, 'rgba(125,116,98,0)');
      g.fillStyle = mg;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0.55, fog: false, depthWrite: false,
    }));
    moon.position.set(-540, 640, -1500);
    moon.scale.set(150, 150, 1);
    scene.add(moon);
    const halo = sprite('#cfd8ff', 430, 0.16);
    halo.position.copy(moon.position);
    scene.add(halo);
    /* the moon owns the night — brightens as the grade darkens */
    updaters.push((t, pe) => {
      const night = Math.min(1, Math.max(0, (pe - 0.2) / 0.5));
      moon.material.opacity = 0.5 + night * 0.42;
      halo.material.opacity = 0.10 + night * 0.12;
    });
  }

  /* ═════════ 2 · ROOFTOP SEARCHLIGHTS ═════════ */
  function addSearchlights(scene) {
    const N = isMobile ? 2 : 3;
    const spots = [[-46, 96, 60], [40, 120, 170], [-34, 70, 280]];
    for (let i = 0; i < N; i++) {
      const [x, y, z] = spots[i];
      const grp = new THREE.Group();
      grp.position.set(x, y, z);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(6.5, 0.6, 170, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xfff2cc, transparent: true, opacity: 0.075,
          blending: THREE.AdditiveBlending, depthWrite: false,
          side: THREE.DoubleSide, fog: false,
        })
      );
      beam.position.y = 85;
      grp.add(beam);
      const lamp = sprite('#fff2cc', 16, 0.5);
      lamp.position.y = 3;
      grp.add(lamp);
      grp.rotation.z = 0.5 + rnd() * 0.35;
      grp.rotation.x = -0.12 + rnd() * 0.24;
      scene.add(grp);
      const phase = rnd() * 6.28, speed = 0.14 + rnd() * 0.1;
      updaters.push((t) => {
        grp.rotation.y = Math.sin(t * speed + phase) * 0.7;
        grp.rotation.z = 0.5 + Math.sin(t * speed * 0.63 + phase * 2.0) * 0.18;
      });
    }
  }

  /* ═════════ 3 · RED-EYE AIRLINER ═════════ */
  function addAirliner(scene) {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 11, 6),
      new THREE.MeshBasicMaterial({ color: 0x0a0d16 })
    );
    body.rotation.z = Math.PI / 2;
    grp.add(body);
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(4.5, 0.22, 2.2),
      new THREE.MeshBasicMaterial({ color: 0x0a0d16 })
    );
    wing.position.y = -0.4;
    grp.add(wing);
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 2.0, 0.22),
      new THREE.MeshBasicMaterial({ color: 0x0a0d16 })
    );
    tail.position.set(-4.6, 1.2, 0);
    grp.add(tail);
    /* aviation lights: steady red + white double-strobe */
    const navR = sprite('#ff2222', 5, 0.9); navR.position.set(-5.5, 0.2, 0); grp.add(navR);
    const navG = sprite('#22ff66', 3.4, 0.8); navG.position.set(5.5, 0.2, 0); grp.add(navG);
    const strobe = sprite('#ffffff', 7, 0); strobe.position.set(-5.5, 0.3, 0); grp.add(strobe);
    grp.position.set(-800, 470, 260);
    scene.add(grp);
    updaters.push((t) => {
      grp.position.x += 0.055;                 // ~146 units/min drift
      if (grp.position.x > 900) grp.position.x = -900;
      navR.material.opacity = (t % 1.2) < 0.14 ? 0.95 : 0.06;
      const f = t % 1.7;
      strobe.material.opacity = (f < 0.07 || (f > 0.16 && f < 0.23)) ? 1.0 : 0.0;
    });
  }

  /* ═════════ 4 · CONSTRUCTION CRANES (always shipping) ═════════ */
  function addCranes(scene) {
    const N = isMobile ? 1 : 2;
    const sites = [[-58, 130, 72], [62, 210, 58]];
    const steel = new THREE.MeshBasicMaterial({ color: 0x171c2a });
    for (let i = 0; i < N; i++) {
      const [x, z, h] = sites[i];
      const mast = new THREE.Mesh(new THREE.BoxGeometry(1.3, h, 1.3), steel);
      mast.position.set(x, h / 2, z);
      scene.add(mast);
      const pivot = new THREE.Group();
      pivot.position.set(x, h, z);
      const jib = new THREE.Mesh(new THREE.BoxGeometry(30, 1.0, 1.0), steel);
      jib.position.set(14, 0, 0);
      pivot.add(jib);
      const counter = new THREE.Mesh(new THREE.BoxGeometry(8, 1.0, 1.0), steel);
      counter.position.set(-4.5, 0, 0);
      pivot.add(counter);
      const hookCable = new THREE.Mesh(new THREE.BoxGeometry(0.12, 14, 0.12), steel);
      hookCable.position.set(9, -7, 0);
      pivot.add(hookCable);
      const hook = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 1.1),
        new THREE.MeshBasicMaterial({ color: 0x0e1119 }));
      hook.position.set(9, -14.4, 0);
      pivot.add(hook);
      const beacon = sprite('#ff3030', 6, 0.8);
      beacon.position.set(28.5, 1.5, 0);
      pivot.add(beacon);
      scene.add(pivot);
      const ph = rnd() * 6.28;
      updaters.push((t) => {
        pivot.rotation.y = t * 0.13 + ph;
        beacon.material.opacity = (t % 1.5) < 0.18 ? 0.95 : 0.05;
      });
    }
  }

  /* ═════════ 5 · SCAFFOLD TOWERS (under construction) ═════════ */
  function addScaffolds(scene) {
    const N = isMobile ? 4 : 7;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const slabMat = new THREE.MeshBasicMaterial({ color: 0x05070c });
    for (let i = 0; i < N; i++) {
      const x = (rnd() < 0.5 ? -1 : 1) * (26 + rnd() * 40);
      const z = -10 + i * 42 + rnd() * 14;
      const h = 34 + rnd() * 70;
      const w = 9 + rnd() * 8, d = 9 + rnd() * 8;
      const slab = new THREE.Mesh(boxGeo, slabMat);
      slab.scale.set(w, h * 0.5, d);
      slab.position.set(x, h * 0.25, z);
      scene.add(slab);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(slab.geometry),
        new THREE.LineBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.32 })
      );
      edge.scale.copy(slab.scale);
      edge.position.copy(slab.position);
      scene.add(edge);
      /* worker floodlights blinking on the deck */
      const w1 = sprite('#ffb050', 8, 0.5);
      w1.position.set(x + w / 2, h * 0.5 + 1, z + d / 2);
      scene.add(w1);
      const ph = rnd() * 6.28;
      updaters.push((t) => { w1.material.opacity = 0.32 + Math.sin(t * 1.7 + ph) * 0.18; });
    }
  }

  /* ═════════ 6 · AVIATION LIGHTS on tall towers ═════════ */
  function addAviationLights(scene) {
    const groups = isMobile ? 2 : 3;         // staggered blink phases
    const per = 22;
    for (let gI = 0; gI < groups; gI++) {
      const pos = new Float32Array(per * 3);
      for (let i = 0; i < per; i++) {
        pos[i * 3] = (rnd() < 0.5 ? -1 : 1) * (24 + rnd() * 52);
        pos[i * 3 + 1] = 34 + rnd() * 96;    // only tall structures
        pos[i * 3 + 2] = -30 + rnd() * 520;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const cloud = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 3.2, map: glowSprite('#ff4040'), color: 0xff5544,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        opacity: 1, fog: false, sizeAttenuation: true,
      }));
      scene.add(cloud);
      const ph = (gI / groups) * Math.PI * 2;
      updaters.push((t) => {
        const s = Math.sin(t * 2.1 + ph);
        cloud.material.opacity = s > 0.3 ? 0.85 : 0.04;
      });
    }
  }

  /* ═════════ 7 · STREET LAMPS (instanced — one draw call) ═════════ */
  function addStreetLamps(scene) {
    const xs = [-16.5, 16.5];
    const zs = [];
    for (let z = -120; z <= 480; z += 26) zs.push(z);
    const count = zs.length * 2;
    /* The shaft flares DOWN from the bulb (narrow at the head, wide at the
       kerb) — the other way round it reads as an inverted funnel floating
       over the road. The falloff is baked into vertex colours rather than
       left to a flat opacity: additive blending is transparent to a uniform
       colour, so a constant alpha shows the cone's hard silhouette edge. */
    const coneGeo = new THREE.CylinderGeometry(0.5, 3.0, 9, 8, 1, true);
    {
      const pos = coneGeo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const t = (pos.getY(i) + 4.5) / 9;      // 0 at the kerb, 1 at the bulb
        const v = 0.12 + 0.88 * t * t;          // falls off fast on the way down
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
      }
      coneGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffc890, transparent: true, opacity: 0.10,
      vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const cones = new THREE.InstancedMesh(coneGeo, coneMat, count);
    const glowGeo = new THREE.BufferGeometry();
    const gpos = new Float32Array(count * 3);
    const m = new THREE.Matrix4();
    let k = 0;
    for (let sI = 0; sI < 2; sI++) {
      for (let i = 0; i < zs.length; i++) {
        const x = xs[sI], z = zs[i];
        m.makeTranslation(x, 4.8, z);
        cones.setMatrixAt(k, m);
        gpos[k * 3] = x; gpos[k * 3 + 1] = 9.4; gpos[k * 3 + 2] = z;
        k++;
      }
    }
    scene.add(cones);
    glowGeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
    scene.add(new THREE.Points(glowGeo, new THREE.PointsMaterial({
      size: 3.4, map: glowSprite('#ffd9a0'), color: 0xffe4bb,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      opacity: 0.5, fog: false,
    })));
    /* static after build — zero per-frame cost */
  }

  /* ═════════ 8 · FULL-STACK BILLBOARDS — live engineering logs ═════════
     Giant tickers on tower faces, running the pipeline of a real
     full-stack app: requests, builds, queries, deploys, retries. */
  const BOARDS = [
    { x: -40, y: 34, z: 60,  w: 22, h: 12, side: -1, glow: '#59f3ff',
      tick: 'GET /api/projects → 200 · 12ms · cache HIT',
      sub:  'edge: fra1 · node 20 · uptime 99.98%' },
    { x: 46,  y: 27, z: 150, w: 20, h: 11, side: 1, glow: '#ffb050',
      tick: 'npm run build ✓ bundled 1.2s · gzip 41kb',
      sub:  'ci: green · 148 tests passed' },
    { x: -48, y: 50, z: 240, w: 24, h: 13, side: -1, glow: '#7dff9e',
      tick: 'SELECT * FROM skills; -- 27 rows in 0.8ms',
      sub:  'postgres 16 · pgbouncer · index scan' },
    { x: 52,  y: 38, z: 320, w: 22, h: 12, side: 1, glow: '#ff7a5c',
      tick: 'POST /contact → 500 ⟳ retry → 200 OK',
      sub:  'graceful degradation · ws: connected' },
  ];
  const billboards = [];

  function makeBoardCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = isMobile ? 384 : 512;
    c.height = isMobile ? 216 : 288;
    return c;
  }

  function drawBoard(bd) {
    const g = bd.g2d, W = bd.canvas.width, H = bd.canvas.height;
    g.fillStyle = '#04060b';
    g.fillRect(0, 0, W, H);
    /* header bar */
    g.fillStyle = '#0b1220';
    g.fillRect(0, 0, W, 34);
    g.fillStyle = bd.glow;
    g.fillRect(0, 0, 8, 34);
    g.font = '600 17px "JetBrains Mono", Consolas, monospace';
    g.fillText('AK47.SYS — LIVE', 20, 24);
    /* blinking rec dot */
    if (Math.floor(performance.now() / 700) % 2 === 0) {
      g.beginPath(); g.arc(W - 26, 17, 6, 0, 7); g.fill();
    }
    /* scrolling ticker */
    g.font = '700 30px "JetBrains Mono", Consolas, monospace';
    g.fillStyle = '#e8f4ff';
    const tw = g.measureText(bd.tick).width + 120;
    let off = (bd.scroll * W) % tw;
    g.save();
    g.beginPath(); g.rect(0, 52, W, 60); g.clip();
    g.fillText(bd.tick, W - off, 96);
    g.fillText(bd.tick, W - off + tw, 96);
    g.restore();
    /* sub line */
    g.font = '500 18px "JetBrains Mono", Consolas, monospace';
    g.fillStyle = '#5f7392';
    g.fillText(bd.sub, 20, H - 26);
    /* scanlines */
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
    bd.tex.needsUpdate = true;
  }

  function addBillboards(scene) {
    const list = isMobile ? BOARDS.slice(0, 2) : BOARDS;
    for (const bd of list) {
      const canvas = makeBoardCanvas();
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(bd.w, bd.h),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
      );
      mesh.position.set(bd.x, bd.y, bd.z);
      mesh.rotation.y = bd.side < 0 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(mesh);
      const back = sprite(bd.glow, Math.max(bd.w, bd.h) * 1.5, 0.28);
      back.position.set(bd.x, bd.y, bd.z);
      scene.add(back);
      const b = {
        canvas, tex, g2d: canvas.getContext('2d'),
        scroll: rnd(), next: 0, glow: bd.glow, tick: bd.tick, sub: bd.sub,
      };
      drawBoard(b);
      billboards.push(b);
    }
    updaters.push((t, pe, nowMs) => {
      for (const b of billboards) {
        b.scroll += 0.0011;                            // ticker speed
        if (nowMs >= b.next) {
          drawBoard(b);
          b.next = nowMs + (isMobile ? 200 : 140);     // 5–7 fps text updates
        }
      }
    });
  }

  /* ═════════ 9 · DUST MOTES near the lens ═════════ */
  function addDust(scene) {
    const N = isMobile ? 120 : 260;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 2);              // vx, vy
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rnd() - 0.5) * 90;
      pos[i * 3 + 1] = 2 + rnd() * 66;
      pos[i * 3 + 2] = -120 + rnd() * 640;
      vel[i * 2] = (rnd() - 0.5) * 0.55;
      vel[i * 2 + 1] = 0.08 + rnd() * 0.3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.15, map: glowSprite('#ffd9b0'), color: 0xffe6cc,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      opacity: 0.3, fog: false,
    }));
    scene.add(dust);
    updaters.push((t) => {
      const arr = geo.attributes.position.array;
      for (let i = 0; i < N; i++) {
        arr[i * 3] += vel[i * 2] * 0.016 + Math.sin(t * 0.7 + i) * 0.006;
        arr[i * 3 + 1] += vel[i * 2 + 1] * 0.016;
        if (arr[i * 3 + 1] > 70) arr[i * 3 + 1] = 2;
        if (arr[i * 3] > 46) arr[i * 3] = -46;
        else if (arr[i * 3] < -46) arr[i * 3] = 46;
      }
      geo.attributes.position.needsUpdate = true;
    });
  }

  /* ═════════ 10 · THE EXPRESS.JS METRO — elevated transit ═════════
     An elevated line runs the length of the boulevard: middleware
     moving requests through the stack, one car per microservice. */
  function addMetro(scene) {
    const X = -52, Y = 17;
    /* viaduct + pylons */
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.8, 640),
      new THREE.MeshBasicMaterial({ color: 0x0d1019 })
    );
    deck.position.set(X, Y, 190);
    scene.add(deck);
    const railMat = new THREE.MeshBasicMaterial({ color: 0x59f3ff, transparent: true, opacity: 0.28 });
    for (const dz of [-0.62, 0.62]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 640), railMat);
      rail.position.set(X, Y + 0.46, 190 + dz);
      scene.add(rail);
    }
    const pylonGeo = new THREE.BoxGeometry(1.0, Y, 1.3);
    const pylons = new THREE.InstancedMesh(pylonGeo,
      new THREE.MeshBasicMaterial({ color: 0x0d1019 }), 16);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) {
      m4.makeTranslation(X, Y / 2, -110 + i * 42);
      pylons.setMatrixAt(i, m4);
    }
    scene.add(pylons);
    /* window texture for the cars */
    const wc = document.createElement('canvas');
    wc.width = 64; wc.height = 16;
    const wg = wc.getContext('2d');
    wg.fillStyle = '#05060c'; wg.fillRect(0, 0, 64, 16);
    for (let i = 0; i < 10; i++) {
      wg.fillStyle = `rgba(190,225,255,${0.5 + rnd() * 0.5})`;
      wg.fillRect(i * 6 + 2, 4, 3, 7);
    }
    const wtex = new THREE.CanvasTexture(wc);
    wtex.colorSpace = THREE.SRGBColorSpace;
    const carMat = new THREE.MeshStandardMaterial({
      color: 0x10141f, roughness: 0.4, metalness: 0.5,
      emissive: 0xffffff, emissiveMap: wtex, emissiveIntensity: 1.6,
    });
    const carGeo = new THREE.BoxGeometry(3.2, 3.0, 11.5);
    const train = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const car = new THREE.Mesh(carGeo, carMat);
      car.position.z = -i * 12.4;
      train.add(car);
    }
    const head = sprite('#dfefff', 10, 0.85);
    head.position.set(0, 0.2, 6.6);
    train.add(head);
    const tail = sprite('#ff4040', 5, 0.7);
    tail.position.set(0, 0.2, -43.2);
    train.add(tail);
    train.position.set(X, Y + 2.6, -160);
    scene.add(train);
    updaters.push((t) => {
      const z = ((t * 26) % 760) - 180;
      train.position.z = z;
      /* headlight brightens as it emerges from the fog */
      head.material.opacity = 0.25 + Math.min(0.65, Math.max(0, (z + 160) / 240));
    });
  }

  /* ═════════ init ═════════ */
  function init(scene, camera) {
    if (inited || !scene || !window.THREE_FILM_OK) return;
    inited = true;
    addMoon(scene);
    addSearchlights(scene);
    addAirliner(scene);
    addCranes(scene);
    addScaffolds(scene);
    addAviationLights(scene);
    addStreetLamps(scene);
    addBillboards(scene);
    addDust(scene);
    addMetro(scene);
    /* reduced motion: keep the world, freeze the choreography */
    if (REDUCED) updaters.length = 0;
  }

  /* called once per rendered frame from film3d's tick */
  function perFrame(t, pe) {
    if (!inited) return;
    const nowMs = performance.now();
    for (let i = 0; i < updaters.length; i++) updaters[i](t, pe, nowMs);
  }

  window.FilmDetails = { init, perFrame, isLive: () => inited };
})();
