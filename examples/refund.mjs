// Partial refund with recovery on timeout.
//   node --env-file=.env examples/refund.mjs <paymentId> <trxId> <amount>
import { BkashClient, BkashApiError } from 'bkash-checkout-ts';

const [paymentId, trxId, amount] = process.argv.slice(2);
if (!paymentId || !trxId || !amount) {
  console.error('usage: refund.mjs <paymentId> <trxId> <amount>');
  process.exit(1);
}

const bkash = BkashClient.fromEnv();

// Record refunds that already exist, so timeout recovery cannot mistake an
// older refund of the same amount for this one.
const before = await bkash.refundStatus({ paymentId, trxId }).catch(() => ({ refundTransactions: [] }));
const known = (before.refundTransactions ?? []).map((r) => r.refundTrxId);

try {
  const refund = await bkash.refund(
    { paymentId, trxId, refundAmount: amount, sku: 'ORDER-ITEMS', reason: 'Customer returned the product' },
    { knownRefundTrxIds: known },
  );
  console.log(`refund ${refund.refundTrxId} ${refund.refundTransactionStatus} (${refund.source})`);
} catch (error) {
  if (error instanceof BkashApiError) console.error(`bKash said: ${error.statusMessage} [${error.code}]`);
  else throw error;
}
