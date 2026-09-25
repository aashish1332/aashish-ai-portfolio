/* ═══════════════════════════════════════════════════════════════
   ai/ui/chat.mjs — the chat shell (§10), loaded ONLY after the click

   This is the file the launcher dynamic-imports, so nothing here exists on
   the initial page load. It carries: the panel, the §6 governor wiring, the
   Quick Answers engine and the §8.3 language tracker.

   P2 scope — deliberately honest about what is not built yet:
     · every answer comes from the deterministic Quick Answers engine, so
       the panel is fully usable on a T0 device with nothing downloaded;
     · there is NO model in this build, so there is nothing to download and
       no spinner pretending otherwise. When a model plan is passed in via
       `modelPlan`, the real preparing → progress → ready states render. The
       visitor is told which kind of answer they got, always (§3).

   Rendering is text-only (`textContent`, never innerHTML). Answers are whole
   messages, so `aria-live` announces them once, completed — no per-token
   announcements (§10).
   ═══════════════════════════════════════════════════════════════ */
import { quickAnswer } from '../answers/quick.mjs';
import { MODEL_BADGES, createModelAnswerer } from '../answers/model.mjs';
import { createModelSession } from '../engine/session.mjs';
import { resolveAnchor, anchorLabel } from './anchors.mjs';
import { createLanguageTracker } from '../language/detect.mjs';
import {
  createVoice, recognizeSupported, voiceSummary,
} from '../voice/index.mjs';
import {
  probeCapabilities, chooseTier, probeWebGPU, tierInfo,
  createDegradeLadder, LADDER, hasSimd,
} from '../governor/index.mjs';
import { STYLES } from './styles.mjs';

const KB_URL = new URL('../../knowledge/knowledge.json', import.meta.url);

/* ── the §6.1 micro-benchmark ────────────────────────────────────
   A ~250 ms matmul loop, run in a worker so it never touches the main
   thread (§4: "AI work on the main thread: no task > 50 ms"). It returns
   milliseconds for 2M multiply-adds; slower is smaller. Any failure —
   no worker, CSP, timeout — returns null, and the tier choice simply runs
   without that signal. */
const BENCH_SRC = `
  onmessage = () => {
    const n = 1024, a = new Float64Array(n), out = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = i * 0.001;
    const t0 = performance.now();
    for (let pass = 0; pass < 64; pass++) {
      for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < 32; k++) s += a[(i + k) % n] * 1.000001; out[i] = s; }
    }
    postMessage(performance.now() - t0);
  };
`;

function runBenchmark(env, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let worker = null;
    let url = null;
    const done = (v) => { try { worker && worker.terminate(); } catch { /* noop */ } try { url && env.URL.revokeObjectURL(url); } catch { /* noop */ } resolve(v); };
    try {
      if (!env.Worker || !env.Blob || !env.URL?.createObjectURL) return done(null);
      url = env.URL.createObjectURL(new env.Blob([BENCH_SRC], { type: 'text/javascript' }));
      worker = new env.Worker(url, { name: 'ai-bench' });
      const timer = env.setTimeout ? env.setTimeout(() => done(null), timeoutMs) : null;
      worker.onmessage = (e) => { if (timer) env.clearTimeout(timer); done(Number(e.data) || null); };
      worker.onerror = () => { if (timer) env.clearTimeout(timer); done(null); };
      worker.postMessage('go');
    } catch { done(null); }
  });
}

const escape = (s) => String(s);

/* ── the model this build ships (§9.3) ───────────────────────────
   Relative to the document so a deploy in a subdirectory works, and one
   place to point at a different export. `sizeBytes` is what §6.5 requires
   to be shown BEFORE a download starts; it is the manifest's own measured
   sum (`sizes.weightsBytes` + the tokenizer), not an estimate. */
export const DEFAULT_ENGINE = Object.freeze({
  manifestUrl: 'ai/model-export/aashish-ai-1/manifest.json',
  sizeBytes: 5_130_000,
});

/* §10: "flush at most every ~50–80 ms via one coalesced write". */
const STREAM_FLUSH_MS = 64;

/**
 * Build the chat controller. Everything it touches is injected, so the e2e
 * probe drives the real thing and unit tests could drive a fake document.
 *
 * @param {object} [opts]
 * @param {HTMLButtonElement} opts.launcher  the button that opens the panel
 * @param {object} [opts.doc] @param {object} [opts.env]
 * @param {object} [opts.hooks]  scene/scroll integration (§12)
 * @param {object} [opts.engine] §9.3 where the exported model lives,
 *        `{manifestUrl, sizeBytes}` — `DEFAULT_ENGINE` unless a caller
 *        (the probes) points somewhere else. Nothing about it is fetched
 *        until `open()` runs, which only happens after the click.
 * @param {boolean} [opts.handsFree] proactive mode: answers move the page by
 *        themselves, with nobody clicking. Off by default — a page that jumps
 *        while you are typing is hostile, and this is what the voice layer
 *        switches on once it exists.
 */
