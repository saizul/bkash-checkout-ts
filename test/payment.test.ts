import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BkashAmountMismatchError,
  BkashApiError,
  BkashClient,
  BkashDuplicateExecutionError,
  BkashPaymentAlreadyCompletedError,
  BkashTimeoutError,
  BkashValidationError,
  BASE_URLS,
} from '../src/index.js';
import {
  CREDS,
  MockFetch,
  P,
  PAYMENT_ID,
  createReply,
  errorReply,
  executeReply,
  makeClient,
  queryReply,
  tokenReply,
} from './helpers/mock-fetch.js';

const input = {
  payerReference: '01770618575',
  callbackURL: 'https://shop.example.com/bkash/callback',
  amount: '2.90',
  merchantInvoiceNumber: 'INV-1001',
};

function base() {
  return new MockFetch().on(P.grant, tokenReply());
}

describe('client construction', () => {
  it('defaults to the sandbox host', () => {
    const c = new BkashClient({ ...CREDS, fetch: base().fetch });
    assert.equal(c.baseUrl, BASE_URLS.sandbox);
    assert.equal(c.environment, 'sandbox');
  });

  it('uses the production host and accepts a custom base URL', () => {
    assert.equal(new BkashClient({ ...CREDS, environment: 'production', fetch: base().fetch }).baseUrl, BASE_URLS.production);
    assert.equal(new BkashClient({ ...CREDS, baseUrl: 'https://proxy.example.com/', fetch: base().fetch }).baseUrl, 'https://proxy.example.com');
  });

  it('requires all four credentials', () => {
    assert.throws(() => new BkashClient({ ...CREDS, appSecret: '' }), BkashValidationError);
  });

  it('rejects an unknown environment', () => {
    assert.throws(() => new BkashClient({ ...CREDS, environment: 'live' as never }), /environment/);
  });

  it('builds from environment variables', () => {
    const c = BkashClient.fromEnv(
      { BKASH_USERNAME: 'u', BKASH_PASSWORD: 'p', BKASH_APP_KEY: 'k', BKASH_APP_SECRET: 's', BKASH_ENV: 'production' },
      { fetch: base().fetch },
    );
    assert.equal(c.environment, 'production');
  });

  it('allows path overrides', async () => {
    const mock = base().on('/custom/create', createReply());
    const c = makeClient(mock, { paths: { createPayment: '/custom/create' } });
    await c.createPayment(input);
    assert.equal(mock.count('/custom/create'), 1);
  });
});

