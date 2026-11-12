import {
  BASE_URLS,
  V2_PATHS,
  type BkashEnvironment,
  type BkashOperation,
  type EndpointPaths,
} from './constants.js';
import {
  BkashAmountMismatchError,
  BkashAuthError,
  BkashDuplicateExecutionError,
  BkashError,
  BkashNetworkError,
  BkashPaymentAlreadyCompletedError,
  BkashValidationError,
} from './errors.js';
import { HttpClient, type FetchLike, type Logger, type RetryOptions } from './http.js';
import { ExecutionGuard, type IdempotencyStore } from './idempotency.js';
import { TokenManager, type BkashCredentials } from './token.js';
import type { TokenStore } from './token-store.js';
import type {
  Amount,
  CachedToken,
  CreatePaymentInput,
  CreatePaymentResponse,
  ExecutePaymentResponse,
  QueryPaymentResponse,
  RefundInput,
  RefundResponse,
  RefundStatusInput,
  RefundStatusResponse,
  SearchTransactionResponse,
} from './types.js';
import {
  formatAmount,
  requireString,
  safeText,
  toPaisa,
  validateCurrency,
  validateUrl,
} from './validation.js';

export interface BkashClientOptions extends BkashCredentials {
  /** `sandbox` (default) or `production`. Ignored when `baseUrl` is set. */
  environment?: BkashEnvironment;
  /** Overrides the host, e.g. a proxy or a host from your onboarding sheet. */
  baseUrl?: string;
  /** Overrides individual endpoint paths. */
  paths?: Partial<EndpointPaths>;
  /**
   * How the `Authorization` header is built. `raw` (default) sends the
   * `id_token` as-is, which is what the bKash curl samples do; `bearer`
   * prefixes it with `Bearer `.
   */
  authScheme?: 'raw' | 'bearer';
  fetch?: FetchLike;
  /** Per-attempt timeout in ms. Default 30 000, as documented by bKash. */
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  logger?: Logger;
  tokenStore?: TokenStore;
  idempotencyStore?: IdempotencyStore;
  refreshSkewSeconds?: number;
  maxTokenCallsPerHour?: number;
  /** Allow `http://` callback URLs. Defaults to true in sandbox, false in production. */
  allowHttpCallback?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ExecuteOptions {
  /**
   * The amount your order expects. When set, a completed payment with a
   * different amount throws `BkashAmountMismatchError`.
   */
  expectedAmount?: Amount;
  /**
   * On timeout, network error or "already completed", call Query Payment to
   * learn the real outcome, as bKash recommends. Default true.
   */
  recover?: boolean;
  signal?: AbortSignal;
}

export interface RefundOptions {
  /**
   * On timeout or network error, call Refund Status and return a completed
   * refund for the same amount if one appears. Default true.
   */
  recover?: boolean;
  /** Refund ids that existed before this call, so recovery ignores them. */
  knownRefundTrxIds?: readonly string[];
  signal?: AbortSignal;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/** Result of `executePayment`, with how it was obtained. */
export type ExecuteResult = ExecutePaymentResponse & {
  /** `execute` = from the Execute API, `query` = recovered via Query Payment, `cache` = guard. */
  source: 'execute' | 'query' | 'cache';
};

export type RefundResult = RefundResponse & { source: 'refund' | 'status' };

/** Client for the bKash Tokenized Checkout API. */
export class BkashClient {
  readonly environment: BkashEnvironment;
  readonly baseUrl: string;
  readonly paths: EndpointPaths;
  readonly tokens: TokenManager;
  readonly guard: ExecutionGuard;
  private readonly http: HttpClient;
  private readonly appKey: string;
  private readonly authScheme: 'raw' | 'bearer';
  private readonly allowHttpCallback: boolean;

