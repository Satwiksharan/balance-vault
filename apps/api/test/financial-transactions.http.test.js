import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/config/auth.js';

if ([...(process.env.JWT_ACCESS_SECRET ?? '')].length < 32) {
  process.env.JWT_ACCESS_SECRET = 'balancevault-financial-http-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
}

const actorId = '30000000-0000-4000-8000-000000000001';
const otherActorId = '30000000-0000-4000-8000-000000000002';
const accountA = '40000000-0000-4000-8000-000000000001';
const accountB = '40000000-0000-4000-8000-000000000002';
const missingAccount = '40000000-0000-4000-8000-000000000099';
const users = new Map([
  [actorId, { id: actorId, role: 'ACCOUNT_HOLDER', isActive: true, tokenVersion: 0 }],
  [otherActorId, { id: otherActorId, role: 'ACCOUNT_HOLDER', isActive: true, tokenVersion: 0 }],
]);
const accounts = new Map([
  [accountA, { id: accountA, accountNumber: 'BV-A', type: 'PERSONAL', status: 'ACTIVE', currencyCode: 'INR', balance: 0n }],
  [accountB, { id: accountB, accountNumber: 'BV-B', type: 'BUSINESS', status: 'ACTIVE', currencyCode: 'INR', balance: 0n }],
]);
const permissions = new Set([
  `${actorId}:${accountA}:canDeposit`, `${actorId}:${accountA}:canWithdraw`, `${actorId}:${accountA}:canTransfer`, `${actorId}:${accountA}:canView`,
  `${actorId}:${accountB}:canDeposit`, `${actorId}:${accountB}:canWithdraw`, `${actorId}:${accountB}:canTransfer`, `${actorId}:${accountB}:canView`,
]);
const idempotency = new Map();
const journals = new Map();
const attempts = [];
let calls = 0;

function databaseResult(status, body) {
  return [{ response_status: status, response_body: body }];
}

function permission(userId, accountId, capability) {
  return permissions.has(`${userId}:${accountId}:${capability}`);
}

function fakePrisma() {
  return {
    user: {
      async findUnique({ where }) {
        const user = users.get(where.id);
        return user ? { id: user.id, role: user.role, isActive: user.isActive, tokenVersion: user.tokenVersion } : null;
      },
    },
    async $queryRaw(_strings, userId, type, sourceId, destinationId, amountText, key, hash) {
      calls += 1;
      const idemKey = `${userId}:${key}`;
      const existing = idempotency.get(idemKey);
      if (existing) {
        if (existing.hash !== hash) return databaseResult(409, { error: 'idempotency_key_conflict' });
        return databaseResult(existing.status, structuredClone(existing.body));
      }

      const amount = BigInt(amountText);
      const save = (status, body) => {
        idempotency.set(idemKey, { hash, status, body: structuredClone(body) });
        return databaseResult(status, body);
      };
      const refuse = (status, reason) => {
        attempts.push({ userId, type, sourceId, destinationId, status: 'REFUSED', reason });
        return save(status, { status: 'REFUSED', reason });
      };

      const actor = users.get(userId);
      if (!actor?.isActive) return refuse(403, 'actor_inactive');
      if (actor.role === 'AUDITOR') return refuse(403, 'role_forbidden');
      const source = sourceId ? accounts.get(sourceId) : null;
      const destination = destinationId ? accounts.get(destinationId) : null;
      if ((sourceId && !source) || (destinationId && !destination)) return refuse(409, 'account_unavailable');
      if (type === 'DEPOSIT' && !permission(userId, destinationId, 'canDeposit')) return refuse(403, 'not_authorized');
      if (type === 'WITHDRAWAL' && !permission(userId, sourceId, 'canWithdraw')) return refuse(403, 'not_authorized');
      if (type === 'TRANSFER' && !permission(userId, sourceId, 'canTransfer')) return refuse(403, 'not_authorized');
      if (type === 'TRANSFER' && !permission(userId, destinationId, 'canView')) return refuse(403, 'not_authorized');
      if ([source, destination].filter(Boolean).some((account) => account.status !== 'ACTIVE')) return refuse(409, 'account_unavailable');
      if ((type === 'WITHDRAWAL' || type === 'TRANSFER') && source.balance < amount) return refuse(422, 'insufficient_funds');

      if (type === 'DEPOSIT') destination.balance += amount;
      if (type === 'WITHDRAWAL') source.balance -= amount;
      if (type === 'TRANSFER') {
        source.balance -= amount;
        destination.balance += amount;
      }
      const id = randomUUID();
      const entries = type === 'DEPOSIT'
        ? [{ accountId: destinationId, amountPaise: amount.toString() }]
        : type === 'WITHDRAWAL'
          ? [{ accountId: sourceId, amountPaise: (-amount).toString() }]
          : [{ accountId: sourceId, amountPaise: (-amount).toString() }, { accountId: destinationId, amountPaise: amount.toString() }];
      const body = { status: 'POSTED', journalTransactionId: id, amountPaise: Number(amount) };
      journals.set(id, { id, type, status: 'POSTED', createdAt: new Date(), entries });
      return save(201, body);
    },
    journalTransaction: {
      async findFirst({ where }) {
        const journal = journals.get(where.id);
        if (!journal || journal.type !== where.type || journal.status !== where.status) return null;
        const permitted = journal.entries.every(({ accountId }) => {
          const account = accounts.get(accountId);
          const filter = where.entries.every.account;
          return account && filter.type.in.includes(account.type)
            && account.status === 'ACTIVE'
            && (filter.systemCode === null)
            && (!filter.permissions || permission(filter.permissions.some.userId, accountId, 'canView'));
        });
        if (!permitted) return null;
        return {
          id: journal.id,
          type: journal.type,
          status: journal.status,
          createdAt: journal.createdAt,
          entries: journal.entries.map((entry) => ({
            amountPaise: BigInt(entry.amountPaise),
            account: { id: entry.accountId, accountNumber: accounts.get(entry.accountId).accountNumber, type: accounts.get(entry.accountId).type, currencyCode: 'INR' },
          })),
        };
      },
    },
  };
}

