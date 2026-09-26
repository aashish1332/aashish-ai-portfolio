/* ═══════════════════════════════════════════════════════════════
   tests/session.test.mjs — the worker protocol (SESSION-1…SESSION-8)

   `ai/engine/session.mjs` owns the page side of §9.3's boundary and had **no
   tests at all**, which is how the bug below survived every suite the project
   had:

     SESSION-0  `ready` was in the list of replies that do NOT settle the
                request that asked for them. `prepare()` therefore resolved
                NEVER — `state` stayed 'loading' and the model never finished
                loading in any browser, on any device. MEASURED in headless
                Chrome: the worker posts `ready`, the page logs the progress
                event, and `status` is still 'loading' 30 s later. Every engine
                test passes regardless, because they call
                `ScratchLlamaEngine.load` directly and drive no protocol.

   The environment is injected (`env.Worker`), so a fake worker can speak the
   protocol deliberately — including the replies that are easy to get wrong,
   like a late token after a `done`, or an `abort` racing a `done`.

   Run:  npm test
   ═══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelSession } from '../ai/engine/session.mjs';

/** A worker double that records what it was sent and lets the test reply. */
function fakeWorkerClass() {
  const made = [];
  class FakeWorker {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.sent = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      made.push(this);
    }

    postMessage(message) {
      if (this.terminated) throw new Error('postMessage on a terminated worker');
      this.sent.push(message);
    }

    terminate() { this.terminated = true; }

    /** Pretend the worker answered. */
    reply(data) { this.onmessage?.({ data }); }

    /** The most recent request of a type, by the id the session minted. */
    lastOf(type) {
      return [...this.sent].reverse().find((m) => m.type === type);
    }
  }
  return { FakeWorker, made };
}

const manifestUrl = '/ai/model-export/aashish-ai-1/manifest.json';

function makeSession(over = {}) {
  const { FakeWorker, made } = fakeWorkerClass();
  const progress = [];
  const session = createModelSession({
    manifestUrl,
    env: { Worker: FakeWorker },
    onProgress: (e) => progress.push(e),
    ...over,
  });
  return { session, worker: () => made[0], made, progress };
}

test('SESSION-1 prepare() resolves on `ready` — the bug that made the model never load',
  async () => {
    const { session, worker } = makeSession();
    const preparing = session.prepare();
    assert.equal(session.status, 'loading');
    assert.equal(worker().opts.type, 'module', 'a module worker, or the engine modules are copied');
    assert.equal(worker().opts.name, 'aashish-ai');

    const request = worker().lastOf('prepare');
    assert.equal(request.manifestUrl, manifestUrl);
    assert.equal(request.verify, true);

    /* `ready` IS the answer to `prepare`. If this hangs, the test times out —
       which is the failure mode being pinned, so no assertion on the clock is
       needed. */
    worker().reply({
      id: request.id, type: 'ready',
      config: { hidden_size: 256 }, verified: true, bytes: 5_059_584,
      memory: { weightsBytes: 5_059_584 },
    });
    const out = await preparing;
    assert.equal(session.status, 'ready');
    assert.deepEqual(session.config, { hidden_size: 256 });
    assert.equal(session.loaded.bytes, 5_059_584);
    assert.equal(out.config.hidden_size, 256);
  });

test('SESSION-2 progress and tokens stream WITHOUT settling their request', async () => {
  const { session, worker, progress } = makeSession();
  const preparing = session.prepare();
  const id = worker().lastOf('prepare').id;

  worker().reply({ id, type: 'progress', stage: 'weights', loaded: 1_000, total: 5_000 });
  worker().reply({ id, type: 'progress', stage: 'weights', loaded: 5_000, total: 5_000 });
  /* still pending: progress is not an answer */
  assert.equal(session.status, 'loading');
  assert.deepEqual(progress.map((p) => p.stage), ['weights', 'weights']);
  assert.equal(progress.at(-1).loaded, 5_000);

  worker().reply({ id, type: 'ready', config: {}, verified: true, bytes: 5, memory: {} });
  await preparing;
  assert.equal(session.status, 'ready');
});

test('SESSION-3 generate() streams tokens and resolves once, on `done`', async () => {
  const { session, worker } = makeSession();
  const preparing = session.prepare();
  worker().reply({
    id: worker().lastOf('prepare').id, type: 'ready',
    config: {}, verified: true, bytes: 5, memory: {},
  });
  await preparing;

  const seen = [];
  const generating = session.generate(
    { question: 'hi', context: '', maxNewTokens: 8 },
    { onToken: (text, index) => seen.push([index, text]) });

  const gen = worker().lastOf('generate');
  assert.equal(gen.question, 'hi');
  for (let i = 0; i < 3; i++) worker().reply({ id: gen.id, type: 'token', index: i, text: `t${i}` });
  worker().reply({ id: gen.id, type: 'done', summary: { text: 't0t1t2', tokens: 3, abstained: false } });

  const summary = await generating;
  assert.deepEqual(seen, [[0, 't0'], [1, 't1'], [2, 't2']]);
  assert.equal(summary.text, 't0t1t2');
  assert.equal(summary.tokens, 3);
});

test('SESSION-4 a worker `error` rejects the request, and marks the session failed',
  async () => {
    const { session, worker } = makeSession();
    const preparing = session.prepare();
    const id = worker().lastOf('prepare').id;
    worker().reply({ id, type: 'error', message: 'a shard failed its SHA-256 check' });
    await assert.rejects(() => preparing, /SHA-256/);
    assert.equal(session.status, 'error');
    assert.match(session.reason, /SHA-256/);
  });

test('SESSION-5 a worker that cannot even be constructed is `unsupported`, not an error',
  () => {
    const { session } = makeSession({
      env: { Worker: class { constructor() { throw new Error('CSP refuses blob: workers'); } } },
    });
    return session.prepare().then((out) => {
      assert.equal(session.status, 'unsupported');
      assert.deepEqual(out, { unsupported: true, reason: session.reason });
      assert.match(session.reason, /CSP/);
    });
  });

test('SESSION-6 no Worker API at all is `unsupported` — §6.2\'s T0 path is a tier, not an error',
  async () => {
    const { session } = makeSession({ env: {} });
    const out = await session.prepare();
    assert.equal(session.status, 'unsupported');
    assert.equal(out.unsupported, true);
    assert.match(session.reason, /Web Worker/);
  });

test('SESSION-7 generate() before prepare() refuses rather than posting anything', async () => {
  const { session, worker } = makeSession();
  assert.equal(worker(), undefined, 'no worker until prepare()');
  await assert.rejects(() => session.generate({ question: 'hi' }),
    /generate\(\) while idle/);
  assert.equal(worker(), undefined, 'a refused call must not have built a worker');
});

test('SESSION-8 dispose() terminates the worker, and a second prepare() starts a new one',
  async () => {
    const { session, made } = makeSession();
    const preparing = session.prepare();
    const first = made[0];
    first.reply({ id: first.lastOf('prepare').id, type: 'ready',
      config: {}, verified: true, bytes: 5, memory: {} });
    await preparing;
    assert.equal(session.status, 'ready');

    session.dispose();
    assert.equal(first.terminated, true, 'terminate is the only thing that frees the model');

    /* A disposed session must be able to start again: §6.4 unloads after idle,
       and the next question has to bring it back without a page reload. */
    const again = session.prepare();
    assert.equal(made.length, 2);
    const second = made[1];
    second.reply({ id: second.lastOf('prepare').id, type: 'ready',
      config: {}, verified: true, bytes: 5, memory: {} });
    await again;
    assert.equal(session.status, 'ready');
  });
