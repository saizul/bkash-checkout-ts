import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BkashValidationError, handleCallback, parseCallback } from '../src/index.js';
import { MockFetch, P, PAYMENT_ID, errorReply, executeReply, makeClient, tokenReply } from './helpers/mock-fetch.js';

describe('parseCallback', () => {
  it('parses a query string, URL, URLSearchParams and object', () => {
    const qs = `paymentID=${PAYMENT_ID}&status=success&signature=abc`;
    const expected = { paymentId: PAYMENT_ID, status: 'success', signature: 'abc' };
    assert.deepEqual(parseCallback(qs), expected);
    assert.deepEqual(parseCallback(`https://shop.example.com/cb?${qs}`), expected);
    assert.deepEqual(parseCallback(new URLSearchParams(qs)), expected);
    assert.deepEqual(parseCallback({ paymentID: [PAYMENT_ID], status: 'SUCCESS', signature: 'abc' }), expected);
  });

  it('rejects missing or odd values', () => {
    assert.throws(() => parseCallback('status=success'), BkashValidationError);
    assert.throws(() => parseCallback(`paymentID=${PAYMENT_ID}&status=paid`), /status/);
    assert.throws(() => parseCallback('paymentID=<script>&status=success'), /format/);
  });
});

describe('handleCallback', () => {
  const base = () => new MockFetch().on(P.grant, tokenReply());

  it('executes on success', async () => {
    const mock = base().on(P.execute, executeReply());
    const out = await handleCallback(makeClient(mock), { paymentID: PAYMENT_ID, status: 'success' }, { expectedAmount: '2.90' });
    assert.equal(out.status, 'completed');
    assert.equal(mock.count(P.execute), 1);
  });

  it('does not execute on failure or cancel', async () => {
    const mock = base();
    const c = makeClient(mock);
    assert.deepEqual(await handleCallback(c, { paymentID: PAYMENT_ID, status: 'cancel' }), { status: 'cancel', paymentId: PAYMENT_ID });
    assert.deepEqual(await handleCallback(c, { paymentID: PAYMENT_ID, status: 'failure' }), { status: 'failure', paymentId: PAYMENT_ID });
    assert.equal(mock.calls.length, 0);
  });

  it('reports not_completed when bKash does not say Completed', async () => {
    const reply = executeReply() as { json: Record<string, unknown> };
    const mock = base().on(P.execute, { json: { ...reply.json, transactionStatus: 'Initiated' } });
    const out = await handleCallback(makeClient(mock), { paymentID: PAYMENT_ID, status: 'success' });
    assert.equal(out.status, 'not_completed');
  });

  it('wraps errors instead of throwing', async () => {
    const mock = base().on(P.execute, errorReply('2002', 'Invalid Payment ID', 'invalid_payment_id'));
    const out = await handleCallback(makeClient(mock), { paymentID: PAYMENT_ID, status: 'success' });
    assert.equal(out.status, 'error');
    if (out.status === 'error') assert.equal(out.error.code, '2002');
    const bad = await handleCallback(makeClient(mock), 'nothing=here');
    assert.equal(bad.status, 'error');
  });

  it('is safe against a replayed callback', async () => {
    const mock = base().on(P.execute, executeReply());
    const c = makeClient(mock);
    const q = { paymentID: PAYMENT_ID, status: 'success' };
    const [a, b] = await Promise.all([handleCallback(c, q), handleCallback(c, q)]);
    assert.equal(a.status, 'completed');
    assert.equal(b.status, 'completed');
    assert.equal(mock.count(P.execute), 1);
  });
});
