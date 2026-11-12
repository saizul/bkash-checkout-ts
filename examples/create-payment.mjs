// Create a sandbox payment and print the URL to open in a browser.
//   node --env-file=.env examples/create-payment.mjs 50
import { BkashClient } from 'bkash-checkout-ts';

const bkash = BkashClient.fromEnv();
const amount = process.argv[2] ?? '10.00';

const payment = await bkash.createPayment({
  payerReference: 'CUSTOMER-42',
  callbackURL: `${process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'}/bkash/callback`,
  amount,
  merchantInvoiceNumber: `INV-${Date.now()}`,
});

console.log('paymentId:', payment.paymentId);
console.log('open:', payment.bkashURL);
