import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BkashApiError, BkashNetworkError } from '../src/index.js';
import { MockFetch, P, PAYMENT_ID, errorReply, makeClient, tokenReply } from './helpers/mock-fetch.js';

const refundInput = {
  paymentId: PAYMENT_ID,
  trxId: 'DIK80PG0SO',
  refundAmount: 10,
  sku: 'PROD9024',
  reason: 'Wrong Product Received',
};

const refundOk = {
  json: {
    originalTrxId: 'DIK80PG0SO',
    refundTrxId: 'DIK50PG0VX',
    refundTransactionStatus: 'Completed',
    originalTrxAmount: '20',
    refundAmount: '10.00',
    currency: 'BDT',
    completedTime: '2026-09-20T14:47:03:555 GMT+0600',
    sku: 'PROD9024',
    reason: 'Wrong Product Received',
  },
};

const statusOk = {
  json: {
    originalTrxId: 'DIK80PG0SO',
    originalTrxAmount: '20',
    originalTrxCompletedTime: '2026-09-20T14:39:02:266 GMT+0600',
    refundTransactions: [
      { refundTrxId: 'DIK50PG0VX', refundTransactionStatus: 'Completed', refundAmount: '10.00', completedTime: '2026-09-20T14:47:02:000' },
      { refundTrxId: 'DIK90PG0TJ', refundTransactionStatus: 'Completed', refundAmount: '5.00', completedTime: '2026-09-20T14:50:02:000' },
    ],
  },
};

const base = () => new MockFetch().on(P.grant, tokenReply());

describe('refund', () => {
  it('sends the documented body', async () => {
    const mock = base().on(P.refund, refundOk);
    const res = await makeClient(mock).refund(refundInput);
    assert.equal(res.refundTrxId, 'DIK50PG0VX');
    assert.equal(res.source, 'refund');
    assert.deepEqual(mock.last(P.refund)!.body, { ...refundInput, refundAmount: '10.00' });
  });

  it('is not retried on a network error', async () => {
    const mock = base().on(P.refund, { networkError: 'ECONNRESET' });
    await assert.rejects(makeClient(mock).refund(refundInput, { recover: false }), BkashNetworkError);
    assert.equal(mock.count(P.refund), 1);
  });

  it('recovers via Refund Status after a timeout', async () => {
    const mock = base().on(P.refund, { hang: true }).on(P.refundStatus, statusOk);
    const res = await makeClient(mock, { timeoutMs: 20 }).refund(refundInput);
    assert.equal(res.source, 'status');
    assert.equal(res.refundTrxId, 'DIK50PG0VX');
    assert.equal(mock.count(P.refund), 1);
  });

  it('ignores refunds that existed before the call', async () => {
    const mock = base().on(P.refund, { hang: true }).on(P.refundStatus, statusOk);
    await assert.rejects(
      makeClient(mock, { timeoutMs: 20 }).refund(refundInput, { knownRefundTrxIds: ['DIK50PG0VX'] }),
      BkashNetworkError,
    );
  });

  it('maps refund errors', async () => {
    const mock = base().on(P.refund, errorReply('2072', 'Refund amount not valid', 'refund_amount_exceed_payment_amount'));
    await assert.rejects(makeClient(mock).refund(refundInput), (e: unknown) => {
      assert.ok(e instanceof BkashApiError);
      assert.equal(e.code, '2072');
      assert.equal(e.category, 'refund');
      return true;
    });
  });

  it('validates refund input', async () => {
    const c = makeClient(base());
    await assert.rejects(c.refund({ ...refundInput, refundAmount: -1 }), /greater than zero/);
    await assert.rejects(c.refund({ ...refundInput, reason: '' }), /reason/);
    await assert.rejects(c.refund({ ...refundInput, sku: 'x'.repeat(256) }), /255/);
  });
});

describe('refundStatus', () => {
  it('returns the refund list', async () => {
    const mock = base().on(P.refundStatus, statusOk);
    const s = await makeClient(mock).refundStatus({ paymentId: PAYMENT_ID, trxId: 'DIK80PG0SO' });
    assert.equal(s.refundTransactions?.length, 2);
    assert.deepEqual(mock.last(P.refundStatus)!.body, { paymentId: PAYMENT_ID, trxId: 'DIK80PG0SO' });
  });

  it('maps a mismatched trxId error', async () => {
    const mock = base().on(P.refundStatus, errorReply('3045', 'Invalid TrxID', 'ERROR_REFUND_TRANSACTION_ID_MISMATCH'));
    await assert.rejects(makeClient(mock).refundStatus({ paymentId: PAYMENT_ID, trxId: 'X' }), (e: unknown) => {
      assert.ok(e instanceof BkashApiError);
      assert.equal(e.category, 'refund');
      return true;
    });
  });
});
