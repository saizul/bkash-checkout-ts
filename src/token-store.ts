import type { CachedToken } from './types.js';

/**
 * Where the token manager keeps the current token and the timestamps of
 * recent Grant/Refresh calls. The default lives in memory. When several
 * processes share one bKash app (cluster, serverless), back this with Redis or
 * a database so they share one token and one call budget.
 */
export interface TokenStore {
  get(): Promise<CachedToken | undefined> | CachedToken | undefined;
  set(token: CachedToken): Promise<void> | void;
  clear(): Promise<void> | void;
  /** Epoch ms of Grant/Refresh calls made within the last hour. */
  getCallLog(): Promise<number[]> | number[];
  setCallLog(log: number[]): Promise<void> | void;
}

export class MemoryTokenStore implements TokenStore {
  private token: CachedToken | undefined;
  private calls: number[] = [];

  get(): CachedToken | undefined {
    return this.token;
  }
  set(token: CachedToken): void {
    this.token = token;
  }
  clear(): void {
    this.token = undefined;
  }
  getCallLog(): number[] {
    return [...this.calls];
  }
  setCallLog(log: number[]): void {
    this.calls = [...log];
  }
}
