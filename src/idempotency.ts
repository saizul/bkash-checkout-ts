import type { ExecutePaymentResponse } from './types.js';

/** State recorded for one payment id. */
export type ExecutionRecord =
  | { state: 'in_progress'; startedAt: number }
  | { state: 'completed'; finishedAt: number; result: ExecutePaymentResponse };

/**
 * Persistence for the double-execute guard.
 *
 * `acquire` must be atomic: it returns true only for the first caller for a
 * given payment id. In-memory is the default; for several processes use
 * something like Redis `SET key value NX PX ttl` or a unique database row.
 */
export interface IdempotencyStore {
  acquire(paymentId: string, record: ExecutionRecord, ttlMs: number): Promise<boolean> | boolean;
  get(paymentId: string): Promise<ExecutionRecord | undefined> | ExecutionRecord | undefined;
  set(paymentId: string, record: ExecutionRecord, ttlMs: number): Promise<void> | void;
  delete(paymentId: string): Promise<void> | void;
}

interface Entry {
  record: ExecutionRecord;
  expiresAt: number;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  private live(paymentId: string): Entry | undefined {
    const e = this.entries.get(paymentId);
    if (e && e.expiresAt <= this.now()) {
      this.entries.delete(paymentId);
      return undefined;
    }
    return e;
  }

  acquire(paymentId: string, record: ExecutionRecord, ttlMs: number): boolean {
    if (this.live(paymentId)) return false;
    this.entries.set(paymentId, { record, expiresAt: this.now() + ttlMs });
    return true;
  }
  get(paymentId: string): ExecutionRecord | undefined {
    return this.live(paymentId)?.record;
  }
  set(paymentId: string, record: ExecutionRecord, ttlMs: number): void {
    this.entries.set(paymentId, { record, expiresAt: this.now() + ttlMs });
  }
  delete(paymentId: string): void {
    this.entries.delete(paymentId);
  }
  get size(): number {
    return this.entries.size;
  }
}

export interface ExecutionGuardOptions {
  store?: IdempotencyStore;
  /** How long a completed result is remembered. Default 24 h (a paymentId's lifetime). */
  resultTtlMs?: number;
  /** How long an in-progress lock is held before it is considered stale. Default 2 min. */
  lockTtlMs?: number;
  now?: () => number;
}

export type GuardOutcome =
  | { kind: 'acquired' }
  | { kind: 'completed'; result: ExecutePaymentResponse }
  | { kind: 'in_progress' };

/**
 * Prevents executing the same bKash payment twice.
 *
 * bKash callbacks can arrive more than once (browser refresh, back button,
 * a customer double-click). Within one process, concurrent callers share the
 * same in-flight promise. Across processes, the store's atomic `acquire`
 * decides who executes; the others get the stored result or an
 * "in progress" answer.
 */
export class ExecutionGuard {
  readonly store: IdempotencyStore;
  private readonly resultTtlMs: number;
  private readonly lockTtlMs: number;
  private readonly now: () => number;
  private readonly local = new Map<string, Promise<ExecutePaymentResponse>>();

  constructor(options: ExecutionGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new MemoryIdempotencyStore(this.now);
    this.resultTtlMs = options.resultTtlMs ?? 24 * 3_600_000;
    this.lockTtlMs = options.lockTtlMs ?? 120_000;
  }

  /** Promise of an execute already running in this process, if any. */
  pending(paymentId: string): Promise<ExecutePaymentResponse> | undefined {
    return this.local.get(paymentId);
  }

  async begin(paymentId: string): Promise<GuardOutcome> {
    const acquired = await this.store.acquire(
      paymentId,
      { state: 'in_progress', startedAt: this.now() },
      this.lockTtlMs,
    );
    if (acquired) return { kind: 'acquired' };
    const record = await this.store.get(paymentId);
    if (record?.state === 'completed') return { kind: 'completed', result: record.result };
    if (record === undefined) {
      // Lock expired between acquire and get: try once more.
      const retry = await this.store.acquire(
        paymentId,
        { state: 'in_progress', startedAt: this.now() },
        this.lockTtlMs,
      );
      if (retry) return { kind: 'acquired' };
    }
    return { kind: 'in_progress' };
  }

  async complete(paymentId: string, result: ExecutePaymentResponse): Promise<void> {
    await this.store.set(paymentId, { state: 'completed', finishedAt: this.now(), result }, this.resultTtlMs);
  }

  /** Releases the lock after a failure whose outcome is known (nothing was charged). */
  async release(paymentId: string): Promise<void> {
    await this.store.delete(paymentId);
  }

  /** Runs `fn` with the in-process single-flight map. */
  track(paymentId: string, fn: () => Promise<ExecutePaymentResponse>): Promise<ExecutePaymentResponse> {
    const p = fn().finally(() => this.local.delete(paymentId));
    this.local.set(paymentId, p);
    return p;
  }
}
