import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/contact.mjs';

let ip = 0;
const call = async (method, body, headers = {}) => {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(value) { this.body = value; },
  };
  const req = {
    method,
    body,
    headers,
    socket: { remoteAddress: `test-${++ip}` },
  };
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body || '{}') };
};

test('contact endpoint rejects non-POST requests', async () => {
  const res = await call('GET');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('contact endpoint validates the fields before delivery', async () => {
  const res = await call('POST', { name: 'A', email: 'not-an-email', message: 'Hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid payload.');
});

test('contact endpoint reports a missing delivery key without claiming success', async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const res = await call('POST', {
    name: 'Aashish', email: 'sender@example.com', message: 'A real brief.',
  });
  if (previous === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previous;
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'email_not_configured');
});

test('contact endpoint sends a correctly shaped Resend request', async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 'test-key';
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, options, payload: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ id: 'email_123' }) };
  };

  try {
    const res = await call('POST', {
      name: 'Aashish',
      email: 'sender@example.com',
      message: 'A real brief.\nSecond line.',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(sent.url, 'https://api.resend.com/emails');
    assert.equal(sent.options.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(sent.payload.to, ['aashishkumarrajut1345@gmail.com']);
    assert.equal(sent.payload.reply_to, 'sender@example.com');
    assert.match(sent.payload.text, /Second line\./);
    assert.match(sent.payload.html, /<br>/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  }
});
