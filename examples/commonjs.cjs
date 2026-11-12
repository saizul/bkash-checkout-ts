// The package ships a CommonJS build too.
//   node --env-file=.env examples/commonjs.cjs <paymentId>
const { BkashClient } = require('bkash-checkout-ts');

async function main() {
  const bkash = BkashClient.fromEnv();
  const status = await bkash.queryPayment(process.argv[2]);
  console.log(status.transactionStatus);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
