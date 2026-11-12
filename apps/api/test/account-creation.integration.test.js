import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/config/auth.js';
import { verifyRuntimeDatabaseIdentity } from '../src/config/runtime.js';

if ([...(process.env.JWT_ACCESS_SECRET ?? '')].length < 32) {
  process.env.JWT_ACCESS_SECRET = 'balancevault-account-db-test-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
}

const { Client } = pg;
const databaseUrl = process.env.BALANCEVAULT_TEST_DATABASE_URL;
const runtimeDatabaseUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const integration = Boolean(databaseUrl && runtimeDatabaseUrl);
const testName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
if ((databaseUrl || runtimeDatabaseUrl)
  && (!testName.endsWith('_test') || testName === 'balancevault_dev'
    || new URL(runtimeDatabaseUrl ?? databaseUrl).pathname.slice(1) !== testName)) {
  throw new Error('Account API integration URLs must target the same disposable database ending in _test.');
}

let admin;

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function sqlState(error) {
  return error?.meta?.driverAdapterError?.cause?.originalCode
    ?? error?.meta?.code
    ?? error?.cause?.code;
}

before(async () => {
  if (!integration) return;
  admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const { rows } = await admin.query('SELECT current_database() AS db');
  assert.equal(rows[0].db, testName);
});

after(async () => {
  if (admin) await admin.end();
});

