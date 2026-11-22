/* ═══════════════════════════════════════════════════════════════
   js/ai/launcher.js — the only AI code on the initial page load

   Budget: ≤ ~2 KB gzipped. One trigger, and only one: the click.

   §2 N6 is literal — "nothing AI-related loads or initialises before the
   click" — and this file is where that promise is kept or broken. An earlier
   revision warmed the shell 1.2 s after `load` so the model would be ready by
   the time a visitor reached for the microphone; with the shipping 49.6M
   checkpoint that meant a 46 MB download, a worker and a parse on every visit
   whether or not anyone wanted the assistant, which is the behaviour N6
   forbids and the browser probe flags. The eager path was removed on
   2026-10-30. Hover and focus used to prefetch the chunk too; both are gone,
   because a pointer crossing a button is not a click.

   This file contains no fetch, no worker, no network API of its own; all of
   the work happens inside the chunk it imports, on the click.
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
      var made = false;
      /* mount() wires the button with its own toggle() listener for every
         later click. Once IT owns #askAI this launcher's own handler must be
         removed, or the first click runs open() AND toggle() — the panel
         shows itself and instantly closes again, and the button reads dead. */
      var existing = window.PortfolioAI;
      var chat = existing || (made = true, m.mount({ launcher: btn }));
      if (made) btn.removeEventListener('click', open);
      btn.classList.remove('is-loading');
      busy = false;
      return chat.open();
    }).catch(fail);
  }

  btn.addEventListener('click', open);
}());