describe('createPayment', () => {
  it('sends the documented body and headers', async () => {
    const mock = base().on(P.create, createReply());
    const client = makeClient(mock);
    const res = await client.createPayment({ ...input, amount: 2.9, subMerchantName: 'Shop A' });
    assert.equal(res.paymentId, PAYMENT_ID);
    assert.match(res.bkashURL, /^https:\/\/sandbox\.payment\.bkash\.com/);
    const call = mock.last(P.create)!;
    assert.equal(call.url, `${BASE_URLS.sandbox}${P.create}`);
    assert.equal(call.headers.authorization, 'id-token-1');
    assert.equal(call.headers['x-app-key'], CREDS.appKey);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(call.body, {
      payerReference: '01770618575',
      callbackURL: 'https://shop.example.com/bkash/callback',
      amount: '2.90',
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: 'INV-1001',
      subMerchantName: 'Shop A',
    });
  });

  it('supports the bearer auth scheme', async () => {
    const mock = base().on(P.create, createReply());
    await makeClient(mock, { authScheme: 'bearer' }).createPayment(input);
    assert.equal(mock.last(P.create)!.headers.authorization, 'Bearer id-token-1');
  });

  it('accepts the bKashURL spelling', async () => {
    const reply = createReply() as { json: Record<string, unknown> };
    const json: Record<string, unknown> = { ...reply.json, bKashURL: reply.json.bkashURL };
    delete json.bkashURL;
    const mock = base().on(P.create, { json });
    const res = await makeClient(mock).createPayment(input);
    assert.ok(res.bkashURL.startsWith('https://'));
  });

  it('validates input before sending', async () => {
    const mock = base();
    const c = makeClient(mock);
    await assert.rejects(c.createPayment({ ...input, merchantInvoiceNumber: 'A&B' }), /must not contain/);
    await assert.rejects(c.createPayment({ ...input, amount: '1.999' }), /two places/);
    await assert.rejects(c.createPayment({ ...input, amount: 0 }), /greater than zero/);
    await assert.rejects(c.createPayment({ ...input, currency: 'USD' }), /BDT/);
    await assert.rejects(c.createPayment({ ...input, callbackURL: '/relative' }), /absolute URL/);
    await assert.rejects(c.createPayment({ ...input, intent: 'buy' as never }), /intent/);
    await assert.rejects(c.createPayment({ ...input, subMerchantName: 'x'.repeat(81) }), /80/);
    assert.equal(mock.calls.length, 0);
  });

  it('requires https callbacks in production', async () => {
    const c = makeClient(base(), { environment: 'production' });
    await assert.rejects(c.createPayment({ ...input, callbackURL: 'http://shop.example.com/cb' }), /https/);
  });

  it('maps a v2 error body to BkashApiError', async () => {
    const mock = base().on(P.create, errorReply('2007', 'Invalid currency.', 'invalid_currency'));
    await assert.rejects(makeClient(mock).createPayment(input), (e: unknown) => {
      assert.ok(e instanceof BkashApiError);
      assert.equal(e.code, '2007');
      assert.equal(e.internalCode, 'invalid_currency');
      assert.equal(e.statusMessage, 'Invalid currency.');
      assert.equal(e.category, 'validation');
      return true;
    });
  });

  it('rejects a success body without paymentId', async () => {
    const mock = base().on(P.create, { json: { statusCode: '0000' } });
    await assert.rejects(makeClient(mock).createPayment(input), /paymentId/);
  });

  it('retries create on a network error', async () => {
    const mock = base().on(P.create, { networkError: 'ECONNRESET' }, createReply());
    const res = await makeClient(mock).createPayment(input);
    assert.equal(res.paymentId, PAYMENT_ID);
    assert.equal(mock.count(P.create), 2);
  });
});

