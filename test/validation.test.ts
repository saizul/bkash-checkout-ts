import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExecutionGuard, MemoryIdempotencyStore, formatAmount, maskWallet, redact, toPaisa } from '../src/index.js';
import { Clock } from './helpers/mock-fetch.js';

describe('formatAmount', () => {
  it('formats numbers with two decimals', () => {
    assert.equal(formatAmount('a', 2.9), '2.90');
    assert.equal(formatAmount('a', 100), '100.00');
    assert.equal(formatAmount('a', 0.1 + 0.2), '0.30');
  });
  it('passes valid strings through', () => {
    assert.equal(formatAmount('a', '10'), '10');
    assert.equal(formatAmount('a', ' 10.5 '), '10.5');
  });
  it('rejects bad values', () => {
    for (const v of [1.234, '1.234', 'abc', '-1', Number.NaN, Infinity, 0, '0.00']) {
      assert.throws(() => formatAmount('a', v as never));
    }
    assert.throws(() => formatAmount('a', null as never), /number or numeric string/);
  });
});

describe('toPaisa', () => {
  it('converts exactly', () => {
    assert.equal(toPaisa('2.90'), 290);
    assert.equal(toPaisa('2.9'), 290);
    assert.equal(toPaisa('16'), 1600);
    assert.equal(toPaisa(0.3), 30);
  });
});

describe('redaction', () => {
  it('redacts sensitive keys deeply and known secrets', () => {
    const out = redact({ password: 'p', nested: { id_token: 't', note: 'contains abcdef' }, list: [{ app_secret: 's' }] }, ['abcdef']);
    assert.deepEqual(out, { password: '[REDACTED]', nested: { id_token: '[REDACTED]', note: 'contains [REDACTED]' }, list: [{ app_secret: '[REDACTED]' }] });
  });
  it('masks wallet numbers', () => {
    assert.equal(maskWallet('01770618575'), '017*****575');
    assert.equal(maskWallet('123'), '***');
    assert.equal(maskWallet(undefined), undefined);
  });
});

describe('ExecutionGuard', () => {
  it('expires locks and results', async () => {
    const clock = new Clock();
    const store = new MemoryIdempotencyStore(clock.now);
    const g = new ExecutionGuard({ store, now: clock.now, lockTtlMs: 1000, resultTtlMs: 5000 });
    assert.deepEqual(await g.begin('p1'), { kind: 'acquired' });
    assert.deepEqual(await g.begin('p1'), { kind: 'in_progress' });
    clock.advance(1001);
    assert.deepEqual(await g.begin('p1'), { kind: 'acquired' });
    await g.complete('p1', { paymentId: 'p1', trxId: 'T' });
    const second = await g.begin('p1');
    assert.equal(second.kind, 'completed');
    clock.advance(5001);
    assert.equal(store.size, 1);
    assert.deepEqual(await g.begin('p1'), { kind: 'acquired' });
  });
  it('release frees the lock', async () => {
    const g = new ExecutionGuard();
    await g.begin('p2');
    await g.release('p2');
    assert.deepEqual(await g.begin('p2'), { kind: 'acquired' });
  });
});
