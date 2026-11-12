import { CURRENCY_BDT } from './constants.js';
import { BkashValidationError } from './errors.js';
import type { Amount } from './types.js';

/** bKash rejects `<`, `>` and `&` in reference and invoice fields. */
const SAFE_TEXT = /^[^<>&]*$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

export function requireString(field: string, value: unknown, maxLength?: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BkashValidationError(field, 'is required');
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new BkashValidationError(field, `must be at most ${maxLength} characters`);
  }
  return value;
}

export function safeText(field: string, value: unknown, maxLength: number, required = true): string | undefined {
  if (!required && (value === undefined || value === null || value === '')) return undefined;
  const v = requireString(field, value, maxLength);
  if (!SAFE_TEXT.test(v)) throw new BkashValidationError(field, 'must not contain <, > or &');
  return v;
}

/**
 * Normalizes an amount to the decimal string bKash expects ("2.90").
 * Numbers are formatted with two decimals; strings must already have at most
 * two decimals so that rounding never changes what the customer pays.
 */
export function formatAmount(field: string, value: Amount): string {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BkashValidationError(field, 'must be a finite number');
    if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
      throw new BkashValidationError(field, 'must have at most two decimal places');
    }
    text = value.toFixed(2);
  } else if (typeof value === 'string') {
    text = value.trim();
    if (!AMOUNT.test(text)) throw new BkashValidationError(field, 'must be a decimal with at most two places, e.g. "120.50"');
  } else {
    throw new BkashValidationError(field, 'must be a number or numeric string');
  }
  if (Number(text) <= 0) throw new BkashValidationError(field, 'must be greater than zero');
  return text;
}

export function validateUrl(field: string, value: unknown, allowHttp: boolean): string {
  const v = requireString(field, value);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new BkashValidationError(field, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new BkashValidationError(field, allowHttp ? 'must use http or https' : 'must use https in production');
  }
  return v;
}

export function validateCurrency(value: string | undefined): string {
  const c = (value ?? CURRENCY_BDT).toUpperCase();
  if (c !== CURRENCY_BDT) throw new BkashValidationError('currency', 'bKash checkout only accepts BDT');
  return c;
}

/** Converts a bKash amount string to integer paisa for exact comparisons. */
export function toPaisa(amount: string | number): number {
  const text = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const [whole = '0', frac = ''] = text.split('.');
  return Number.parseInt(whole, 10) * 100 + Number.parseInt((frac + '00').slice(0, 2), 10);
}