export function createChat(opts = {}) {
  const doc = opts.doc || document;
  const env = opts.env || window;
  const hooks = opts.hooks || {};
  const launcher = opts.launcher || doc.getElementById('askAI');
  const track = createLanguageTracker('en');
  let handsFree = !!opts.handsFree;

  let state = 'closed';        /* closed | loading | ready | error */
/* Whether the shell EXISTS, separately from whether it is open.
   Conflating the two was a real bug: close() set state back to 'closed', so
   every reopen after the first re-ran injectStyles() + build() and appended a
   second panel, leaving the previous one orphaned in the DOM. Measured cost
   before the split: +87 nodes and +16 listeners per open/close cycle — the
   shape of growth that ends in a browser "using too much resources" warning. */
let built = false;
/* The result of the one-time load, remembered across close() so a reopen can
   report 'ready' or 'error' truthfully instead of falling back to 'closed'. */
let loadOutcome = null;
  let kb = null;
  let tier = null;
  let caps = null;
  let body = null;             /* panel element */
  let log = null;
  let input = null;
  let focus = null;            /* §8.2 carried focus entity */
  let lastQuestion = '';
  /* What the last answer actually was, verbatim enough for the e2e probe to
     assert it: which path produced it, and the context the model read. */
  let lastAnswer = null;
  let lastAnchor = null;
  let noticeShown = false;
  let userScrolledUp = false;
  let stylesInjected = false;
  let tickerFn = null;
  let ladder = null;
/* Nesting depth of "the assistant is working". Answering is the only thing
   that raises it: not the panel being open, and not a microphone listening
   (no §6.3 rung makes recognition faster — see ai/voice/index.mjs). It counts
   rather than toggles because two overlapping generations would otherwise
   hand the scene back when the first finished (§15.3, and P5 makes that real). */
let working = 0;
  /* ── the model session (§9.3, §5) ────────────────────────────────
     `session` is the worker client, `answerer` the §5.1 pipeline around it.
     Both are null until open() has prepared them, and `modelState` is what
     the tier badge and the panel say out loud: idle | loading | ready |
     unsupported | error. `modelNotice` is the sentence for the last three,
     so a visitor reads a reason instead of watching a spinner (§10). */
  const engineOpts = { ...DEFAULT_ENGINE, ...(opts.engine || {}) };
  let session = null;
  let answerer = null;
  let modelState = 'idle';
  let modelNotice = null;
  let preparing = null;
  let unloadTimer = null;
  /* §6.2's per-tier answer budget, and §6.3 steps 1–2 acting on it. These
     are the knobs the degrade ladder turns; the model itself is unchanged. */
  let maxNewTokens = null;
  let paceMs = 0;
  let voice = null;            /* built on the first tap, never on open */
  let micBtn = null;
  let disclosureSpoken = false;
  let voiceFailure = null;      /* the reason last spoken for a stop nobody asked for */

  /* ── section: DOM ─────────────────────────────────────────────── */
  function injectStyles() {
    if (stylesInjected || doc.getElementById('aiStyles')) return;
    const el = doc.createElement('style');
    el.id = 'aiStyles';
    el.textContent = STYLES;
    doc.head.appendChild(el);
    stylesInjected = true;
  }

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;      /* text-only, always */
    return n;
  }

  function build() {
    body = el('div', 'ai');
    body.hidden = true;
    /* never a scroll target: the panel contains the answer, so it repeats the
       very words a "show me where" lookup searches for. See ai/ui/anchors.mjs */
    body.setAttribute('data-ai-ignore', '');

    const scrim = el('div', 'ai__scrim');
    scrim.addEventListener('click', close);

    const panel = el('section', 'ai__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'aiTitle');

    const head = el('header', 'ai__head');
    const title = el('div', 'ai__title', 'ASK AASHISH ');
    title.id = 'aiTitle';
    const aiWord = el('span', null, 'AI');
    title.appendChild(aiWord);
    const tierBadge = el('span', 'ai__tier', 'CHECKING…');
    /* VOICE is a button, not a mode: nothing about speech exists until it is
       pressed, and the reason it cannot be pressed is its tooltip. On a
       browser without an engine it is disabled from the first paint rather
       than failing after the visitor has spoken into a dead microphone. */
    micBtn = el('button', 'ai__mic', 'VOICE');
    micBtn.type = 'button';
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.addEventListener('click', toggleVoice);
    const closeBtn = el('button', 'ai__close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close the assistant');
    closeBtn.addEventListener('click', close);
    head.append(title, tierBadge, micBtn, closeBtn);

    log = el('div', 'ai__log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-relevant', 'additions text');
    log.setAttribute('tabindex', '0');
    log.setAttribute('data-lenis-prevent', '');        /* §12: chat scrolls, not the page */
    log.addEventListener('scroll', () => {
      userScrolledUp = log.scrollHeight - log.scrollTop - log.clientHeight > 48;
    });

    const chips = el('div', 'ai__chips');

    const form = el('form', 'ai__form');
    const label = el('label', 'ai__sr', 'Your question');
    label.setAttribute('for', 'aiInput');
    input = el('textarea', 'ai__input');
    input.id = 'aiInput';
    input.rows = 1;
    input.setAttribute('placeholder', 'Ask about projects, skills, education…');
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    });
    const send = el('button', 'ai__send', 'SEND');
    send.type = 'submit';
    form.append(label, input, send);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

    const foot = el('footer', 'ai__foot');
    foot.appendChild(el('p', 'ai__trust',
      'Runs on your device. What you type stays in your browser.'));
    const clear = el('button', 'ai__link', 'CLEAR');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      while (log.firstChild) log.removeChild(log.firstChild);
      focus = null;
      track.reset('en');
      renderChips(starterChips());
    });
    foot.appendChild(clear);

    panel.append(head, log, chips, form, foot);
    body.append(scrim, panel);
    doc.body.appendChild(body);
    return { tierBadge, chips };
  }

  /* ── section: rendering ───────────────────────────────────────── */
  function scrollToEnd() {
    if (userScrolledUp || !log) return;
    log.scrollTop = log.scrollHeight;                  /* no smooth: no motion cost */
  }

  function bubble(kind, text, meta = {}) {
    const wrap = el('div', 'ai__msg ' + (kind === 'user' ? 'is-user' : 'is-bot'));
    if (meta.badge) {
      const b = el('span', 'ai__badge ' + (meta.badgeClass || ''), meta.badge);
      wrap.appendChild(b);
    }
    wrap.appendChild(el('span', null, text));
    if (meta.sources?.length) {
      const src = el('div', 'ai__sources');
      for (const s of meta.sources) src.appendChild(el('span', 'ai__source', s));
      wrap.appendChild(src);
    }
    log.appendChild(wrap);
    scrollToEnd();
    return wrap;
  }

  /** A bubble the model writes into, one coalesced write per ~64 ms (§10:
   *  "append tokens to a single text node; flush at most every ~50–80 ms").
   *  Re-rendering the message list per token is the thing this exists to
   *  avoid, and `aria-live` is told only about the finished text. */
  function streamBubble(badge, badgeClass, sources) {
    const wrap = bubble('bot', '', { badge, badgeClass, sources });
    const span = wrap.querySelector('span:not(.ai__badge)');
    let buffer = '';
    let painted = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (painted === buffer) return;
      painted = buffer;
      if (span) span.textContent = painted;
      scrollToEnd();
    };
    return {
      push(text) {
        buffer += text;
        if (!timer) timer = env.setTimeout?.(flush, STREAM_FLUSH_MS) ?? flush();
      },
      /** Replace everything written so far — a guard failure, or the model's
       *  own abstention. Never a silent retraction: the visitor sees the
       *  final text and a badge that says where it came from. */
      set(text) {
        buffer = text;
        if (timer) { env.clearTimeout?.(timer); timer = null; }
        flush();
        return wrap;
      },
      finish(text) { return this.set(text); },
      node: wrap,
      get text() { return painted; },
    };
  }

  /* ── section: "show me where that is" (§12) ────────────────────
     The target is resolved from the answer's FACTS against the live DOM, so
     it follows the page's own content instead of a stored offset: reorder the
     projects, move them to another scene, and the same question lands on the
     same content. `anchors.mjs` is where that lives; the chat shell only
     decides *when* to move.

     It moves SILENTLY, and only in hands-free mode. Two rules, both from how
     this has to feel in use:
       · nothing is ever said about the navigation — not "moving to the
         projects section", not "I couldn't find that". A recruiter listening
         to an answer is being shown a portfolio, not a scrolling mechanism,
         and a miss is simply a question with no place on the page.
       · the typed chat stays plain. Auto-scrolling the page out from under
         somebody who is mid-sentence is hostile; it is the voice layer that
         needs the page to follow the answer. */
  function sceneFor(node) {
    let n = node;
    while (n && n !== doc.body && n !== doc.documentElement) {
      const tag = String(n.tagName || '').toUpperCase();
      if (n.getAttribute?.('data-scene') || (tag === 'SECTION' && n.id)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function flash(node) {
    if (!node?.classList?.add) return;
    node.classList.add('is-ai-focus');
    env.setTimeout?.(() => node.classList.remove('is-ai-focus'), 2400);
  }

  /** Move the page to where an answer came from. Never announces itself, and
   *  does nothing at all when the fact has no place on this page. */
  function showAnchor(anchor) {
    if (!anchor) return false;
    const scene = sceneFor(anchor.el) || anchor.el;
    /* §12 keeps the page still while the panel is open; the page is being
       asked to move instead, so the lock is released — and it stays released,
       because a visitor watching the page follow the answer should not have
       to close the panel to scroll it afterwards. */
    hooks.releaseScroll?.();
    hooks.scrollToAnchor?.(scene, anchor);
    flash(anchor.el);
    return true;
  }

  function renderChips(list) {
    const chips = body.querySelector('.ai__chips');
    while (chips.firstChild) chips.removeChild(chips.firstChild);
    for (const c of list || []) {
      const btn = el('button', 'ai__chip', c);
      btn.type = 'button';
      btn.addEventListener('click', () => ask(c));
      chips.appendChild(btn);
    }
  }

  /* the visitor's own words, in the voice the answers use (§10) */
  const starterChips = () => [
    'What projects have you built?',
    'What are your skills?',
    'What is your CGPA?',
    'How can I contact you?',
  ];

  /* ── section: answering ───────────────────────────────────────── */
  function submit() {
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    ask(text);
  }

  /**
   * §6.3 — the frame ladder is armed around the work it exists to protect, and
   * not merely around the panel being open. Leaving it running while the
   * visitor reads made it degrade the scene for no reason and, in doing so,
   * force a full shader recompile (measured: 21 programs, 1221 ms — see
   * docs/BENCHMARKS.md §15.3). Answering is the work, and it is the only thing
   * that arms this — not the panel being open, and not a microphone listening
   * (see `ai/voice/index.mjs`: no rung makes recognition faster, so arming for
   * a listen would only hold the film down). The scene comes back when this
   * returns.
   */
  function whileWorking(fn) {
    setWorking(true);
    const done = () => setWorking(false);
    let out;
    try {
      out = fn();
    } catch (err) {
      done();
      throw err;
    }
    /* A `finally` would disarm too early the day `answer()` becomes async
       (P5): `return fn()` inside try/finally runs the finally as soon as the
       promise is RETURNED, not when it settles — the ladder would go idle
       while the model was still generating, which is the one moment it exists
       for. So a thenable is disarmed when it settles. */
    if (out && typeof out.then === 'function') return out.finally(done);
    done();
    return out;
  }

  function ask(text) {
    return whileWorking(() => answer(text));
  }

  /** Everything after the text is settled: the page follows the answer when
   *  nobody is holding a mouse, the voice layer speaks the same words, and
   *  the next questions are offered. Shared by the model path and the
   *  deterministic one so an answer behaves identically either way. */
  function finish(res, lang, anchor, { badge, badgeClass } = {}) {
    if (badge) res.badge = badge;
    if (badgeClass) res.badgeClass = badgeClass;
    lastAnswer = {
      kind: res.model ? 'model'
        : res.extractive ? 'quick-extractive'
          : res.abstained ? 'quick-abstain'
            : res.injection ? 'quick-safety' : 'quick',
      badge: res.badge || null,
      text: res.text ?? null,
      sources: res.sources || [],
      /* the retrieved facts the model was allowed to read, and the guard's
         verdict — the two things that make an answer auditable */
      context: res.context ?? null,
      guard: res.guard ?? null,
      lang,
    };
    /* hands-free only: nobody is holding a mouse, so the page follows the
       answer by itself. A miss is silence — never an apology in the log. */
    if (anchor && handsFree) showAnchor(anchor);
    /* out loud, when voice mode is on and the tier allows it — the same
       words the bubble shows, never a description of the bubble */
    voice?.onAnswer(res, { lang });
    renderChips(res.followups?.length ? res.followups : starterChips());
    if (res.intent === 'injection_suspect') {
      /* the only case where the panel says something about itself */
      noticeOnce('That request stayed off the instruction path.');
    }
    return res;
  }

  /** The deterministic path (§5.1 step 4): verbatim facts, refusals and
   *  instruction-change attempts. Exact by construction — never labelled as
   *  an AI answer, because it is not one. */
  function presentQuick(res, lang, anchor) {
    const badge = res.injection ? 'SAFE REPLY'
      : res.abstained ? 'NO CLAIM MADE'
        : res.extractive ? 'QUICK ANSWER · VERBATIM FROM PORTFOLIO'
          : modelState === 'ready' ? 'QUICK ANSWER · EXACT, NOT THE MODEL'
            : 'QUICK ANSWER · NO AI MODEL ON THIS DEVICE';
    bubble('bot', res.text, {
      badge,
      badgeClass: res.abstained || res.injection ? 'is-note' : 'is-quick',
      sources: res.sources,
    });
    return finish(res, lang, anchor, { badge, badgeClass: null });
  }

  /**
   * One question, one answer.
   *
   * The routing is §5.1's, and the split is deliberate: an email address, a
   * repository URL or a refusal is produced from the knowledge base, because
   * "exact by construction" beats "the model probably gets it right" for
   * the facts that must never be wrong; everything a person would call a
   * *sentence* — explanations, comparisons, follow-ups, Hinglish phrasing —
   * is the model's own generation, with no template consulted.
   *
   * Async since P7: the model runs in a worker, tokens arrive over time, and
   * `whileWorking()` arms the §6.3 ladder around the whole of it.
   */
  async function answer(text) {
    if (!kb) return { error: 'not-ready' };

    bubble('user', text);
    lastQuestion = text;

    /* §8.3 per-message detection with turn smoothing; §8.2 carried entity */
    const { lang } = track.push(text);
    const res = quickAnswer(kb, text, { lang, focus });
    focus = res.focus || focus;

    /* where on THIS page the answer came from — resolved by content, every
       time, so an edited page resolves to the same facts */
    const anchor = resolveAnchor(doc, { kb, ids: res.sources });
    lastAnchor = anchor;

    if (res.injection || res.abstained || res.extractive || !answerer
        || answerer.status !== 'ready') {
      return presentQuick(res, lang, anchor);
    }

    const line = streamBubble(MODEL_BADGES.model, 'is-ai', null);
    let out;
    try {
      out = await answerer.ask({
        question: text, lang, focus: res.focus || null, quick: res,
        onToken: (chunk) => line.push(chunk),
        onReplace: (text_) => line.set(text_),
      });
    } catch (err) {
      /* A model that died mid-answer is not an answer. Fall back to the
         portfolio's own words and say why, once. */
      line.set(res.text);
      line.node.querySelector('.ai__badge').textContent = 'QUICK ANSWER · THE MODEL STOPPED';
      noticeOnce(`The on-device model stopped (${escape(err?.message || err)}); answers `
        + 'fall back to my portfolio data.');
      return finish({ ...res, badge: 'QUICK ANSWER · THE MODEL STOPPED' }, lang, anchor);
    }

    if (out.kind === 'abstain') {
      /* The model was not asked (retrieval below the gate) or chose
         <|abstain|>. Either way the honest sentence is the portfolio's, and
         the visitor is told which kind of answer this is. */
      line.set(res.abstained || !res.text ? out.text || res.text || '' : res.text);
      line.node.querySelector('.ai__badge').textContent = MODEL_BADGES.abstain;
      lastAnchor = resolveAnchor(doc, { kb, ids: res.sources }) || lastAnchor;
      return finish({ ...res, abstained: true, text: line.text,
        badge: MODEL_BADGES.abstain }, lang, lastAnchor);
    }

    if (out.kind === 'fallback') {
      line.set(out.text);
      line.node.querySelector('.ai__badge').textContent = MODEL_BADGES.fallback;
      const fbAnchor = resolveAnchor(doc, { kb, ids: out.sources });
      /* the model's text was rejected, so the page follows the portfolio's */
      lastAnchor = fbAnchor || lastAnchor;
      return finish({ ...res, text: out.text, sources: out.sources,
        badge: MODEL_BADGES.fallback }, lang, lastAnchor);
    }

    line.finish(out.text);
    if (out.sources?.length) {
      const src = el('div', 'ai__sources');
      for (const id of out.sources) src.appendChild(el('span', 'ai__source', id));
      line.node.appendChild(src);
    }
    /* §6.3 step 4: if the governor has already given up on the model, this
       is still the model's answer — but the panel says what got it here. */
    if (paceMs || ladder?.status?.().step >= 2) {
      noticeOnce('The scene was struggling, so answers are kept shorter for this session.');
    }
    lastAnchor = resolveAnchor(doc, { kb, ids: out.sources }) || lastAnchor;
    return finish({
      ...res, text: out.text, sources: out.sources, model: true,
      badge: MODEL_BADGES.model, context: out.context,
      guard: { attempts: out.attempts, failed: out.guardFailed },
    }, lang, lastAnchor, { badge: MODEL_BADGES.model, badgeClass: 'is-ai' });
  }

  function noticeOnce(text) {
    if (noticeShown) return;
    noticeShown = true;
    bubble('bot', text, { badge: 'NOTICE', badgeClass: 'is-note' });
  }

  /* ── section: the assistant is working ─────────────────────────
     The frame ladder is armed around the work it exists to protect and
     disarmed when that work finishes. A depth COUNT rather than a boolean,
     because the day answering is asynchronous (P5) two questions can overlap,
     and with one boolean the first to finish hands the scene back while the
     other is still generating — the one moment the ladder exists for. */
  function setWorking(on) {
    working = Math.max(0, working + (on ? 1 : -1));
    ladder?.setActive(working > 0);
    return working;
  }

  /* ── section: voice (§11) ────────────────────────────────────────
     Adapter-first: `ai/voice/index.mjs` owns every decision (which tier may
     do what, what wakes it, what gets spoken) and this shell owns only the
     button. Two rules from §12 survive into speech unchanged — the answer is
     never accompanied by a description of what the assistant is doing, and
     when nothing was asked, nothing happens at all. */
  function voiceButton() {
    if (!micBtn) return;
    const st = voice?.status();
    const info = st || (tier == null
      ? { ...recognizeSupported(env), pushToTalk: true, enabled: false, mode: null }
      : voiceSummary(tier, env));
    const on = !!info.enabled;
    micBtn.classList.toggle('is-on', on);
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.textContent = on ? (info.mode === 'continuous' ? 'LISTENING' : 'MIC ON') : 'VOICE';
    micBtn.disabled = !info.supported || !info.pushToTalk;
    micBtn.title = info.reason || 'Talk to the assistant';
  }

  /** A status change the visitor did not ask for — a dead microphone, or an
   *  engine that gave up. Turning voice off is not something to narrate, but
   *  a button silently going back to off IS, so the reason is said once. */
  function voiceChanged() {
    voiceButton();
    const st = voice?.status();
    if (st && !st.enabled && st.reason && st.reason !== voiceFailure) {
      voiceFailure = st.reason;
      bubble('bot', st.reason, { badge: 'VOICE OFF', badgeClass: 'is-note' });
    }
  }

  /** Created on demand — and creating it builds no engine, so this is safe to
   *  call before anything is ever listened to (`createRecognizer` constructs
   *  nothing until `start()`). */
  function voiceController() {
    if (!voice) {
      voice = createVoice(env, {
        tier: tier ?? 0,
        chat: api,
        onStatus: voiceChanged,
      });
    }
    return voice;
  }

  function toggleVoice() {
    if (voice?.isEnabled()) { stopVoice(); return; }
    const st = voiceController().enable();
    voiceButton();
    if (!st.enabled) {
      if (st.reason) {
        voiceFailure = st.reason;
        bubble('bot', st.reason, { badge: 'VOICE UNAVAILABLE', badgeClass: 'is-note' });
      }
      return;
    }
    voiceFailure = null;
    /* Said once, in the open, before anything is listened to: this engine
       sends audio off the device, and the panel's usual "what you type stays
       in your browser" does not stretch to cover speech. */
    if (!disclosureSpoken) {
      disclosureSpoken = true;
      bubble('bot', st.disclosure, { badge: 'VOICE ON', badgeClass: 'is-note' });
    }
  }

  function stopVoice() {
    voice?.disable();
    voiceButton();
  }

  /** §6.2: the starting tier is a starting point — "the session may move down
   *  at runtime". Voice is where that becomes visible, because the tier decides
   *  whether this device may listen continuously, push-to-talk only, not at
   *  all. Exposed so a host (and the probe) can move it deliberately rather
   *  than waiting for the governor to. */
  function setVoiceTier(next) {
    const st = voiceController().setTier(next);
    voiceButton();
    return st;
  }

  /* ── section: governor wiring ─────────────────────────────────── */
  function applyLadderStep(step) {
    if (!step) return;
    const key = LADDER[step - 1]?.key;
    if (key === 'scene') {
      /* §12 step 3: temporary low quality, restored when the device recovers */
      hooks.setSceneQuality?.('low');
    } else if (key === 'extractive') {
      hooks.setSceneQuality?.('low');
      noticeOnce('Frames were struggling, so answers stay quick for this session.');
    } else if (key === 'pace') {
      /* §6.3 step 1: yield between tokens. The arithmetic is unchanged, so
         the answer is the same one — measured in tests/engine.test.mjs — the
         main thread simply gets its frames back. */
      paceMs = 24;
    } else if (key === 'budget') {
      /* §6.3 step 2: shorter answers. Applied to the answerer, which owns
         the token budget for the session. */
      maxNewTokens = Math.max(32, Math.round((maxNewTokens || 96) / 2));
      if (answerer) answerer.setMaxNewTokens?.(maxNewTokens);
    }
  }

  function startFrameHealth() {
    if (ladder) return;                                /* idempotent: never stack */
    const gsapRef = env.gsap;
    if (!gsapRef?.ticker?.add) return;                 /* §6.3: reuse the ticker or nothing */
    ladder = createDegradeLadder({
      /* armed by whileWorking() around real work, not by the panel opening */
      active: false,
      onStep: (step) => applyLadderStep(step),
      onRestore: (step) => {
        hooks.setSceneQuality?.('normal');
        /* §6.3: "restore when idle" — the pacing and the shortened budget
           existed for the frames that were struggling, and the frames
           recovered. */
        paceMs = 0;
        maxNewTokens = tier === 1 ? 96 : tier === 3 ? 256 : 160;
        if (step < 3) noticeShown = false;
      },
    });
    tickerFn = (_time, deltaMs) => ladder.tick(deltaMs);
    gsapRef.ticker.add(tickerFn);
    /* A reopen (or a voice mode that is still listening) must not get a
       freshly-created ladder that thinks nobody is working. */
    if (working > 0) ladder.setActive(true);
  }

  function stopFrameHealth() {
    if (tickerFn && env.gsap?.ticker?.remove) env.gsap.ticker.remove(tickerFn);
    tickerFn = null;
    if (ladder) { ladder.reset(); ladder = null; }
    working = 0;
    hooks.setSceneQuality?.('normal');
  }

  /* ── section: lifecycle ───────────────────────────────────────── */
  async function loadKnowledge() {
    if (kb) return kb;
    const res = await fetch(KB_URL);
    if (!res.ok) throw new Error(`knowledge.json → HTTP ${res.status}`);
    kb = await res.json();
    return kb;
  }

  /* ── section: the model (§9.3, §5, §6.5) ────────────────────────
     Lazy by construction: `startModel()` is called from `prepareModel()`,
     which only runs from `open()`, which only runs after the visitor
     clicked. Until then this file has no worker, no shard and no tokenizer
     — §2 N6, and the network assertion in the e2e probe is what keeps it
     true. */
  const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

  function setModelState(next, notice = null) {
    modelState = next;
    modelNotice = notice;
    const badge = body?.querySelector('.ai__tier');
    if (badge && tier != null) {
      const info = tierInfo(tier);
      const suffix = next === 'ready' ? 'MODEL READY'
        : next === 'loading' ? 'PREPARING MODEL…'
          : next === 'unsupported' ? 'QUICK ANSWERS ONLY'
            : next === 'error' ? 'MODEL UNAVAILABLE · QUICK ANSWERS'
              : 'NO MODEL YET';
      badge.textContent = `T${tier} · ${suffix}`;
      badge.title = `${info.name} (${info.note}) — ${caps?.threads || '?'} threads`
        + (notice ? ` · ${notice}` : '');
    }
    return next;
  }

  /** §6.5's "always show the size before it starts". One bubble, then it
   *  becomes the progress line, then it goes away. */
  function startModel() {
    if (preparing || modelState === 'ready' || modelState === 'unsupported') return preparing;
    clearTimeout(unloadTimer);
    /* Relative to the DOCUMENT, not to this module: the deploy may live in a
       subdirectory, and a model URL resolved against `/ai/ui/` would 404 into
       a Quick-Answers-only session that nobody asked for. */
    const resolveAsset = (path) => {
      if (!path) return undefined;
      try { return new URL(path, doc.baseURI).href; } catch { return path; }
    };
    session = createModelSession({
      env, verify: true,
      manifestUrl: resolveAsset(engineOpts.manifestUrl),
      tokenizerUrl: resolveAsset(engineOpts.tokenizerUrl),
      workerUrl: engineOpts.workerUrl ? resolveAsset(engineOpts.workerUrl) : undefined,
      onProgress: ({ stage, loaded, total }) => {
        if (stage !== 'weights' || !label || !total) return;
        label.textContent = `Downloading the on-device model — `
          + `${fmtMB(loaded)} of ${fmtMB(total)} (one-time; cached afterwards).`;
      },
    });
    setModelState('loading');
    const line = bubble('bot',
      `Preparing Aashish AI — downloading the on-device model once `
      + `(${fmtMB(engineOpts.sizeBytes)}), then it stays in your browser.`,
      { badge: 'AI MODEL', badgeClass: 'is-ai' });
    const label = line.querySelector('span:not(.ai__badge)');
    /* `label` is read by the progress callback above, which is created before
       the bubble exists — hence the late binding. */
    void label;

    preparing = session.prepare()
      .then((ready) => {
        answerer = createModelAnswerer({
          kb, session, persona: 'first', maxNewTokens,
          onNotice: (text) => noticeOnce(text),
        });
        setModelState('ready');
        const kbLoaded = ready?.loaded?.bytes ?? session.loaded?.bytes ?? 0;
        if (label) {
          label.textContent = `Aashish AI is ready — ${fmtMB(kbLoaded)} of model in your `
            + 'browser, answering from my portfolio data only.';
        }
        line?.remove?.();
        renderChips(starterChips());
        return true;
      })
      .catch((err) => {
        const unsupported = session.status === 'unsupported';
        setModelState(unsupported ? 'unsupported' : 'error', err?.message);
        if (label) {
          label.textContent = unsupported
            ? 'This browser cannot run the on-device model, so I will answer from '
              + 'my portfolio data directly.'
            : `The on-device model could not start (${escape(err?.message || err)}). `
              + 'Quick Answers still work and nothing else on the site is affected.';
        }
        return false;
      });
    return preparing;
  }

  /** §6.4: unload after the panel has been closed and idle for ~2 minutes.
   *  The files stay in the cache, so a reopen is a load, not a download. */
  function unloadLater() {
    clearTimeout(unloadTimer);
    unloadTimer = env.setTimeout?.(() => {
      session?.dispose();
      session = null;
      answerer = null;
      preparing = null;
      setModelState('idle');
    }, 120_000);
  }

  async function prepareModel() {
    /* §6.1 probe + §6.2 tier, after the click only. Failures degrade the
       session, never the page. */
    const bench = await runBenchmark(env);
    caps = probeCapabilities(env, {
      benchmarkMs: bench,
      wasmSimd: env.WebAssembly ? hasSimd(env.WebAssembly) : false,
      storageBytes: await (async () => {
        try { return (await env.navigator?.storage?.estimate())?.quota ?? null; } catch { return null; }
      })(),
    });
    caps.webgpu = await probeWebGPU(env);
    tier = chooseTier(caps);
    /* §6.2's answer budget per tier. The model itself is one model: the tier
       decides how long an answer may be and how hard the device is pushed. */
    maxNewTokens = tier === 1 ? 96 : tier === 0 ? 48 : tier === 2 ? 160 : 256;

    /* 
       §6.5: the size is stated BEFORE anything is fetched, and the download
       only starts by itself on a device that is not saving data and is not
       on a slow connection. Otherwise the visitor chooses. Either way Quick
       Answers already work, so this is never a blocking decision. */
    if (tier > 0) startModel();

    const info = tierInfo(tier);
    const badge = body.querySelector('.ai__tier');
    if (badge) {
      badge.textContent = `T${tier} · ${info.label.toUpperCase()}`;
      badge.title = `${info.name} (${info.note}) — ${caps.threads || '?'} threads`
        + `${caps.memoryReported ? `, ${caps.memory} GB` : ''}`
        + `${caps.benchmarkMs ? `, bench ${Math.round(caps.benchmarkMs)} ms` : ''}`
        + `${caps.webgpu ? ', WebGPU' : ''}`;
    }
    return { caps, tier, info };
  }

  async function open() {
    /* Built once, reused forever. A reopen only has to reveal the shell. */
    if (built) { show(); return api; }

    state = 'loading';
    injectStyles();
    const { tierBadge, chips: chipRow } = build();
    built = true;
    show();
    /* before the tier is known, the button reports what the BROWSER can do;
       prepareModel() refines it with what this tier is allowed to do */
    voiceButton();

    try {
      await loadKnowledge();
      await prepareModel();
      loadOutcome = 'ready';
      state = 'ready';
      bubble('bot', modelState === 'ready'
        ? 'Ask me about my projects, skills, education, certifications or how to '
          + 'reach me. Answers are generated on your device by a model trained for this '
          + 'portfolio, reading only its verified data.'
        : 'Ask me about my projects, skills, education, certifications, or how to '
          + 'reach me. Exact facts come from my portfolio data while the on-device '
          + 'model gets ready.',
        {
          badge: modelState === 'ready' ? 'ON-DEVICE MODEL READY' : 'QUICK ANSWERS READY',
          badgeClass: modelState === 'ready' ? 'is-ai' : 'is-quick',
        });
      renderChips(starterChips());
      voiceButton();
      input?.focus();
      return api;
    } catch (err) {
      loadOutcome = 'error';
      state = 'error';
      if (tierBadge) tierBadge.textContent = 'UNAVAILABLE';
      bubble('bot', `The assistant could not start (${escape(err.message)}). `
        + 'The rest of the site is unaffected.');
      return api;
    }
  }

  function close() {
    if (state === 'closed') return;
    stopVoice();                                       /* the mic never outlives the panel */
    stopFrameHealth();
    unloadLater();                                     /* §6.4: ~2 min, then free it */
    hooks.startScroll?.();                             /* §12: Lenis start */
    hooks.resumeScene?.();
    body.classList.remove('is-open');
    body.hidden = true;
    state = 'closed';
    launcher?.setAttribute?.('aria-expanded', 'false');
    launcher?.focus?.();                               /* focus returns to the button */
  }

  function show() {
    body.hidden = false;
    /* A reopen must report the shell's real state, not the fact that it was
       closed a moment ago — `state` doubles as the toggle indicator. */
    if (state === 'closed') state = loadOutcome || 'loading';
    env.requestAnimationFrame?.(() => body.classList.add('is-open'));
    launcher?.setAttribute?.('aria-expanded', 'true');
    hooks.stopScroll?.();                              /* §12: Lenis stop */
    /* close() disarms frame health, so a reopen must re-arm it. The re-arm is
       idempotent, or repeated open/close would stack ticker callbacks. */
    startFrameHealth();
    if (hooks.pauseScene && env.matchMedia?.('(max-width: 640px)')?.matches) {
      hooks.pauseScene();                              /* panel covers the scene (§10) */
    }
    input?.focus();
  }

  function toggle() {
    if (body && !body.hidden) close(); else open();
  }

  /* ── public API (also used by dev-ai-probe.js) ────────────────── */
  const api = {
    open, close, toggle, ask, showAnchor,
    /* the voice layer flips this on; nothing else has to change */
    setHandsFree(on) { handsFree = !!on; return handsFree; },
    enableVoice: toggleVoice,
    disableVoice: stopVoice,
    setVoiceTier,
    get voice() { return voice?.status() || null; },
    get state() { return state; },
    get tier() { return tier; },
    get caps() { return caps; },
    get isOpen() { return !!body && !body.hidden; },
    get focus() { return focus; },
    get handsFree() { return handsFree; },
    /* §5/§9.3, exposed for the e2e probe: which engine state the panel is
       in, why, and what the last answer actually was (kind, model or
       template, and the context the model was allowed to read). */
    get model() {
      return {
        state: modelState,
        notice: modelNotice,
        engine: session ? { status: session.status, reason: session.reason,
                            bytes: session.loaded?.bytes ?? null,
                            maxNewTokens, paceMs } : null,
        last: lastAnswer,
      };
    },
    /* the probes need the answerer's own statistics, not a paraphrase of it */
    get answerStats() { return answerer?.stats || { asks: 0, guardFailures: 0 }; },
    /* exposed so the e2e probe can assert that LISTENING does not arm the
       frame ladder, and that an answer does */
    ladderStatus: () => (ladder ? ladder.status() : null),
    /* exposed so the e2e probe can assert which section a question resolved
       to without having to infer it from the scroll position */
    get lastAnchor() {
      if (!lastAnchor) return null;
      const target = sceneFor(lastAnchor.el) || lastAnchor.el;
      return {
        why: lastAnchor.why, kind: lastAnchor.kind, id: lastAnchor.id,
        topics: lastAnchor.topics, tag: lastAnchor.tag,
        /* the element the content lives in, and the section the page will
           actually move to — they differ, and the probe needs both */
        text: String(lastAnchor.el?.textContent || '').slice(0, 60),
        target: target?.id || null,
        targetTag: target?.tagName || null,
        label: anchorLabel(lastAnchor),
      };
    },
    /* The live element an answer pointed at, as a CALL because this snapshot
       crosses `page.evaluate`'s returnByValue boundary: a DOM node in that
       object makes the whole thing unserializable, and puppeteer hands the
       probe `undefined` instead of an error — every anchor then reads as
       "nothing found". That is not hypothetical: putting `el` in the snapshot
       above did exactly that to dev-anchor-probe.js. A probe calls this
       INSIDE the page, where the node is just a node. */
    anchorElement: () => lastAnchor?.el || null,
    onKey: (e) => { if (e.key === 'Escape' && body && !body.hidden) close(); },
  };

  return api;
}

/** Boot helper the launcher calls: wires the button, Escape, and the hook set. */
export function mount({ launcher, hooks, handsFree } = {}) {
  const chat = createChat({
    launcher: launcher || document.getElementById('askAI'),
    handsFree,
    hooks: hooks || {
      stopScroll: () => window.Director?.getLenis?.()?.stop?.(),
      startScroll: () => window.Director?.getLenis?.()?.start?.(),
      /* "show me" needs the opposite of open(): scrolling has to be live,
         and the move itself goes through the same scrollTo the chapter dots
         use, so a pinned scene moves the way the site already knows how. */
      releaseScroll: () => window.Director?.getLenis?.()?.start?.(),
      scrollToAnchor: (scene) => {
        const id = scene?.id ? `#${scene.id}` : null;
        if (id && window.Director?.scrollTo) window.Director.scrollTo(id);
        else scene?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      },
      pauseScene: () => window.Film3D?.pause?.(),
      resumeScene: () => window.Film3D?.resume?.(),
      setSceneQuality: (m) => window.Film3D?.setQuality?.(m),
    },
  });
  if (chat.state === 'closed') {
    const btn = launcher || document.getElementById('askAI');
    btn?.addEventListener('click', () => chat.toggle());
    document.addEventListener('keydown', (e) => chat.onKey(e));
  }
  window.PortfolioAI = chat;
  return chat;
}