test('account creation function privileges and authenticated HTTP creation are enforced', {
  skip: !integration,
  timeout: 30_000,
}, async () => {
  const { rows } = await admin.query(`
    SELECT
      (SELECT pg_get_userbyid(p.proowner)='balancevault_account_owner' AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
       FROM pg_proc p
       WHERE p.oid='public.create_customer_account(uuid,text,public."AccountType",uuid)'::regprocedure) AS function_secure,
      has_function_privilege('balancevault_runtime',
        'public.create_customer_account(uuid,text,public."AccountType",uuid)', 'EXECUTE') AS runtime_can_execute,
      NOT EXISTS (
        SELECT 1 FROM pg_proc p,
          LATERAL aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) acl
        WHERE p.oid='public.create_customer_account(uuid,text,public."AccountType",uuid)'::regprocedure
          AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS public_cannot_execute,
      has_table_privilege('balancevault_runtime','public."Account"','INSERT') AS runtime_account_insert,
      has_table_privilege('balancevault_runtime','public."Account"','UPDATE') AS runtime_account_update,
      has_table_privilege('balancevault_runtime','public."AccountPermission"','INSERT') AS runtime_permission_insert,
      has_table_privilege('balancevault_runtime','public."AccountPermission"','UPDATE') AS runtime_permission_update,
      (SELECT NOT rolcanlogin AND NOT rolinherit FROM pg_roles WHERE rolname='balancevault_account_owner') AS owner_restricted,
      pg_has_role('balancevault_migration_owner','balancevault_account_owner','MEMBER') AS migration_owner_member
  `);
  assert.equal(rows[0].function_secure, true);
  assert.equal(rows[0].runtime_can_execute, true);
  assert.equal(rows[0].public_cannot_execute, true);
  assert.equal(rows[0].runtime_account_insert, false);
  assert.equal(rows[0].runtime_account_update, false);
  assert.equal(rows[0].runtime_permission_insert, false);
  assert.equal(rows[0].runtime_permission_update, false);
  assert.equal(rows[0].owner_restricted, true);
  assert.equal(rows[0].migration_owner_member, true);

  const adminId = randomUUID();
  const holderId = randomUUID();
  await admin.query('BEGIN');
  try {
    await admin.query(
      `INSERT INTO public."User" (id,email,"passwordHash",role,"isActive","updatedAt")
       VALUES ($1,$2,'test-hash','ADMIN',true,clock_timestamp()),
              ($3,$4,'test-hash','ACCOUNT_HOLDER',true,clock_timestamp())`,
      [adminId, `${adminId}@example.test`, holderId, `${holderId}@example.test`],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }) });
  await verifyRuntimeDatabaseIdentity(prisma);
  await admin.query(`
    INSERT INTO public."Account" ("id", "accountNumber", "systemCode", "type", "status", "balancePaise", "currencyCode", "updatedAt")
    VALUES ('00000000-0000-0000-0000-000000000012', 'BV-CLEAR-DEP', 'CLEARING_DEPOSIT_INR',
            'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp()),
           ('00000000-0000-0000-0000-000000000013', 'BV-CLEAR-WD', 'CLEARING_WITHDRAWAL_INR',
            'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
    ON CONFLICT ("systemCode") DO NOTHING
  `);
  const instance = await listen(createApp({ prismaClient: prisma }));
  const accountNumber = `BV-${randomUUID()}`;
  const accessToken = jwt.sign({ role: 'ADMIN', ver: 0 }, process.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: adminId,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: '15m',
  });

  try {
    const response = await fetch(`${instance.url}/api/accounts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountNumber, accountType: 'PERSONAL', holderUserId: holderId }),
    });
    assert.equal(response.status, 201);
    const { account } = await response.json();
    assert.equal(account.accountNumber, accountNumber);
    assert.equal(account.type, 'PERSONAL');
    assert.equal(account.status, 'ACTIVE');
    assert.equal(account.currencyCode, 'INR');
    assert.equal(Object.hasOwn(account, 'balancePaise'), false);

    const records = await admin.query(`
      SELECT p."userId", p."canView", p."canDeposit", p."canWithdraw", p."canTransfer",
             a."balancePaise", a."systemCode"
        FROM public."Account" a
        JOIN public."AccountPermission" p ON p."accountId"=a.id
       WHERE a.id=$1`, [account.id]);
    assert.deepEqual(records.rows[0], {
      userId: holderId,
      canView: true,
      canDeposit: true,
      canWithdraw: true,
      canTransfer: true,
      balancePaise: '0',
      systemCode: null,
    });

    const holderToken = jwt.sign({ ver: 0 }, process.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: holderId,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '15m',
    });
    const clearingOpeningBalance = await admin.query(
      `SELECT "balancePaise"::text AS balance FROM public."Account"
        WHERE "id"='00000000-0000-0000-0000-000000000012'`,
    );
    assert.equal(clearingOpeningBalance.rowCount, 1);
    const depositResponse = await fetch(`${instance.url}/api/deposits`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${holderToken}`,
        'content-type': 'application/json',
        'Idempotency-Key': `account-creation-deposit-${randomUUID()}`,
      },
      body: JSON.stringify({ accountId: account.id, amountPaise: '12500' }),
    });
    assert.equal(depositResponse.status, 201);
    const deposit = await depositResponse.json();
    assert.equal(deposit.status, 'POSTED');

    const postings = await admin.query(
      `SELECT "accountId", "amountPaise"::text AS amount FROM public."LedgerEntry"
        WHERE "journalTransactionId"=$1 ORDER BY "accountId"`,
      [deposit.journalTransactionId],
    );
    assert.deepEqual(postings.rows, [
      { accountId: account.id, amount: '12500' },
      { accountId: '00000000-0000-0000-0000-000000000012', amount: '-12500' },
    ].sort((left, right) => left.accountId.localeCompare(right.accountId)));
    const balances = await admin.query(
      `SELECT "id", "balancePaise"::text AS balance FROM public."Account"
        WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
      [[account.id, '00000000-0000-0000-0000-000000000012']],
    );
    assert.deepEqual(balances.rows, [
      { id: account.id, balance: '12500' },
      {
        id: '00000000-0000-0000-0000-000000000012',
        balance: (BigInt(clearingOpeningBalance.rows[0].balance) - 12500n).toString(),
      },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    const depositAudit = await admin.query(
      `SELECT "actorId", action, "entityId" FROM public."AuditLog" WHERE "entityId"=$1`,
      [deposit.journalTransactionId],
    );
    assert.deepEqual(depositAudit.rows, [{
      actorId: holderId,
      action: 'TRANSACTION_POSTED',
      entityId: deposit.journalTransactionId,
    }]);

    const withdrawalResponse = await fetch(`${instance.url}/api/withdrawals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${holderToken}`,
        'content-type': 'application/json',
        'Idempotency-Key': `account-creation-withdrawal-${randomUUID()}`,
      },
      body: JSON.stringify({ accountId: account.id, amountPaise: '2500' }),
    });
    assert.equal(withdrawalResponse.status, 201);
    const withdrawal = await withdrawalResponse.json();
    const withdrawalPostings = await admin.query(
      `SELECT count(*)::int AS count, sum("amountPaise")::text AS total
         FROM public."LedgerEntry" WHERE "journalTransactionId"=$1`,
      [withdrawal.journalTransactionId],
    );
    assert.deepEqual(withdrawalPostings.rows[0], { count: 2, total: '0' });

    const secondAccountNumber = `BV-${randomUUID()}`;
    const secondAccountResponse = await fetch(`${instance.url}/api/accounts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accountNumber: secondAccountNumber,
        accountType: 'PERSONAL',
        holderUserId: holderId,
      }),
    });
    assert.equal(secondAccountResponse.status, 201);
    const { account: secondAccount } = await secondAccountResponse.json();
    const transferResponse = await fetch(`${instance.url}/api/transfers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${holderToken}`,
        'content-type': 'application/json',
        'Idempotency-Key': `account-creation-transfer-${randomUUID()}`,
      },
      body: JSON.stringify({
        sourceAccountId: account.id,
        destinationAccountId: secondAccount.id,
        amountPaise: '1000',
      }),
    });
    assert.equal(transferResponse.status, 201);
    const transfer = await transferResponse.json();
    const transferPostings = await admin.query(
      `SELECT count(*)::int AS count, sum("amountPaise")::text AS total
         FROM public."LedgerEntry" WHERE "journalTransactionId"=$1`,
      [transfer.journalTransactionId],
    );
    assert.deepEqual(transferPostings.rows[0], { count: 2, total: '0' });
    const postTransactionBalances = await admin.query(
      `SELECT id, "balancePaise"::text AS balance FROM public."Account"
        WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[account.id, secondAccount.id]],
    );
    assert.deepEqual(postTransactionBalances.rows, [
      { id: account.id, balance: '9000' },
      { id: secondAccount.id, balance: '1000' },
    ].sort((left, right) => left.id.localeCompare(right.id)));

    const audit = await admin.query(
      `SELECT "actorId",action,"entityType","entityId" FROM public."AuditLog" WHERE "entityId"=$1`,
      [account.id],
    );
    assert.deepEqual(audit.rows, [{
      actorId: adminId,
      action: 'ACCOUNT_CREATED',
      entityType: 'Account',
      entityId: account.id,
    }]);

    const duplicate = await fetch(`${instance.url}/api/accounts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountNumber, accountType: 'PERSONAL', holderUserId: holderId }),
    });
    assert.equal(duplicate.status, 409);

    await assert.rejects(
      prisma.$queryRaw`
        SELECT * FROM public.create_customer_account(
          ${adminId}::uuid, ${`BV-CLEAR-${randomUUID()}`}::text,
          ${'SYSTEM_CLEARING'}::public."AccountType", ${holderId}::uuid
        )
      `,
      (error) => sqlState(error) === '22023',
    );

    await assert.rejects(
      prisma.$queryRaw`
        SELECT * FROM public.create_customer_account(
          ${holderId}::uuid, ${`BV-DENIED-${randomUUID()}`}::text,
          ${'PERSONAL'}::public."AccountType", ${holderId}::uuid
        )
      `,
      (error) => sqlState(error) === '42501',
    );
  } finally {
    instance.server.closeAllConnections();
    await new Promise((resolve, reject) => instance.server.close((error) => (error ? reject(error) : resolve())));
    await prisma.$disconnect();
  }
});
