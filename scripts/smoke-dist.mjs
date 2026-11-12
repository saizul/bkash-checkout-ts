// Verifies the ESM build loads through the package "exports" map.
import assert from 'node:assert/strict';
import { BkashClient, BASE_URLS } from 'bkash-checkout-ts';

assert.equal(typeof BkashClient, 'function');
assert.equal(BASE_URLS.sandbox, 'https://tokenized.sandbox.bka.sh');
console.log('esm ok');
