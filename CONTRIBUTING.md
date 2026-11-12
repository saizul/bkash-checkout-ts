# Contributing

Thanks for helping improve bkash-checkout-ts. Bug reports, documentation fixes and pull requests are welcome.

## Getting started

```bash
git clone https://github.com/saizul/bkash-checkout-ts.git
cd bkash-checkout-ts
npm install
npm run lint
npm test
```

Node.js 20 or newer is required.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/client.ts` | `BkashClient`: public API methods and recovery logic |
| `src/token.ts`, `src/token-store.ts` | Token caching, renewal and the hourly call budget |
| `src/http.ts` | fetch wrapper: timeout, backoff, logging |
| `src/errors.ts`, `src/error-codes.ts` | Error classes and bKash code mapping |
| `src/idempotency.ts` | Double-execute guard |
| `src/callback.ts` | Callback parsing and handling |
| `src/validation.ts`, `src/redact.ts` | Input checks and log redaction |
| `test/` | `node:test` suites; `test/helpers/mock-fetch.ts` is the scripted fetch |
| `examples/` | Runnable examples |

## Guidelines

- **Follow the official docs.** Every endpoint, header and field must be traceable to
  [developer.bka.sh](https://developer.bka.sh). If something cannot be confirmed, make it configurable and add it to
  the README "Limitations" section. Link the doc page in your pull request.
- **No real credentials.** Use the placeholders in `test/helpers/mock-fetch.ts` and `.env.example`. Do not paste
  real tokens, wallet numbers or sandbox responses that contain them.
- **Money-moving calls are never retried blindly.** Changes to retry behaviour for Execute or Refund need a test
  that shows no duplicate request is sent.
- **Tests for every change.** Add or update tests next to the feature; `npm test` must pass.
- **Zero runtime dependencies.** Development dependencies are fine.
- **Style.** `npm run lint` must pass. Keep public APIs typed and documented with TSDoc.
- **Changelog.** Add a line under `[Unreleased]` in `CHANGELOG.md`.

## Commit messages

Short imperative subject line (`Add agreement API`, `Fix refund recovery amount match`), with details in the body
when needed.

## Releasing

1. Update the version in `package.json` and `src/version.ts`, and move `[Unreleased]` entries in `CHANGELOG.md`.
2. Tag `vX.Y.Z` and publish a GitHub release. The `Publish to GitHub Packages` workflow builds, tests and publishes
   `@saizul/bkash-checkout-ts`.

## Code of conduct

Be respectful and constructive. Harassment of any kind is not tolerated.