  constructor(options: BkashClientOptions) {
    for (const key of ['username', 'password', 'appKey', 'appSecret'] as const) {
      requireString(key, options[key]);
    }
    this.environment = options.environment ?? 'sandbox';
    if (!(this.environment in BASE_URLS)) {
      throw new BkashValidationError('environment', 'must be "sandbox" or "production"');
    }
    this.baseUrl = (options.baseUrl ?? BASE_URLS[this.environment]).replace(/\/+$/, '');
    this.paths = { ...V2_PATHS, ...options.paths };
    this.appKey = options.appKey;
    this.authScheme = options.authScheme ?? 'raw';
    this.allowHttpCallback = options.allowHttpCallback ?? this.environment === 'sandbox';

    const secrets = [options.password, options.appSecret, options.appKey, options.username];
    let tokenSecrets: string[] = [];
    this.http = new HttpClient({
      baseUrl: this.baseUrl,
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      ...(options.retry && { retry: options.retry }),
      ...(options.logger && { logger: options.logger }),
      ...(options.sleep && { sleep: options.sleep }),
      ...(options.random && { random: options.random }),
      ...(options.now && { now: options.now }),
      secrets: () => [...secrets, ...tokenSecrets],
    });

    this.tokens = new TokenManager({
      http: this.http,
      paths: this.paths,
      credentials: {
        username: options.username,
        password: options.password,
        appKey: options.appKey,
        appSecret: options.appSecret,
      },
      ...(options.tokenStore && { store: options.tokenStore }),
      ...(options.refreshSkewSeconds !== undefined && { refreshSkewSeconds: options.refreshSkewSeconds }),
      ...(options.maxTokenCallsPerHour !== undefined && { maxTokenCallsPerHour: options.maxTokenCallsPerHour }),
      ...(options.now && { now: options.now }),
    });
    this.guard = new ExecutionGuard({
      ...(options.idempotencyStore && { store: options.idempotencyStore }),
      ...(options.now && { now: options.now }),
    });
    this.onToken = (t) => {
      tokenSecrets = [t.idToken, t.refreshToken].filter(Boolean);
    };
  }

  private readonly onToken: (t: CachedToken) => void;

  /**
   * Builds a client from environment variables:
   * `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_APP_KEY`, `BKASH_APP_SECRET`,
   * optional `BKASH_ENV` (`sandbox`|`production`) and `BKASH_BASE_URL`.
   */
  static fromEnv(
    env: Record<string, string | undefined> = process.env,
    overrides: Partial<BkashClientOptions> = {},
  ): BkashClient {
    const environment = (env.BKASH_ENV ?? 'sandbox') as BkashEnvironment;
    return new BkashClient({
      username: env.BKASH_USERNAME ?? '',
      password: env.BKASH_PASSWORD ?? '',
      appKey: env.BKASH_APP_KEY ?? '',
      appSecret: env.BKASH_APP_SECRET ?? '',
      environment,
      ...(env.BKASH_BASE_URL && { baseUrl: env.BKASH_BASE_URL }),
      ...overrides,
    });
  }

  // ---------------------------------------------------------------- tokens

  /** Calls Grant Token directly and caches the result. */
  async grantToken(): Promise<CachedToken> {
    const t = await this.tokens.grant();
    this.onToken(t);
    return t;
  }

  /** Calls Refresh Token directly with the cached refresh token. */
  async refreshToken(): Promise<CachedToken> {
    const t = await this.tokens.refresh();
    this.onToken(t);
    return t;
  }

  // -------------------------------------------------------------- payments

