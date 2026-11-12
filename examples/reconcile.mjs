// Resolve payments whose callback never finished (customer closed the tab,
// server restarted, execute timed out).
//   node --env-file=.env examples/reconcile.mjs TR0011... TR0011...
import { BkashClient } from 'bkash-checkout-ts';

const bkash = BkashClient.fromEnv();

for (const paymentId of process.argv.slice(2)) {
  try {
    const q = await bkash.queryPayment(paymentId);
    console.log(paymentId, q.transactionStatus, q.trxId ?? '-', q.amount ?? '-');
  } catch (error) {
    console.log(paymentId, 'error', error.code, error.message);
  }
}
