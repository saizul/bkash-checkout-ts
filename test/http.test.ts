import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BkashApiError, BkashError, BkashResponseError, HttpClient, type LogEntry } from '../src/index.js';
import { CREDS, MockFetch, P, PAYMENT_ID, makeClient, queryReply, tokenReply } from './helpers/mock-fetch.js';

const spec = { operation: 'queryPayment' as const, path: '/q', headers: {}, body: { a: 1 } };

describe('HttpClient', () => {
  it('computes exponential backoff capped by maxDelayMs', () => {
    const h = new HttpClient({ baseUrl: 'https://x', fetch: async () => new Response('{}'), retry: { jitter: false, baseDelayMs: 100, maxDelayMs: 300 } });
    assert.deepEqual([1, 2, 3, 4].map((n) => h.backoffDelay(n)), [100, 200, 300, 300]);
  });

  it('applies jitter within [50%, 100%]', () => {
    const h = new HttpClient({ baseUrl: 'https://x', fetch: async () => new Response('{}'), random: () => 0, retry: { baseDelayMs: 100 } });
    assert.equal(h.backoffDelay(1), 50);
  });

  it('gives up after the configured retries', async () => {
    const mock = new MockFetch().on('/q', { networkError: 'down' });
    const h = new HttpClient({ baseUrl: 'https://x', fetch: mock.fetch, sleep: async () => {}, retry: { retries: 3 } });
    await assert.rejects(h.post(spec), /network error: down/);
    assert.equal(mock.count('/q'), 4);
  });

  it('retries 503 responses for safe operations', async () => {
    const mock = new MockFetch().on('/q', { status: 503, text: '<html>busy</html>' }, { json: { ok: 1 } });
    const h = new HttpClient({ baseUrl: 'https://x', fetch: mock.fetch, sleep: async () => {} });
    assert.deepEqual(await h.post(spec), { ok: 1 });
  });

  it('does not retry API errors', async () => {
    const mock = new MockFetch().on('/q', { json: { externalCode: '2002', errorMessageEn: 'Invalid Payment ID' } });
    const h = new HttpClient({ baseUrl: 'https://x', fetch: mock.fetch, sleep: async () => {} });
    await assert.rejects(h.post(spec), BkashApiError);
    assert.equal(mock.count('/q'), 1);
  });

  it('throws BkashResponseError on non-JSON', async () => {
    const mock = new MockFetch().on('/q', { status: 400, text: 'Bad gateway html' });
    const h = new HttpClient({ baseUrl: 'https://x', fetch: mock.fetch });
    await assert.rejects(h.post(spec), (e: unknown) => e instanceof BkashResponseError && e.httpStatus === 400);
  });

  it('throws BkashResponseError on an HTTP error without bKash fields', async () => {
    const mock = new MockFetch().on('/q', { status: 400, json: { foo: 'bar' } });
    const h = new HttpClient({ baseUrl: 'https://x', fetch: mock.fetch });
    await assert.rejects(h.post(spec), (e: unknown) => e instanceof BkashResponseError && e.code === 'HTTP_400');
  });

  it('honours an abort signal without retrying', async () => {
    const mock = new MockFetch().on('/q', { hang: true });
    const h = new HttpClient({ baseUrl: 'https://x', fetch: mock.fetch, sleep: async () => {} });
    const ac = new AbortController();
    const p = h.post({ ...spec, signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e: unknown) => e instanceof BkashError && e.code === 'ABORTED');
    assert.equal(mock.count('/q'), 1);
  });

  it('survives a throwing logger', async () => {
    const mock = new MockFetch().on('/q', { json: {} });
    const h = new HttpClient({ baseUrl: 'https://x', fetch: mock.fetch, logger: () => { throw new Error('boom'); } });
    assert.deepEqual(await h.post(spec), {});
  });

  it('requires a fetch implementation', () => {
    const original = globalThis.fetch;
    // @ts-expect-error simulate an environment without fetch
    delete globalThis.fetch;
    try {
      assert.throws(() => new HttpClient({ baseUrl: 'https://x' }), /fetch/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('logging and redaction', () => {
  it('never logs credentials or tokens', async () => {
    const logs: LogEntry[] = [];
    const mock = new MockFetch().on(P.grant, tokenReply('secret-id-token')).on(P.query, { networkError: `failed with secret-id-token ${CREDS.password}` }, queryReply());
    const c = makeClient(mock, { logger: (e) => logs.push(e) });
    await c.queryPayment(PAYMENT_ID);
    const text = JSON.stringify(logs);
    assert.ok(logs.some((l) => l.event === 'retry'));
    assert.ok(!text.includes('secret-id-token'));
    assert.ok(!text.includes(CREDS.password));
  });

  it('redacts token values from error raw bodies', async () => {
    const mock = new MockFetch().on(P.grant, tokenReply('secret-id-token')).on(P.query, {
      json: { externalCode: '9', errorMessageEn: 'bad', echo: 'secret-id-token', id_token: 'z' },
    });
    await assert.rejects(makeClient(mock).queryPayment(PAYMENT_ID), (e: unknown) => {
      const raw = JSON.stringify((e as BkashApiError).raw);
      assert.ok(!raw.includes('secret-id-token'));
      assert.ok(raw.includes('[REDACTED]'));
      return true;
    });
  });
});
