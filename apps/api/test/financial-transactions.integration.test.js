import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { createApp } from '../src/app.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/config/auth.js';
import { canonicalRequestHash } from '../src/services/financial-transaction.service.js';

if ([...(process.env.JWT_ACCESS_SECRET ?? '')].length < 32) {
  process.env.JWT_ACCESS_SECRET = 'balancevault-financial-db-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
}

const { Client } = pg;
const testRunId = randomUUID();
const databaseUrl = process.env.BALANCEVAULT_TEST_DATABASE_URL;
const runtimeDatabaseUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
const integration = Boolean(databaseUrl && runtimeDatabaseUrl);
if ((databaseUrl || runtimeDatabaseUrl)
  && (!databaseName.endsWith('_test') || databaseName === 'balancevault_dev'
    || new URL(runtimeDatabaseUrl ?? databaseUrl).pathname.slice(1) !== databaseName)) {
  throw new Error('Financial API integration URLs must point to the same disposable database ending in _test.');
}

let admin;
let prisma;
let server;
let baseUrl;

function accessToken(userId) {
  return jwt.sign({ ver: 0 }, process.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: '15m',
  });
}

async function apiPost(path, userId, body, key) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken(userId)}`,
      'content-type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
  });
}

async function apiGet(path, userId, base = baseUrl) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${accessToken(userId)}` } });
}

