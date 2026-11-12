import { DEFAULT_TIMEOUT_MS, type BkashOperation } from './constants.js';
import {
  BkashError,
  BkashNetworkError,
  BkashResponseError,
  BkashTimeoutError,
  extractStatus,
  toApiError,
} from './errors.js';
import { redact } from './redact.js';

/** Minimal fetch signature; `globalThis.fetch` satisfies it. Inject a mock in tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Retries after the first attempt. 0 disables retrying. Default 2. */
  retries: number;
  /** First backoff delay in ms. Default 500. */
  baseDelayMs: number;
  /** Upper bound for a single delay in ms. Default 8000. */
  maxDelayMs: number;
  /** Growth factor. Default 2. */
  factor: number;
  /** Randomize each delay within [50%, 100%]. Default true. */
  jitter: boolean;
  /** Also retry HTTP 502/503/504 responses on safe operations. Default true. */
  retryOnGatewayErrors: boolean;
}

export const DEFAULT_RETRY: Readonly<RetryOptions> = Object.freeze({
  retries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  factor: 2,
  jitter: true,
  retryOnGatewayErrors: true,
});

/**
 * Operations that move money. They are never retried blindly, because a
 * request that timed out may still have been processed by bKash. The client
 * resolves their outcome with Query Payment / Refund Status instead.
 */
export const NON_RETRYABLE_OPERATIONS: ReadonlySet<BkashOperation> = new Set([
  'executePayment',
  'refund',
]);

export interface LogEntry {
  level: 'debug' | 'warn' | 'error';
  event: 'request' | 'response' | 'retry' | 'error';
  operation: BkashOperation;
  attempt: number;
  status?: number;
  durationMs?: number;
  delayMs?: number;
  code?: string;
  message?: string;
}

export type Logger = (entry: LogEntry) => void;

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  logger?: Logger;
  /** Strings scrubbed from error messages (credentials, tokens). */
  secrets?: () => readonly string[];
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface RequestSpec {
  operation: BkashOperation;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** Overrides the default retry decision for this request. */
  retry?: boolean;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions;
  private readonly logger: Logger | undefined;
  private readonly secrets: () => readonly string[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new BkashError('No fetch implementation available; pass options.fetch');
    this.fetchImpl = f;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.logger = options.logger;
    this.secrets = options.secrets ?? (() => []);
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  /** Backoff before retry number `attempt` (1-based). */
  backoffDelay(attempt: number): number {
    const exp = Math.min(
      this.retry.maxDelayMs,
      this.retry.baseDelayMs * this.retry.factor ** (attempt - 1),
    );
    return Math.round(this.retry.jitter ? exp * (0.5 + this.random() * 0.5) : exp);
  }

  private canRetry(spec: RequestSpec): boolean {
    if (spec.retry !== undefined) return spec.retry;
    return !NON_RETRYABLE_OPERATIONS.has(spec.operation);
  }

  /** POSTs JSON and returns the parsed success body, or throws a typed error. */
  async post<T>(spec: RequestSpec): Promise<T> {
    const retryAllowed = this.canRetry(spec);
    const maxAttempts = retryAllowed ? this.retry.retries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.once<T>(spec, attempt);
      } catch (error) {
        lastError = error;
        const transient =
          error instanceof BkashNetworkError ||
          (this.retry.retryOnGatewayErrors &&
            error instanceof BkashResponseError &&
            [502, 503, 504].includes(error.httpStatus ?? 0));
        if (!transient || attempt >= maxAttempts || spec.signal?.aborted) throw error;
        const delayMs = this.backoffDelay(attempt);
        this.log({
          level: 'warn',
          event: 'retry',
          operation: spec.operation,
          attempt,
          delayMs,
          message: (error as Error).message,
        });
        await this.sleep(delayMs);
      }
    }
    throw lastError;
  }

  private async once<T>(spec: RequestSpec, attempt: number): Promise<T> {
    const url = `${this.baseUrl}${spec.path}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort(spec.signal?.reason);
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const started = this.now();
    this.log({ level: 'debug', event: 'request', operation: spec.operation, attempt });

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...spec.headers,
        },
        body: JSON.stringify(spec.body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      const message = this.scrub(error instanceof Error ? error.message : String(error));
      if (timedOut) {
        this.log({ level: 'error', event: 'error', operation: spec.operation, attempt, code: 'TIMEOUT' });
        throw new BkashTimeoutError(
          `bKash ${spec.operation} timed out after ${this.timeoutMs} ms`,
          { code: 'TIMEOUT', operation: spec.operation, cause: error },
        );
      }
      if (spec.signal?.aborted) {
        throw new BkashError(`bKash ${spec.operation} aborted`, {
          code: 'ABORTED',
          operation: spec.operation,
          cause: error,
        });
      }
      this.log({ level: 'error', event: 'error', operation: spec.operation, attempt, code: 'NETWORK_ERROR', message });
      throw new BkashNetworkError(`bKash ${spec.operation} network error: ${message}`, {
        code: 'NETWORK_ERROR',
        operation: spec.operation,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
    }

    const durationMs = this.now() - started;
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : {};
    } catch {
      this.log({ level: 'error', event: 'response', operation: spec.operation, attempt, status: response.status, durationMs });
      throw new BkashResponseError(
        `bKash ${spec.operation} returned a non-JSON response (HTTP ${response.status})`,
        {
          code: response.ok ? 'INVALID_RESPONSE' : `HTTP_${response.status}`,
          operation: spec.operation,
          httpStatus: response.status,
          raw: this.scrub(text.slice(0, 500)),
        },
      );
    }

    const status = extractStatus(body);
    this.log({
      level: status.ok && response.ok ? 'debug' : 'warn',
      event: 'response',
      operation: spec.operation,
      attempt,
      status: response.status,
      durationMs,
      ...(status.code === undefined ? {} : { code: status.code }),
    });

    const safeBody = redact(body, this.secrets());
    if (!response.ok && status.code === undefined && status.message === undefined) {
      throw new BkashResponseError(`bKash ${spec.operation} failed with HTTP ${response.status}`, {
        code: `HTTP_${response.status}`,
        operation: spec.operation,
        httpStatus: response.status,
        raw: safeBody,
      });
    }
    if (!status.ok || !response.ok) throw toApiError(safeBody, spec.operation, response.status);
    return body as T;
  }

  private scrub(text: string): string {
    return redact(text, this.secrets());
  }

  private log(entry: LogEntry): void {
    if (!this.logger) return;
    try {
      this.logger(entry);
    } catch {
      // A failing logger must never break a payment.
    }
  }
}
