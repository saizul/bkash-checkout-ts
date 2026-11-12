import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  BkashApiError,
  BkashAuthError,
  BkashNetworkError,
  BkashPaymentAlreadyCompletedError,
  BkashResponseError,
  BkashTimeoutError,
  describeErrorCode,
  extractStatus,
  isBkashError,
  registerErrorCode,
  resetCustomErrorCodes,
  toApiError,
} from '../src/index.js';

afterEach(() => resetCustomErrorCodes());

describe('extractStatus', () => {
  it('treats statusCode 0000 as success', () => {
    assert.equal(extractStatus({ statusCode: '0000', statusMessage: 'Successful' }).ok, true);
  });
  it('treats a body without status fields as success', () => {
    assert.equal(extractStatus({ paymentId: 'x' }).ok, true);
  });
  it('reads the classic statusCode/statusMessage shape', () => {
    const s = extractStatus({ statusCode: '2023', statusMessage: 'Insufficient Balance' });
    assert.deepEqual([s.ok, s.code, s.message], [false, '2023', 'Insufficient Balance']);
  });
  it('reads the v2 externalCode/errorMessageEn shape', () => {
    const s = extractStatus({ externalCode: '2002', internalCode: 'invalid_payment_id', errorMessageEn: 'Invalid Payment ID', errorMessageBn: null });
    assert.deepEqual([s.ok, s.code, s.message, s.internalCode, s.messageBn], [false, '2002', 'Invalid Payment ID', 'invalid_payment_id', null]);
  });
  it('treats an error message without a code as failure', () => {
    assert.equal(extractStatus({ errorMessageEn: 'Something' }).ok, false);
  });
  it('accepts numeric codes', () => {
    assert.equal(extractStatus({ statusCode: 2062 }).code, '2062');
  });
  it('handles non-object bodies', () => {
    assert.equal(extractStatus(null).ok, true);
    assert.equal(extractStatus('text').ok, true);
  });
});

describe('toApiError', () => {
  it('returns BkashPaymentAlreadyCompletedError for 2062', () => {
    const e = toApiError({ externalCode: '2062', errorMessageEn: 'done' }, 'executePayment', 200);
    assert.ok(e instanceof BkashPaymentAlreadyCompletedError);
    assert.ok(e instanceof BkashApiError);
    assert.equal(e.category, 'payment_state');
  });
  it('returns BkashAuthError for token operations and 401', () => {
    assert.ok(toApiError({ statusCode: '1' , statusMessage: 'x'}, 'grantToken', 200) instanceof BkashAuthError);
    assert.ok(toApiError({ errorMessageEn: 'x' }, 'queryPayment', 401) instanceof BkashAuthError);
  });
  it('falls back to HTTP status when the body has no code', () => {
    const e = toApiError({ errorMessageEn: 'x' }, 'queryPayment', 500);
    assert.equal(e.code, 'HTTP_500');
  });
  it('keeps the raw body and operation', () => {
    const body = { externalCode: '2007', errorMessageEn: 'Invalid currency.' };
    const e = toApiError(body, 'createPayment', 200);
    assert.equal(e.operation, 'createPayment');
    assert.deepEqual(e.raw, body);
    assert.match(e.message, /createPayment failed: Invalid currency\. \(2007\)/);
    assert.equal(e.name, 'BkashApiError');
  });
});

describe('error codes', () => {
  it('describes documented codes', () => {
    assert.equal(describeErrorCode('2002').category, 'not_found');
    assert.equal(describeErrorCode('nope').category, 'unknown');
    assert.equal(describeErrorCode(undefined).category, 'unknown');
  });
  it('can register custom codes', () => {
    registerErrorCode('2029', { category: 'payment_state', description: 'Duplicate for all transactions', retryable: true });
    const e = toApiError({ statusCode: '2029', statusMessage: 'Duplicate' }, 'executePayment', 200);
    assert.equal(e.category, 'payment_state');
    assert.equal(e.retryable, true);
  });
  it('retryable flags', () => {
    assert.equal(new BkashNetworkError('x').retryable, true);
    assert.equal(new BkashTimeoutError('x').retryable, true);
    assert.equal(new BkashResponseError('x', { httpStatus: 502 }).retryable, true);
    assert.equal(new BkashResponseError('x', { httpStatus: 400 }).retryable, false);
    assert.ok(isBkashError(new BkashTimeoutError('x')));
    assert.ok(!isBkashError(new Error('x')));
  });
});