async function createTestUser(role) {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO public."User" (id,email,"passwordHash",role,"isActive","updatedAt")
     VALUES ($1,$2,'test-hash',$3,true,clock_timestamp())`,
    [id, `${id}@example.test`, role],
  );
  return id;
}

async function createFinancialFixture(accountCount = 2, capabilities = {
  canView: true,
  canDeposit: true,
  canWithdraw: true,
  canTransfer: true,
}) {
  const userId = randomUUID();
  const accountIds = Array.from({ length: accountCount }, () => randomUUID());
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO public."User" (id,email,"passwordHash",role,"isActive","updatedAt")
       VALUES ($1,$2,'test-hash','ACCOUNT_HOLDER',true,clock_timestamp())`,
      [userId, `${userId}@example.test`],
    );
    for (const [index, accountId] of accountIds.entries()) {
      await admin.query(
        `INSERT INTO public."Account" (id,"accountNumber",type,status,"balancePaise","currencyCode","updatedAt")
         VALUES ($1,$2,'PERSONAL','ACTIVE',0,'INR',clock_timestamp())`,
        [accountId, `BV-RACE-${userId.slice(0, 8)}-${index}`],
      );
      await admin.query(
        `INSERT INTO public."AccountPermission"
          (id,"userId","accountId","canView","canDeposit","canWithdraw","canTransfer","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
        [randomUUID(), userId, accountId, capabilities.canView, capabilities.canDeposit,
          capabilities.canWithdraw, capabilities.canTransfer],
      );
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  return { userId, accountIds };
}

async function postDatabaseTransaction({ actorId, type, sourceAccountId = null, destinationAccountId = null, amountPaise, idempotencyKey }, client = null) {
  const ownedClient = client ?? new Client({ connectionString: runtimeDatabaseUrl });
  if (!client) await ownedClient.connect();
  await ownedClient.query('SET ROLE balancevault_runtime');
  try {
    const requestHash = canonicalRequestHash({ type, sourceAccountId, destinationAccountId, amountPaise });
    const { rows: [result] } = await ownedClient.query(
      `SELECT * FROM public.balancevault_post_transaction(
        $1::uuid,$2::public."JournalTransactionType",$3::uuid,$4::uuid,$5::bigint,$6::text,$7::char(64)
      )`,
      [actorId, type, sourceAccountId, destinationAccountId, amountPaise.toString(), idempotencyKey, requestHash],
    );
    return result;
  } finally {
    if (!client) await ownedClient.end();
  }
}

async function balance(accountId) {
  const { rows } = await admin.query('SELECT "balancePaise" FROM public."Account" WHERE id=$1', [accountId]);
  return BigInt(rows[0].balancePaise);
}

async function customerBalanceTotal(accountIds) {
  const { rows: [{ total }] } = await admin.query(
    `SELECT COALESCE(sum("balancePaise"),0)::text AS total
       FROM public."Account" WHERE id=ANY($1::uuid[])`,
    [accountIds],
  );
  return BigInt(total);
}

async function journalPostings(journalId) {
  const { rows } = await admin.query(
    'SELECT "amountPaise" FROM public."LedgerEntry" WHERE "journalTransactionId"=$1 ORDER BY "postingSequence"',
    [journalId],
  );
  return rows.map(({ amountPaise }) => BigInt(amountPaise));
}

async function waitForDatabaseLock(pid, timeoutMillis = 5000) {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    const { rows: [activity] } = await admin.query(
      'SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1', [pid],
    );
    if (activity?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Posting connection did not reach the expected account-row lock wait.');
}

before(async () => {
  if (!integration) return;
  admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const { rows } = await admin.query('SELECT current_database() AS db');
  assert.equal(rows[0].db, databaseName);

  // Stable clearing accounts are required by the existing deposit posting
  // function. These are created only in the disposable test database.
  await admin.query(`
    INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
    VALUES
      ('00000000-0000-0000-0000-000000000012','BV-CLEAR-DEP','CLEARING_DEPOSIT_INR','SYSTEM_CLEARING','ACTIVE',0,'INR',clock_timestamp()),
      ('00000000-0000-0000-0000-000000000013','BV-CLEAR-WD','CLEARING_WITHDRAWAL_INR','SYSTEM_CLEARING','ACTIVE',0,'INR',clock_timestamp())
    ON CONFLICT ("systemCode") DO NOTHING
  `);

  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }) });
  const app = createApp({ prismaClient: prisma });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  if (prisma) await prisma.$disconnect();
  if (admin) await admin.end();
});

test('financial HTTP endpoints persist through the PostgreSQL runtime role', {
  skip: !integration,
  timeout: 60_000,
}, async () => {
  const userId = randomUUID();
  const [accountA, accountB] = [randomUUID(), randomUUID()];
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO public."User" (id,email,"passwordHash",role,"isActive","updatedAt")
       VALUES ($1,$2,'test-hash','ACCOUNT_HOLDER',true,clock_timestamp())`,
      [userId, `${userId}@example.test`],
    );
    for (const [index, accountId] of [accountA, accountB].entries()) {
      await admin.query(
        `INSERT INTO public."Account" (id,"accountNumber",type,status,"balancePaise","currencyCode","updatedAt")
         VALUES ($1,$2,'PERSONAL','ACTIVE',0,'INR',clock_timestamp())`,
        [accountId, `BV-HTTP-${userId.slice(0, 8)}-${index}`],
      );
      await admin.query(
        `INSERT INTO public."AccountPermission"
          (id,"userId","accountId","canView","canDeposit","canWithdraw","canTransfer","updatedAt")
         VALUES ($1,$2,$3,true,true,true,true,clock_timestamp())`,
        [randomUUID(), userId, accountId],
      );
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }

  const depositBody = { accountId: accountA, amountPaise: '100000' };
  const deposit = await apiPost('/api/deposits', userId, depositBody, 'http-db-deposit');
  assert.equal(deposit.status, 201);
  const depositResult = await deposit.json();
  assert.equal(depositResult.status, 'POSTED');
  assert.equal(await balance(accountA), 100000n);

  const replay = await apiPost('/api/deposits', userId, depositBody, 'http-db-deposit');
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), depositResult);
  const conflict = await apiPost('/api/deposits', userId, { ...depositBody, amountPaise: '100001' }, 'http-db-deposit');
  assert.equal(conflict.status, 409);
  assert.equal(await balance(accountA), 100000n);

  const parallel = await Promise.all(Array.from({ length: 8 }, () => apiPost(
    '/api/deposits', userId, { accountId: accountA, amountPaise: '777' }, 'http-db-concurrent-duplicate',
  )));
  assert.ok(parallel.every((response) => response.status === 201));
  const parallelBodies = await Promise.all(parallel.map((response) => response.json()));
  assert.equal(new Set(parallelBodies.map((body) => body.journalTransactionId)).size, 1);
  assert.equal(await balance(accountA), 100777n);

  const transfer = await fetch(`${baseUrl}/api/transfers`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken(userId)}`,
      'content-type': 'application/json',
      'Idempotency-Key': 'http-db-transfer',
    },
    body: JSON.stringify({ sourceAccountId: accountA, destinationAccountId: accountB, amountPaise: '25000' }),
  });
  assert.equal(transfer.status, 201);
  const transferResult = await transfer.json();
  assert.equal(await balance(accountA), 75777n);
  assert.equal(await balance(accountB), 25000n);
  const transferReplay = await fetch(`${baseUrl}/api/transfers`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken(userId)}`,
      'content-type': 'application/json',
      'Idempotency-Key': 'http-db-transfer',
    },
    body: JSON.stringify({ sourceAccountId: accountA, destinationAccountId: accountB, amountPaise: '25000' }),
  });
  assert.equal(transferReplay.status, 201);
  assert.deepEqual(await transferReplay.json(), transferResult);
  assert.equal(await balance(accountA), 75777n);
  assert.equal(await balance(accountB), 25000n);

  const transferRead = await fetch(`${baseUrl}/api/transfers/${transferResult.journalTransactionId}`, {
    headers: { authorization: `Bearer ${accessToken(userId)}` },
  });
  assert.equal(transferRead.status, 200);
  const visiblePostings = (await transferRead.json()).transfer.entries
    .map((entry) => entry.amountPaise)
    .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
  assert.deepEqual(visiblePostings, ['-25000', '25000']);

  const insufficient = await fetch(`${baseUrl}/api/withdrawals`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken(userId)}`,
      'content-type': 'application/json',
      'Idempotency-Key': 'http-db-insufficient',
    },
    body: JSON.stringify({ accountId: accountA, amountPaise: '99999999' }),
  });
  assert.equal(insufficient.status, 422);
  assert.equal((await insufficient.json()).reason, 'insufficient_funds');
  assert.equal(await balance(accountA), 75777n);

  const evidence = await admin.query(`
    SELECT a.status, a."refusalReason", count(e.id) AS ledger_rows
      FROM public."IdempotencyRecord" i
      JOIN public."TransactionAttempt" a ON a."idempotencyRecordId"=i.id
      LEFT JOIN public."LedgerEntry" e ON e."journalTransactionId"=i."resultJournalTransactionId"
     WHERE i."userId"=$1 AND i."idempotencyKey"='http-db-insufficient'
     GROUP BY a.status,a."refusalReason"`, [userId]);
  assert.deepEqual(evidence.rows, [{ status: 'REFUSED', refusalReason: 'insufficient_funds', ledger_rows: '0' }]);

  const statementPages = [];
  let statementCursor;
  do {
    const query = new URLSearchParams({ limit: '2' });
    if (statementCursor) query.set('cursor', statementCursor);
    const page = await apiGet(`/api/accounts/${accountA}/statement?${query}`, userId);
    assert.equal(page.status, 200);
    const body = await page.json();
    statementPages.push(...body.events);
    statementCursor = body.nextCursor;
  } while (statementCursor);

  if (statementPages.length !== 4) {
    console.error('financial_statement_diagnostic', JSON.stringify({
      testRunId,
      eventCount: statementPages.length,
      events: statementPages.map((event) => ({
        eventId: event.id,
        type: event.type,
        accountId: 'accountA',
        status: event.status,
        amountPaise: event.amountPaise,
        reference: event.reference,
      })),
    }));
  }
  assert.equal(statementPages.length, 4);
  assert.equal(new Set(statementPages.map((event) => event.id)).size, 4);
  assert.deepEqual(statementPages.map((event) => event.status), ['POSTED', 'POSTED', 'POSTED', 'REFUSED']);
  assert.deepEqual(statementPages.map((event) => event.amountPaise), ['100000', '777', '-25000', '99999999']);
  assert.deepEqual(statementPages.map((event) => event.runningBalancePaise), ['100000', '100777', '75777', '75777']);
  assert.ok(statementPages.every((event) => event.actor.id === userId && event.actor.role === 'ACCOUNT_HOLDER'));
  assert.equal(statementPages[3].refusalReason, 'insufficient_funds');
  assert.equal((await apiGet(`/api/accounts/${accountA}/statement?limit=101`, userId)).status, 400);
  assert.equal((await apiGet(`/api/accounts/${accountA}/statement?cursor=not-a-cursor`, userId)).status, 400);

  const otherHolderId = await createTestUser('ACCOUNT_HOLDER');
  const hiddenStatement = await apiGet(`/api/accounts/${accountA}/statement`, otherHolderId);
  assert.equal(hiddenStatement.status, 404);

  const auditorId = await createTestUser('AUDITOR');
  await admin.query(
    `INSERT INTO public."AccountPermission" (id,"userId","accountId","canView","updatedAt")
     VALUES ($1,$2,$3,true,clock_timestamp())`, [randomUUID(), auditorId, accountA],
  );
  assert.equal((await apiGet(`/api/accounts/${accountA}/statement`, auditorId)).status, 200);
  assert.equal((await apiGet(`/api/accounts/${accountB}/statement`, auditorId)).status, 404);
  const auditorDeposit = await apiPost('/api/deposits', auditorId, { accountId: accountA, amountPaise: '1' }, 'auditor-deposit');
  assert.equal(auditorDeposit.status, 403);
  assert.equal((await auditorDeposit.json()).reason, 'role_forbidden');
  const auditorWithdrawal = await apiPost('/api/withdrawals', auditorId, { accountId: accountA, amountPaise: '1' }, 'auditor-withdrawal');
  assert.equal(auditorWithdrawal.status, 403);
  assert.equal((await auditorWithdrawal.json()).reason, 'role_forbidden');
  const adminId = await createTestUser('ADMIN');

  const noDeposit = await createFinancialFixture(1, {
    canView: true, canDeposit: false, canWithdraw: true, canTransfer: true,
  });
  const noDepositBefore = await balance(noDeposit.accountIds[0]);
  const depositDenied = await postDatabaseTransaction({
    actorId: noDeposit.userId, type: 'DEPOSIT', destinationAccountId: noDeposit.accountIds[0],
    amountPaise: 1n, idempotencyKey: 'deposit-capability-denied',
  });
  assert.equal(depositDenied.response_status, 403);
  assert.equal(depositDenied.response_body.reason, 'not_authorized');
  assert.equal(await balance(noDeposit.accountIds[0]), noDepositBefore);
  const unauthorizedDeposit = await postDatabaseTransaction({
    actorId: noDeposit.userId, type: 'DEPOSIT', destinationAccountId: accountA,
    amountPaise: 1n, idempotencyKey: 'another-holders-deposit-denied',
  });
  assert.equal(unauthorizedDeposit.response_status, 403);
  assert.equal(unauthorizedDeposit.response_body.reason, 'not_authorized');
  assert.equal(await balance(accountA), 75777n);

  const noWithdrawal = await createFinancialFixture(1, {
    canView: true, canDeposit: true, canWithdraw: false, canTransfer: true,
  });
  await postDatabaseTransaction({
    actorId: noWithdrawal.userId, type: 'DEPOSIT', destinationAccountId: noWithdrawal.accountIds[0],
    amountPaise: 500n, idempotencyKey: 'withdrawal-capability-funding',
  });
  const noWithdrawalBefore = await balance(noWithdrawal.accountIds[0]);
  const withdrawalDenied = await postDatabaseTransaction({
    actorId: noWithdrawal.userId, type: 'WITHDRAWAL', sourceAccountId: noWithdrawal.accountIds[0],
    amountPaise: 1n, idempotencyKey: 'withdrawal-capability-denied',
  });
  assert.equal(withdrawalDenied.response_status, 403);
  assert.equal(withdrawalDenied.response_body.reason, 'not_authorized');
  assert.equal(await balance(noWithdrawal.accountIds[0]), noWithdrawalBefore);

  const noTransfer = await createFinancialFixture(2, {
    canView: true, canDeposit: true, canWithdraw: true, canTransfer: false,
  });
  await postDatabaseTransaction({
    actorId: noTransfer.userId, type: 'DEPOSIT', destinationAccountId: noTransfer.accountIds[0],
    amountPaise: 500n, idempotencyKey: 'transfer-capability-funding',
  });
  const transferDenied = await postDatabaseTransaction({
    actorId: noTransfer.userId, type: 'TRANSFER', sourceAccountId: noTransfer.accountIds[0],
    destinationAccountId: noTransfer.accountIds[1], amountPaise: 1n,
    idempotencyKey: 'transfer-capability-denied',
  });
  assert.equal(transferDenied.response_status, 403);
  assert.equal(transferDenied.response_body.reason, 'not_authorized');
  assert.equal(await balance(noTransfer.accountIds[0]), 500n);
  assert.equal(await balance(noTransfer.accountIds[1]), 0n);
  const unauthorizedWithdrawal = await postDatabaseTransaction({
    actorId: noTransfer.userId, type: 'WITHDRAWAL', sourceAccountId: accountA,
    amountPaise: 1n, idempotencyKey: 'another-holders-withdrawal-denied',
  });
  assert.equal(unauthorizedWithdrawal.response_status, 403);
  assert.equal(unauthorizedWithdrawal.response_body.reason, 'not_authorized');
  assert.equal(await balance(accountA), 75777n);

  const noDestinationView = await createFinancialFixture(1);
  const destinationOwner = await createFinancialFixture(1);
  await postDatabaseTransaction({
    actorId: noDestinationView.userId, type: 'DEPOSIT', destinationAccountId: noDestinationView.accountIds[0],
    amountPaise: 100n, idempotencyKey: 'transfer-destination-funding',
  });
  const destinationDenied = await postDatabaseTransaction({
    actorId: noDestinationView.userId, type: 'TRANSFER', sourceAccountId: noDestinationView.accountIds[0],
    destinationAccountId: destinationOwner.accountIds[0], amountPaise: 1n,
    idempotencyKey: 'transfer-destination-not-visible',
  });
  assert.equal(destinationDenied.response_status, 403);
  assert.equal(destinationDenied.response_body.reason, 'not_authorized');
  assert.equal(await balance(noDestinationView.accountIds[0]), 100n);
  assert.equal(await balance(destinationOwner.accountIds[0]), 0n);

  const missingAccountId = randomUUID();
  const missingAccount = await postDatabaseTransaction({
    actorId: adminId, type: 'WITHDRAWAL', sourceAccountId: missingAccountId,
    amountPaise: 1n, idempotencyKey: 'missing-admin-account',
  });
  assert.equal(missingAccount.response_status, 409);
  assert.equal(missingAccount.response_body.reason, 'account_unavailable');

  // Refusal evidence must not retain a nonexistent FK, while idempotency and
  // audit evidence must still be committed with the expected response.
  const missingWithdrawalEvidence = await admin.query(`
    SELECT a.id, a."sourceAccountId", a."destinationAccountId", a.status,
           a."refusalReason", i."responseStatus", i."responseBody"
      FROM public."TransactionAttempt" AS a
      JOIN public."IdempotencyRecord" AS i ON i.id=a."idempotencyRecordId"
     WHERE i."userId"=$1 AND i."idempotencyKey"=$2`,
  [adminId, 'missing-admin-account']);
  assert.equal(missingWithdrawalEvidence.rows.length, 1);
  assert.equal(missingWithdrawalEvidence.rows[0].sourceAccountId, null);
  assert.equal(missingWithdrawalEvidence.rows[0].destinationAccountId, null);
  assert.equal(missingWithdrawalEvidence.rows[0].status, 'REFUSED');
  assert.equal(missingWithdrawalEvidence.rows[0].refusalReason, 'account_unavailable');
  assert.equal(missingWithdrawalEvidence.rows[0].responseStatus, 409);
  assert.deepEqual(missingWithdrawalEvidence.rows[0].responseBody, {
    status: 'REFUSED', reason: 'account_unavailable',
  });

  const missingWithdrawalAudit = await admin.query(`
    SELECT count(*)::int AS count
      FROM public."AuditLog"
     WHERE action='TRANSACTION_REFUSED'
       AND "entityType"='TransactionAttempt'
       AND "entityId"=$1`,
  [missingWithdrawalEvidence.rows[0].id]);
  assert.equal(missingWithdrawalAudit.rows[0].count, 1);

  // When one side exists, preserve its valid FK while nulling only the missing side.
  const missingTransferSourceId = randomUUID();
  const missingSourceTransfer = await postDatabaseTransaction({
    actorId: adminId, type: 'TRANSFER', sourceAccountId: missingTransferSourceId,
    destinationAccountId: noTransfer.accountIds[0], amountPaise: 1n,
    idempotencyKey: 'missing-transfer-source',
  });
  assert.equal(missingSourceTransfer.response_status, 409);
  assert.equal(missingSourceTransfer.response_body.reason, 'account_unavailable');
  const missingTransferEvidence = await admin.query(`
    SELECT a."sourceAccountId", a."destinationAccountId", a.status, a."refusalReason"
      FROM public."TransactionAttempt" AS a
      JOIN public."IdempotencyRecord" AS i ON i.id=a."idempotencyRecordId"
     WHERE i."userId"=$1 AND i."idempotencyKey"=$2`,
  [adminId, 'missing-transfer-source']);
  assert.deepEqual(missingTransferEvidence.rows, [{
    sourceAccountId: null,
    destinationAccountId: noTransfer.accountIds[0],
    status: 'REFUSED',
    refusalReason: 'account_unavailable',
  }]);

  const clearingAccount = await admin.query(`SELECT id FROM public."Account" WHERE "systemCode"='CLEARING_DEPOSIT_INR'`);
  assert.equal((await apiGet(`/api/accounts/${accountA}/statement`, adminId)).status, 200);
  assert.equal((await apiGet('/api/audit?perPage=100', adminId)).status, 200);
  const auditorAuditResponse = await apiGet('/api/audit', auditorId);
  assert.equal(auditorAuditResponse.status, 200);
  const auditorAudit = await auditorAuditResponse.json();
  assert.ok(auditorAudit.events.every((event) => event.entityType === 'Account' && event.entityId === accountA));
  assert.ok(auditorAudit.events.every((event) => !Object.hasOwn(event.actor, 'email')));
  assert.equal((await apiGet(`/api/accounts/${clearingAccount.rows[0].id}/statement`, adminId)).status, 404);

  const auditResponse = await apiGet('/api/audit?perPage=100', adminId);
  const auditEvents = (await auditResponse.json()).events;
  const conflictAudit = auditEvents.find((event) => event.action === 'IDEMPOTENCY_CONFLICT'
    && event.metadata?.requestHash === '[REDACTED]');
  assert.ok(conflictAudit, 'audit metadata redacts request hashes');
  assert.equal(Object.hasOwn(conflictAudit.actor, 'passwordHash'), false);
  assert.ok(auditEvents.every((event) => !Object.hasOwn(event.actor, 'passwordHash')));

  // Hold the statement between its authorization read and ledger query. A real
  // concurrent deposit commits in that interval; REPEATABLE READ must keep the
  // statement on the original snapshot, and a later statement sees the deposit.
  let accountRead;
  const accountReadPromise = new Promise((resolve) => { accountRead = resolve; });
  let releaseStatement;
  const releasePromise = new Promise((resolve) => { releaseStatement = resolve; });
  const snapshotPrisma = {
    user: prisma.user,
    $transaction(callback, options) {
      return prisma.$transaction((tx) => callback({
        account: {
          findFirst: async (...args) => {
            const result = await tx.account.findFirst(...args);
            accountRead();
            await releasePromise;
            return result;
          },
        },
        $queryRaw: tx.$queryRaw.bind(tx),
      }), options);
    },
  };
  const snapshotApp = createApp({ prismaClient: snapshotPrisma });
  const snapshotServer = snapshotApp.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    snapshotServer.once('listening', resolve);
    snapshotServer.once('error', reject);
  });
  const snapshotUrl = `http://127.0.0.1:${snapshotServer.address().port}`;
  try {
    const pendingStatement = apiGet(`/api/accounts/${accountB}/statement`, userId, snapshotUrl);
    await accountReadPromise;
    const concurrentDeposit = await apiPost('/api/deposits', userId, { accountId: accountB, amountPaise: '444' }, 'snapshot-concurrent-deposit');
    assert.equal(concurrentDeposit.status, 201);
    releaseStatement();
    const snapshotResponse = await pendingStatement;
    assert.equal(snapshotResponse.status, 200);
    const snapshotEvents = (await snapshotResponse.json()).events;
    assert.equal(snapshotEvents.length, 1);
    assert.equal(snapshotEvents[0].runningBalancePaise, '25000');
    const freshStatement = await apiGet(`/api/accounts/${accountB}/statement`, userId);
    assert.equal((await freshStatement.json()).events.at(-1).runningBalancePaise, '25444');
  } finally {
    releaseStatement();
    snapshotServer.closeAllConnections();
    await new Promise((resolve, reject) => snapshotServer.close((error) => (error ? reject(error) : resolve())));
  }

  const journalIntegrity = await admin.query(`
    SELECT count(*) AS postings, sum("amountPaise") AS total
      FROM public."LedgerEntry" WHERE "journalTransactionId"=$1`, [transferResult.journalTransactionId]);
  assert.equal(Number(journalIntegrity.rows[0].postings), 2);
  assert.equal(BigInt(journalIntegrity.rows[0].total), 0n);

  const transferRace = await createFinancialFixture(3);
  const [transferSource, transferDestinationA, transferDestinationB] = transferRace.accountIds;
  await postDatabaseTransaction({ actorId: transferRace.userId, type: 'DEPOSIT', destinationAccountId: transferSource, amountPaise: 1000n, idempotencyKey: 'transfer-race-funding' });
  const competingTransfers = await Promise.all([
    postDatabaseTransaction({ actorId: transferRace.userId, type: 'TRANSFER', sourceAccountId: transferSource, destinationAccountId: transferDestinationA, amountPaise: 700n, idempotencyKey: 'transfer-race-a' }),
    postDatabaseTransaction({ actorId: transferRace.userId, type: 'TRANSFER', sourceAccountId: transferSource, destinationAccountId: transferDestinationB, amountPaise: 700n, idempotencyKey: 'transfer-race-b' }),
  ]);
  assert.deepEqual(competingTransfers.map(({ response_status }) => response_status).sort(), [201, 422]);
  assert.equal(await balance(transferSource), 300n);
  assert.equal((await balance(transferDestinationA)) + (await balance(transferDestinationB)), 700n);
  assert.equal(await customerBalanceTotal(transferRace.accountIds), 1000n);
  const winningTransfer = competingTransfers.find(({ response_status }) => response_status === 201);
  const concurrentJournal = await journalPostings(winningTransfer.response_body.journalTransactionId);
  assert.equal(concurrentJournal.length, 2);
  assert.equal(concurrentJournal.reduce((total, amount) => total + amount, 0n), 0n);

  const freezeRace = await createFinancialFixture(2);
  const [freezeSource] = freezeRace.accountIds;
  await postDatabaseTransaction({ actorId: freezeRace.userId, type: 'DEPOSIT', destinationAccountId: freezeSource, amountPaise: 1000n, idempotencyKey: 'freeze-race-funding' });
  const blockedRuntime = new Client({ connectionString: runtimeDatabaseUrl });
  await blockedRuntime.connect();
  await blockedRuntime.query('SET ROLE balancevault_runtime');
  let freezeTransactionOpen = false;
  try {
    await admin.query('BEGIN');
    freezeTransactionOpen = true;
    await admin.query('UPDATE public."Account" SET status=\'FROZEN\' WHERE id=$1', [freezeSource]);
    const { rows: [{ pid }] } = await blockedRuntime.query('SELECT pg_catalog.pg_backend_pid() AS pid');
    const posting = postDatabaseTransaction({ actorId: freezeRace.userId, type: 'WITHDRAWAL', sourceAccountId: freezeSource, amountPaise: 100n, idempotencyKey: 'freeze-race-withdrawal' }, blockedRuntime);
    await waitForDatabaseLock(pid);
    await admin.query('COMMIT');
    freezeTransactionOpen = false;
    const refused = await posting;
    assert.equal(refused.response_status, 409);
    assert.equal(refused.response_body.reason, 'account_unavailable');
    assert.equal(await balance(freezeSource), 1000n);
  } finally {
    if (freezeTransactionOpen) await admin.query('ROLLBACK');
    await blockedRuntime.end();
  }

});
