import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearPendingTransaction,
  createSubmissionGuard,
  createTransactionAttempt,
  parseInrToPaise,
  readPendingTransaction,
  savePendingTransaction,
} from '../src/lib/transactions.js';

test('INR text converts to integer paise without floating-point arithmetic', () => {
  assert.equal(parseInrToPaise('1'), '100');
  assert.equal(parseInrToPaise('0.5'), '50');
  assert.equal(parseInrToPaise('1234.56'), '123456');
  assert.equal(parseInrToPaise('90071992547409.91'), '9007199254740991');
});

test('INR parsing rejects nonpositive, malformed, over-precision, and out-of-range values', () => {
  for (const value of ['', '0', '0.00', '-1', '+1', '1.001', '1e2', '01.00', '90071992547409.92']) {
    assert.throws(() => parseInrToPaise(value), Error, `expected ${value} to be rejected`);
  }
});

test('same payload reuses its idempotency key while a changed payload gets a fresh key', () => {
  let sequence = 0;
  const idFactory = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const firstPayload = { type: 'DEPOSIT', accountId: 'account-a', amountPaise: '1000' };
  const first = createTransactionAttempt(null, firstPayload, idFactory);
  const retry = createTransactionAttempt(first, { ...firstPayload }, idFactory);
  const changed = createTransactionAttempt(first, { ...firstPayload, amountPaise: '1001' }, idFactory);

  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changed.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(retry.payload, firstPayload);
});

test('pending transaction storage restores the same payload and key after reload', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const attempt = createTransactionAttempt(null, {
    type: 'TRANSFER', sourceAccountId: 'source', destinationAccountId: 'destination', amountPaise: '2500',
  }, () => '00000000-0000-4000-8000-000000000001');
  savePendingTransaction('user-id', 'TRANSFER', { ...attempt, state: 'uncertain' }, storage);
  const restored = readPendingTransaction('user-id', 'TRANSFER', storage);

  assert.deepEqual(restored, { ...attempt, state: 'uncertain' });
  clearPendingTransaction('user-id', 'TRANSFER', storage);
  assert.equal(readPendingTransaction('user-id', 'TRANSFER', storage), null);
});

test('submission guard blocks duplicate submissions until the pending request finishes', () => {
  const guard = createSubmissionGuard();
  assert.equal(guard.tryBegin(), true);
  assert.equal(guard.tryBegin(), false);
  guard.finish();
  assert.equal(guard.tryBegin(), true);
  guard.finish();
});

test('transaction payload key ignores extra display metadata and formatPaiseForInput formats correctly', () => {
  const payloadWithMeta = {
    type: 'TRANSFER',
    sourceAccountId: 'acc-1',
    destinationAccountId: 'acc-2',
    amountPaise: '50000',
    sourceAccountNumber: '01',
    destinationAccountNumber: '02',
  };
  const payloadWithoutMeta = {
    type: 'TRANSFER',
    sourceAccountId: 'acc-1',
    destinationAccountId: 'acc-2',
    amountPaise: '50000',
  };
  const key1 = createTransactionAttempt(null, payloadWithMeta, () => 'id-1');
  const key2 = createTransactionAttempt(key1, payloadWithoutMeta, () => 'id-2');
  assert.equal(key1.idempotencyKey, key2.idempotencyKey);
});
