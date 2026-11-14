import { SUCCESS_STATUS_CODE } from './constants.js';
import {
  categoryFromInternalCode,
  describeErrorCode,
  type ErrorCategory,
} from './error-codes.js';
import type { BkashOperation } from './constants.js';
import type { BkashStatusFields } from './types.js';

export interface BkashErrorOptions {
  code?: string;
  operation?: BkashOperation;
  httpStatus?: number;
  cause?: unknown;
  raw?: unknown;
}

/** Base class for everything this SDK throws. */
export class BkashError extends Error {
  /** bKash error code (`statusCode` / `externalCode`) or an SDK code such as `NETWORK_ERROR`. */
  readonly code: string;
  readonly operation: BkashOperation | undefined;
  readonly httpStatus: number | undefined;
  /** Response body as received, with no credentials. */
  readonly raw: unknown;

  constructor(message: string, options: BkashErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'BKASH_ERROR';
    this.operation = options.operation;
    this.httpStatus = options.httpStatus;
    this.raw = options.raw;
  }

  /** True when retrying the same call may succeed. */
  get retryable(): boolean {
    return false;
  }
}

export interface BkashApiErrorOptions extends BkashErrorOptions {
  statusMessage: string;
  messageBn?: string | null;
  internalCode?: string;
}

/** bKash answered, and the answer was a failure. */
export class BkashApiError extends BkashError {
  /** Message bKash says is safe to show to the customer. */
  readonly statusMessage: string;
  readonly messageBn: string | null;
  readonly internalCode: string | undefined;
  readonly category: ErrorCategory;

  constructor(options: BkashApiErrorOptions) {
    super(`bKash ${options.operation ?? 'API'} failed: ${options.statusMessage} (${options.code ?? 'unknown'})`, options);
    this.statusMessage = options.statusMessage;
    this.messageBn = options.messageBn ?? null;
    this.internalCode = options.internalCode;
    this.category =
      categoryFromInternalCode(options.internalCode) ?? describeErrorCode(options.code).category;
  }

  override get retryable(): boolean {
    return describeErrorCode(this.code).retryable;
  }
}

/** Credentials were rejected or the token could not be obtained. */
export class BkashAuthError extends BkashApiError {}

/** The payment was already executed. Query the payment for its final state. */
export class BkashPaymentAlreadyCompletedError extends BkashApiError {}

