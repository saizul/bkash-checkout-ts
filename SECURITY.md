# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through
[GitHub Security Advisories](https://github.com/saizul/bkash-checkout-ts/security/advisories/new). Include the
affected version, a description, steps to reproduce and the impact you expect. You should receive a reply within
7 days. Once a fix is released, the advisory is published with credit to the reporter unless you prefer otherwise.

Do not include real bKash credentials, tokens or customer wallet numbers in reports. If a secret has been exposed,
rotate it with bKash first.

## Scope

In scope: anything in this repository that could lead to double charging, accepting an unpaid order, leaking
credentials or tokens, or bypassing the double-execute guard, the capture/void guard or the amount check.

Out of scope: vulnerabilities in the bKash platform itself (report those to bKash), and issues that need an attacker
who already controls your server or credentials.

## Recommendations for users

- Keep credentials on the server and in a secret manager, never in source control.
- Verify every payment with `executePayment` or `queryPayment` and `expectedAmount`; never trust the callback query
  string.
- Use shared stores (`tokenStore`, `idempotencyStore`) when you run more than one process.
