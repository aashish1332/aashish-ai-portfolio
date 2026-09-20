/* ═══════════════════════════════════════════════════════════════
   ai/ui/styles.mjs — the panel's CSS, injected by the chunk on first open

   It lives in the chunk, not in css/style.css, for two reasons:
     · §4 budgets the pre-click load at "+0 requests for AI assets" and a
       stylesheet for a panel nobody opened is exactly that;
     · the panel's worst-case CSS mistakes (a full-screen blurred layer over
       a live WebGL canvas) should never touch the film's own stylesheet.

   §12 rules honoured here: no backdrop-filter over the canvas, opaque fill,
   `contain: layout paint style`, transitions on transform/opacity only,
   content-visibility on old messages, safe-area padding on phones.
   Tokens are the portfolio's own --paper/--line/--accent so it reads as a
   part of the film rather than a chatbot bolted on.
   ═══════════════════════════════════════════════════════════════ */
export const STYLES = `
.ai { position: fixed; inset: 0; z-index: 980; pointer-events: none; }
.ai[hidden] { display: none; }

.ai__scrim {
  position: absolute; inset: 0; background: rgba(10,10,11,.55);
  opacity: 0; transition: opacity .28s ease; pointer-events: none;
}

.ai__panel {
  position: absolute; right: 0; top: 0; bottom: 0;
  width: min(432px, 100vw);
  display: flex; flex-direction: column;
  background: var(--panel, #141418);
  border-left: 1px solid var(--line);
  color: var(--paper); font-family: var(--font-body);
  transform: translateX(12px); opacity: 0;
  transition: transform .28s cubic-bezier(.2,.7,.2,1), opacity .28s ease;
  contain: layout paint style;          /* §12: never re-layout the film */
  pointer-events: auto;
}
.ai.is-open .ai__panel { transform: none; opacity: 1; }
.ai.is-open .ai__scrim { opacity: 1; }

.ai__head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px 12px; border-bottom: 1px solid var(--line);
}
.ai__title {
  font-family: var(--font-display); font-size: 20px; letter-spacing: .08em;
  margin-right: auto; line-height: 1;
}
.ai__title span { color: var(--accent); }
.ai__tier {
  font-family: var(--font-mono); font-size: 9px; letter-spacing: .12em;
  color: var(--paper-faint); border: 1px solid var(--line);
  padding: 4px 7px; white-space: nowrap;
}
.ai__close {
  background: none; border: 1px solid var(--line); color: var(--paper-dim);
  width: 30px; height: 30px; cursor: pointer; font-size: 13px; line-height: 1;
  transition: color .2s, border-color .2s;
}
.ai__close:hover, .ai__close:focus-visible { color: var(--accent); border-color: var(--accent); }

.ai__log {
  flex: 1; overflow-y: auto; overscroll-behavior: contain;
  padding: 16px; display: flex; flex-direction: column; gap: 14px;
}
.ai__log:focus-visible { outline: 1px solid var(--accent); outline-offset: -2px; }

.ai__msg {
  max-width: 92%; white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: 13.5px; line-height: 1.55;
  content-visibility: auto; contain-intrinsic-size: auto 60px;
}
.ai__msg.is-user {
  align-self: flex-end; color: var(--paper);
  border-left: 2px solid var(--accent); padding: 2px 0 2px 10px;
}
.ai__msg.is-bot { color: var(--paper-dim); }
.ai__msg.is-bot b, .ai__msg.is-bot strong { color: var(--paper); font-weight: 500; }

.ai__badge {
  display: block; font-family: var(--font-mono); font-size: 8.5px;
  letter-spacing: .16em; color: var(--paper-faint); margin-bottom: 5px;
}
.ai__badge.is-quick { color: var(--cyan); }
.ai__badge.is-note { color: var(--gold); }

.ai__sources { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.ai__source {
  font-family: var(--font-mono); font-size: 9px; letter-spacing: .08em;
  color: var(--paper-faint); border: 1px solid var(--line); padding: 3px 6px;
}

.ai__chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 16px 10px; }
.ai__chip {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: .04em;
  color: var(--paper-dim); background: none; border: 1px solid var(--line);
  padding: 7px 10px; cursor: pointer; text-align: left;
  transition: color .2s, border-color .2s, transform .2s;
}
.ai__chip:hover, .ai__chip:focus-visible { color: var(--accent); border-color: var(--accent); transform: translateY(-1px); }

.ai__form { display: flex; gap: 8px; padding: 12px 16px 0; border-top: 1px solid var(--line); }
.ai__input {
  flex: 1; resize: none; max-height: 120px; min-height: 42px;
  background: var(--ink, #101014); border: 1px solid var(--line); color: var(--paper);
  font: 400 13.5px/1.5 var(--font-body); padding: 10px 12px;
}
.ai__input:focus-visible { outline: none; border-color: var(--accent); }
.ai__input::placeholder { color: var(--paper-faint); }
.ai__send {
  align-self: flex-end; height: 42px; padding: 0 16px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: .14em;
  background: none; border: 1px solid var(--line-strong); color: var(--paper);
  cursor: pointer; transition: color .2s, border-color .2s;
}
.ai__send:hover, .ai__send:focus-visible { color: var(--accent); border-color: var(--accent); }
.ai__send:disabled { color: var(--paper-faint); border-color: var(--line); cursor: default; }

.ai__foot {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 16px calc(12px + env(safe-area-inset-bottom, 0px));
}
.ai__trust {
  font-family: var(--font-mono); font-size: 8.5px; letter-spacing: .06em;
  color: var(--paper-faint); margin: 0; line-height: 1.5;
}
.ai__link {
  background: none; border: 0; padding: 0; margin-left: auto; cursor: pointer;
  font-family: var(--font-mono); font-size: 9px; letter-spacing: .1em;
  color: var(--paper-dim); text-decoration: underline; text-underline-offset: 3px;
}
.ai__link:hover, .ai__link:focus-visible { color: var(--accent); }

.ai__sr {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}

/* phones: full-screen sheet with a visible close button (§10) */
@media (max-width: 640px) {
  .ai__panel { width: 100vw; border-left: 0; }
  .ai__msg { max-width: 96%; font-size: 14px; }
}

@media (prefers-reduced-motion: reduce) {
  .ai__panel, .ai__scrim, .ai__chip { transition: none; }
}

/* the launcher chip itself is styled in css/style.css — it is part of the
   initial page, not of this lazy chunk. */
`;