  /** Creates a payment and returns the `bkashURL` to redirect the customer to. */
  async createPayment(input: CreatePaymentInput, options: CallOptions = {}): Promise<CreatePaymentResponse> {
    const body: Record<string, unknown> = {
      ...input.extra,
      payerReference: safeText('payerReference', input.payerReference, 255),
      callbackURL: validateUrl('callbackURL', input.callbackURL, this.allowHttpCallback),
      amount: formatAmount('amount', input.amount),
      currency: validateCurrency(input.currency),
      intent: input.intent ?? 'sale',
      merchantInvoiceNumber: safeText('merchantInvoiceNumber', input.merchantInvoiceNumber, 255),
    };
    if (body.intent !== 'sale' && body.intent !== 'authorization') {
      throw new BkashValidationError('intent', 'must be "sale" or "authorization"');
    }
    const sub = safeText('subMerchantName', input.subMerchantName, 80, false);
    if (sub !== undefined) body.subMerchantName = sub;
    const assoc = safeText('merchantAssociationInfo', input.merchantAssociationInfo, 255, false);
    if (assoc !== undefined) body.merchantAssociationInfo = assoc;

    const res = await this.call<CreatePaymentResponse>('createPayment', body, options.signal);
    // The docs spell the field both `bkashURL` and `bKashURL`.
    const url = res.bkashURL ?? (res as Record<string, unknown>).bKashURL;
    if (!res.paymentId || typeof url !== 'string') {
      throw new BkashError('Create Payment response did not contain paymentId and bkashURL', {
        code: 'INVALID_RESPONSE',
        operation: 'createPayment',
        raw: res,
      });
    }
    return { ...res, bkashURL: url };
  }

  /**
   * Executes a payment after the customer returns with `status=success`.
   *
   * Guarded against double execution: concurrent or repeated calls for the
   * same `paymentId` share one request or get the stored result. On a
   * timeout the outcome is resolved with Query Payment instead of retrying.
   */
  async executePayment(paymentId: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    requireString('paymentId', paymentId);
    const pending = this.guard.pending(paymentId);
    if (pending) return this.checkAmount(paymentId, (await pending) as ExecuteResult, options);

    // Registered synchronously so concurrent callers in this process join it.
    const run = this.guard.track(paymentId, async () => {
      const outcome = await this.guard.begin(paymentId);
      if (outcome.kind === 'completed') return { ...outcome.result, source: 'cache' } as ExecuteResult;
      if (outcome.kind === 'in_progress') throw new BkashDuplicateExecutionError(paymentId);
      return this.doExecute(paymentId, options);
    });
    return this.checkAmount(paymentId, (await run) as ExecuteResult, options);
  }

  private async doExecute(paymentId: string, options: ExecuteOptions): Promise<ExecuteResult> {
    const recover = options.recover ?? true;
    try {
      const res = await this.call<ExecutePaymentResponse>('executePayment', { paymentId }, options.signal);
      const result: ExecuteResult = { ...res, source: 'execute' };
      await this.guard.complete(paymentId, result);
      return result;
    } catch (error) {
      const unknownOutcome = error instanceof BkashNetworkError;
      const alreadyDone = error instanceof BkashPaymentAlreadyCompletedError;
      if (recover && (unknownOutcome || alreadyDone)) {
        let q: QueryPaymentResponse;
        try {
          q = await this.queryPayment(paymentId, options.signal ? { signal: options.signal } : {});
        } catch {
          // Keep the lock: the payment may have gone through. Query later.
          throw error;
        }
        if (q.transactionStatus === 'Completed') {
          const result = this.fromQuery(q);
          await this.guard.complete(paymentId, result);
          return result;
        }
        if (q.transactionStatus === 'Initiated') await this.guard.release(paymentId);
        throw error;
      }
      if (!unknownOutcome) await this.guard.release(paymentId);
      throw error;
    }
  }

  private fromQuery(q: QueryPaymentResponse): ExecuteResult {
    const result: ExecuteResult = { ...q, paymentId: q.paymentId, source: 'query' };
    if (q.merchantInvoice !== undefined && result.merchantInvoiceNumber === undefined) {
      result.merchantInvoiceNumber = q.merchantInvoice;
    }
    return result;
  }

  private checkAmount(paymentId: string, result: ExecuteResult, options: ExecuteOptions): ExecuteResult {
    if (options.expectedAmount === undefined) return result;
    const expected = formatAmount('expectedAmount', options.expectedAmount);
    if (result.amount === undefined || toPaisa(result.amount) !== toPaisa(expected)) {
      throw new BkashAmountMismatchError(paymentId, expected, result.amount, result);
    }
    return result;
  }

