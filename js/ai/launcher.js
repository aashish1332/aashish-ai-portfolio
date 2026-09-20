/* ═══════════════════════════════════════════════════════════════
   js/ai/launcher.js — the ONLY AI code on the initial page load (§4, §5)

   Budget: ≤ ~2 KB gzipped. It answers one question — "did the visitor
   click?" — and does nothing else until they do. No worker, no wasm, no
   model, no knowledge base, no request: the entire assistant arrives via
   the dynamic import below, which is why opening the panel is the first
   moment any of it exists.

   Hover-prefetch (optional per §10) warms the UI chunk only, on a fine
   pointer, after 120 ms of hover intent — never the model, never on touch.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  var btn = document.getElementById('askAI');
  if (!btn) return;

  var CHUNK = '/ai/ui/chat.mjs';
  var mod = null;      /* resolved module, once */
  var busy = false;

  function load() {
    if (!mod) mod = import(CHUNK);
    return mod;
  }

  function fail() {
    busy = false;
    btn.classList.remove('is-loading');
    btn.classList.add('is-failed');
    btn.querySelector('.askai__label').textContent = 'AI UNAVAILABLE';
    btn.disabled = true;
  }

  function open() {
    if (busy) return;
    busy = true;
    btn.classList.add('is-loading');
    load().then(function (m) {
      /* mount() wires the button for every later click */
      var chat = window.PortfolioAI || m.mount({ launcher: btn });
      btn.classList.remove('is-loading');
      busy = false;
      return chat.open();
    }).catch(fail);
  }

  btn.addEventListener('click', open);

  /* hover intent: fetch the UI chunk, nothing heavier */
  if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
    var t = 0;
    btn.addEventListener('pointerenter', function () {
      t = setTimeout(function () { load().catch(function () {}); }, 120);
    });
    btn.addEventListener('pointerleave', function () { clearTimeout(t); });
    btn.addEventListener('focus', function () { load().catch(function () {}); });
  }
}());
