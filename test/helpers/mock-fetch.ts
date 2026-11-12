import { BkashClient, type BkashClientOptions, type FetchLike } from '../../src/index.js';

export interface RecordedCall {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type Reply =
  | { status?: number; json?: unknown; text?: string }
  | { networkError: string }
  | { hang: true };

type Handler = Reply | ((call: RecordedCall) => Reply | Promise<Reply>);

/**
 * A scripted fetch. Register replies per path; each call consumes the next
 * reply for its path, and the last reply repeats.
 */
export class MockFetch {
  readonly calls: RecordedCall[] = [];
  private readonly routes = new Map<string, Handler[]>();

  on(path: string, ...replies: Handler[]): this {
    const list = this.routes.get(path) ?? [];
    list.push(...replies);
    this.routes.set(path, list);
    return this;
  }

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  last(path: string): RecordedCall | undefined {
    return this.calls.filter((c) => c.path === path).at(-1);
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: RecordedCall = {
      url: input,
      path: url.pathname,
      method: init.method ?? 'GET',
      headers,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    this.calls.push(call);
    const list = this.routes.get(url.pathname);
    if (!list || list.length === 0) throw new Error(`No mock for ${url.pathname}`);
    const handler = list.length > 1 ? list.shift()! : list[0]!;
    const reply = typeof handler === 'function' ? await handler(call) : handler;
    if ('networkError' in reply) throw new TypeError(reply.networkError);
    if ('hang' in reply) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const body = reply.text ?? JSON.stringify(reply.json ?? {});
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

export const P = {
  grant: '/v2/tokenized-checkout/auth/grant-token',
  refresh: '/v2/tokenized-checkout/auth/refresh-token',
  create: '/v2/tokenized-checkout/payment/create',
  execute: '/v2/tokenized-checkout/payment/execute',
  query: '/v2/tokenized-checkout/query/payment',
  search: '/v2/tokenized-checkout/general/search-transaction',
  refund: '/v2/tokenized-checkout/refund/payment/transaction',
  refundStatus: '/v2/tokenized-checkout/refund/payment/status',
} as const;

export const CREDS = {
  username: 'sandbox-user',
  password: 'sandbox-pass-placeholder',
  appKey: 'app-key-placeholder',
  appSecret: 'app-secret-placeholder',
};

export function tokenReply(id = 'id-token-1', refresh = 'refresh-token-1', expiresIn = '3600'): Reply {
  return {
    json: {
      statusCode: '0000',
      statusMessage: 'Successful',
      token_type: 'Bearer',
      id_token: id,
      refresh_token: refresh,
      expires_in: expiresIn,
    },
  };
}

export const PAYMENT_ID = 'TR0011NaM01uE1789885888970';

export function createReply(paymentId = PAYMENT_ID): Reply {
  return {
    json: {
      paymentId,
      bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${paymentId}&hash=x&mode=0011&apiVersion=v2/`,
      callbackURL: 'https://shop.example.com/bkash/callback',
      successCallbackURL: `https://shop.example.com/bkash/callback?paymentID=${paymentId}&status=success&signature=abc`,
      failureCallbackURL: `https://shop.example.com/bkash/callback?paymentID=${paymentId}&status=failure&signature=abc`,
      cancelledCallbackURL: `https://shop.example.com/bkash/callback?paymentID=${paymentId}&status=cancel&signature=abc`,
      amount: '2.90',
      intent: 'sale',
      currency: 'BDT',
      paymentCreateTime: '2026-09-20T12:31:28:970 GMT+0600',
      transactionStatus: 'Initiated',
      merchantInvoiceNumber: 'INV-1001',
      signature: 'abc',
    },
  };
}

export function executeReply(paymentId = PAYMENT_ID, amount = '2.90'): Reply {
  return {
    json: {
      paymentId,
      trxId: 'DIK20PG0H4',
      transactionStatus: 'Completed',
      amount,
      currency: 'BDT',
      intent: 'sale',
      paymentExecuteTime: '2026-09-20T12:34:11:929 GMT+0600',
      merchantInvoiceNumber: 'INV-1001',
      payerType: 'Customer',
      payerReference: '01770618575',
      payerAccount: '01770618575',
      maxRefundableAmount: amount,
    },
  };
}

export function queryReply(status = 'Completed', paymentId = PAYMENT_ID, amount = '2.90'): Reply {
  return {
    json: {
      paymentId,
      verificationStatus: 'Complete',
      transactionStatus: status,
      amount,
      currency: 'BDT',
      intent: 'sale',
      merchantInvoice: 'INV-1001',
      ...(status === 'Completed' ? { trxId: 'DIK20PG0H4' } : {}),
    },
  };
}

export function errorReply(externalCode: string, message: string, internalCode = 'some_error', status = 200): Reply {
  return {
    status,
    json: { internalCode, externalCode, errorMessageEn: message, errorMessageBn: null },
  };
}

export class Clock {
  constructor(public t = Date.UTC(2026, 0, 1)) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function makeClient(
  mock: MockFetch,
  overrides: Partial<BkashClientOptions> = {},
): BkashClient {
  return new BkashClient({
    ...CREDS,
    fetch: mock.fetch,
    sleep: async () => {},
    random: () => 1,
    ...overrides,
  });
}
