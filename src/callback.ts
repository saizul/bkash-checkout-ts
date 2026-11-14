import type { BkashClient, ExecuteOptions, ExecuteResult } from './client.js';
import { BkashError, BkashValidationError } from './errors.js';
import type { CallbackStatus } from './types.js';

export type CallbackQuery =
  | string
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

export interface ParsedCallback {
  paymentId: string;
  status: CallbackStatus;
  signature: string | undefined;
}

function pick(query: CallbackQuery, ...names: string[]): string | undefined {
  if (typeof query === 'string') {
    const qs = query.includes('?') ? query.slice(query.indexOf('?') + 1) : query;
    return pick(new URLSearchParams(qs), ...names);
  }
  for (const name of names) {
    let v: string | string[] | null | undefined;
    if (query instanceof URLSearchParams) v = query.get(name);
    else v = query[name];
    if (Array.isArray(v)) v = v[0];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Parses the query string bKash appends to `callbackURL`:
 * `?paymentID=TR...&status=success|failure|cancel&signature=...`.
 */
export function parseCallback(query: CallbackQuery): ParsedCallback {
  const paymentId = pick(query, 'paymentID', 'paymentId');
  if (!paymentId) throw new BkashValidationError('paymentID', 'missing from callback');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(paymentId)) {
    throw new BkashValidationError('paymentID', 'has an unexpected format');
  }
  const status = pick(query, 'status')?.toLowerCase();
  if (status !== 'success' && status !== 'failure' && status !== 'cancel') {
    throw new BkashValidationError('status', 'must be success, failure or cancel');
  }
  return { paymentId, status, signature: pick(query, 'signature') };
}

export type CallbackOutcome =
  | { status: 'completed'; paymentId: string; payment: ExecuteResult }
  | { status: 'authorized'; paymentId: string; payment: ExecuteResult }
  | { status: 'not_completed'; paymentId: string; payment: ExecuteResult }
  | { status: 'failure' | 'cancel'; paymentId: string }
  | { status: 'error'; paymentId: string | undefined; error: BkashError };

export interface HandleCallbackOptions extends ExecuteOptions {
  /**
   * The amount your order expects for this payment id. Recommended:
   * the callback query string is controlled by the browser, so the amount
   * must come from your own records.
   */
  expectedAmount?: ExecuteOptions['expectedAmount'];
}

/**
 * Turns a bKash callback into a final outcome.
 *
 * The `status` query parameter comes from the customer's browser and can be
 * edited, so it is never trusted on its own: `success` is only reported as
 * `completed` after Execute Payment (or Query Payment) says `Completed`.
 * A payment created with `intent: 'authorization'` is reported as
 * `authorized` once bKash holds the amount; finish it with
 * `capturePayment()` or `voidPayment()`.
 */
export async function handleCallback(
  client: BkashClient,
  query: CallbackQuery,
  options: HandleCallbackOptions = {},
): Promise<CallbackOutcome> {
  let parsed: ParsedCallback;
  try {
    parsed = parseCallback(query);
  } catch (error) {
    return { status: 'error', paymentId: undefined, error: error as BkashError };
  }
  if (parsed.status !== 'success') return { status: parsed.status, paymentId: parsed.paymentId };
  try {
    const payment = await client.executePayment(parsed.paymentId, options);
    const status =
      payment.transactionStatus === 'Completed'
        ? 'completed'
        : payment.transactionStatus === 'Authorized'
          ? 'authorized'
          : 'not_completed';
    return { status, paymentId: parsed.paymentId, payment };
  } catch (error) {
    const err =
      error instanceof BkashError
        ? error
        : new BkashError(String((error as Error)?.message ?? error), { cause: error });
    return { status: 'error', paymentId: parsed.paymentId, error: err };
  }
}