/** Input rejected by the SDK before any request was sent. */
export class BkashValidationError extends BkashError {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`, { code: 'VALIDATION_ERROR' });
    this.field = field;
  }
}

/** The request never produced an HTTP response (DNS, TCP reset, TLS...). */
export class BkashNetworkError extends BkashError {
  override get retryable(): boolean {
    return true;
  }
}

/** No response within the configured timeout. The outcome on bKash's side is unknown. */
export class BkashTimeoutError extends BkashNetworkError {}

/** A non-JSON or otherwise unreadable response. */
export class BkashResponseError extends BkashError {
  override get retryable(): boolean {
    return this.httpStatus !== undefined && this.httpStatus >= 500;
  }
}

/** The local token-call budget (twice per hour by default) is exhausted. */
export class BkashTokenRateLimitError extends BkashError {
  /** Epoch ms after which another Grant/Refresh call is allowed. */
  readonly retryAt: number;
  constructor(retryAt: number) {
    super(
      'Grant/Refresh Token budget exhausted; bKash blocks apps that call these more than twice an hour',
      { code: 'TOKEN_RATE_LIMIT' },
    );
    this.retryAt = retryAt;
  }
}

/** A second execute for a payment id that this process is already executing or has executed. */
export class BkashDuplicateExecutionError extends BkashError {
  readonly paymentId: string;
  constructor(paymentId: string) {
    super(`Payment ${paymentId} has already been executed`, {
      code: 'DUPLICATE_EXECUTION',
      operation: 'executePayment',
    });
    this.paymentId = paymentId;
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

export interface ExtractedStatus {
  ok: boolean;
  code: string | undefined;
  message: string | undefined;
  messageBn: string | null;
  internalCode: string | undefined;
}

/**
 * Reads the success/failure signal from a bKash body.
 *
 * bKash uses two shapes: `statusCode`/`statusMessage` (token APIs and the
 * classic API) and `externalCode`/`errorMessageEn`/`internalCode` (v2 checkout
 * failures). A body is a failure when either code is present and is not
 * `0000`, or when an error message is present without a code.
 */
export function extractStatus(body: unknown): ExtractedStatus {
  const b = (body && typeof body === 'object' ? body : {}) as BkashStatusFields;
  const code = asString(b.statusCode) ?? asString(b.externalCode) ?? asString(b.errorCode);
  const message =
    asString(b.statusMessage) ?? asString(b.errorMessageEn) ?? asString(b.errorMessage);
  const internalCode = asString(b.internalCode);
  const messageBn = typeof b.errorMessageBn === 'string' ? b.errorMessageBn : null;
  const hasErrorShape =
    b.externalCode !== undefined || b.errorMessageEn !== undefined || b.errorCode !== undefined;
  const ok = code === undefined ? !hasErrorShape : code === SUCCESS_STATUS_CODE;
  return { ok, code, message, messageBn, internalCode };
}

/** Builds the most specific error for a failed bKash body. */
export function toApiError(
  body: unknown,
  operation: BkashOperation,
  httpStatus: number,
): BkashApiError {
  const s = extractStatus(body);
  const options: BkashApiErrorOptions = {
    code: s.code ?? `HTTP_${httpStatus}`,
    statusMessage: s.message ?? `HTTP ${httpStatus}`,
    messageBn: s.messageBn,
    operation,
    httpStatus,
    raw: body,
  };
  if (s.internalCode !== undefined) options.internalCode = s.internalCode;
  if (s.code === '2062' || s.internalCode === 'payment_already_completed') {
    return new BkashPaymentAlreadyCompletedError(options);
  }
  if (
    operation === 'grantToken' ||
    operation === 'refreshToken' ||
    httpStatus === 401 ||
    httpStatus === 403 ||
    s.code === '9999'
  ) {
    return new BkashAuthError(options);
  }
  return new BkashApiError(options);
}

export function isBkashError(error: unknown): error is BkashError {
  return error instanceof BkashError;
}

/** bKash reported a different amount from the one your order expects. Do not fulfil the order. */
export class BkashAmountMismatchError extends BkashError {
  readonly expected: string;
  readonly actual: string | undefined;
  constructor(
    paymentId: string,
    expected: string,
    actual: string | undefined,
    raw: unknown,
    operation: BkashOperation = 'executePayment',
  ) {
    super(`Payment ${paymentId}: expected amount ${expected}, bKash reported ${actual ?? 'none'}`, {
      code: 'AMOUNT_MISMATCH',
      operation,
      raw,
    });
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A capture or void was refused locally because the payment is already being
 * confirmed, or was already confirmed the other way (captured when you asked
 * to void, or voided when you asked to capture).
 */
export class BkashConfirmConflictError extends BkashError {
  readonly paymentId: string;
  /** The action that was requested. */
  readonly action: 'capture' | 'void';
  /** The action already applied to this payment, or `undefined` while one is still in progress. */
  readonly completedAction: 'capture' | 'void' | undefined;
  constructor(
    paymentId: string,
    action: 'capture' | 'void',
    completedAction: 'capture' | 'void' | undefined,
    raw?: unknown,
  ) {
    const state =
      completedAction === undefined
        ? 'is already being captured or voided'
        : completedAction === 'capture'
          ? 'has already been captured'
          : 'has already been voided';
    super(`Cannot ${action} payment ${paymentId}: it ${state}`, {
      code: completedAction === undefined ? 'CONFIRM_IN_PROGRESS' : 'CONFIRM_CONFLICT',
      operation: action === 'capture' ? 'capturePayment' : 'voidPayment',
      raw,
    });
    this.paymentId = paymentId;
    this.action = action;
    this.completedAction = completedAction;
  }
}
