// Sharing the token and the double-execute guard between processes.
//
// Works with any client exposing get/set/del like node-redis v4+:
//   npm install redis
import { createClient } from 'redis';
import { BkashClient } from 'bkash-checkout-ts';

const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
await redis.connect();

const PREFIX = 'bkash:';

/** @type {import('bkash-checkout-ts').TokenStore} */
const tokenStore = {
  async get() {
    const raw = await redis.get(`${PREFIX}token`);
    return raw ? JSON.parse(raw) : undefined;
  },
  async set(token) {
    await redis.set(`${PREFIX}token`, JSON.stringify(token));
  },
  async clear() {
    await redis.del(`${PREFIX}token`);
  },
  async getCallLog() {
    const raw = await redis.get(`${PREFIX}token-calls`);
    return raw ? JSON.parse(raw) : [];
  },
  async setCallLog(log) {
    await redis.set(`${PREFIX}token-calls`, JSON.stringify(log), { PX: 3_600_000 });
  },
};

/** @type {import('bkash-checkout-ts').IdempotencyStore} */
const idempotencyStore = {
  async acquire(paymentId, record, ttlMs) {
    // SET NX is atomic: only one process gets "OK".
    const ok = await redis.set(`${PREFIX}exec:${paymentId}`, JSON.stringify(record), { NX: true, PX: ttlMs });
    return ok === 'OK';
  },
  async get(paymentId) {
    const raw = await redis.get(`${PREFIX}exec:${paymentId}`);
    return raw ? JSON.parse(raw) : undefined;
  },
  async set(paymentId, record, ttlMs) {
    await redis.set(`${PREFIX}exec:${paymentId}`, JSON.stringify(record), { PX: ttlMs });
  },
  async delete(paymentId) {
    await redis.del(`${PREFIX}exec:${paymentId}`);
  },
};

export const bkash = BkashClient.fromEnv(process.env, { tokenStore, idempotencyStore });
console.log('bKash client ready with Redis-backed stores');
await redis.quit();
