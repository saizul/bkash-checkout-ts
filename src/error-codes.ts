/**
 * Error codes that appear in the public bKash documentation samples.
 *
 * This is not the full bKash error catalogue. Unknown codes still produce a
 * `BkashApiError`; they simply fall into the `unknown` category. Register
 * additional codes with `registerErrorCode` if you need different handling.
 */
export type ErrorCategory =
  | 'auth'
  | 'validation'
  | 'payment_state'
  | 'refund'
  | 'not_found'
  | 'rate_limit'
  | 'server'
  | 'unknown';

export interface ErrorCodeInfo {
  category: ErrorCategory;
  description: string;
  /** Whether calling the same API again with the same input can succeed. */
  retryable: boolean;
}

const KNOWN: Record<string, ErrorCodeInfo> = {
  '2002': { category: 'not_found', description: 'Invalid Payment ID', retryable: false },
  '2007': { category: 'validation', description: 'Invalid currency', retryable: false },
  '2062': {
    category: 'payment_state',
    description: 'The payment has already been completed',
    retryable: false,
  },
  '2072': { category: 'refund', description: 'Refund amount not valid', retryable: false },
  '3045': { category: 'refund', description: 'Invalid TrxID', retryable: false },
  '9999': {
    category: 'auth',
    description: 'Invalid or unrecognized access credentials',
    retryable: false,
  },
};

const custom = new Map<string, ErrorCodeInfo>();

/** Add or override the description of a bKash error code. */
export function registerErrorCode(code: string, info: ErrorCodeInfo): void {
  custom.set(code, info);
}

/** Remove every code added with `registerErrorCode`. Mostly useful in tests. */
export function resetCustomErrorCodes(): void {
  custom.clear();
}

export function describeErrorCode(code: string | undefined): ErrorCodeInfo {
  if (code !== undefined) {
    const info = custom.get(code) ?? KNOWN[code];
    if (info) return info;
  }
  return { category: 'unknown', description: 'Unknown bKash error', retryable: false };
}

/** `internalCode` values from the docs, mapped to categories. */
export function categoryFromInternalCode(internal: string | undefined): ErrorCategory | undefined {
  if (!internal) return undefined;
  const v = internal.toLowerCase();
  if (v.includes('already_completed')) return 'payment_state';
  if (v.includes('refund')) return 'refund';
  if (v.includes('invalid_payment_id')) return 'not_found';
  if (v.includes('currency') || v.startsWith('invalid_')) return 'validation';
  return undefined;
}
