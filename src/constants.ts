/**
 * Hosts and endpoint paths for the bKash Tokenized Checkout API.
 *
 * The sandbox host and every v2 path below are taken from the public
 * documentation at https://developer.bka.sh. The production host is not
 * printed on those pages; `tokenized.pay.bka.sh` is the host bKash hands to
 * merchants during onboarding and is used by existing integrations, but you
 * should confirm it against the credentials sheet you receive. Both values can
 * be overridden with the `baseUrl` client option.
 */
export const BASE_URLS = Object.freeze({
  sandbox: 'https://tokenized.sandbox.bka.sh',
  production: 'https://tokenized.pay.bka.sh',
});

export type BkashEnvironment = keyof typeof BASE_URLS;

/** Operation names used for path lookup, logging and retry policy. */
export type BkashOperation =
  | 'grantToken'
  | 'refreshToken'
  | 'createPayment'
  | 'executePayment'
  | 'queryPayment'
  | 'searchTransaction'
  | 'refund'
  | 'refundStatus'
  | 'capturePayment'
  | 'voidPayment';

export type EndpointPaths = Record<BkashOperation, string>;

/** Endpoint paths of the v2 Tokenized Checkout API (without agreement). */
export const V2_PATHS: Readonly<EndpointPaths> = Object.freeze({
  grantToken: '/v2/tokenized-checkout/auth/grant-token',
  refreshToken: '/v2/tokenized-checkout/auth/refresh-token',
  createPayment: '/v2/tokenized-checkout/payment/create',
  executePayment: '/v2/tokenized-checkout/payment/execute',
  queryPayment: '/v2/tokenized-checkout/query/payment',
  searchTransaction: '/v2/tokenized-checkout/general/search-transaction',
  refund: '/v2/tokenized-checkout/refund/payment/transaction',
  refundStatus: '/v2/tokenized-checkout/refund/payment/status',
  // Auth & Capture: settle or release a payment created with
  // `intent: 'authorization'` and executed into the `Authorized` state.
  capturePayment: '/v2/tokenized-checkout/payment/confirm/capture',
  voidPayment: '/v2/tokenized-checkout/payment/confirm/void',
});

/** bKash documents a 30 second timeout for every checkout API. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** `id_token` lifetime bKash returns by default (`expires_in`). */
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;

/** bKash recommends refreshing between the 50th and 55th minute. */
export const DEFAULT_REFRESH_SKEW_SECONDS = 300;

/** `refresh_token` lifetime stated in the docs. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

/**
 * bKash blocks an app for one hour when Grant/Refresh Token is called more
 * than twice within an hour. The token manager enforces this locally.
 */
export const DEFAULT_MAX_TOKEN_CALLS_PER_HOUR = 2;

/** The only currency the checkout API accepts today. */
export const CURRENCY_BDT = 'BDT';

/** Status code bKash uses for a successful call. */
export const SUCCESS_STATUS_CODE = '0000';
