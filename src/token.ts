import {
  DEFAULT_MAX_TOKEN_CALLS_PER_HOUR,
  DEFAULT_REFRESH_SKEW_SECONDS,
  DEFAULT_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type EndpointPaths,
} from './constants.js';
import { BkashAuthError, BkashError, BkashTokenRateLimitError } from './errors.js';
import type { HttpClient } from './http.js';
import { MemoryTokenStore, type TokenStore } from './token-store.js';
import type { CachedToken, TokenResponse } from './types.js';

export interface BkashCredentials {
  /** Merchant username, sent as the `username` header. */
  username: string;
  /** Merchant password, sent as the `password` header. */
  password: string;
  appKey: string;
  appSecret: string;
}

export interface TokenManagerOptions {
  http: HttpClient;
  paths: EndpointPaths;
  credentials: BkashCredentials;
  store?: TokenStore;
  /** Seconds before expiry at which the token is renewed. Default 300 (55th minute). */
  refreshSkewSeconds?: number;
  /** Local cap on Grant+Refresh calls in a rolling hour. Default 2. Set 0 to disable. */
  maxTokenCallsPerHour?: number;
  now?: () => number;
}

const HOUR_MS = 3_600_000;

function toSeconds(value: string | number | undefined): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOKEN_TTL_SECONDS;
}

/**
 * Issues, caches and renews the bKash `id_token`.
 *
 * - Concurrent callers share one in-flight Grant/Refresh request.
 * - The token is renewed `refreshSkewSeconds` before it expires.
 * - Refresh Token is preferred over Grant Token while the refresh token is valid.
 * - Grant+Refresh calls are counted so the app never trips bKash's
 *   "more than two per hour" block.
 */
export class TokenManager {
  private readonly http: HttpClient;
  private readonly paths: EndpointPaths;
  private readonly credentials: BkashCredentials;
  private readonly store: TokenStore;
  private readonly skewMs: number;
  private readonly maxCalls: number;
  private readonly now: () => number;
  private inflight: Promise<CachedToken> | undefined;

  constructor(options: TokenManagerOptions) {
    this.http = options.http;
    this.paths = options.paths;
    this.credentials = options.credentials;
    this.store = options.store ?? new MemoryTokenStore();
    this.skewMs = (options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;
    this.maxCalls = options.maxTokenCallsPerHour ?? DEFAULT_MAX_TOKEN_CALLS_PER_HOUR;
    this.now = options.now ?? Date.now;
  }

  /** Returns a valid `id_token`, renewing it when needed. */
  async getIdToken(): Promise<string> {
    return (await this.getToken()).idToken;
  }

  async getToken(): Promise<CachedToken> {
    const cached = await this.store.get();
    if (cached && cached.expiresAt - this.skewMs > this.now()) return cached;
    return this.renew(cached);
  }

  /** Forces a Grant Token call, ignoring the cache. Counts against the hourly budget. */
  async grant(): Promise<CachedToken> {
    return this.singleFlight(() => this.callGrant());
  }

  /** Forces a Refresh Token call with the cached refresh token. */
  async refresh(): Promise<CachedToken> {
    const cached = await this.store.get();
    if (!cached) throw new BkashError('No cached token to refresh; call grant() first', { code: 'NO_TOKEN' });
    return this.singleFlight(() => this.callRefresh(cached.refreshToken));
  }

  /** Drops the cached token (for example after bKash rejects it). */
  async invalidate(): Promise<void> {
    await this.store.clear();
  }

  /** Calls left in the current rolling hour, or Infinity when the guard is off. */
  async remainingTokenCalls(): Promise<number> {
    if (this.maxCalls <= 0) return Number.POSITIVE_INFINITY;
    const log = await this.recentCalls();
    return Math.max(0, this.maxCalls - log.length);
  }

  private renew(cached: CachedToken | undefined): Promise<CachedToken> {
    return this.singleFlight(async () => {
      // Another caller may have renewed while we waited for the store.
      const fresh = await this.store.get();
      if (fresh && fresh !== cached && fresh.expiresAt - this.skewMs > this.now()) return fresh;
      const current = fresh ?? cached;
      if (current && current.refreshExpiresAt > this.now()) {
        try {
          return await this.callRefresh(current.refreshToken);
        } catch (error) {
          if (!(error instanceof BkashAuthError)) throw error;
          // Refresh token rejected: fall back to a full grant.
        }
      }
      return this.callGrant();
    });
  }

  private async singleFlight(fn: () => Promise<CachedToken>): Promise<CachedToken> {
    if (this.inflight) return this.inflight;
    this.inflight = fn().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async recentCalls(): Promise<number[]> {
    const cutoff = this.now() - HOUR_MS;
    return (await this.store.getCallLog()).filter((t) => t > cutoff);
  }

  private async consumeBudget(): Promise<void> {
    if (this.maxCalls <= 0) return;
    const log = await this.recentCalls();
    if (log.length >= this.maxCalls) {
      throw new BkashTokenRateLimitError(Math.min(...log) + HOUR_MS);
    }
    log.push(this.now());
    await this.store.setCallLog(log);
  }

  private headers(): Record<string, string> {
    return { username: this.credentials.username, password: this.credentials.password };
  }

  private async callGrant(): Promise<CachedToken> {
    await this.consumeBudget();
    const body = await this.http.post<TokenResponse>({
      operation: 'grantToken',
      path: this.paths.grantToken,
      headers: this.headers(),
      body: { app_key: this.credentials.appKey, app_secret: this.credentials.appSecret },
    });
    return this.save(body);
  }

  private async callRefresh(refreshToken: string): Promise<CachedToken> {
    await this.consumeBudget();
    const body = await this.http.post<TokenResponse>({
      operation: 'refreshToken',
      path: this.paths.refreshToken,
      headers: this.headers(),
      body: {
        app_key: this.credentials.appKey,
        app_secret: this.credentials.appSecret,
        refresh_token: refreshToken,
      },
    });
    return this.save(body, refreshToken);
  }

  private async save(body: TokenResponse, previousRefresh?: string): Promise<CachedToken> {
    if (!body.id_token) {
      throw new BkashAuthError({
        code: 'NO_ID_TOKEN',
        statusMessage: 'Token response did not contain id_token',
        operation: 'grantToken',
      });
    }
    const now = this.now();
    const prev = await this.store.get();
    const newRefresh = body.refresh_token || previousRefresh || '';
    const token: CachedToken = {
      idToken: body.id_token,
      refreshToken: newRefresh,
      tokenType: body.token_type ?? 'Bearer',
      expiresAt: now + toSeconds(body.expires_in) * 1000,
      refreshExpiresAt:
        body.refresh_token && body.refresh_token !== prev?.refreshToken
          ? now + REFRESH_TOKEN_TTL_SECONDS * 1000
          : (prev?.refreshExpiresAt ?? now + REFRESH_TOKEN_TTL_SECONDS * 1000),
    };
    await this.store.set(token);
    return token;
  }
}
