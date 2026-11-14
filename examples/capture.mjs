// Auth & Capture: settle or release a payment created with
// `intent: 'authorization'` once the customer's callback reported `authorized`.
//   node --env-file=.env examples/capture.mjs capture <paymentId> <amount>
//   node --env-file=.env examples/capture.mjs void <paymentId>
import { BkashClient, BkashApiError, BkashConfirmConflictError } from 'bkash-checkout-ts';

const [action, paymentId, amount] = process.argv.slice(2);
if ((action !== 'capture' && action !== 'void') || !paymentId || (action === 'capture' && !amount)) {
  console.error('usage: capture.mjs capture <paymentId> <amount> | void <paymentId>');
  process.exit(1);
}

const bkash = BkashClient.fromEnv();

try {
  const res =
    action === 'capture'
      ? await bkash.capturePayment(paymentId, { expectedAmount: amount })
      : await bkash.voidPayment(paymentId);
  console.log(`${res.action} ${res.paymentId} ${res.transactionStatus ?? '-'} (${res.source})`);
} catch (error) {
  if (error instanceof BkashConfirmConflictError) console.error(error.message);
  else if (error instanceof BkashApiError) console.error(`bKash said: ${error.statusMessage} [${error.code}]`);
  else throw error;
}
