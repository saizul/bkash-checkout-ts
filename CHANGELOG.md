# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Auth & Capture: `capturePayment()` and `voidPayment()` for payments created with `intent: 'authorization'`, with
  `capturePayment`/`voidPayment` entries in `V2_PATHS` and `NON_RETRYABLE_OPERATIONS`.
- Capture/void guard sharing the `idempotencyStore` (key `confirm:<paymentId>`): concurrent calls share one request,
  repeats return the stored result with `source: 'cache'`, and capture-after-void or void-after-capture throws the new
  `BkashConfirmConflictError` without calling bKash.
- Capture/void recovery through Query Payment after a timeout, network error or "already completed".
- `expectedAmount` on `capturePayment()`.
- `handleCallback()` returns `status: 'authorized'` when Execute reports `Authorized`.
- `ConfirmResult`, `CaptureOptions`, `VoidOptions`, `ConfirmAction` and `ConfirmPaymentResponse` types.
- Example: `examples/capture.mjs`.

### Changed

- `handleCallback()` reports an `Authorized` payment as `authorized` instead of `not_completed`.
- Execute recovery accepts `Authorized` from Query Payment as a successful execute, so a timed-out execute of an
  authorization payment is no longer left locked.
- `BkashAmountMismatchError` takes an optional `operation` (default `executePayment`).

## [0.1.0] - 2026-11-12

### Added

- `BkashClient` for the bKash Tokenized Checkout v2 API: Grant Token, Refresh Token, Create Payment, Execute
  Payment, Query Payment, Search Transaction, Refund and Refund Status.
- Sandbox and production base URLs, per-endpoint path overrides and `BkashClient.fromEnv()`.
- Token manager with caching, renewal at the 55th minute, refresh-before-grant, single-flight requests and a local
  two-calls-per-hour budget. Pluggable `TokenStore`.
- Typed errors mapping both `statusCode`/`statusMessage` and `externalCode`/`errorMessageEn`/`internalCode` bodies,
  with error categories and `registerErrorCode()`.
- HTTP layer with per-attempt timeout, exponential backoff with jitter on network errors and 502/503/504, abort
  signals, injectable `fetch` and redacted structured logging.
- Double-execute guard (`ExecutionGuard`) with pluggable `IdempotencyStore`.
- Execute recovery through Query Payment and refund recovery through Refund Status after timeouts.
- `expectedAmount` check and `BkashAmountMismatchError`.
- `parseCallback()` and `handleCallback()` for the callback route.
- ESM and CommonJS builds with type declarations.
- Examples: Express checkout, create payment, refund, reconciliation, Redis stores, CommonJS.
- CI on Node 20, 22 and 24, and a GitHub Packages publish workflow.

[Unreleased]: https://github.com/saizul/bkash-checkout-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/bkash-checkout-ts/releases/tag/v0.1.0
