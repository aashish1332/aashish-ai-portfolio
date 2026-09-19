/* ═══════════════════════════════════════════════════════════════
   sound.js — WebAudio engine
   50Hz projector hum through a lowpass, plus UI blips.
   Toggle: Sound.toggle() → bool
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Sound = (() => {
  let ctxA = null, master = null, hum = null, humGain = null, on = false;

  function ensure() {
    if (ctxA) return;
    ctxA = new (window.AudioContext || window.webkitAudioContext)();
    master = ctxA.createGain();
    master.gain.value = 0.5;
    master.connect(ctxA.destination);
  }

  function startHum() {
    ensure();
    if (hum) return;
    hum = ctxA.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 50;
    const lp = ctxA.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 140;
    humGain = ctxA.createGain();
    humGain.gain.value = 0.045;
    hum.connect(lp); lp.connect(humGain); humGain.connect(master);
    hum.start();
  }

  function setMuffle(muffled) {
    if (!humGain || !ctxA) return;
    humGain.gain.linearRampToValueAtTime(muffled ? 0.015 : 0.045, ctxA.currentTime + 0.4);
  }

  function blip(freq = 880, dur = 0.06, type = 'square', vol = 0.05) {
    if (!on) return;
    ensure();
    const o = ctxA.createOscillator();
    const g = ctxA.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctxA.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctxA.currentTime + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(ctxA.currentTime + dur);
  }

  function toggle() {
    on = !on;
    if (on) { startHum(); }
    else if (humGain) humGain.gain.linearRampToValueAtTime(0, ctxA.currentTime + 0.3);
    return on;
  }

  return { toggle, blip, isOn: () => on, setMuffle, ensure };
})();
