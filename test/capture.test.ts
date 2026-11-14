import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BkashAmountMismatchError,
  BkashApiError,
  BkashConfirmConflictError,
  BkashNetworkError,
  BkashTimeoutError,
  BkashValidationError,
  MemoryIdempotencyStore,
  NON_RETRYABLE_OPERATIONS,
  V2_PATHS,
  handleCallback,
} from '../src/index.js';
import {
  Clock,
  MockFetch,
  P,
  PAYMENT_ID,
  confirmReply,
  errorReply,
  executeReply,
  makeClient,
  queryReply,
  tokenReply,
} from './helpers/mock-fetch.js';

function base() {
  return new MockFetch().on(P.grant, tokenReply());
}

describe('auth & capture paths', () => {
  it('adds capture and void to the v2 paths and never retries them', () => {
    assert.equal(V2_PATHS.capturePayment, P.capture);
    assert.equal(V2_PATHS.voidPayment, P.void);
    assert.ok(NON_RETRYABLE_OPERATIONS.has('capturePayment'));
    assert.ok(NON_RETRYABLE_OPERATIONS.has('voidPayment'));
  });

  it('honours path overrides', async () => {
    const mock = base().on('/custom/capture', confirmReply());
    const c = makeClient(mock, { paths: { capturePayment: '/custom/capture' } });
    await c.capturePayment(PAYMENT_ID);
    assert.equal(mock.count('/custom/capture'), 1);
  });
});

describe('capturePayment', () => {
  it('sends the paymentId with auth headers and returns the result', async () => {
    const mock = base().on(P.capture, confirmReply('Completed'));
    const res = await makeClient(mock).capturePayment(PAYMENT_ID, { expectedAmount: 2.9 });
    assert.equal(res.transactionStatus, 'Completed');
    assert.equal(res.action, 'capture');
    assert.equal(res.source, 'confirm');
    assert.equal(res.trxId, 'DIK20PG0H4');
    const call = mock.last(P.capture)!;
    assert.deepEqual(call.body, { paymentId: PAYMENT_ID });
    assert.equal(call.headers.authorization, 'id-token-1');
  });

  it('validates the paymentId before sending anything', async () => {
    const mock = base();
    await assert.rejects(makeClient(mock).capturePayment(''), BkashValidationError);
    await assert.rejects(makeClient(mock).voidPayment(''), BkashValidationError);
    assert.equal(mock.calls.length, 0);
  });

  it('shares one request between concurrent captures', async () => {
    const mock = base().on(P.capture, confirmReply());
    const c = makeClient(mock);
    const [a, b] = await Promise.all([c.capturePayment(PAYMENT_ID), c.capturePayment(PAYMENT_ID)]);
    assert.equal(a.trxId, b.trxId);
    assert.equal(mock.count(P.capture), 1);
  });

  it('returns the stored result for a repeated capture', async () => {
    const mock = base().on(P.capture, confirmReply());
    const c = makeClient(mock);
    await c.capturePayment(PAYMENT_ID);
    const again = await c.capturePayment(PAYMENT_ID);
    assert.equal(again.source, 'cache');
    assert.equal(again.action, 'capture');
    assert.equal(mock.count(P.capture), 1);
  });

  it('throws BkashAmountMismatchError when the captured amount differs', async () => {
    const mock = base().on(P.capture, confirmReply('Completed', PAYMENT_ID, '5.00'));
    const err = await makeClient(mock)
      .capturePayment(PAYMENT_ID, { expectedAmount: '2.90' })
      .catch((e: unknown) => e);
    assert.ok(err instanceof BkashAmountMismatchError);
    assert.equal(err.operation, 'capturePayment');
    assert.equal(err.actual, '5.00');
  });

  it('releases the lock after an API error so the capture can be retried', async () => {
    const mock = base().on(P.capture, errorReply('2056', 'Invalid Payment State', 'invalid_payment_state'), confirmReply());
    const c = makeClient(mock);
    await assert.rejects(c.capturePayment(PAYMENT_ID), BkashApiError);
    const res = await c.capturePayment(PAYMENT_ID);
    assert.equal(res.source, 'confirm');
    assert.equal(mock.count(P.capture), 2);
    assert.equal(mock.count(P.query), 0);
  });

  it('does not store a response that left the payment unconfirmed', async () => {
    const mock = base().on(P.capture, confirmReply('Authorized'), confirmReply('Completed'));
    const c = makeClient(mock);
    assert.equal((await c.capturePayment(PAYMENT_ID)).transactionStatus, 'Authorized');
    assert.equal((await c.capturePayment(PAYMENT_ID)).source, 'confirm');
    assert.equal(mock.count(P.capture), 2);
  });
});

