/* ═══════════════════════════════════════════════════════════════
   ai/ui/chat.mjs — the chat shell (§10), loaded ONLY after the click

   This is the file the launcher dynamic-imports, so nothing here exists on
   the initial page load. It carries: the panel, the §6 governor wiring, the
   on-device model session and the §8.3 language tracker.

   **100% pure AI** (owner decision, 2026-10-14): every question — safety,
   identity, small talk, lists, withheld fields, adversarial bait — is put
   to the on-device model, which answers in its own words. There is no
   data-file wording and no pre-model refusal in the answer path anymore;
   the only routed refusal is the machine's (no model on this device, or
   generation stopped by the ladder), and the guard still rejects every
   claim that does not ground in the context the model actually read. The
   visitor is told which kind of answer they got, always (§3): the badge
   says whether the words are the model's (AI ANSWER), a no (NO ANSWER),
   or a Stop (PARTIAL). Multi-turn comes free with the engine's frame:
   answered turns are fed back as `history`, so follow-ups read the
   conversation, not a fresh retrieval.

   Rendering is text-only (`textContent`, never innerHTML). Answers are whole
   messages, so `aria-live` announces them once, completed — no per-token
   announcements (§10).
   ═══════════════════════════════════════════════════════════════ */
import { DEFAULT_PERSONA, quickAnswer } from '../answers/quick.mjs';
/* The default answer path: the same deterministic, data-file-first wording the
evaluation suite has always used. It is local, instant and downloads nothing. */
import { quickAnswer as guideAnswer } from '../answers/wording.mjs';
import {
  MODEL_BADGES, createModelAnswerer, noAnswerLine, partialAnswer, routeQuestion,
} from '../answers/model.mjs';
import { createModelSession } from '../engine/session.mjs';
import { resolveAnchor, anchorLabel, resolveTopicAnchor } from './anchors.mjs';
import { createLanguageTracker } from '../language/detect.mjs';
import { recognizeSupported, voiceSummary } from '../voice/caps.mjs';
import {
  probeCapabilities, chooseTier, probeWebGPU, tierInfo,
  createDegradeLadder, createSessionBudget, hasSimd,
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

/* Model-internal tokens (`<|fact:edu.lpu|>`, `<|end|>`, a HALF-emitted one) are
   training internals, never words on screen: a finished answer never carries
   one (the placeholder resolver and the guard see to it), but a streamed
   bubble paints BEFORE the guard has spoken — and a checkpoint's first
   attempt can emit one it never read, which is what the PII probe then
   flashed at a visitor between "i study at" and the refusal that replaces
   it. The paint strips complete tokens AND a trailing half-token, so a
   placeholder split across two 64 ms flushes never shows either half. The
   guard still audits the FULL text; this is a display rule only. */
const stripModelTokens = (s) => String(s)
  .replace(/<\|[^|>]*\|>/g, '')
  .replace(/<\|[^|>]*$/, '');

/* ── the model this build ships (§9.3) ───────────────────────────
   Relative to the document so a deploy in a subdirectory works, and one
   place to point at a different export. `sizeBytes` is what §6.5 requires
   to be shown BEFORE a download starts; it is the manifest's own measured
   sum (`sizes.weightsBytes` + the tokenizer), not an estimate. */
export const DEFAULT_ENGINE = Object.freeze({
  manifestUrl: 'ai/model-export/aashish-ai-b/manifest.json',
  sizeBytes: 51_113_004,
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
/* ── §11.5's voice visual, as a pure decision ─────────────────────
   One attribute, and CSS does the rest: no canvas, no WebGL, no new frame
   loop (§2 N8), and nothing that runs while the tab is hidden. It is a pure
   function because the ORDER is the part that can be wrong — a session can
   be listening and speaking and hidden at once, and the state that wins has
   to be the one the visitor most needs to know about. */
export function voiceVisualState(info) {
  if (!info?.enabled) return 'off';
  if (info.suspended) return 'suspended';   /* §11.1: hidden tab, not listening */
  if (info.standby) return 'standby';       /* §11.1 (e): released until spoken to */
  if (info.speaking) return 'speaking';
  if (info.listening) return 'listening';
  return 'armed';
}

/** §11.1 asks each voice state to be announced, not only shown: the visible
 *  label is terse (a 30px button cannot hold a sentence), so the accessible
 *  name says the state in words. */
export const VOICE_STATE_WORDS = Object.freeze({
  off: 'Voice mode is off',
  armed: 'Voice mode is on, waiting for you to speak',
  listening: 'Voice mode is listening',
  speaking: 'Voice mode is reading the answer aloud',
  suspended: 'Voice mode is paused while this tab is hidden',
  standby: 'Voice mode is on, microphone released until you speak',
});

/* ── §2 N4's disclosure, as data ─────────────────────────────────
   The brief asks the UI itself to say which parts of this assistant are ours
   and which belong to the browser, so the text is a constant here rather than
   a string buried inside the DOM builder — the same reason
   `VOICE_STATE_WORDS` is one. A claim in a constant can be tested without a
   browser, and `tests/voice.test.mjs` does exactly that.

   Nothing in it is a claim about Aashish, so it never goes near the
   Faithfulness Guard; and like every other string in this file it is rendered
   as text, never as markup. */
export const ABOUT_TITLE = 'What this assistant is';

export const ABOUT_SECTIONS = Object.freeze([
  { term: 'Your questions',
    detail: 'Never leave this device. There is no server behind this panel and '
      + 'no analytics watching it.' },
  { term: 'The model',
    detail: 'Optional. Written and trained from scratch for this portfolio: our '
      + 'own tokenizer, architecture, training loop and instruction tuning. No '
      + 'pretrained language model is used anywhere in it.' },
  { term: 'Where answers come from',
    detail: 'By default, a data file read on this device: answers are worded '
      + 'straight from the verified portfolio data, so updating that file '
      + 'updates the answers without retraining anything. The on-device model '
      + 'is a second, optional mode; every message is labelled with which path '
      + 'produced it.' },
  { term: 'Voice input',
    detail: 'Your browser\u2019s own speech recognition, not ours. It is asked to '
      + 'run on this device, and when the browser says it cannot, what you say '
      + 'goes to the browser\u2019s speech service instead \u2014 the panel tells you '
      + 'which of the two you are in, in words, every time voice turns on.' },
  { term: 'Answers spoken aloud',
    detail: 'Your browser\u2019s own voice. Nothing is sent anywhere, and no '
      + 'recording is stored.' },
  { term: 'What gets downloaded',
    detail: 'Nothing, unless you press AI MODEL. That button downloads the '
      + '51.1 MB on-device model once from this site\u2019s own path, then it '
      + 'stays in your browser. The portfolio guide never downloads the model.' },
]);

/* ── §0 rule 4: MODEL_STATUS ────────────────────────────────────
   "Until real checkpoints exist, ship in MODEL_STATUS=untrained mode …
   Never present smoke-test output as a trained model."

   The literal half of that rule — an env var that leaves the deterministic
   answers answering — is NOT what this build does, because the owner retired
   those as answers (§3), so an "off" mode would ship a panel that answers
   nothing at all. What the rule exists to prevent is the other half, and that
   half this build must not fudge: the 4.98M checkpoint this project shipped
   until 2026-10-30 trained for 1,100 steps on ~3 MB of corpus and answered
   *badly* (docs/FINAL_REPORT.md, limitation 1). It is a pipeline artifact, and a panel that calls it "a
   model trained from scratch for this portfolio" — true about provenance,
   silent about quality — is exactly the presentation the rule forbids.

   So the status is a named constant the UI has to disclose, and the coupling
   is a TEST rather than a promise: `tests/disclosure.test.mjs` reads
   `docs/EVALUATION.json`, and while the §14 gates say `passed: false` this
   constant cannot be flipped to 'trained' without that test failing. A better
   checkpoint therefore cannot make this disclosure lie by being forgotten. */

/* MEASURED 2026-11-15 (docs/EVALUATION.json, the shipping export
   `aashish-ai-b` — Stage B run `stage-b`, latest @ step 3000, the 66 §14
   prompts at 1024/256, decoded with **no grammar**: the model writes its own
   answers — `MODEL_OWNS_ANSWERS` in `ai/answers/model.mjs` — and the closed
   answer space is retired from the product). Portfolio QA accuracy
   **97.1 % (33/34)**, abstention recall **100 %**, false abstention **2.4 %**,
   unsupported post-guard **0.0 %**, **no** fabricated fact on the adversarial
   set, EN **100 %**, HI/Hinglish **100 %**, identity disclosure **100 %**.
   **All eight §14 gates pass**, so the measured word is `'trained'`.

   The test below keeps that a measurement rather than a memory: the same free
   decode that produced these numbers produced `docs/EVALUATION.json`, and
   flipping this constant back to `'untrained'` while that file says
   `passed: true` fails the suite just as the old mismatch did.

   The one remaining factual miss is `syn04`, a synthetic email address the
   model correctly refuses to invent. It is inside the 95 % allowance; the
   gates, not a perfect score, are what this build claims. */
export const MODEL_STATUS = 'trained';

/* ── the two answer modes, as constants ──────────────────────────
   `guide` is the default and the only path that runs on open. `model` is an
explicit opt-in: the button that enables it is the only thing that may start
the 51.1 MB download. Keeping the names here means the shell, the tests and a
probe cannot drift on what "default" means. */
export const ANSWER_MODES = Object.freeze({ GUIDE: 'guide', MODEL: 'model' });
export const ANSWER_MODE_LABELS = Object.freeze({
  [ANSWER_MODES.GUIDE]: 'PORTFOLIO GUIDE',
  [ANSWER_MODES.MODEL]: 'AI MODEL',
});
export const GUIDE_BADGE = ANSWER_MODE_LABELS[ANSWER_MODES.GUIDE];
export const MODEL_OPT_IN_LABEL = ANSWER_MODE_LABELS[ANSWER_MODES.MODEL];

export const MODEL_STATUS_TEXT = Object.freeze({
  untrained: 'What runs here is a model trained from scratch for this portfolio '
    + '\u2014 and not a model trained for quality: it writes its own answers, '
    + 'unconstrained, and an evaluation that has not cleared the project\u2019s '
    + 'own \u00a714 gates is a reason to keep that limit visible, not to hide it.',
  trained: 'What runs here is a 49.6M-parameter model trained from scratch for '
    + 'this portfolio, and it cleared the project\u2019s own \u00a714 evaluation '
    + 'gates \u2014 33 of 34 answerable questions (97.1 %), published with the '
    + 'evidence. It is not a general-purpose model: the claim is only as good '
    + 'as that file.'
});

/** The sentence the About card shows for a status. Unknown values fall back
 *  to the cautious one: a typo must not be able to remove the disclosure. */
export function modelStatusText(status = MODEL_STATUS) {
  return MODEL_STATUS_TEXT[status] || MODEL_STATUS_TEXT.untrained;
}

/* ── §11.1 (c): the guided tour ─────────────────────────────────
   "optional guided tour — walks About → Projects → Skills → Contact, scrolling
   via Lenis to allowlisted anchors (jump instead of smooth scroll under
   reduced-motion), pausing for questions".

   Four stops, in the order the brief names, each resolved from the markup's
   own `data-ai-topics` declaration — the same allowlist "show me where that
   is" stands on. So the tour needs no model call, no knowledge base and no
   question, it survives the page being reordered, and a stop whose topic no
   section declares is SKIPPED rather than walked to nowhere. The lines are
   fixed strings: nothing here can invent a place or a claim. */
export const TOUR_STOPS = Object.freeze([
  /* Written in the ASSISTANT's voice: first person about itself, third person
     about Aashish — the greeting's voice, the refusal strings' voice, and §5's
     explicit rule ("it speaks about Aashish in the third person and never
     pretends to be him"). They were first-person-about-Aashish when this list
     was written, in line with the answer templates' first-person persona, and
     the two fixed strings then disagreed with each other inside one session.
     The answer templates are the documented deviation; the assistant's own
     copy should not be. */
  { topic: 'about',
    line: 'Starting with the short version \u2014 who he is, his education, and what he has built.' },
  { topic: 'projects',
    line: 'These are his projects, each with what it does and what it was built with.' },
  { topic: 'skills',
    line: 'This is the stack he works in and the tools he uses day to day.' },
  { topic: 'contact',
    line: 'And this is how to reach him. Ask me anything as we go.' },
]);

/** How long each stop is held before the page moves on. Long enough to read a
 *  section heading and hear one sentence, short enough that a visitor who is
 *  not interested is not held hostage by it. */
export const TOUR_STEP_MS = 7000;

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
  /* Default to the deterministic guide. The model is a separate, explicitly
     chosen mode; nothing about it is fetched until its own button is pressed. */
  let answerMode = ANSWER_MODES.GUIDE;
  let modelRequested = false;
  const modeButtons = { guide: null, model: null };
  const modeNotes = { guide: null, model: null };
  let kb = null;
  let tier = null;
  let caps = null;
  let body = null;             /* panel element */
  let log = null;
  let input = null;
  let focus = null;            /* §8.2 carried focus entity */
  let lastQuestion = '';
  /* The conversation the MODEL sees, oldest first — `[question, answer]`
     pairs of turns whose answer actually grounded, capped and re-trimmed
     by `fitToBudget` (§10's 3–4 turns). A refusal is NOT a turn worth
     remembering: nothing about it can make the next question better. */
  let turnHistory = [];
  /* §10's Stop. One in-flight generation at a time is the only thing this
     panel offers — the composer is not disabled while answering, but a second
     question replaces the first, so keeping the newest controller is exactly
     right and keeping a list would be keeping a bug. */
  let activeAbort = null;
  /* The turn the panel is on, chained. A new question replaces the one the
     panel was on (§10's rule) — but it replaces it in TIME, never alongside
     it: the model session and the answerer's per-turn state cannot carry two
     turns at once, and the probe proved that racing them ends the retried
     turn with a context that emptied itself mid-answer. */
  let activeRun = Promise.resolve();
  let stopBtn = null;
  let retryBtn = null;
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
  /* §6.2's per-tier budget and §6.3's two session knobs live in the governor
     (`createSessionBudget`), where the tests can run every rung: this shell
     needs a DOM, which is why rungs 1 and 2 were silent no-ops for a phase. */
  const budget = createSessionBudget({
    getAnswerer: () => answerer,
    setSceneQuality: (m) => hooks.setSceneQuality?.(m),
    onStop: () => noticeOnce('The frames were struggling, so I have stopped '
      + 'generating answers for this session.'),
    /* A rung below 3 raised no notice, so the once-per-session flag goes
       back and the next session can still say what happened to it. */
    onRestore: (step) => { if (step < 3) noticeShown = false; },
  });
  let voice = null;            /* built on the first tap, never on open */
  let micBtn = null;
  let micLabel = null;         /* the button's text; the orb is a sibling */
  let orb = null;
  let disclosureSpoken = false;
  /* A disclosure waiting on the on-device question (§19) — see voiceChanged. */
  let disclosurePending = false;
  let voiceFailure = null;      /* the reason last spoken for a stop nobody asked for */
  /* §11.1 (c)'s tour. `tourIndex` is -1 when nothing is running, so "is a tour
     running" and "which stop" are one piece of state rather than two that can
     disagree. */
  let tourIndex = -1;
  let tourTimer = null;
  let aboutBtn = null;          /* §2 N4's disclosure control, in the footer */
  let aboutCard = null;
  let aboutClose = null;
  let aboutOpen = false;        /* the topmost layer while it is open */

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
    const tierBadge = el('span', 'ai__tier', 'GUIDED');
    /* VOICE is a button, not a mode: nothing about speech exists until it is
       pressed, and the reason it cannot be pressed is its tooltip. On a
       browser without an engine it is disabled from the first paint rather
       than failing after the visitor has spoken into a dead microphone. */
    micBtn = el('button', 'ai__mic');
    micBtn.type = 'button';
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.dataset.voice = 'off';          /* §11.5: nothing to look at yet */
    micBtn.setAttribute('aria-label', 'Voice mode is off');
    /* §11.5's visual, inside the button so it cannot say something the button
       does not: a span, not the button's own text, because the label is
       rewritten on every state change and a text node would be wiped. */
    orb = el('span', 'ai__orb');
    orb.setAttribute('aria-hidden', 'true');
    micLabel = el('span', 'ai__mic-label', 'VOICE');
    micBtn.append(orb, micLabel);
    micBtn.addEventListener('click', toggleVoice);
    const closeBtn = el('button', 'ai__close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close the assistant');
    closeBtn.addEventListener('click', close);
    head.append(title, tierBadge, micBtn, closeBtn);

    /* The answer-mode switch. It is deliberately visible before the first
       question, and AI MODEL carries the size on its face: a visitor cannot
       accidentally trigger a 51.1 MB download without pressing the control
       that names it. PORTFOLIO GUIDE is the default and costs no download. */
    const modes = el('div', 'ai__modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Answer mode');
    modeButtons.guide = el('button', 'ai__mode is-on');
    modeButtons.guide.type = 'button';
    modeButtons.guide.dataset.mode = ANSWER_MODES.GUIDE;
    modeButtons.guide.setAttribute('aria-pressed', 'true');
    modeButtons.guide.append(
      el('span', 'ai__mode-name', ANSWER_MODE_LABELS[ANSWER_MODES.GUIDE]),
      modeNotes.guide = el('span', 'ai__mode-note', 'Instant · from the verified data file'),
    );
    modeButtons.guide.addEventListener('click', () => chooseMode(ANSWER_MODES.GUIDE));
    modeButtons.model = el('button', 'ai__mode');
    modeButtons.model.type = 'button';
    modeButtons.model.dataset.mode = ANSWER_MODES.MODEL;
    modeButtons.model.setAttribute('aria-pressed', 'false');
    modeButtons.model.setAttribute('aria-label',
      `AI model — ${fmtMB(engineOpts.sizeBytes)}, downloaded only when you press this button`);
    modeButtons.model.append(
      el('span', 'ai__mode-name', MODEL_OPT_IN_LABEL),
      modeNotes.model = el('span', 'ai__mode-note', `${fmtMB(engineOpts.sizeBytes)} · one-time download`),
    );
    modeButtons.model.addEventListener('click', () => chooseMode(ANSWER_MODES.MODEL));
    modes.append(modeButtons.guide, modeButtons.model);

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
    const trust = el('p', 'ai__trust',
      'Runs on your device. What you type stays in your browser.');
    foot.appendChild(trust);
    /* §2 N4: a control rather than another line of small print. A paragraph
       of caveats in a footer is read as decoration; a button is opened on
       purpose, and the text behind it can be as long as it needs to be. */
    aboutBtn = el('button', 'ai__about', 'ABOUT');
    aboutBtn.type = 'button';
    aboutBtn.setAttribute('aria-label',
      'About this assistant: what runs on this device and what your browser provides');
    aboutBtn.setAttribute('aria-expanded', 'false');
    aboutBtn.setAttribute('aria-controls', 'aiAbout');
    aboutBtn.addEventListener('click', () => setAbout(!aboutOpen));
    foot.appendChild(aboutBtn);

    /* §10's message controls: **Stop**, **Retry**, **Clear**. Each one is a
       real `<button>` and none of them narrates itself. They live together so
       that "which of these is available right now" is one decision
       (`syncControls`) instead of three buttons independently guessing. */
    const controls = el('div', 'ai__controls');

    stopBtn = el('button', 'ai__link', 'STOP');
    stopBtn.type = 'button';
    stopBtn.hidden = true;
    stopBtn.setAttribute('aria-label', 'Stop answering');
    stopBtn.addEventListener('click', () => stop());

    retryBtn = el('button', 'ai__link', 'RETRY');
    retryBtn.type = 'button';
    retryBtn.hidden = true;
    retryBtn.setAttribute('aria-label', 'Ask the last question again');
    retryBtn.addEventListener('click', () => retry());

    const clear = el('button', 'ai__link', 'CLEAR');
    clear.type = 'button';
    clear.setAttribute('aria-label', 'Clear this conversation');
    clear.addEventListener('click', () => {
      while (log.firstChild) log.removeChild(log.firstChild);
      focus = null;
      track.reset('en');
      renderChips(starterChips());
      syncControls();
    });

    controls.append(stopBtn, retryBtn, clear);
    foot.appendChild(controls);
    syncControls();

    aboutCard = buildAboutCard();
    panel.append(head, modes, log, chips, form, foot, aboutCard);
    body.append(scrim, panel);
    doc.body.appendChild(body);
    updateModeUi();
    return { tierBadge, chips, modes };
  }

  /* ── section: rendering ───────────────────────────────────────── */
  function buildAboutCard() {
    const card = el('section', 'ai__about-card');
    card.id = 'aiAbout';
    card.hidden = true;
    card.setAttribute('role', 'region');
    card.setAttribute('aria-labelledby', 'aiAboutTitle');
    const title = el('h2', 'ai__about-title', ABOUT_TITLE);
    title.id = 'aiAboutTitle';
    const list = el('dl', 'ai__about-list');
    for (const section of ABOUT_SECTIONS) {
      list.appendChild(el('dt', null, section.term));
      list.appendChild(el('dd', null, section.detail));
    }
    /* §0 rule 4: the honest status of the checkpoint shipping today, stated
       where the rest of the disclosure is, and derived from MODEL_STATUS so
       there is one place to change when a real checkpoint lands. */
    const status = el('p', 'ai__about-note', modelStatusText());
    aboutClose = el('button', 'ai__link', 'CLOSE');
    aboutClose.type = 'button';
    aboutClose.setAttribute('aria-label', 'Close this explanation');
    aboutClose.addEventListener('click', () => setAbout(false));
    card.append(title, list, status, aboutClose);
    return card;
  }

  /** Pin the log to its newest line. `force` is for a NEW message arriving
   *  (a turn started or finished, a notice) — the visitor asked for the chat
   *  to always show the latest, and a sticky-bottom rule that never un-sticks
   *  itself means one scroll-up during a long model wait silently disables
   *  autoscroll for the rest of the session, which is exactly the bug this
   *  replaces. Mid-stream updates KEEP the respect: you must be allowed to
   *  read back while the answer is still being written. */
  function scrollToEnd(force = false) {
    if (!log) return;
    if (!force && userScrolledUp) return;
    userScrolledUp = false;
    log.scrollTop = log.scrollHeight;                  /* no smooth: no motion cost */
  }

  function bubble(kind, text, meta = {}) {
    const wrap = el('div', 'ai__msg ' + (kind === 'user' ? 'is-user' : 'is-bot'));
    if (meta.badge) {
      const b = el('span', 'ai__badge ' + (meta.badgeClass || ''), meta.badge);
      wrap.appendChild(b);
    }
    wrap.appendChild(el('span', null, text));
    if (meta.edit) {
      /* §11.2's "show the transcript in the UI with tap-to-edit/resend". A
         voice question is shown as the recognizer HEARD it — that is the
         honest thing to display, and it is also the only way a visitor can
         see that a wrong answer started with a wrong question. One tap puts
         the words back in the box to be corrected and sent again; without
         it, the only fix for a misheard word is to type the whole question. */
      const edit = el('button', 'ai__edit', 'EDIT');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Edit what was heard and send it again: "${text}"`);
      edit.addEventListener('click', () => {
        if (!input) return;
        input.value = text;
        /* The box grows with its content, and that is done by a real `input`
           listener — so one is dispatched. It has to be an Event: a plain
           `{type:'input'}` looks harmless and throws in a real browser
           ("parameter 1 is not of type 'Event'"), which is how the e2e probe
           found this rather than a visitor. The height is cosmetic, so a
           browser without the constructor still gets the edit. */
        try {
          const Ev = env.Event || (typeof Event === 'function' ? Event : null);
          if (Ev) input.dispatchEvent(new Ev('input', { bubbles: true }));
        } catch { /* the words are in the box either way */ }
        input.focus();
      });
      wrap.appendChild(edit);
    }
    if (meta.sources?.length) {
      const src = el('div', 'ai__sources');
      for (const s of meta.sources) src.appendChild(el('span', 'ai__source', s));
      wrap.appendChild(src);
    }
    log.appendChild(wrap);
    /* A new message always re-sticks the log — see scrollToEnd(). */
    scrollToEnd(true);
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
      if (span) span.textContent = stripModelTokens(painted);
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
  function showAnchor(anchor, { jump = false } = {}) {
    if (!anchor) return false;
    const scene = sceneFor(anchor.el) || anchor.el;
    /* §12 keeps the page still while the panel is open; the page is being
       asked to move instead, so the lock is released — and it stays released,
       because a visitor watching the page follow the answer should not have
       to close the panel to scroll it afterwards. */
    hooks.releaseScroll?.();
    hooks.scrollToAnchor?.(scene, anchor, { jump });
    flash(anchor.el);
    return true;
  }

  /* ── §11.1 (c): the tour's machinery ──────────────────────────── */

  const reducedMotion = () => env.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

  function cancelTourTimer() {
    if (tourTimer === null) return;
    env.clearTimeout?.(tourTimer);
    tourTimer = null;
  }

  /** Stop the walk. `announce` is for a stop the visitor asked for; a silent
   *  stop is for the ones they did not (a question, the panel closing). */
  function stopTour({ announce = false } = {}) {
    if (tourIndex < 0) return false;
    cancelTourTimer();
    tourIndex = -1;
    if (announce) bubble('bot', 'Tour stopped \u2014 ask me anything, or take it again from the chip.',
      { badge: 'TOUR', badgeClass: 'is-note' });
    return true;
  }

  /**
   * One stop, then the next. Returns whether the page moved.
   *
   * A stop the markup does not declare is skipped IN SILENCE rather than
   * walked to the top of the page, which is what a move with no target would
   * look like from the visitor's side.
   */
  function tourStep() {
    cancelTourTimer();
    if (tourIndex < 0) return false;
    while (tourIndex >= 0 && tourIndex < TOUR_STOPS.length) {
      const stop = TOUR_STOPS[tourIndex];
      tourIndex += 1;
      const anchor = resolveTopicAnchor(doc, stop.topic);
      if (!anchor) continue;                    /* not on this page: skip it */
      /* §11.1 (c): jump instead of smooth-scrolling when the visitor asked for
         less motion — a 1.6 s glide across the page is exactly the animation
         that request is about. */
      showAnchor(anchor, { jump: reducedMotion() });
      bubble('bot', stop.line, { badge: `TOUR \u00b7 ${stop.topic.toUpperCase()}`, badgeClass: 'is-note' });
      /* The shell reads its own lines aloud through the voice layer's one
         speaker, and only while a voice session is on — a typed visitor gets
         the text, not a talking panel. */
      voice?.speak?.(stop.line);
      if (env.setTimeout) tourTimer = env.setTimeout(tourStep, TOUR_STEP_MS);
      return true;
    }
    /* every remaining stop was missing a section: end it honestly, with no
       claim that the visitor has seen anything they have not */
    tourIndex = -1;
    bubble('bot', 'That is the tour. Ask me anything about what you saw.',
      { badge: 'TOUR', badgeClass: 'is-note' });
    return false;
  }

  function startTour() {
    if (tourIndex >= 0) return false;            /* already walking */
    if (body?.hidden) return false;
    tourIndex = 0;
    return tourStep();
  }

  /** §11.1 (c)'s offer: one chip, added when Proactive turns on. It is a
   *  chip rather than an automatic walk because the brief calls the tour
   *  *optional*, and a page that starts scrolling itself is not an offer. */
  function offerTour() {
    const chips = body?.querySelector('.ai__chips');
    if (!chips || chips.querySelector('.ai__chip--tour')) return false;
    const btn = el('button', 'ai__chip ai__chip--tour', 'Take the tour');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Take a guided tour of the portfolio, section by section');
    btn.addEventListener('click', () => {
      if (tourIndex >= 0) stopTour({ announce: true }); else startTour();
    });
    chips.appendChild(btn);
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

  function ask(text, opts) {
    /* §11.1 (c): "pausing for questions" — a question ends the walk instead of
       racing it. The offer chip stays where it was, so taking it up again is
       one tap and not a lost feature. */
    stopTour();
    /* Wait at most ONE turn behind: the longest wait is one answer. A missed
       settlement (the browser dropped it) unblocks the chain instead of
       queueing every following question behind a turn that will never settle. */
    const turn = activeRun.catch(() => {})
      .then(() => whileWorking(() => answer(text, opts)));
    activeRun = turn;
    return turn;
  }

  /** Everything after the text is settled: the page follows the answer when
   *  nobody is holding a mouse, the voice layer speaks the same words, and
   *  the next questions are offered. Shared by the model path and the
   *  deterministic one so an answer behaves identically either way. */
  function finish(res, lang, anchor, { badge, badgeClass } = {}) {
    if (badge) res.badge = badge;
    if (badgeClass) res.badgeClass = badgeClass;
    lastAnswer = {
      /* Which path produced this, so the probe can assert it rather than infer
         it from the words: 'model' is the only kind that IS an answer by the
         model. The rest are refusals, and each says which refusal it is. */
      kind: res.kind || (res.model ? 'model' : 'unknown'),
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
    syncControls();
    if (res.intent === 'injection_suspect') {
      /* the only case where the panel says something about itself */
      noticeOnce('That request stayed off the instruction path.');
    }
    return res;
  }

  /** Swap the badge on a bubble that is already on screen — a streamed answer
   *  the guard then rejected, a model that stopped mid-sentence, or one the
   *  visitor stopped. */
  function setBadge(line, text) {
    const node = line?.node?.querySelector?.('.ai__badge');
    if (node) node.textContent = text;
  }

  /** §10's Stop, as a rendered state. What is on screen is the model's own
   *  words, so it is KEPT — but the two things that normally happen to a
   *  stream never will: the guard does not run (it runs when generation ends,
   *  which is the whole reason it can check the finished text) and neither
   *  does the placeholder resolver. So this resolves the placeholders itself,
   *  drops the incomplete one at the cut, and badges the result as PARTIAL.
   *  An unfinished, unverified sentence must not wear the badge a verified one
   *  wears, and it must not be presented as a refusal either.
   *
   *  Stopped before the first token: there is no partial to keep, and the
   *  `cancelled` line says that — rather than "the model stopped", which would
   *  blame the machine for a click. */
  function presentPartial(line, lang, res = {}) {
    const text = partialAnswer(kb, line.text, lang);
    line.set(text);
    setBadge(line, MODEL_BADGES.partial);
    return finish({ text, sources: [], abstained: true, kind: 'stopped',
      badge: MODEL_BADGES.partial, context: null,
      focus: res.focus || focus, followups: res.followups },
      lang, null, { badge: MODEL_BADGES.partial, badgeClass: 'is-note' });
  }

  /** Which of §10's controls exist right now, decided in ONE place. Stop is
   *  there while a generation is; Retry is there when the last turn did not
   *  answer the question — a good answer does not need repeating, and a
   *  control that is usually useless teaches people to ignore the row. */
  function syncControls() {
    if (stopBtn) stopBtn.hidden = !activeAbort;
    if (retryBtn) {
      /* Retry is for ANOTHER read of the same question (the model is greedy
         and deterministic, so a good answer has nothing to re-roll); a
         refusal is worth re-trying, because the model or the device may
         have moved. The guide is deterministic too: another read of the same
         data cannot change its answer. */
      retryBtn.hidden = !lastQuestion || !!activeAbort
        || lastAnswer?.kind === 'model' || lastAnswer?.kind === 'guided';
    }
  }

  /** §10's Stop. Aborting rejects the in-flight `generate`, so `answer()`'s
   *  catch sees `signal.aborted` and renders the partial. The session itself
   *  stays 'ready' — a Stop must not cost the visitor the model. */
  function stop() {
    if (!activeAbort) return false;
    activeAbort.abort();
    return true;
  }

  /** §10's Retry: the last question, asked again. Nothing is cached, so this
   *  is a fresh generation — which is the point of it after a refusal. */
  function retry() {
    if (activeAbort || !lastQuestion) return false;
    ask(lastQuestion);
    return true;
  }

  /** A refusal, rendered as itself — never dressed up as an answer. `text` is
   *  one of the fixed, localized sentences that claim nothing about Aashish,
   *  and the badge names which refusal it is (§15.5). `base` carries only what
   *  the turn still needs — the §8.2 focus and the follow-up chips — because
   *  the panel made no claim and must not offer a source for one, nor move the
   *  page to where a claim it did not make came from. */
  function presentRefusal(base, text, badge, lang, { kind = 'no-answer', abstained = true } = {}) {
    bubble('bot', text, { badge, badgeClass: 'is-note' });
    /* `abstained` is what the voice layer reads to decide whether the turn is
       over, so a disclosure — which is not a refusal — keeps the conversation
       open while still claiming no portfolio fact. */
    return finish({ ...(base || {}), text, badge, abstained, kind, sources: [] },
      lang, null, { badge });
  }

  /**
   * One question, one answer — and exactly one answer path: the model.
   *
   * `quickAnswer()` still runs, but it is **not an answer source**. What is
   * used is everything else it knows: the intent (which fact ids a topic
   * owns, so the model READS them), the §8.2 focus entity, the fact ids
   * §12 resolves to a place on the page, the private/injection verdicts
   * (signals into the guard, not refusals), and the follow-up chips.
   *
   * 100% pure AI (owner decision, 2026-10-14): NO question refuses on the
   * panel's own authority anymore. Injection attempts, "are you Aashish?",
   * invented-employer bait, withheld fields, off-portfolio small talk —
   * all go to the model, whose trained refusal and `<|abstain|>` behavior
   * speaks the no in its own words, and whose claims still pass the guard
   * (§8.4 layer 4) or the turn does not ship. The one short-circuit that
   * remains is the machine's: no model, or generation stopped.
   *
   * Async since P7: the model runs in a worker, tokens arrive over time, and
   * `whileWorking()` arms the §6.3 ladder around the whole of it.
   */
  async function answer(text, opts = {}) {
    if (!kb) return { error: 'not-ready' };

    /* `source` is how a question arrived, and it is only ever used to label
       what the visitor is looking at: a recognised question is shown as
       heard, with §11.2's EDIT control on it. Nothing about the answer path
       changes, which is the point — speech and typing share one pipeline. */
    const fromVoice = opts.source === 'voice';
    bubble('user', text, fromVoice ? { badge: 'HEARD', badgeClass: 'is-note', edit: true } : {});
    lastQuestion = text;

    /* §8.3 per-message detection with turn smoothing; §8.2 carried entity */
    const { lang } = track.push(text);
    const useGuide = answerMode === ANSWER_MODES.GUIDE;
    /* The default is the deterministic, data-file-first wording engine. It
       reads only the public knowledge view and never creates a worker. The
       trained model is reached only when the visitor has selected it. */
    const res = useGuide
      ? guideAnswer(kb, text, { lang, focus })
      : quickAnswer(kb, text, { lang, focus });
    focus = res.focus || focus;

    /* where on THIS page the facts came from — resolved by content, every
       time, so an edited page resolves to the same facts */
    const anchor = resolveAnchor(doc, { kb, ids: res.sources });
    lastAnchor = anchor;

    if (useGuide) {
      const answerText = res.text || noAnswerLine('notFound', lang);
      bubble('bot', answerText, { badge: GUIDE_BADGE, badgeClass: 'is-note' });
      return finish({
        ...res, text: answerText, sources: res.sources || [],
        kind: 'guided', badge: GUIDE_BADGE, context: null,
      }, lang, anchor, { badge: GUIDE_BADGE, badgeClass: 'is-note' });
    }

    /* §5.1's routing, as ONE decision that can be tested without a DOM
       (`routeQuestion` in ai/answers/model.mjs). 100% pure AI (owner
       decision, 2026-10-14): the shell refuses NO question on its own
       authority anymore — the model answers injection attempts (§9),
       "are you Aashish?", invented-employer bait (§14), withheld fields,
       and off-portfolio small talk, with its own trained refusal and
       `<|abstain|>` behavior. The one short-circuit left is the machine's. */
    const route = routeQuestion({
      res, lang, generationStopped: budget.stopped, modelState,
      hasModel: !!answerer && answerer.status === 'ready',
    });
    if (route.path === 'no-model') {
      return presentRefusal(res, route.noAnswer, MODEL_BADGES.noModel, lang,
        { kind: route.kind });
    }

    /* Small talk and the identity question are answered, not asked
       (`routeQuestion`'s `fixed` path, and the measurements behind it).
       Nothing is generated, nothing is grounded and nothing is claimed:
       small talk is the assistant's own greeting, and the identity turn is
       the disclosure sentence — "I'm Aashish's AI Portfolio Assistant, not
       Aashish himself" — which is a statement about the assistant, so it is
       the one line a model must not improvise. The bubble therefore carries
       no AI badge. §10's Stop is not involved because no generation started. */
    if (route.path === 'fixed') {
      bubble('bot', route.text);
      return finish({
        ...res, text: route.text, sources: [], abstained: false,
        kind: route.kind || 'small-talk',
      }, lang, null, {});
    }

    const line = streamBubble(MODEL_BADGES.model, 'is-ai', null);
    /* §10's Stop, wired to the generation and to nothing else. `AbortController`
       is not in every environment this shell runs under (and not in the tests'
       doubles), so its absence is a missing control rather than an error. */
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeAbort = controller;
    syncControls();
    let out;
    try {
      out = await answerer.ask({
        question: text, lang, focus: res.focus || null,
        /* The topic's own facts, for the questions retrieval cannot reach
           because the intent rules consumed their only content token — see
           `ask()`'s note. A greeting now carries the ONE fact the model was
           trained to greet with (`person.name`, see the §7.4 greeting
           examples): the runtime frame matches training, so the checkpoint's
           own short trained answer loads and stops cleanly instead of
           rambling off-distribution into a double guard rejection. */
        intentIds: res.sources,
        /* The plan, so the answer path can tell a whole-kind question ("which
           databases does he use?" — every database fact is the answer, and
           three BM25 chunks cannot hold them) from a one-fact one. See
           `intentScopesContext` in `ai/answers/model.mjs`. */
        plan: res.plan || null,
        /* The conversation so far, oldest first. The engine's frame carries
           completed turns and `fitToBudget` trims them, so follow-ups such
           as "come again" are answered from what was already said, not
           from a fresh retrieval. */
        history: turnHistory,
        signal: controller?.signal || null,
        onToken: (chunk) => line.push(chunk),
        onReplace: (text_) => line.set(text_),
      });
    } catch (err) {
      if (controller?.signal?.aborted) {
        /* The visitor pressed Stop. That is not the model dying, and saying
           "the on-device model stopped" would blame the machine for a click —
           see `stop()` for what is kept and why. */
        return presentPartial(line, lang, res);
      }
      /* A model that died mid-answer is not an answer. */
      line.set(noAnswerLine('stopped', lang));
      setBadge(line, MODEL_BADGES.noModel);
      noticeOnce(`The on-device model stopped (${escape(err?.message || err)}).`);
      return finish({ text: line.text, abstained: true, kind: 'no-model',
        badge: MODEL_BADGES.noModel, focus, followups: res.followups },
        lang, null, { badge: MODEL_BADGES.noModel });
    } finally {
      /* The generation is over either way, so there is nothing left to
         abort — a Stop button that outlived its stream would abort the NEXT
         answer. The ladder is disarmed separately, by `whileWorking`. */
      activeAbort = null;
      syncControls();
    }

    if (out.kind !== 'model') {
      /* The model ran and made no claim: it chose `<|abstain|>` (a question
         it will not answer — the only refusal the panel NOW owns), or the
         guard rejected both attempts. Both are refusals, and the badge
         says which one. */
      const badge = out.kind === 'notFound' ? MODEL_BADGES.notFound : MODEL_BADGES.unverified;
      line.set(out.text);
      setBadge(line, badge);
      return finish({ ...res, text: out.text, sources: [], abstained: true,
        kind: 'no-answer', badge, context: out.context,
        guard: { attempts: out.attempts, failed: out.guardFailed } },
        lang, null, { badge, badgeClass: 'is-note' });
    }

    line.finish(out.text);
    if (out.sources?.length) {
      const src = el('div', 'ai__sources');
      for (const id of out.sources) src.appendChild(el('span', 'ai__source', id));
      line.node.appendChild(src);
    }
    /* §6.3 steps 1–2: if the governor has already shortened this session, the
       answer is still the model's — the panel just says why it is shorter. */
    if (budget.paceMs || ladder?.status?.().step >= 2) {
      noticeOnce('The scene was struggling, so answers are kept shorter for this session.');
    }
    lastAnchor = resolveAnchor(doc, { kb, ids: out.sources }) || lastAnchor;
    /* The turn just answered becomes the model's own memory: `history` is
       fed back on the next question, so follow-ups ("come again", "his
       age?" right after "how old is he?") read the conversation instead
       of retrieving as if the last turn never happened. Truncated so a
       long answer cannot eat the window; `fitToBudget` drops oldest-first
       beyond that (§10's 3–4 turns). */
    turnHistory.push([text, out.text.length > 400
      ? `${out.text.slice(0, 400)}…` : out.text]);
    if (turnHistory.length > 6) turnHistory.splice(0, turnHistory.length - 6);
    return finish({
      ...res, text: out.text, sources: out.sources, model: true, kind: 'model',
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
    syncControls();
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
    micLabel.textContent = on ? (info.mode === 'continuous' ? 'LISTENING' : 'MIC ON') : 'VOICE';
    /* The live level property resets the moment voice mode is off — a stale
       "loud" value must not be able to say the mic is still up. */
    if (!on && orb) orb.style.removeProperty('--orb-level');
    /* §11.5: one attribute, read by CSS; which value it is comes from
       voiceVisualState(), where the order is pinned by test. */
    const state = voiceVisualState(info);
    micBtn.dataset.voice = state;
    micBtn.setAttribute('aria-label', VOICE_STATE_WORDS[state] || VOICE_STATE_WORDS.off);
    micBtn.disabled = !info.supported || !info.pushToTalk;
    micBtn.title = info.reason || 'Talk to the assistant';
    /* §2 N7 — the button must never just go dead. Turning voice on now loads
       a module first (§2 N6), and on a slow connection that is a visible
       wait: without this, a tap would produce nothing at all until the code
       arrived, which reads as a broken button. */
    if (voicePending) {
      micBtn.classList.add('is-loading');
      micLabel.textContent = 'VOICE…';
      micBtn.disabled = true;
      micBtn.title = 'Loading voice mode…';
      micBtn.setAttribute('aria-label', 'Voice mode is loading');
    } else {
      micBtn.classList.remove('is-loading');
    }
  }

  /** §11.5's live level, from the VAD's own frames. The browser has already
   *  paid for the detector (it gates the recognizer), so reading its number
   *  costs nothing new — and the one DOM write is a CSS custom property,
   *  which is a style recalc on one 7px span, not layout. Throttled to
   *  every-other-frame so the value the visitor sees is ~15 Hz, smooth but
   *  not a per-frame churn, and stopped the moment voice is off. No rAF loop
   *  of our own (§2 N8): this only ever runs while the VAD is alive. */
  let vadFrameSkip = 0;
  function vadLevelTick(frame) {
    if (!orb || voiceWanted === false) return;
    /* Even frames only: one DOM write per ~60 ms is plenty for "my voice is
       being heard" and halves the work of the loop that is already running. */
    vadFrameSkip = (vadFrameSkip + 1) % 2;
    if (vadFrameSkip) return;
    const lvl = Math.max(0, Math.min(1, Number(frame?.level) || 0));
    orb.style.setProperty('--orb-level', lvl.toFixed(3));
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
    /* The disclosure that was waiting for the platform to say where
       recognition runs (see toggleVoice): now that it has answered, the
       sentence can be the true one. Nothing is spoken for a session that
       ended while the question was open. */
    if (disclosurePending && st?.enabled && st.onDevice !== null) {
      disclosurePending = false;
      disclosureSpoken = true;
      bubble('bot', st.disclosure, { badge: 'VOICE ON', badgeClass: 'is-note' });
    }
  }

  /* §2 N6: the recognizer, the VAD and the speaker arrive on the first tap,
     not with the shell — normally-typing visitors never parse them. That
     makes enabling voice async, so the loader is single-flight (two callers
     must not build two controllers) and `voiceWanted` stops a load that
     finished after Stop from switching the microphone on anyway. */
  let voicePromise = null;
  let voiceWanted = false;
  let voicePending = false;

  function voiceController() {
    if (voice) return Promise.resolve(voice);
    /* Forgotten on failure, so a second tap can retry a fetch that failed */
    voicePromise ||= import('../voice/index.mjs')
      .then((m) => {
        voice = m.createVoice(env, {
          tier: tier ?? 0,
          chat: api,
          onStatus: voiceChanged,
          /* §11.5's live level: the VAD's 0–1 "how loud is the room" number,
             per ~30 ms frame, straight to the orb. Without this "listening"
             looks identical to "armed" — the transparent tube now says
             something the moment a voice arrives, rather than a dot that
             only ever pulses on its own clock. */
          onVadFrame: vadLevelTick,
          /* §11.1 (d): the one idle nudge. Deterministic, shown rather than
             spoken — a sentence out of a quiet room is a worse interruption
             than a line on screen, and the line says how to make it stop. */
          onNudge: (text) => bubble('bot', text, { badge: 'STILL HERE', badgeClass: 'is-note' }),
          /* §11.1's two one-line notices, both said once: the headphones
             suggestion on the first hands-free session, and the downgrade
             when the §6.3 ladder reaches step 3. They are bubbles for the
             same reason `onNudge` is — a sentence out of a quiet room is a
             worse interruption than a line on the screen the visitor is
             already looking at. */
          onNotice: (text) => bubble('bot', text, { badge: 'VOICE', badgeClass: 'is-note' }),
        });
        return voice;
      })
      .catch((err) => { voicePromise = null; throw err; });
    return voicePromise;
  }

  async function toggleVoice() {
    if (voice?.isEnabled()) { stopVoice(); return; }
    voiceWanted = true;
    voicePending = true;
    voiceButton();
    let ctl;
    try {
      ctl = await voiceController();
    } catch (err) {
      voicePending = false;
      voiceButton();
      /* The module itself could not load. That is the same visitor-facing
         situation as an engine-less browser, and it is said the same way. */
      voiceFailure = `Voice mode could not load (${escape(err?.message || err)}).`;
      bubble('bot', voiceFailure, { badge: 'VOICE UNAVAILABLE', badgeClass: 'is-note' });
      return;
    }
    voicePending = false;
    if (!voiceWanted) { voiceButton(); return; }   /* Stop was pressed while loading */
    const st = ctl.enable();
    voiceButton();
    if (!st.enabled) {
      if (st.reason) {
        voiceFailure = st.reason;
        bubble('bot', st.reason, { badge: 'VOICE UNAVAILABLE', badgeClass: 'is-note' });
      }
      return;
    }
    voiceFailure = null;
    /* §11.1 (a)/(c): Proactive greets once and offers the tour. Both live here
       rather than inside `enable()` because they are sentences, not the
       microphone's state machine — and both are no-ops on Tap & Speak, where
       the press is already the question. */
    if (st.mode === 'continuous') {
      ctl.greet();
      offerTour();
    }
    /* Said once, in the open, before anything is listened to: this engine
       sends audio off the device, and the panel's usual "what you type stays
       in your browser" does not stretch to cover speech.

       §19 turned up one exception worth asking about — an experimental mode
       where the platform recognises speech on this device instead. That
       question is answered in a few milliseconds, and this is a sentence
       about where the audio goes, so it waits for the answer rather than
       guessing at it: `onDevice === null` means the question is still open. */
    if (!disclosureSpoken) {
      if (st.onDevice === null) {
        disclosurePending = true;
      } else {
        disclosureSpoken = true;
        bubble('bot', st.disclosure, { badge: 'VOICE ON', badgeClass: 'is-note' });
      }
    }
  }

  function stopVoice() {
    voiceWanted = false;
    voice?.disable();
    voiceButton();
  }

  /** §6.2: the starting tier is a starting point — "the session may move down
   *  at runtime". Voice is where that becomes visible, because the tier decides
   *  whether this device may listen continuously, push-to-talk only, not at
   *  all. Exposed so a host (and the probe) can move it deliberately rather
   *  than waiting for the governor to. */
  async function setVoiceTier(next) {
    const st = (await voiceController()).setTier(next);
    voiceButton();
    return st;
  }

  /* ── section: governor wiring ─────────────────────────────────── */
  function startFrameHealth() {
    if (ladder) return;                                /* idempotent: never stack */
    const gsapRef = env.gsap;
    if (!gsapRef?.ticker?.add) return;                 /* §6.3: reuse the ticker or nothing */
    ladder = createDegradeLadder({
      /* armed by whileWorking() around real work, not by the panel opening */
      active: false,
      /* §11.1's auto-downgrade rides the same rung as the answer budget: the
         shell owns the ladder, so the voice layer is told the step rather
         than measuring the device a second time. `voice` is null until the
         first tap, which is why this is optional-chained. */
      onStep: (step) => { budget.applyStep(step); voice?.setPressure?.(step); },
      onRestore: (step) => { budget.restore(step); voice?.setPressure?.(step); },
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
    /* nothing a rung turned outlives the session it turned it in */
    budget.restore(0);
  }

  /* ── section: lifecycle ───────────────────────────────────────── */
  async function loadKnowledge() {
    if (kb) return kb;
    const res = await fetch(KB_URL);
    if (!res.ok) throw new Error(`knowledge.json → HTTP ${res.status}`);
    kb = await res.json();
    return kb;
  }

  /* ── section: the optional model (§9.3, §5, §6.5) ───────────────
     Lazy by construction AND opt-in: unlike the old shell, `open()` does not
     call `prepareModel()`. The only caller of `startModel()` is the AI MODEL
     button, so a visitor who uses the default portfolio guide has no worker,
     no shard and no tokenizer request. `prepareCapabilities()` is the cheap
     device probe; it sets the voice tier and is deliberately separate from
     anything that fetches model bytes. */
  const fmtMB = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

  function updateModeUi() {
    const guideOn = answerMode === ANSWER_MODES.GUIDE;
    if (modeButtons.guide) {
      modeButtons.guide.classList.toggle('is-on', guideOn);
      modeButtons.guide.setAttribute('aria-pressed', guideOn ? 'true' : 'false');
    }
    if (modeButtons.model) {
      const on = answerMode === ANSWER_MODES.MODEL;
      const loading = modelState === 'loading';
      modeButtons.model.classList.toggle('is-on', on);
      modeButtons.model.setAttribute('aria-pressed', on ? 'true' : 'false');
      modeButtons.model.disabled = loading;
      if (modeNotes.model) {
        modeNotes.model.textContent = loading ? 'Downloading…'
          : modelState === 'ready' ? 'Ready · on this device'
            : modelState === 'unsupported' ? 'Not available on this device'
              : modelState === 'error' ? 'Failed · press to retry'
                : `${fmtMB(engineOpts.sizeBytes)} · one-time download`;
      }
      modeButtons.model.title = loading
        ? 'Downloading the AI model…'
        : modelState === 'ready' ? 'AI model is loaded; switch to it'
          : modelState === 'unsupported' ? 'This device cannot run the AI model'
            : modelState === 'error' ? 'The model could not start; press to retry'
              : `Download the ${fmtMB(engineOpts.sizeBytes)} AI model once`;
    }
    const badge = body?.querySelector('.ai__tier');
    if (badge) {
      if (answerMode === ANSWER_MODES.MODEL) {
        badge.textContent = modelState === 'ready' ? 'AI MODEL READY' : 'AI MODEL';
        badge.title = 'Answers are generated by the on-device model';
      } else if (modelState === 'loading') {
        badge.textContent = 'AI MODEL · LOADING';
        badge.title = 'The portfolio guide is still answering; the model is downloading';
      } else if (modelState === 'error' || modelState === 'unsupported') {
        badge.textContent = 'GUIDED';
        badge.title = 'Portfolio guide is active; the AI model is unavailable';
      } else {
        badge.textContent = 'GUIDED';
        badge.title = 'Instant answers from the verified portfolio data; no model download';
      }
    }
  }

  function setModelState(next, notice = null) {
    modelState = next;
    modelNotice = notice;
    updateModeUi();
    return next;
  }

  /** The visible mode switch, and the only door to the model. Switching to
   *  the guide never touches the network; switching to the model starts the
   *  one-time download only when the visitor presses the AI MODEL button. */
  async function chooseMode(next) {
    if (next === ANSWER_MODES.GUIDE) {
      modelRequested = false;
      answerMode = ANSWER_MODES.GUIDE;
      updateModeUi();
      if (body && !body.hidden) {
        bubble('bot', 'Portfolio Guide is active. Answers come straight from the verified data file; no model is downloaded.',
          { badge: GUIDE_BADGE, badgeClass: 'is-note' });
      }
      return true;
    }
    if (next !== ANSWER_MODES.MODEL) return false;

    if (modelState === 'ready') {
      answerMode = ANSWER_MODES.MODEL;
      updateModeUi();
      if (body && !body.hidden) {
        bubble('bot', 'AI model is active. Answers now come from the on-device model; switch to Portfolio Guide anytime.',
          { badge: ANSWER_MODE_LABELS[ANSWER_MODES.MODEL], badgeClass: 'is-ai' });
      }
      return true;
    }
    if (modelState === 'loading') {
      if (body && !body.hidden) {
        bubble('bot', 'The AI model is still downloading. The portfolio guide will answer until it is ready.',
          { badge: ANSWER_MODE_LABELS[ANSWER_MODES.MODEL], badgeClass: 'is-ai' });
      }
      return false;
    }

    modelRequested = true;
    if (modelState === 'error') preparing = null;
    answerMode = ANSWER_MODES.GUIDE;
    updateModeUi();
    const ready = await prepareModel();
    if (ready && modelRequested) {
      answerMode = ANSWER_MODES.MODEL;
      updateModeUi();
      return true;
    }
    if (modelRequested && modelState === 'unsupported' && body && !body.hidden) {
      bubble('bot', noAnswerLine('unsupported', 'en'),
        { badge: MODEL_BADGES.noModel, badgeClass: 'is-note' });
    }
    modelRequested = false;
    answerMode = ANSWER_MODES.GUIDE;
    updateModeUi();
    return false;
  }

  /** §6.5's "always show the size before it starts". One bubble, then it
   *  becomes the progress line, then it goes away. */
  function startModel() {
    if (preparing) return preparing;
    if (modelState === 'ready') return Promise.resolve(true);
    if (modelState === 'unsupported') return Promise.resolve(false);
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
      `Downloading the AI model once (${fmtMB(engineOpts.sizeBytes)}). `
      + 'It stays in your browser after this; the portfolio guide keeps answering meanwhile.',
      { badge: 'AI MODEL', badgeClass: 'is-ai' });
    const label = line.querySelector('span:not(.ai__badge)');
    /* `label` is read by the progress callback above, which is created before
       the bubble exists — hence the late binding. */
    void label;

    preparing = session.prepare()
      .then((ready) => {
        answerer = createModelAnswerer({
          /* §5's voice, from its one owner rather than a literal here: the
             shell may not be the second place that decides how the assistant
             refers to Aashish. */
          kb, session, persona: DEFAULT_PERSONA, maxNewTokens: budget.maxNewTokens,
          onNotice: (text) => noticeOnce(text),
        });
        /* Seeds the budget if the tier never set one, and re-pushes whatever a
           rung already turned onto this answerer. */
        budget.attach(answerer);
        setModelState('ready');
        const kbLoaded = ready?.loaded?.bytes ?? session.loaded?.bytes ?? 0;
        if (label) {
          label.textContent = `Aashish AI is ready — ${fmtMB(kbLoaded)} of model in your `
            + 'browser, answering from his portfolio data only.';
        }
        line?.remove?.();
        /* Only switch once the weights are genuinely ready. A visitor who
           pressed Portfolio Guide while the download was running keeps the
           deterministic path; the model stays warm but is not used silently. */
        if (modelRequested && answerMode === ANSWER_MODES.GUIDE) {
          answerMode = ANSWER_MODES.MODEL;
          bubble('bot', 'AI model is ready. Answers now come from the on-device model; switch to Portfolio Guide anytime.',
            { badge: 'AI MODEL READY', badgeClass: 'is-ai' });
        }
        updateModeUi();
        renderChips(starterChips());
        return true;
      })
      .catch((err) => {
        const unsupported = session.status === 'unsupported';
        preparing = null;
        modelRequested = false;
        answerMode = ANSWER_MODES.GUIDE;
        setModelState(unsupported ? 'unsupported' : 'error', err?.message);
        if (label) {
          label.textContent = unsupported
            ? noAnswerLine('unsupported', 'en')
            : `The on-device model could not start (${escape(err?.message || err)}). `
              + 'Nothing else on the site is affected; press AI MODEL to retry.';
        }
        updateModeUi();
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
      /* §6.4: nothing is generating any more, so nothing should be paced */
      budget.detach();
      preparing = null;
      answerMode = ANSWER_MODES.GUIDE;
      modelRequested = false;
      setModelState('idle');
    }, 120_000);
  }

  let capsPromise = null;

  /** §6.1 probe + §6.2 tier. This reads capabilities and sets the voice
   *  policy; it does NOT fetch the manifest, a shard, the tokenizer or the
   *  worker. Keeping that boundary explicit is what lets the panel open with
   *  the guide while making the model genuinely opt-in. */
  async function prepareCapabilities() {
    if (caps) return { caps, tier, info: tierInfo(tier) };
    capsPromise ||= (async () => {
      const bench = await runBenchmark(env);
      const found = probeCapabilities(env, {
        benchmarkMs: bench,
        wasmSimd: env.WebAssembly ? hasSimd(env.WebAssembly) : false,
        storageBytes: await (async () => {
          try { return (await env.navigator?.storage?.estimate())?.quota ?? null; } catch { return null; }
        })(),
      });
      found.webgpu = await probeWebGPU(env);
      caps = found;
      tier = chooseTier(caps);
      /* §6.2's answer budget per tier. The model itself is one model: the tier
         decides how long an answer may be and how hard the device is pushed. */
      budget.setTier(tier);
      updateModeUi();
      return { caps, tier, info: tierInfo(tier) };
    })();
    return capsPromise;
  }

  /** Called only from `chooseMode('model')`, after the visitor pressed the
   *  AI MODEL button. It may start the one-time download; `open()` cannot. */
  async function prepareModel() {
    const found = await prepareCapabilities();
    if (preparing) return preparing;
    if (found.tier > 0) return startModel();
    /* T0 is the tier that may not have an LLM at all (§6.2). */
    setModelState('unsupported', `tier T${found.tier} does not run an LLM`);
    return false;
  }

  /* ── the one-time load ─────────────────────────────────────────
     Knowledge and the cheap capability probe only. The trained model is NOT
     part of this: its download starts from the AI MODEL button and nowhere
     else. The guide is usable as soon as this resolves. */

  /* Returns false on failure, for the opening line to render honestly. */
  async function loadAll() {
    try {
      await loadKnowledge();
      await prepareCapabilities();
      loadOutcome = 'ready';
      if (state === 'loading') state = 'ready';
      return true;
    } catch (err) {
      loadOutcome = 'error';
      state = 'error';
      warmError = err;
      return false;
    }
  }

  let warmPromise = null;
  let warmError = null;
  let tierBadge = null;

  /** The eager half: build the shell HIDDEN and load the knowledge/probe.
   *  It never starts the model download; only the AI MODEL button does that.
   *  Idempotent: two callers share one promise, and open() below reuses
   *  whatever this already built. */
  function warmup() {
    if (built) return Promise.resolve(api);
    if (!warmPromise) {
      state = 'loading';
      injectStyles();
      tierBadge = build().tierBadge;
      built = true;
      warmPromise = loadAll().then(() => api);
    }
    return warmPromise;
  }

  /* The click half's last step: exactly one opening line, whatever path
     built the shell. States what THIS device can do rather than promising.
     `openLineShown` keeps a click that lands mid-warm-up from stamping the
     loading line onto a panel that then becomes ready under it — the "AI
     MODEL" download bubble's label is live, so it tells the rest itself. */
  let openLineShown = false;
  function openFirstTime() {
    if (openLineShown) return;
    openLineShown = true;
    /* before the tier is known, the button reports what the BROWSER can do;
       prepareModel() refines it with what this tier is allowed to do */
    voiceButton();
    if (loadOutcome === 'error') {
      if (tierBadge) tierBadge.textContent = 'UNAVAILABLE';
      bubble('bot', `The assistant could not start (${escape(warmError?.message || 'unknown')}). `
        + 'The rest of the site is unaffected.');
      return;
    }
    /* The default opening line names the mode and the opt-in cost. It does
       not promise a model download has started, because it has not. */
    bubble('bot',
      'Ask me anything about his projects, skills, education, certifications or how to '
      + 'reach him. The Portfolio Guide answers instantly from the verified data file. '
      + `If you want free-form answers, choose AI MODEL — it downloads ${fmtMB(engineOpts.sizeBytes)} once, `
      + 'only when you press that button.',
      { badge: GUIDE_BADGE, badgeClass: 'is-note' });
    renderChips(starterChips());
    updateModeUi();
    voiceButton();
    input?.focus();
  }

  async function open() {
    /* Built once, reused forever. A reopen only has to reveal the shell. */
    if (built) { show(); openFirstTime(); return api; }
    state = 'loading';
    injectStyles();
    tierBadge = build().tierBadge;
    built = true;
    show();
    await loadAll();
    openFirstTime();
    return api;
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
    /* §11.1 (c): a tour does not survive the panel — and it must not keep a
       timer alive either, because a closure holding the page after close() is
       the leak this project keeps testing for. */
    stopTour();
    /* the explanation never outlives the panel, and it resets WITHOUT taking
       focus, because focus belongs to the launcher on the way out */
    if (aboutOpen) {
      aboutOpen = false;
      if (aboutCard) aboutCard.hidden = true;
      aboutBtn?.setAttribute?.('aria-expanded', 'false');
    }
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
    /* The film is the heaviest main-thread work on the page, and the
       interlude's own canvas (scene 6) rides an independent rAF that
       otherwise keeps drawing behind the panel, so both stop — not only
       on a phone, where the panel covers the scene and it was pointless
       anyway (§10), but on every device: the whole point is to hand
       generation the machine. A paused scene is measured seconds off
       every answer's first token. */
    hooks.pauseScene?.();
    input?.focus();
  }

  function toggle() {
    if (body && !body.hidden) close(); else open();
  }

  /* §2 N4's explanation, and the topmost layer while it is open — Escape has
     to close IT first, because closing the whole panel while a card the
     visitor just opened is on screen reads as a bug. */
  function setAbout(on) {
    if (!aboutCard) return false;
    aboutOpen = !!on;
    aboutCard.hidden = !aboutOpen;
    aboutBtn?.setAttribute?.('aria-expanded', aboutOpen ? 'true' : 'false');
    if (aboutOpen) aboutClose?.focus?.();
    else aboutBtn?.focus?.();
    return aboutOpen;
  }

  /* ── public API (also used by dev-ai-probe.js) ────────────────── */
  const api = {
    open, close, toggle, warmup, ask, showAnchor,
    /* The two answer modes, exposed for a host and for browser probes. The
       model still cannot start without an explicit AI MODEL selection. */
    chooseMode,
    enableModel: () => chooseMode(ANSWER_MODES.MODEL),
    useGuide: () => chooseMode(ANSWER_MODES.GUIDE),
    /* §10's message controls, exposed so the e2e probe can press them the way
       a person would rather than reaching into the shell's internals */
    stop, retry,
    /* §2 N4's disclosure — the probe opens it through the same control a
       visitor uses, so the check cannot drift from the real interaction */
    about(on = true) { return setAbout(on); },
    isAboutOpen() { return aboutOpen; },
    /* §11.1 (c)'s tour, exposed for the probes (which cannot click a chip that
       only exists once voice is on) and for a host that wants to offer it */
    startTour, stopTour,
    isTouring: () => tourIndex >= 0,
    /* the voice layer flips this on; nothing else has to change */
    setHandsFree(on) { handsFree = !!on; return handsFree; },
    enableVoice: toggleVoice,
    disableVoice: stopVoice,
    /* §11.2's tap-to-edit: the same box, filled from the bubble. Exposed for
       the probes, which cannot click a button inside a bubble that only
       exists after a voice question. */
    edit(text) {
      if (!input || !text) return false;
      input.value = String(text);
      input.focus();
      return true;
    },
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
    get mode() { return answerMode; },
    get model() {
      return {
        mode: answerMode,
        requested: modelRequested,
        state: modelState,
        notice: modelNotice,
        engine: session ? { status: session.status, reason: session.reason,
                            bytes: session.loaded?.bytes ?? null,
                            /* §9.3: the worker's own account of where the
                               bytes came from — the only thing that can tell
                               a cache hit from a fast network (dev-offline-probe.js) */
                            cache: session.cache ?? null,
                            ...budget.status() } : null,
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
    onKey: (e) => {
      if (e.key !== 'Escape' || !body || body.hidden) return;
      if (aboutOpen) { setAbout(false); return; }   /* topmost layer first */
      close();
    },
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
      /* `jump` is §11.1 (c) under `prefers-reduced-motion`: the tour visits
         four sections, and four 1.6 s glides are the animation that request is
         about. Everything else keeps the site's own smooth move. */
      scrollToAnchor: (scene, anchor, { jump } = {}) => {
        const id = scene?.id ? `#${scene.id}` : null;
        if (id && window.Director?.scrollTo) window.Director.scrollTo(id, { immediate: !!jump });
        else scene?.scrollIntoView?.({ behavior: jump ? 'auto' : 'smooth', block: 'start' });
      },
      pauseScene: () => {
        window.Film3D?.pause?.();
      },
      resumeScene: () => {
        window.Film3D?.resume?.();
      },
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
