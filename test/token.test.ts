import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BkashAuthError, BkashTokenRateLimitError, MemoryTokenStore } from '../src/index.js';
import { Clock, CREDS, MockFetch, P, createReply, makeClient, tokenReply, errorReply } from './helpers/mock-fetch.js';

const input = {
  payerReference: '01770618575',
  callbackURL: 'https://shop.example.com/bkash/callback',
  amount: 2.9,
  merchantInvoiceNumber: 'INV-1001',
};

describe('token management', () => {
  it('sends credentials in headers and body on grant', async () => {
    const mock = new MockFetch().on(P.grant, tokenReply());
    const client = makeClient(mock);
    const token = await client.grantToken();
    assert.equal(token.idToken, 'id-token-1');
    const call = mock.last(P.grant)!;
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.username, CREDS.username);
    assert.equal(call.headers.password, CREDS.password);
    assert.deepEqual(call.body, { app_key: CREDS.appKey, app_secret: CREDS.appSecret });
  });

  it('caches the token across API calls', async () => {
    const mock = new MockFetch().on(P.grant, tokenReply()).on(P.create, createReply());
    const client = makeClient(mock);
    await client.createPayment(input);
    await client.createPayment(input);
    await client.createPayment(input);
    assert.equal(mock.count(P.grant), 1);
    assert.equal(mock.count(P.create), 3);
  });

  it('shares one grant between concurrent callers', async () => {
    const mock = new MockFetch().on(P.grant, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return tokenReply();
    }).on(P.create, createReply());
    const client = makeClient(mock);
    await Promise.all([client.createPayment(input), client.createPayment(input), client.createPayment(input)]);
    assert.equal(mock.count(P.grant), 1);
  });

  it('refreshes with the refresh token near expiry (55th minute)', async () => {
    const clock = new Clock();
    const mock = new MockFetch()
      .on(P.grant, tokenReply('id-1', 'rt-1'))
      .on(P.refresh, tokenReply('id-2', 'rt-2'))
      .on(P.create, createReply());
    const client = makeClient(mock, { now: clock.now });
    await client.createPayment(input);
    clock.advance(54 * 60_000);
    await client.createPayment(input);
    assert.equal(mock.count(P.refresh), 0, 'still fresh at minute 54');
    clock.advance(2 * 60_000);
    await client.createPayment(input);
    assert.equal(mock.count(P.refresh), 1);
    assert.equal(mock.last(P.refresh)!.body.refresh_token, 'rt-1');
    assert.equal(mock.last(P.create)!.headers.authorization, 'id-2');
  });

  it('falls back to grant when the refresh token is rejected', async () => {
    const clock = new Clock();
    const mock = new MockFetch()
      .on(P.grant, tokenReply('id-1', 'rt-1'), tokenReply('id-3', 'rt-3'))
      .on(P.refresh, { json: { statusCode: '9999', statusMessage: 'Invalid refresh token' } })
      .on(P.create, createReply());
    const client = makeClient(mock, { now: clock.now, maxTokenCallsPerHour: 0 });
    await client.createPayment(input);
    clock.advance(3600_000);
    await client.createPayment(input);
    assert.equal(mock.count(P.grant), 2);
    assert.equal(mock.last(P.create)!.headers.authorization, 'id-3');
  });

  it('grants again once the refresh token is older than 30 days', async () => {
    const clock = new Clock();
    const mock = new MockFetch().on(P.grant, tokenReply()).on(P.create, createReply());
    const client = makeClient(mock, { now: clock.now });
    await client.createPayment(input);
    clock.advance(31 * 24 * 3600_000);
    await client.createPayment(input);
    assert.equal(mock.count(P.refresh), 0);
    assert.equal(mock.count(P.grant), 2);
  });

  it('enforces the two-calls-per-hour budget locally', async () => {
    const clock = new Clock();
    const mock = new MockFetch().on(P.grant, tokenReply());
    const client = makeClient(mock, { now: clock.now });
    await client.grantToken();
    await client.grantToken();
    await assert.rejects(client.grantToken(), (e: unknown) => {
      assert.ok(e instanceof BkashTokenRateLimitError);
      assert.equal(e.retryAt, clock.t - 0 + 3600_000);
      return true;
    });
    assert.equal(mock.count(P.grant), 2);
    assert.equal(await client.tokens.remainingTokenCalls(), 0);
    clock.advance(3600_001);
    await client.grantToken();
    assert.equal(mock.count(P.grant), 3);
  });

  it('maps a grant failure to BkashAuthError with the bKash message', async () => {
    const mock = new MockFetch().on(P.grant, {
      json: { statusCode: '9999', statusMessage: 'Invalid or unrecognized access credentials.' },
    });
    const client = makeClient(mock);
    await assert.rejects(client.grantToken(), (e: unknown) => {
      assert.ok(e instanceof BkashAuthError);
      assert.equal(e.code, '9999');
      assert.equal(e.statusMessage, 'Invalid or unrecognized access credentials.');
      assert.equal(e.category, 'auth');
      return true;
    });
  });

  it('uses a shared token store when provided', async () => {
    const store = new MemoryTokenStore();
    const mock = new MockFetch().on(P.grant, tokenReply()).on(P.create, createReply());
    const a = makeClient(mock, { tokenStore: store });
    const b = makeClient(mock, { tokenStore: store });
    await a.createPayment(input);
    await b.createPayment(input);
    assert.equal(mock.count(P.grant), 1);
  });

  it('drops the token and retries once on HTTP 401', async () => {
    const mock = new MockFetch()
      .on(P.grant, tokenReply('id-1'), tokenReply('id-2'))
      .on(P.create, errorReply('401', 'Unauthorized', 'unauthorized', 401), createReply());
    const client = makeClient(mock);
    const res = await client.createPayment(input);
    assert.equal(res.paymentId, 'TR0011NaM01uE1789885888970');
    assert.equal(mock.count(P.grant), 2);
    assert.equal(mock.last(P.create)!.headers.authorization, 'id-2');
  });

  it('refresh() without a cached token throws', async () => {
    const client = makeClient(new MockFetch());
    await assert.rejects(client.refreshToken(), /No cached token/);
  });

  it('rejects a token response without id_token', async () => {
    const mock = new MockFetch().on(P.grant, { json: { statusCode: '0000', expires_in: '3600' } });
    await assert.rejects(makeClient(mock).grantToken(), BkashAuthError);
  });
});
