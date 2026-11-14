/** Amount accepted by the SDK. Strings are passed through after validation. */
export type Amount = number | string;

export type PaymentIntent = 'sale' | 'authorization';

export type TransactionStatus =
  | 'Initiated'
  | 'Completed'
  | 'Authorized'
  | 'Cancelled'
  | 'Failed'
  | 'Expired'
  | (string & {});

export type PayerType = 'Customer' | 'Agent' | 'Merchant' | 'Corporate Merchant' | (string & {});

/** Fields present on a raw bKash response that can describe a failure. */
export interface BkashStatusFields {
  statusCode?: string;
  statusMessage?: string;
  externalCode?: string;
  internalCode?: string;
  errorMessageEn?: string;
  errorMessageBn?: string | null;
  errorCode?: string;
  errorMessage?: string;
}

/** Raw Grant/Refresh Token response. */
export interface TokenResponse extends BkashStatusFields {
  token_type?: string;
  id_token: string;
  refresh_token: string;
  /** bKash sends this as a string ("3600"). */
  expires_in: string | number;
}

/** A token as cached by the SDK. */
export interface CachedToken {
  idToken: string;
  refreshToken: string;
  tokenType: string;
  /** Epoch ms when `idToken` expires. */
  expiresAt: number;
  /** Epoch ms when `refreshToken` expires. */
  refreshExpiresAt: number;
}

export interface CreatePaymentInput {
  /** Customer reference, max 255 chars. A wallet number is pre-filled on the bKash page. */
  payerReference: string;
  /** Base URL bKash redirects to with `paymentID`, `status` and `signature` appended. */
  callbackURL: string;
  amount: Amount;
  /** Your invoice id, max 255 chars, must not contain `<`, `>` or `&`. */
  merchantInvoiceNumber: string;
  /** Defaults to `BDT`. */
  currency?: string;
  /** Defaults to `sale`. */
  intent?: PaymentIntent;
  /** Aggregators only, max 80 chars. */
  subMerchantName?: string;
  /** Aggregators only, TLV formatted, max 255 chars. */
  merchantAssociationInfo?: string;
  /** Extra fields sent verbatim, for fields this SDK does not model yet. */
  extra?: Record<string, unknown>;
}

export interface CreatePaymentResponse extends BkashStatusFields {
  paymentId: string;
  bkashURL: string;
  callbackURL?: string;
  successCallbackURL?: string;
  failureCallbackURL?: string;
  cancelledCallbackURL?: string;
  amount?: string;
  intent?: string;
  currency?: string;
  paymentCreateTime?: string;
  transactionStatus?: TransactionStatus;
  merchantInvoiceNumber?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface ExecutePaymentResponse extends BkashStatusFields {
  paymentId: string;
  trxId?: string;
  transactionStatus?: TransactionStatus;
  amount?: string;
  currency?: string;
  intent?: string;
  paymentExecuteTime?: string;
  merchantInvoiceNumber?: string;
  subMerchantName?: string;
  payerType?: PayerType;
  payerReference?: string;
  payerAccount?: string;
  maxRefundableAmount?: string;
  couponAmount?: string;
  creditedAmount?: string;
  [key: string]: unknown;
}

export interface QueryPaymentResponse extends BkashStatusFields {
  paymentId: string;
  verificationStatus?: 'Incomplete' | 'Complete' | (string & {});
  payerReference?: string;
  payerAccount?: string;
  payerType?: PayerType;
  trxId?: string;
  paymentCreateTime?: string;
  paymentExecuteTime?: string;
  paymentUpdateTime?: string;
  amount?: string;
  currency?: string;
  intent?: string;
  merchantInvoice?: string;
  transactionStatus?: TransactionStatus;
  serviceFee?: string;
  creditedAmount?: string;
  couponAmount?: string;
  subMerchantName?: string;
  maxRefundableAmount?: string;
  [key: string]: unknown;
}

export interface SearchTransactionResponse extends BkashStatusFields {
  transactionType?: string;
  initiationTime?: string;
  completedTime?: string;
  trxId: string;
  transactionStatus?: TransactionStatus;
  amount?: string;
  currency?: string;
  payerAccount?: string;
  payerType?: PayerType;
  serviceFee?: string;
  organizationAccount?: string;
  creditedAmount?: string;
  couponAmount?: string;
  merchantShareAmount?: string;
  maxRefundableAmount?: string;
  [key: string]: unknown;
}

export interface RefundInput {
  paymentId: string;
  /** Original transaction id (`trxId` from execute). */
  trxId: string;
  refundAmount: Amount;
  /** Product tag, max 255 chars. */
  sku: string;
  /** Refund reason, max 255 chars. */
  reason: string;
}

export interface RefundResponse extends BkashStatusFields {
  originalTrxId?: string;
  refundTrxId?: string;
  refundTransactionStatus?: TransactionStatus;
  originalTrxAmount?: string;
  refundAmount?: string;
  currency?: string;
  completedTime?: string;
  sku?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface RefundStatusInput {
  paymentId: string;
  trxId: string;
}

export interface RefundTransaction {
  refundTrxId: string;
  refundTransactionStatus: TransactionStatus;
  refundAmount: string;
  completedTime?: string;
}

export interface RefundStatusResponse extends BkashStatusFields {
  originalTrxId?: string;
  originalTrxAmount?: string;
  originalTrxCompletedTime?: string;
  refundTransactions?: RefundTransaction[];
  [key: string]: unknown;
}

/** Second step of an `authorization` payment: settle it or release the hold. */
export type ConfirmAction = 'capture' | 'void';

/** Capture or Void Payment response. */
export interface ConfirmPaymentResponse extends BkashStatusFields {
  paymentId: string;
  trxId?: string;
  /** `Completed` after a capture, `Cancelled` after a void. */
  transactionStatus?: TransactionStatus;
  amount?: string;
  currency?: string;
  intent?: string;
  merchantInvoiceNumber?: string;
  paymentUpdateTime?: string;
  [key: string]: unknown;
}

/** Query string bKash appends to `callbackURL`. */
export type CallbackStatus = 'success' | 'failure' | 'cancel';
