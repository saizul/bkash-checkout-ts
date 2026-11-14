# bkash-checkout-ts

Typed TypeScript SDK for the **bKash Tokenized Checkout API** (v2).

[![CI](https://github.com/saizul/bkash-checkout-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/bkash-checkout-ts/actions/workflows/ci.yml)
[![Publish](https://github.com/saizul/bkash-checkout-ts/actions/workflows/publish-github-packages.yml/badge.svg)](https://github.com/saizul/bkash-checkout-ts/actions/workflows/publish-github-packages.yml)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![module](https://img.shields.io/badge/module-ESM%20%2B%20CJS-blue)
![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

bKash is the largest mobile wallet in Bangladesh. Its checkout API is simple on paper, but a production integration has
to get some details right: the token may only be requested twice an hour, a payment may only be executed once, a
timed-out execute must be resolved with a query instead of a retry, and errors arrive in two different shapes. This
SDK handles those details so your callback route stays short.

> Read [Limitations](#limitations) before going live. The SDK is tested against mocked responses built from the
> public documentation, not against the live bKash API.

## Contents

- [Features](#features)
- [Install](#install)
- [Install from GitHub Packages](#install-from-github-packages)
- [Quick start](#quick-start)
- [Payment flow](#payment-flow)
- [API reference](#api-reference)
- [Errors](#errors)
- [Configuration](#configuration)
- [Retries, timeouts and double execution](#retries-timeouts-and-double-execution)
- [Multi-process deployments](#multi-process-deployments)
- [Examples](#examples)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Full checkout surface** - Grant Token, Refresh Token, Create Payment, Execute Payment, Query Payment, Search
  Transaction, Refund, Refund Status, and Capture / Void for `intent: 'authorization'` payments.
- **Token caching** - the `id_token` is cached and renewed at the 55th minute, Refresh Token is preferred over Grant
  Token, concurrent callers share one in-flight request, and a local budget stops you from exceeding bKash's
  "two calls per hour" rule (which blocks the app for an hour).
- **Typed errors** - both `statusCode`/`statusMessage` and `externalCode`/`errorMessageEn`/`internalCode` bodies map to
  `BkashApiError` with a `code`, a customer-safe `statusMessage`, the Bangla message when present and a `category`.
- **Retry with backoff** - exponential backoff with jitter on network errors and 502/503/504 for read-only and
  create calls. Execute and Refund are never retried blindly.
- **Double-execute guard** - concurrent or replayed callbacks for the same `paymentID` share one execute request; the
  result is remembered for 24 hours. Pluggable store for Redis or a database.
- **Outcome recovery** - a timed-out Execute is resolved with Query Payment, a timed-out Refund with Refund Status,
  exactly as the bKash docs recommend.
- **Auth & Capture** - `capturePayment()` and `voidPayment()` finish an authorized payment. Capture and void share
  one guard per payment, so a payment can never be both captured and voided, and a timed-out call is resolved with
  Query Payment.
- **Amount check** - `expectedAmount` makes Execute fail with `BkashAmountMismatchError` if bKash charged a different
  amount from your order.
- **Callback helper** - `handleCallback()` parses `paymentID`/`status`, executes only on `success`, and returns one of
  `completed`, `not_completed`, `failure`, `cancel` or `error`.
- **Injectable `fetch`** - tests mock HTTP without a server; the default is the global `fetch` of Node 20+.
- **Input validation** - amount format, `BDT` only, `<>&` rejected in invoice/reference fields, length limits,
  absolute https callback URLs in production.
- **Redacted logging** - structured log entries never contain credentials, tokens or app secrets.
- **ESM and CommonJS** builds with type declarations, zero runtime dependencies.

## Install

```bash
npm install bkash-checkout-ts
```

Requires Node.js 20 or newer (or any runtime with a WHATWG `fetch`, `AbortController` and `Response`).

## Install from GitHub Packages

Every release is also published to GitHub Packages as `@saizul/bkash-checkout-ts`.

1. Create a GitHub personal access token (classic) with the `read:packages` scope.
2. Add an `.npmrc` next to your `package.json`:

   ```ini
   @saizul:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   ```

3. Install with the token in your environment:

   ```bash
   export GITHUB_TOKEN=ghp_your_token_here
   npm install @saizul/bkash-checkout-ts
   ```

4. Import the scoped name:

   ```ts
   import { BkashClient } from '@saizul/bkash-checkout-ts';
   ```

In GitHub Actions, use `secrets.GITHUB_TOKEN` with `permissions: packages: read`.

## Quick start

```ts
import { BkashClient, handleCallback } from 'bkash-checkout-ts';

const bkash = new BkashClient({
  environment: 'sandbox', // or 'production'
  username: process.env.BKASH_USERNAME!,
  password: process.env.BKASH_PASSWORD!,
  appKey: process.env.BKASH_APP_KEY!,
  appSecret: process.env.BKASH_APP_SECRET!,
});

// 1. Create the payment and send the customer to bKash.
const payment = await bkash.createPayment({
  payerReference: 'CUSTOMER-42',
  callbackURL: 'https://shop.example.com/bkash/callback',
  amount: 120.5, // sent as "120.50"
  merchantInvoiceNumber: 'INV-1001',
});
redirect(payment.bkashURL);

// 2. In GET /bkash/callback, finish the payment.
const outcome = await handleCallback(bkash, req.query, { expectedAmount: '120.50' });
if (outcome.status === 'completed') {
  markOrderPaid('INV-1001', outcome.payment.trxId);
}
```

`BkashClient.fromEnv()` reads `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_ENV`
and `BKASH_BASE_URL`. See [.env.example](.env.example).

CommonJS works too:

```js
const { BkashClient } = require('bkash-checkout-ts');
```

## Payment flow

```
Your server                         bKash                          Customer
-----------                         -----                          --------
createPayment()  ---------------->  /payment/create
                 <----------------  paymentId, bkashURL
redirect(bkashURL) ------------------------------------------------>  wallet, OTP, PIN
                                    redirects customer to
GET callbackURL?paymentID=..&status=success|failure|cancel  <-----
executePayment() ---------------->  /payment/execute
                 <----------------  trxId, transactionStatus=Completed
(timeout?) queryPayment() ------->  /query/payment
```

The `status` in the callback query string comes from the customer's browser. Only the Execute or Query response is
proof of payment, which is why `handleCallback` never reports `completed` from the query string alone.

## API reference

### `new BkashClient(options)`

See [Configuration](#configuration) for every option.

| Method | bKash API | Returns |
| --- | --- | --- |
| `grantToken()` | `POST /v2/tokenized-checkout/auth/grant-token` | `CachedToken` |
| `refreshToken()` | `POST /v2/tokenized-checkout/auth/refresh-token` | `CachedToken` |
| `createPayment(input, { signal })` | `POST /v2/tokenized-checkout/payment/create` | `CreatePaymentResponse` |
| `executePayment(paymentId, { expectedAmount, recover, signal })` | `POST /v2/tokenized-checkout/payment/execute` | `ExecuteResult` |
| `queryPayment(paymentId, { signal })` | `POST /v2/tokenized-checkout/query/payment` | `QueryPaymentResponse` |
| `searchTransaction(trxId, { signal })` | `POST /v2/tokenized-checkout/general/search-transaction` | `SearchTransactionResponse` |
| `refund(input, { recover, knownRefundTrxIds, signal })` | `POST /v2/tokenized-checkout/refund/payment/transaction` | `RefundResult` |
| `refundStatus({ paymentId, trxId }, { signal })` | `POST /v2/tokenized-checkout/refund/payment/status` | `RefundStatusResponse` |
| `capturePayment(paymentId, { expectedAmount, recover, signal })` | `POST /v2/tokenized-checkout/payment/confirm/capture` | `ConfirmResult` |
| `voidPayment(paymentId, { recover, signal })` | `POST /v2/tokenized-checkout/payment/confirm/void` | `ConfirmResult` |

You normally never call `grantToken()` or `refreshToken()`: every other method obtains a valid token on its own.

#### `createPayment(input)`

| Field | Required | Notes |
| --- | --- | --- |
| `payerReference` | yes | Max 255 chars. A wallet number here is pre-filled on the bKash page. |
| `callbackURL` | yes | Absolute URL. bKash appends `paymentID`, `status` and `signature`. |
| `amount` | yes | Number or string, at most two decimals. Numbers are sent as `"2.90"`. |
| `merchantInvoiceNumber` | yes | Max 255 chars, no `<`, `>` or `&`. |
| `currency` | no | Only `BDT`. |
| `intent` | no | `sale` (default) or `authorization`. |
| `subMerchantName` | no | Aggregators only, max 80 chars. |
| `merchantAssociationInfo` | no | Aggregators only, TLV formatted, max 255 chars. |
| `extra` | no | Extra body fields sent verbatim. |

The response contains `paymentId`, `bkashURL` (the docs also spell it `bKashURL`; both are accepted and normalized),
the three callback URLs, `transactionStatus: 'Initiated'` and the echoed fields. A `paymentId` is valid for 24 hours.

#### `executePayment(paymentId, options)`

Returns the Execute response plus `source`:

- `execute` - from the Execute API,
- `query` - the execute timed out or bKash said "already completed" (2062) and Query Payment reported `Completed`,
- `cache` - this payment was already executed through this guard.

Options: `expectedAmount` (throws `BkashAmountMismatchError` on mismatch), `recover` (default `true`), `signal`.

#### `refund(input, options)`

`{ paymentId, trxId, refundAmount, sku, reason }`. bKash allows up to 10 partial refunds per transaction within
60 days and rejects a duplicate refund within 10 minutes. On a timeout, the SDK calls Refund Status and returns a
completed refund of the same amount with `source: 'status'`. Pass `knownRefundTrxIds` (refunds that existed before)
so an older refund of the same amount is never mistaken for this one.

#### `capturePayment(paymentId, options)` and `voidPayment(paymentId, options)`

With `intent: 'authorization'`, Execute Payment only holds the amount on the customer's wallet and returns
`transactionStatus: 'Authorized'` (and `handleCallback` reports `authorized`). Settle the hold with
`capturePayment()` (status becomes `Completed`) or release it with `voidPayment()` (status becomes `Cancelled`):

```ts
const outcome = await handleCallback(bkash, req.query, { expectedAmount: order.amount });
if (outcome.status === 'authorized') {
  // Later, when the goods ship:
  const captured = await bkash.capturePayment(outcome.paymentId, { expectedAmount: order.amount });
  markOrderPaid(order.id, captured.trxId);
  // Or, if the order is cancelled: await bkash.voidPayment(outcome.paymentId);
}
```

Both return the bKash response plus `action` (`capture` or `void`) and `source`:

- `confirm` - from the Capture or Void API,
- `query` - the call timed out (or bKash said "already completed") and Query Payment showed the final state,
- `cache` - this payment was already captured or voided through this guard.

Capture and void are guarded together, per `paymentId`, through the same `idempotencyStore` as execute (under the
key `confirm:<paymentId>`):

- concurrent calls for the same action share one request; a repeated call returns the stored result;
- a capture after a void, a void after a capture, or either one while the other is still running throws
  `BkashConfirmConflictError` without calling bKash. `completedAction` tells you what already happened (`undefined`
  while it is still in progress);
- an API error releases the lock so you can try again; an unknown outcome (call and query both failed) keeps it until
  it expires (2 minutes).

`expectedAmount` on capture checks the amount bKash reports and throws `BkashAmountMismatchError`; the capture has
already happened by then, so treat it as a reconciliation alarm. Check the authorized amount before capturing by
passing `expectedAmount` to `executePayment` / `handleCallback`.

### `handleCallback(client, query, options)`

`query` can be `req.query`, a `URLSearchParams`, a raw query string or a full URL. Returns:

| `status` | Meaning |
| --- | --- |
| `completed` | Executed and bKash reported `Completed`. `payment` holds the response. |
| `authorized` | Executed an `intent: 'authorization'` payment and bKash reported `Authorized`. Capture or void it. |
| `not_completed` | Executed but the status was not `Completed`. |
| `failure` / `cancel` | The customer failed or cancelled; nothing was executed. |
| `error` | Bad query string, API error or unknown outcome. `error` is a `BkashError`. |

### `parseCallback(query)`

Returns `{ paymentId, status, signature }` or throws `BkashValidationError`.

### Other exports

`BASE_URLS`, `V2_PATHS`, `TokenManager`, `MemoryTokenStore`, `ExecutionGuard`, `MemoryIdempotencyStore`,
`HttpClient`, `extractStatus`, `toApiError`, `describeErrorCode`, `registerErrorCode`, `formatAmount`, `toPaisa`,
`redact`, `maskWallet`, `VERSION`, and every request/response type.

## Errors

Every error extends `BkashError` (`code`, `operation`, `httpStatus`, `raw`, `retryable`).

| Class | When |
| --- | --- |
| `BkashApiError` | bKash returned a failure. Has `statusMessage` (safe to show), `messageBn`, `internalCode`, `category`. |
| `BkashAuthError` | Grant/Refresh failed, HTTP 401/403, or code `9999`. |
| `BkashPaymentAlreadyCompletedError` | Code `2062`. Recovered automatically unless `recover: false`. |
| `BkashValidationError` | Rejected locally before any request. Has `field`. |
| `BkashNetworkError` | No HTTP response. Outcome unknown. |
| `BkashTimeoutError` | No response within `timeoutMs`. Outcome unknown. |
| `BkashResponseError` | Non-JSON body or an HTTP error without bKash fields. |
| `BkashTokenRateLimitError` | The local token-call budget is spent. Has `retryAt`. |
| `BkashDuplicateExecutionError` | Another process holds the execute lock for this payment. |
| `BkashAmountMismatchError` | `expectedAmount` differs from the charged or captured amount. |
| `BkashConfirmConflictError` | A capture or void was refused because the payment is being, or was, confirmed the other way. |

```ts
try {
  await bkash.createPayment(input);
} catch (error) {
  if (error instanceof BkashApiError) {
    showToCustomer(error.statusMessage); // bKash asks merchants to show the message, not the code
    log(error.code, error.internalCode, error.category);
  } else if (error instanceof BkashNetworkError) {
    // retry later
  } else {
    throw error;
  }
}
```

`category` is one of `auth`, `validation`, `payment_state`, `refund`, `not_found`, `rate_limit`, `server` or
`unknown`. Only codes that appear in the public documentation are built in; add your own with
`registerErrorCode('2029', { category: 'payment_state', description: '...', retryable: false })`.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `username`, `password`, `appKey`, `appSecret` | required | Credentials from your bKash onboarding sheet. |
| `environment` | `'sandbox'` | `'sandbox'` or `'production'`. |
| `baseUrl` | from `environment` | Override the host (proxy, or the host on your onboarding sheet). |
| `paths` | `V2_PATHS` | Override individual endpoint paths. |
| `authScheme` | `'raw'` | `raw` sends the `id_token` as the `Authorization` value, as the bKash samples do; `bearer` adds `Bearer `. |
| `fetch` | `globalThis.fetch` | Any WHATWG-compatible fetch. |
| `timeoutMs` | `30000` | Per-attempt timeout (bKash documents 30 s). |
| `retry` | `{ retries: 2, baseDelayMs: 500, maxDelayMs: 8000, factor: 2, jitter: true, retryOnGatewayErrors: true }` | Backoff policy for safe operations. |
| `logger` | none | `(entry: LogEntry) => void`, receives redacted entries. |
| `tokenStore` | in memory | Share the token and the call budget across processes. |
| `idempotencyStore` | in memory | Share the double-execute guard across processes. |
| `refreshSkewSeconds` | `300` | Renew this many seconds before expiry. |
| `maxTokenCallsPerHour` | `2` | Local cap on Grant+Refresh calls; `0` disables it. |
| `allowHttpCallback` | `true` in sandbox | Allow `http://` callback URLs. |
| `now`, `sleep`, `random` | real ones | Injectable for deterministic tests. |

Base URLs:

| Environment | Host |
| --- | --- |
| sandbox | `https://tokenized.sandbox.bka.sh` |
| production | `https://tokenized.pay.bka.sh` (see [Limitations](#limitations)) |

## Retries, timeouts and double execution

| Operation | Retried on network error / 502-504 | On timeout |
| --- | --- | --- |
| Grant / Refresh Token | yes | error |
| Create Payment | yes (an unexecuted payment expires harmlessly) | error |
| Execute Payment | **never** | Query Payment decides |
| Query Payment, Search Transaction, Refund Status | yes | error |
| Refund | **never** | Refund Status decides |
| Capture / Void Payment | **never** | Query Payment decides |

API errors (a JSON failure body from bKash) are never retried. A 401 drops the cached token and resends once, because
a rejected token means the request was not processed.

The execute guard works in three layers:

1. Concurrent calls in one process share the same promise.
2. A store lock (`acquire`) stops other processes; they get `BkashDuplicateExecutionError` while it is held.
3. The completed result is stored for 24 hours, so a replayed callback returns it with `source: 'cache'`.

If the outcome stays unknown (execute and query both failed), the lock is kept until it expires (2 minutes) so
nothing executes twice. Reconcile such payments later with `queryPayment()`.

## Multi-process deployments

With several Node processes, containers or serverless instances on one bKash app, give them shared stores. Both
interfaces are small:

```ts
interface TokenStore {
  get(): Promise<CachedToken | undefined>;
  set(token: CachedToken): Promise<void>;
  clear(): Promise<void>;
  getCallLog(): Promise<number[]>;
  setCallLog(log: number[]): Promise<void>;
}

interface IdempotencyStore {
  acquire(paymentId: string, record: ExecutionRecord, ttlMs: number): Promise<boolean>; // must be atomic
  get(paymentId: string): Promise<ExecutionRecord | undefined>;
  set(paymentId: string, record: ExecutionRecord, ttlMs: number): Promise<void>;
  delete(paymentId: string): Promise<void>;
}
```

A Redis implementation (`SET NX PX` for `acquire`) is in [examples/redis-stores.mjs](examples/redis-stores.mjs).

## Examples

| File | What it shows |
| --- | --- |
| [examples/express-checkout.mjs](examples/express-checkout.mjs) | Express checkout and the callback route |
| [examples/create-payment.mjs](examples/create-payment.mjs) | Create a sandbox payment from the command line |
| [examples/refund.mjs](examples/refund.mjs) | Partial refund with timeout recovery |
| [examples/capture.mjs](examples/capture.mjs) | Capture or void an authorized payment |
| [examples/reconcile.mjs](examples/reconcile.mjs) | Resolve payments whose callback never finished |
| [examples/redis-stores.mjs](examples/redis-stores.mjs) | Redis-backed token store and execute guard |
| [examples/commonjs.cjs](examples/commonjs.cjs) | Using the CommonJS build |

```bash
cp .env.example .env    # sandbox credentials
npm install express
node --env-file=.env examples/express-checkout.mjs
```

## Testing

```bash
npm install
npm run lint        # eslint + tsc --noEmit
npm test            # compiles and runs node:test suites
npm run build       # dist/esm + dist/cjs
npm run test:dist   # loads both builds through the exports map
```

The tests use a scripted `fetch` (see [test/helpers/mock-fetch.ts](test/helpers/mock-fetch.ts)), so they need no
network or credentials. You can use the same approach in your own tests:

```ts
const client = new BkashClient({
  username: 'u', password: 'p', appKey: 'k', appSecret: 's',
  fetch: async (url, init) => new Response(JSON.stringify(fakeReplyFor(url, init))),
  sleep: async () => {},
});
```

## Security notes

- Keep `username`, `password`, `app_key` and `app_secret` on the server only. Never send them to the browser.
- Never trust the callback `status`. Fulfil an order only after `executePayment` or `queryPayment` reports
  `Completed`, and always pass `expectedAmount` taken from your database.
- Map `paymentID` back to your own order record. Reject callbacks for payment ids you did not create.
- The callback `signature` parameter is returned for reference; bKash does not publish how to verify it, so this SDK
  does not claim to.
- Logs and error `raw` bodies are redacted (credentials and tokens), but they may still contain wallet numbers. Use
  `maskWallet()` before logging `payerAccount`.
- Use https callback URLs in production (enforced by default).
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Limitations

- **Not tested against the live API.** Request and response fields follow the public pages at
  [developer.bka.sh](https://developer.bka.sh) (Grant Token, Refresh Token, Create/Execute Payment without agreement,
  Query Payment, Search Transaction, Refund, Refund Status). Test in the sandbox before going live.
- **Production host.** The public docs only print the sandbox host. `https://tokenized.pay.bka.sh` is the host in
  common use; confirm it against your onboarding sheet and set `baseUrl` if it differs.
- **Authorization header format.** The docs say "Bearer token" while the curl samples send the raw `id_token`. The
  default is the raw token; switch with `authScheme: 'bearer'`.
- **Legacy API.** Only the v2 paths are built in. Older `v1.2.0-beta` integrations use other paths and field names
  (`paymentID`, `trxID`); `paths` can be overridden, but field names are not translated.
- **Agreement.** Agreement creation and payment with agreement are not wrapped yet.
- **Capture and Void paths.** `payment/confirm/capture` and `payment/confirm/void` with the body `{ paymentId }` are
  modelled on the bKash Auth & Capture API and have not been checked against the live API. Confirm them in the
  sandbox and override `paths.capturePayment` / `paths.voidPayment` if your onboarding sheet differs. A `Cancelled` payment is
  treated as voided, even when the hold was released by bKash rather than by you.
- **Error catalogue.** Only error codes printed in the docs samples are described. Unknown codes still raise
  `BkashApiError` with `category: 'unknown'`.
- **Callback signature.** Not verified (algorithm not published).
- **Timestamps.** bKash times such as `2026-09-20T12:31:28:970 GMT+0600` do not match the documented format and are
  returned as strings, unparsed.
- **Refund recovery** matches by amount; with several refunds of the same amount, pass `knownRefundTrxIds`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) - Copyright (c) 2026 Saizul Amin.

This project is not affiliated with or endorsed by bKash Limited. "bKash" is a trademark of its owner.