describe('capture recovery', () => {
  it('resolves a timed-out capture with Query Payment instead of retrying', async () => {
    const mock = base().on(P.capture, { hang: true }).on(P.query, queryReply('Completed'));
    const c = makeClient(mock, { timeoutMs: 20 });
    const res = await c.capturePayment(PAYMENT_ID, { expectedAmount: '2.90' });
    assert.equal(res.source, 'query');
    assert.equal(res.action, 'capture');
    assert.equal(res.merchantInvoiceNumber, 'INV-1001');
    assert.equal(mock.count(P.capture), 1);
    assert.equal((await c.capturePayment(PAYMENT_ID)).source, 'cache');
  });

  it('releases the lock when Query Payment says the payment is still Authorized', async () => {
    const mock = base()
      .on(P.capture, { networkError: 'socket hang up' }, confirmReply())
      .on(P.query, queryReply('Authorized'));
    const c = makeClient(mock);
    await assert.rejects(c.capturePayment(PAYMENT_ID), BkashNetworkError);
    assert.equal((await c.capturePayment(PAYMENT_ID)).source, 'confirm');
    assert.equal(mock.count(P.capture), 2);
  });

  it('keeps the lock when both capture and query fail', async () => {
    const store = new MemoryIdempotencyStore();
    const mock = base().on(P.capture, { networkError: 'reset' }).on(P.query, { networkError: 'down' });
    const c = makeClient(mock, { idempotencyStore: store, retry: { retries: 0 } });
    await assert.rejects(c.capturePayment(PAYMENT_ID), BkashNetworkError);
    const err = await c.capturePayment(PAYMENT_ID).catch((e: unknown) => e);
    assert.ok(err instanceof BkashConfirmConflictError);
    assert.equal(err.code, 'CONFIRM_IN_PROGRESS');
    assert.equal(mock.count(P.capture), 1);
  });

  it('lets the lock expire so a stuck capture can be resolved later', async () => {
    const clock = new Clock();
    const mock = base()
      .on(P.capture, { networkError: 'reset' }, confirmReply())
      .on(P.query, { networkError: 'down' });
    const c = makeClient(mock, { now: clock.now, retry: { retries: 0 } });
    await assert.rejects(c.capturePayment(PAYMENT_ID), BkashNetworkError);
    clock.advance(121_000);
    assert.equal((await c.capturePayment(PAYMENT_ID)).source, 'confirm');
  });

  it('reports a conflict when the query shows the payment was voided', async () => {
    const mock = base().on(P.capture, { networkError: 'reset' }).on(P.query, queryReply('Cancelled'));
    const c = makeClient(mock);
    const err = await c.capturePayment(PAYMENT_ID).catch((e: unknown) => e);
    assert.ok(err instanceof BkashConfirmConflictError);
    assert.equal(err.completedAction, 'void');
    // Remembered: a later void is answered from the store.
    assert.equal((await c.voidPayment(PAYMENT_ID)).source, 'cache');
  });

  it('does not query when recover is false', async () => {
    const mock = base().on(P.capture, { hang: true });
    const c = makeClient(mock, { timeoutMs: 20 });
    await assert.rejects(c.capturePayment(PAYMENT_ID, { recover: false }), BkashTimeoutError);
    assert.equal(mock.count(P.query), 0);
  });

  it('recovers from "already completed" through Query Payment', async () => {
    const mock = base()
      .on(P.capture, errorReply('2062', 'The payment has already been completed', 'payment_already_completed'))
      .on(P.query, queryReply('Completed'));
    const res = await makeClient(mock).capturePayment(PAYMENT_ID);
    assert.equal(res.source, 'query');
  });
});

