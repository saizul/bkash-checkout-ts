// Verifies the CommonJS build loads through the package "exports" map.
const assert = require('node:assert/strict');
const sdk = require('bkash-checkout-ts');

assert.equal(typeof sdk.BkashClient, 'function');
assert.equal(sdk.BASE_URLS.sandbox, 'https://tokenized.sandbox.bka.sh');
console.log('cjs ok');