  /** Current state of a payment. Use it after an execute timeout and for reconciliation. */
  async queryPayment(paymentId: string, options: CallOptions = {}): Promise<QueryPaymentResponse> {
    requireString('paymentId', paymentId);
    return this.call<QueryPaymentResponse>('queryPayment', { paymentId }, options.signal);
  }

  /** Looks up a completed transaction by its `trxId`. */
  async searchTransaction(trxId: string, options: CallOptions = {}): Promise<SearchTransactionResponse> {
    requireString('trxId', trxId);
    return this.call<SearchTransactionResponse>('searchTransaction', { trxId }, options.signal);
  }

  // --------------------------------------------------------------- refunds

  /**
   * Refunds all or part of a completed payment. bKash allows up to 10 partial
   * refunds per transaction within 60 days, and rejects a duplicate refund
   * within 10 minutes.
   */
  async refund(input: RefundInput, options: RefundOptions = {}): Promise<RefundResult> {
    const body = {
      paymentId: requireString('paymentId', input.paymentId),
      trxId: requireString('trxId', input.trxId),
      refundAmount: formatAmount('refundAmount', input.refundAmount),
      sku: safeText('sku', input.sku, 255),
      reason: safeText('reason', input.reason, 255),
    };
    try {
      const res = await this.call<RefundResponse>('refund', body, options.signal);
      return { ...res, source: 'refund' };
    } catch (error) {
      if (!(options.recover ?? true) || !(error instanceof BkashNetworkError)) throw error;
      let status: RefundStatusResponse;
      try {
        status = await this.refundStatus({ paymentId: body.paymentId, trxId: body.trxId });
      } catch {
        throw error;
      }
      const known = new Set(options.knownRefundTrxIds ?? []);
      const match = (status.refundTransactions ?? []).find(
        (r) =>
          r.refundTransactionStatus === 'Completed' &&
          !known.has(r.refundTrxId) &&
          toPaisa(r.refundAmount) === toPaisa(body.refundAmount),
      );
      if (!match) throw error;
      return {
        originalTrxId: status.originalTrxId,
        originalTrxAmount: status.originalTrxAmount,
        refundTrxId: match.refundTrxId,
        refundTransactionStatus: match.refundTransactionStatus,
        refundAmount: match.refundAmount,
        completedTime: match.completedTime,
        sku: body.sku,
        reason: body.reason,
        source: 'status',
      };
    }
  }

  /** Lists refunds made against a payment. */
  async refundStatus(input: RefundStatusInput, options: CallOptions = {}): Promise<RefundStatusResponse> {
    const body = {
      paymentId: requireString('paymentId', input.paymentId),
      trxId: requireString('trxId', input.trxId),
    };
    return this.call<RefundStatusResponse>('refundStatus', body, options.signal);
  }

  // -------------------------------------------------------------- internals

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.tokens.getToken();
    this.onToken(token);
    return {
      Authorization: this.authScheme === 'bearer' ? `Bearer ${token.idToken}` : token.idToken,
      'X-APP-Key': this.appKey,
    };
  }

  /**
   * Sends an authenticated call. When bKash rejects the token with HTTP 401
   * the cached token is dropped and the call is sent once more; a rejected
   * token means the request was not processed, so this is safe for every
   * operation.
   */
  private async call<T>(operation: BkashOperation, body: unknown, signal?: AbortSignal): Promise<T> {
    const send = async () =>
      this.http.post<T>({
        operation,
        path: this.paths[operation],
        headers: await this.authHeaders(),
        body,
        ...(signal && { signal }),
      });
    try {
      return await send();
    } catch (error) {
      if (error instanceof BkashAuthError && error.httpStatus === 401) {
        await this.tokens.invalidate();
        return send();
      }
      throw error;
    }
  }
}