let server;
let baseUrl;

function token(userId = actorId) {
  return jwt.sign({ ver: 0 }, process.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256', subject: userId, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: '15m',
  });
}

async function request(path, { method = 'POST', body, key, userId = actorId, auth = true } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token(userId)}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  for (const account of accounts.values()) account.balance = 0n;
  idempotency.clear();
  journals.clear();
  attempts.length = 0;
  calls = 0;
  users.get(actorId).role = 'ACCOUNT_HOLDER';
  users.get(actorId).isActive = true;
  permissions.add(`${actorId}:${accountA}:canView`);
  permissions.add(`${actorId}:${accountB}:canView`);
  const app = createApp({ prismaClient: fakePrisma() });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('deposit, withdrawal and transfer return database posting results with integer paise', async () => {
  const deposit = await request('/api/deposits', { body: { accountId: accountA, amountPaise: '100000' }, key: 'deposit' });
  assert.equal(deposit.status, 201);
  const depositBody = await deposit.json();
  assert.equal(depositBody.status, 'POSTED');
  assert.equal(accounts.get(accountA).balance, 100000n);

  const withdrawal = await request('/api/withdrawals', { body: { accountId: accountA, amountPaise: 20000 }, key: 'withdrawal' });
  assert.equal(withdrawal.status, 201);
  assert.equal(accounts.get(accountA).balance, 80000n);

  const transfer = await request('/api/transfers', { body: { sourceAccountId: accountA, destinationAccountId: accountB, amountPaise: '30000' }, key: 'transfer' });
  assert.equal(transfer.status, 201);
  assert.equal(accounts.get(accountA).balance, 50000n);
  assert.equal(accounts.get(accountB).balance, 30000n);
  assert.equal(accounts.get(accountA).balance + accounts.get(accountB).balance, 80000n);

  const transferBody = await transfer.json();
  const transferReplay = await request('/api/transfers', {
    body: { sourceAccountId: accountA, destinationAccountId: accountB, amountPaise: '30000' },
    key: 'transfer',
  });
  assert.equal(transferReplay.status, 201);
  assert.deepEqual(await transferReplay.json(), transferBody);
  assert.equal(accounts.get(accountA).balance, 50000n);
  assert.equal(accounts.get(accountB).balance, 30000n);
  const lookup = await request(`/api/transfers/${transferBody.journalTransactionId}`, { method: 'GET' });
  assert.equal(lookup.status, 200);
  const { transfer: record } = await lookup.json();
  assert.equal(record.entries.length, 2);
  assert.deepEqual(record.entries.map((entry) => entry.amountPaise), ['-30000', '30000']);
  const hidden = await request(`/api/transfers/${transferBody.journalTransactionId}`, { method: 'GET', userId: otherActorId });
  assert.equal(hidden.status, 404);
});

test('insufficient funds and unauthorized accounts produce persisted refusals without balance changes', async () => {
  const insufficient = await request('/api/withdrawals', { body: { accountId: accountA, amountPaise: '1' }, key: 'too-much' });
  assert.equal(insufficient.status, 422);
  assert.equal((await insufficient.json()).reason, 'insufficient_funds');
  assert.equal(attempts.at(-1).status, 'REFUSED');
  assert.equal(accounts.get(accountA).balance, 0n);

  const unauthorized = await request('/api/withdrawals', { body: { accountId: accountA, amountPaise: '1' }, key: 'unauthorized', userId: otherActorId });
  assert.equal(unauthorized.status, 403);
  assert.equal((await unauthorized.json()).reason, 'not_authorized');
  assert.equal(attempts.at(-1).status, 'REFUSED');

  const missing = await request('/api/deposits', { body: { accountId: missingAccount, amountPaise: '1' }, key: 'missing-account' });
  assert.equal(missing.status, 409);
  assert.equal(attempts.at(-1).reason, 'account_unavailable');
});

