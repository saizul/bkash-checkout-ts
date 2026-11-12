// Express checkout with the bKash callback route.
//
//   npm install bkash-checkout-ts express
//   cp .env.example .env   # fill in sandbox credentials
//   node --env-file=.env examples/express-checkout.mjs
//
// Flow: POST /checkout -> redirect to bkashURL -> bKash redirects the customer
// to GET /bkash/callback?paymentID=...&status=... -> execute -> order paid.
import express from 'express';
import { BkashClient, handleCallback, BkashError } from 'bkash-checkout-ts';

const bkash = BkashClient.fromEnv(process.env, {
  logger: (entry) => {
    if (entry.level !== 'debug') console.log('[bkash]', entry);
  },
});

// Stand-in for your database. Replace with real persistence.
const orders = new Map(); // invoice -> { amount, status, paymentId, trxId }
const byPaymentId = new Map(); // paymentId -> invoice

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post('/checkout', async (req, res) => {
  const invoice = `INV-${Date.now()}`;
  const amount = '120.00'; // always take the amount from your cart, never from the browser
  orders.set(invoice, { amount, status: 'pending' });
  try {
    const payment = await bkash.createPayment({
      payerReference: invoice,
      callbackURL: `${process.env.PUBLIC_BASE_URL}/bkash/callback`,
      amount,
      merchantInvoiceNumber: invoice,
    });
    orders.get(invoice).paymentId = payment.paymentId;
    byPaymentId.set(payment.paymentId, invoice);
    res.redirect(303, payment.bkashURL);
  } catch (error) {
    const message = error instanceof BkashError && 'statusMessage' in error ? error.statusMessage : 'Payment could not be started';
    res.status(502).send(message);
  }
});

app.get('/bkash/callback', async (req, res) => {
  const paymentId = String(req.query.paymentID ?? '');
  const invoice = byPaymentId.get(paymentId);
  if (!invoice) return res.status(404).send('Unknown payment');
  const order = orders.get(invoice);

  // handleCallback executes only when status=success, never twice for the
  // same paymentID, and checks the amount bKash charged against your order.
  const outcome = await handleCallback(bkash, req.query, { expectedAmount: order.amount });

  switch (outcome.status) {
    case 'completed':
      order.status = 'paid';
      order.trxId = outcome.payment.trxId;
      return res.redirect(303, `/orders/${invoice}?paid=1`);
    case 'cancel':
      order.status = 'cancelled';
      return res.redirect(303, `/orders/${invoice}?cancelled=1`);
    case 'failure':
    case 'not_completed':
      order.status = 'failed';
      return res.redirect(303, `/orders/${invoice}?failed=1`);
    case 'error':
      // Network trouble leaves the outcome unknown: keep the order pending and
      // reconcile later with bkash.queryPayment(paymentId).
      console.error('[bkash] callback error', outcome.error.code, outcome.error.message);
      return res.redirect(303, `/orders/${invoice}?pending=1`);
  }
});

app.get('/orders/:invoice', (req, res) => {
  res.json(orders.get(req.params.invoice) ?? null);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