describe('executePayment', () => {
  it('executes and returns the transaction', async () => {
    const mock = base().on(P.execute, executeReply());
    const res = await makeClient(mock).executePayment(PAYMENT_ID);
    assert.equal(res.trxId, 'DIK20PG0H4');
    assert.equal(res.transactionStatus, 'Completed');
    assert.equal(res.source, 'execute');
    assert.deepEqual(mock.last(P.execute)!.body, { paymentId: PAYMENT_ID });
  });

  it('never sends a second execute for the same payment', async () => {
    const mock = base().on(P.execute, executeReply());
    const c = makeClient(mock);
    const first = await c.executePayment(PAYMENT_ID);
    const second = await c.executePayment(PAYMENT_ID);
    assert.equal(mock.count(P.execute), 1);
    assert.equal(second.source, 'cache');
    assert.equal(second.trxId, first.trxId);
  });

  it('shares one request between concurrent executes', async () => {
    const mock = base().on(P.execute, async () => {
      await new Promise((r) => setTimeout(r, 15));
      return executeReply();
    });
    const c = makeClient(mock);
    const results = await Promise.all([c.executePayment(PAYMENT_ID), c.executePayment(PAYMENT_ID), c.executePayment(PAYMENT_ID)]);
    assert.equal(mock.count(P.execute), 1);
    assert.ok(results.every((r) => r.trxId === 'DIK20PG0H4'));
  });

  it('reports a lock held by another process', async () => {
    const mock = base().on(P.execute, executeReply());
    const c = makeClient(mock);
    await c.guard.store.acquire(PAYMENT_ID, { state: 'in_progress', startedAt: Date.now() }, 60_000);
    await assert.rejects(c.executePayment(PAYMENT_ID), BkashDuplicateExecutionError);
    assert.equal(mock.count(P.execute), 0);
  });

  it('does not retry execute on timeout; resolves with Query Payment', async () => {
    const mock = base().on(P.execute, { hang: true }).on(P.query, queryReply('Completed'));
    const c = makeClient(mock, { timeoutMs: 20 });
    const res = await c.executePayment(PAYMENT_ID);
    assert.equal(mock.count(P.execute), 1);
    assert.equal(res.source, 'query');
    assert.equal(res.trxId, 'DIK20PG0H4');
    assert.equal(res.merchantInvoiceNumber, 'INV-1001');
    const again = await c.executePayment(PAYMENT_ID);
    assert.equal(again.source, 'cache');
  });

  it('rethrows the timeout when the query says Initiated and frees the lock', async () => {
    const mock = base().on(P.execute, { hang: true }).on(P.query, queryReply('Initiated'));
    const c = makeClient(mock, { timeoutMs: 20 });
    await assert.rejects(c.executePayment(PAYMENT_ID), BkashTimeoutError);
    assert.equal(await c.guard.store.get(PAYMENT_ID), undefined);
  });

  it('keeps the lock when the outcome stays unknown', async () => {
    const mock = base().on(P.execute, { networkError: 'socket hang up' }).on(P.query, { networkError: 'down' });
    const c = makeClient(mock, { retry: { retries: 0 } });
    await assert.rejects(c.executePayment(PAYMENT_ID), /network error/);
    assert.equal((await c.guard.store.get(PAYMENT_ID))?.state, 'in_progress');
  });

  it('recovers from "already completed" (2062) via query', async () => {
    const mock = base()
      .on(P.execute, errorReply('2062', 'The payment has already been completed', 'payment_already_completed'))
      .on(P.query, queryReply('Completed'));
    const res = await makeClient(mock).executePayment(PAYMENT_ID);
    assert.equal(res.source, 'query');
  });

  it('throws BkashPaymentAlreadyCompletedError when recovery is off', async () => {
    const mock = base().on(P.execute, errorReply('2062', 'The payment has already been completed', 'payment_already_completed'));
    await assert.rejects(makeClient(mock).executePayment(PAYMENT_ID, { recover: false }), BkashPaymentAlreadyCompletedError);
  });

  it('releases the lock on a definite API failure', async () => {
    const mock = base().on(P.execute, errorReply('2002', 'Invalid Payment ID', 'invalid_payment_id'));
    const c = makeClient(mock);
    await assert.rejects(c.executePayment(PAYMENT_ID), (e: unknown) => e instanceof BkashApiError && e.category === 'not_found');
    assert.equal(await c.guard.store.get(PAYMENT_ID), undefined);
  });

  it('checks the expected amount', async () => {
    const mock = base().on(P.execute, executeReply(PAYMENT_ID, '1.00'));
    const c = makeClient(mock);
    await assert.rejects(c.executePayment(PAYMENT_ID, { expectedAmount: '2.90' }), BkashAmountMismatchError);
    // Cached result is checked too.
    await assert.rejects(c.executePayment(PAYMENT_ID, { expectedAmount: 2.9 }), BkashAmountMismatchError);
    const ok = await c.executePayment(PAYMENT_ID, { expectedAmount: 1 });
    assert.equal(ok.amount, '1.00');
  });
});

describe('query and search', () => {
  it('queries a payment', async () => {
    const mock = base().on(P.query, queryReply('Completed'));
    const q = await makeClient(mock).queryPayment(PAYMENT_ID);
    assert.equal(q.transactionStatus, 'Completed');
    assert.deepEqual(mock.last(P.query)!.body, { paymentId: PAYMENT_ID });
  });

  it('retries query on network errors with backoff', async () => {
    const delays: number[] = [];
    const mock = base().on(P.query, { networkError: 'ETIMEDOUT' }, { networkError: 'ETIMEDOUT' }, queryReply());
    const c = makeClient(mock, { sleep: async (ms) => void delays.push(ms), retry: { jitter: false, baseDelayMs: 100 } });
    await c.queryPayment(PAYMENT_ID);
    assert.equal(mock.count(P.query), 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it('searches a transaction by trxId', async () => {
    const mock = base().on(P.search, {
      json: { trxId: 'DIK80PG0SO', transactionStatus: 'Completed', amount: '20.00', currency: 'BDT', transactionType: 'bKash Tokenized Checkout via API' },
    });
    const t = await makeClient(mock).searchTransaction('DIK80PG0SO');
    assert.equal(t.amount, '20.00');
    assert.deepEqual(mock.last(P.search)!.body, { trxId: 'DIK80PG0SO' });
  });

  it('rejects empty identifiers', async () => {
    const c = makeClient(base());
    await assert.rejects(c.queryPayment(''), BkashValidationError);
    await assert.rejects(c.searchTransaction('  '), BkashValidationError);
  });
});