test('operation-specific capabilities and destination visibility are enforced', async () => {
  permissions.delete(`${actorId}:${accountA}:canDeposit`);
  const deposit = await request('/api/deposits', {
    body: { accountId: accountA, amountPaise: '100' }, key: 'no-deposit-capability',
  });
  assert.equal(deposit.status, 403);
  assert.equal((await deposit.json()).reason, 'not_authorized');
  assert.equal(accounts.get(accountA).balance, 0n);

  permissions.add(`${actorId}:${accountA}:canDeposit`);
  permissions.delete(`${actorId}:${accountA}:canWithdraw`);
  const withdrawal = await request('/api/withdrawals', {
    body: { accountId: accountA, amountPaise: '1' }, key: 'no-withdraw-capability',
  });
  assert.equal(withdrawal.status, 403);
  assert.equal((await withdrawal.json()).reason, 'not_authorized');
  assert.equal(accounts.get(accountA).balance, 0n);

  permissions.add(`${actorId}:${accountA}:canWithdraw`);
  permissions.delete(`${actorId}:${accountB}:canView`);
  const transfer = await request('/api/transfers', {
    body: { sourceAccountId: accountA, destinationAccountId: accountB, amountPaise: '1' },
    key: 'destination-not-visible',
  });
  assert.equal(transfer.status, 403);
  assert.equal((await transfer.json()).reason, 'not_authorized');
  assert.equal(accounts.get(accountA).balance, 0n);
  assert.equal(accounts.get(accountB).balance, 0n);
  assert.equal(journals.size, 0);
});

test('auditors cannot deposit or withdraw even when granted account permissions', async () => {
  const auditorId = randomUUID();
  users.set(auditorId, { id: auditorId, role: 'AUDITOR', isActive: true, tokenVersion: 0 });
  permissions.add(`${auditorId}:${accountA}:canDeposit`);
  permissions.add(`${auditorId}:${accountA}:canWithdraw`);
  const deposit = await request('/api/deposits', {
    userId: auditorId, body: { accountId: accountA, amountPaise: '1' }, key: 'auditor-no-deposit',
  });
  const withdrawal = await request('/api/withdrawals', {
    userId: auditorId, body: { accountId: accountA, amountPaise: '1' }, key: 'auditor-no-withdrawal',
  });
  assert.equal(deposit.status, 403);
  assert.equal(withdrawal.status, 403);
  assert.equal((await deposit.json()).reason, 'role_forbidden');
  assert.equal((await withdrawal.json()).reason, 'role_forbidden');
  assert.equal(accounts.get(accountA).balance, 0n);
  assert.equal(journals.size, 0);
});

test('amounts, account IDs, idempotency keys, and unauthenticated requests are validated', async () => {
  for (const amount of [0, -1, 1.5, '1.5', '0', '01', '9007199254740992']) {
    const response = await request('/api/deposits', { body: { accountId: accountA, amountPaise: amount }, key: randomUUID() });
    assert.equal(response.status, 400, `amount ${String(amount)} should be rejected`);
  }
  assert.equal((await request('/api/deposits', { body: { accountId: 'invalid', amountPaise: 1 }, key: 'bad-id' })).status, 400);
  assert.equal((await request('/api/deposits', { body: { accountId: accountA, amountPaise: 1 } })).status, 400);
  assert.equal((await request('/api/deposits', { body: { accountId: accountA, amountPaise: 1, actorId: otherActorId, role: 'ADMIN' }, key: 'spoof' })).status, 400);
  assert.equal((await request('/api/deposits', { body: { accountId: accountA, amountPaise: 1 }, key: 'no-auth', auth: false })).status, 401);
  assert.equal(calls, 0);
});

test('same idempotency key replays the original result; changed payload conflicts', async () => {
  const body = { accountId: accountA, amountPaise: '900' };
  const first = await request('/api/deposits', { body, key: 'replay-key' });
  const original = await first.json();
  const replay = await request('/api/deposits', { body, key: 'replay-key' });
  assert.deepEqual(await replay.json(), original);
  assert.equal(accounts.get(accountA).balance, 900n);
  const conflict = await request('/api/deposits', { body: { ...body, amountPaise: '901' }, key: 'replay-key' });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_key_conflict' });
  assert.equal(accounts.get(accountA).balance, 900n);
});

test('concurrent duplicate requests post once and concurrent withdrawals cannot overdraw', async () => {
  const duplicateBody = { accountId: accountA, amountPaise: '1000' };
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => request('/api/deposits', { body: duplicateBody, key: 'parallel-duplicate' })));
  assert.ok(duplicates.every((response) => response.status === 201));
  const results = await Promise.all(duplicates.map((response) => response.json()));
  assert.equal(new Set(results.map((result) => result.journalTransactionId)).size, 1);
  assert.equal(accounts.get(accountA).balance, 1000n);

  accounts.get(accountA).balance = 100000n;
  const withdrawals = await Promise.all(Array.from({ length: 10 }, (_, index) => request('/api/withdrawals', {
    body: { accountId: accountA, amountPaise: '20000' }, key: `withdraw-${index}`,
  })));
  assert.equal(withdrawals.filter((response) => response.status === 201).length, 5);
  assert.equal(withdrawals.filter((response) => response.status === 422).length, 5);
  assert.equal(accounts.get(accountA).balance, 0n);
});