describe('voidPayment', () => {
  it('voids an authorized payment', async () => {
    const mock = base().on(P.void, confirmReply('Cancelled'));
    const res = await makeClient(mock).voidPayment(PAYMENT_ID);
    assert.equal(res.action, 'void');
    assert.equal(res.transactionStatus, 'Cancelled');
    assert.deepEqual(mock.last(P.void)!.body, { paymentId: PAYMENT_ID });
  });

  it('refuses to capture a voided payment without calling bKash', async () => {
    const mock = base().on(P.void, confirmReply('Cancelled')).on(P.capture, confirmReply());
    const c = makeClient(mock);
    await c.voidPayment(PAYMENT_ID);
    const err = await c.capturePayment(PAYMENT_ID).catch((e: unknown) => e);
    assert.ok(err instanceof BkashConfirmConflictError);
    assert.equal(err.code, 'CONFIRM_CONFLICT');
    assert.equal(err.action, 'capture');
    assert.equal(err.completedAction, 'void');
    assert.equal(mock.count(P.capture), 0);
  });

  it('refuses to void a captured payment', async () => {
    const mock = base().on(P.capture, confirmReply()).on(P.void, confirmReply('Cancelled'));
    const c = makeClient(mock);
    await c.capturePayment(PAYMENT_ID);
    await assert.rejects(c.voidPayment(PAYMENT_ID), /already been captured/);
    assert.equal(mock.count(P.void), 0);
  });

  it('rejects a void while a capture is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mock = base()
      .on(P.capture, async () => {
        await gate;
        return confirmReply();
      })
      .on(P.void, confirmReply('Cancelled'));
    const c = makeClient(mock);
    const capture = c.capturePayment(PAYMENT_ID);
    const err = await c.voidPayment(PAYMENT_ID).catch((e: unknown) => e);
    assert.ok(err instanceof BkashConfirmConflictError);
    assert.equal(err.completedAction, undefined);
    release();
    assert.equal((await capture).action, 'capture');
    assert.equal(mock.count(P.void), 0);
  });

  it('blocks a second process through a shared store', async () => {
    const store = new MemoryIdempotencyStore();
    const one = base().on(P.void, confirmReply('Cancelled'));
    const two = base().on(P.capture, confirmReply());
    await makeClient(one, { idempotencyStore: store }).voidPayment(PAYMENT_ID);
    await assert.rejects(makeClient(two, { idempotencyStore: store }).capturePayment(PAYMENT_ID), BkashConfirmConflictError);
    assert.equal(two.count(P.capture), 0);
  });

  it('keeps execute and confirm records apart in a shared store', async () => {
    const store = new MemoryIdempotencyStore();
    const mock = base()
      .on(P.execute, executeReply())
      .on(P.capture, confirmReply());
    const c = makeClient(mock, { idempotencyStore: store });
    await c.executePayment(PAYMENT_ID);
    await c.capturePayment(PAYMENT_ID);
    assert.equal(store.size, 2);
    assert.equal(store.get(PAYMENT_ID)?.state, 'completed');
    assert.equal(store.get(`confirm:${PAYMENT_ID}`)?.state, 'completed');
  });

  it('resolves a timed-out void with Query Payment', async () => {
    const mock = base().on(P.void, { hang: true }).on(P.query, queryReply('Cancelled'));
    const res = await makeClient(mock, { timeoutMs: 20 }).voidPayment(PAYMENT_ID);
    assert.equal(res.source, 'query');
    assert.equal(res.action, 'void');
    assert.equal(mock.count(P.void), 1);
  });
});

describe('authorization intent through execute and callback', () => {
  const authorizedExecute = () => {
    const reply = executeReply() as { json: Record<string, unknown> };
    return { json: { ...reply.json, transactionStatus: 'Authorized', intent: 'authorization' } };
  };

  it('reports authorized from handleCallback, then captures', async () => {
    const mock = base().on(P.execute, authorizedExecute()).on(P.capture, confirmReply());
    const c = makeClient(mock);
    const out = await handleCallback(c, { paymentID: PAYMENT_ID, status: 'success' }, { expectedAmount: '2.90' });
    assert.equal(out.status, 'authorized');
    const captured = await c.capturePayment(PAYMENT_ID, { expectedAmount: '2.90' });
    assert.equal(captured.transactionStatus, 'Completed');
  });

  it('recovers a timed-out execute that left the payment Authorized', async () => {
    const mock = base().on(P.execute, { hang: true }).on(P.query, queryReply('Authorized'));
    const c = makeClient(mock, { timeoutMs: 20 });
    const res = await c.executePayment(PAYMENT_ID);
    assert.equal(res.source, 'query');
    assert.equal(res.transactionStatus, 'Authorized');
    assert.equal((await c.executePayment(PAYMENT_ID)).source, 'cache');
  });
});
