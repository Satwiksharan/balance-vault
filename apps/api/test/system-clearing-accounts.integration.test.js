import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.BALANCEVAULT_TEST_CLEARING_DATABASE_URL ?? process.env.BALANCEVAULT_TEST_DATABASE_URL;
const runtimeDatabaseUrl = process.env.BALANCEVAULT_TEST_CLEARING_RUNTIME_DATABASE_URL ?? process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const integration = Boolean(databaseUrl);
const testName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';

if (integration && (!testName.endsWith('_test') || testName === 'balancevault_dev')) {
  throw new Error('Test database URL must target a disposable database ending in _test.');
}
if (integration && !runtimeDatabaseUrl) {
  throw new Error('A runtime database URL is required to verify the actual runtime role.');
}

const migrationSql = readFileSync(
  new URL('../prisma/migrations/20261112000000_provision_system_clearing_accounts/migration.sql', import.meta.url),
  'utf8',
);

const CLEARING_DEPOSIT_ID = '00000000-0000-0000-0000-000000000012';
const CLEARING_WITHDRAWAL_ID = '00000000-0000-0000-0000-000000000013';

let admin;
let runtime;
let hasHistoricalEntries = false;

function canonicalRequestHash(payload) {
  const canonical = JSON.stringify([
    payload.type,
    payload.sourceAccountId ?? null,
    payload.destinationAccountId ?? null,
    payload.amountPaise.toString(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function runMigrationSql(accountsJson = null) {
  if (!accountsJson) {
    return admin.query(migrationSql);
  }
  const customSql = migrationSql.replace(
    /v_clearing_accounts CONSTANT jsonb := \$json\$[\s\S]*?\$json\$::jsonb;/,
    `v_clearing_accounts CONSTANT jsonb := $custom_json$${JSON.stringify(accountsJson)}$custom_json$::jsonb;`,
  );
  return admin.query(customSql);
}

before(async () => {
  if (!integration) return;
  admin = new Client({ connectionString: databaseUrl });
  runtime = new Client({ connectionString: runtimeDatabaseUrl });
  await Promise.all([admin.connect(), runtime.connect()]);
  await runtime.query('SET ROLE balancevault_runtime');

  const { rows } = await admin.query(
    'SELECT count(*)::int AS count FROM public."LedgerEntry" WHERE "accountId" IN ($1, $2)',
    [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID],
  );
  hasHistoricalEntries = rows[0].count > 0;
});

after(async () => {
  if (runtime) await runtime.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
});

test('system clearing accounts provisioning migration', { skip: !integration, timeout: 60_000 }, async (t) => {
  await t.test('provisions fresh clearing accounts and preserves double-entry invariants', async () => {
    await admin.query('BEGIN');
    try {
      if (!hasHistoricalEntries) {
        // Safe to remove pre-existing clearing accounts in disposable clean DB within transaction
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
        await runMigrationSql();

        const depResult = await admin.query('SELECT * FROM public."Account" WHERE id = $1', [CLEARING_DEPOSIT_ID]);
        assert.equal(depResult.rowCount, 1);
        const dep = depResult.rows[0];
        assert.equal(dep.accountNumber, 'BV-CLEAR-DEP');
        assert.equal(dep.systemCode, 'CLEARING_DEPOSIT_INR');
        assert.equal(dep.type, 'SYSTEM_CLEARING');
        assert.equal(dep.status, 'ACTIVE');
        assert.equal(dep.currencyCode, 'INR');
        assert.equal(BigInt(dep.balancePaise), 0n);

        const wdResult = await admin.query('SELECT * FROM public."Account" WHERE id = $1', [CLEARING_WITHDRAWAL_ID]);
        assert.equal(wdResult.rowCount, 1);
        const wd = wdResult.rows[0];
        assert.equal(wd.accountNumber, 'BV-CLEAR-WD');
        assert.equal(wd.systemCode, 'CLEARING_WITHDRAWAL_INR');
        assert.equal(wd.type, 'SYSTEM_CLEARING');
        assert.equal(wd.status, 'ACTIVE');
        assert.equal(wd.currencyCode, 'INR');
        assert.equal(BigInt(wd.balancePaise), 0n);

        const permResult = await admin.query(
          'SELECT count(*) FROM public."AccountPermission" WHERE "accountId" IN ($1, $2)',
          [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID],
        );
        assert.equal(Number(permResult.rows[0].count), 0);
      } else {
        // In database with historical ledger entries, test fresh provisioning via isolated synthetic account
        const synthId = randomUUID();
        await runMigrationSql([
          { id: synthId, accountNumber: 'BV-CLEAR-SYNTH-FRESH', systemCode: 'CLEARING_SYNTH_FRESH_INR' },
        ]);

        const synthResult = await admin.query('SELECT * FROM public."Account" WHERE id = $1', [synthId]);
        assert.equal(synthResult.rowCount, 1);
        const synth = synthResult.rows[0];
        assert.equal(synth.accountNumber, 'BV-CLEAR-SYNTH-FRESH');
        assert.equal(synth.systemCode, 'CLEARING_SYNTH_FRESH_INR');
        assert.equal(synth.type, 'SYSTEM_CLEARING');
        assert.equal(synth.status, 'ACTIVE');
        assert.equal(synth.currencyCode, 'INR');
        assert.equal(BigInt(synth.balancePaise), 0n);

        const permResult = await admin.query(
          'SELECT count(*) FROM public."AccountPermission" WHERE "accountId" = $1',
          [synthId],
        );
        assert.equal(Number(permResult.rows[0].count), 0);
      }
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('is idempotent on repeated execution without modifying existing valid rows', async () => {
    await admin.query('BEGIN');
    try {
      // First execution
      await runMigrationSql();
      const firstRun = await admin.query(
        'SELECT id, "accountNumber", "createdAt", "updatedAt" FROM public."Account" WHERE id IN ($1, $2) ORDER BY id',
        [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID],
      );
      assert.equal(firstRun.rowCount, 2);

      // Repeated execution
      await runMigrationSql();
      const secondRun = await admin.query(
        'SELECT id, "accountNumber", "createdAt", "updatedAt" FROM public."Account" WHERE id IN ($1, $2) ORDER BY id',
        [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID],
      );
      assert.equal(secondRun.rowCount, 2);

      // Verify rows remain completely identical and unchanged
      assert.equal(secondRun.rows[0].createdAt.toISOString(), firstRun.rows[0].createdAt.toISOString());
      assert.equal(secondRun.rows[0].updatedAt.toISOString(), firstRun.rows[0].updatedAt.toISOString());
      assert.equal(secondRun.rows[1].createdAt.toISOString(), firstRun.rows[1].createdAt.toISOString());
      assert.equal(secondRun.rows[1].updatedAt.toISOString(), firstRun.rows[1].updatedAt.toISOString());
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('preserves correct pre-existing test fixture clearing accounts', async () => {
    await admin.query('BEGIN');
    try {
      if (!hasHistoricalEntries) {
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
        await admin.query(`
          INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
          VALUES
            ($1, 'BV-CLEAR-DEP', 'CLEARING_DEPOSIT_INR', 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp()),
            ($2, 'BV-CLEAR-WD', 'CLEARING_WITHDRAWAL_INR', 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
        `, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);

        await runMigrationSql();

        const accounts = await admin.query(
          'SELECT count(*) FROM public."Account" WHERE id IN ($1, $2)',
          [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID],
        );
        assert.equal(Number(accounts.rows[0].count), 2);
      } else {
        const synthId = randomUUID();
        await admin.query(`
          INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
          VALUES ($1, 'BV-CLEAR-SYNTH-PRE', 'CLEARING_SYNTH_PRE_INR', 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
        `, [synthId]);

        await runMigrationSql([
          { id: synthId, accountNumber: 'BV-CLEAR-SYNTH-PRE', systemCode: 'CLEARING_SYNTH_PRE_INR' },
        ]);

        const accounts = await admin.query('SELECT count(*) FROM public."Account" WHERE id = $1', [synthId]);
        assert.equal(Number(accounts.rows[0].count), 1);
      }
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('rejects conflicting UUID identifier mismatch', async () => {
    await admin.query('BEGIN');
    try {
      const conflictId = hasHistoricalEntries ? randomUUID() : CLEARING_DEPOSIT_ID;
      const targetNumber = hasHistoricalEntries ? 'BV-CLEAR-SYNTH-UUID' : 'BV-CLEAR-DEP';
      const targetCode = hasHistoricalEntries ? 'CLEARING_SYNTH_UUID_INR' : 'CLEARING_DEPOSIT_INR';

      if (!hasHistoricalEntries) {
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
      }
      await admin.query(`
        INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
        VALUES ($1, $2, 'CLEARING_OTHER_INR', 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
      `, [conflictId, `BV-CONFLICT-${conflictId.slice(0, 8)}`]);

      await assert.rejects(
        runMigrationSql([
          { id: conflictId, accountNumber: targetNumber, systemCode: targetCode },
        ]),
        /identifier mismatch|Conflicting existing account records/i,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('rejects conflicting accountNumber identifier mismatch', async () => {
    await admin.query('BEGIN');
    try {
      const expectedId = hasHistoricalEntries ? randomUUID() : CLEARING_DEPOSIT_ID;
      const differentId = randomUUID();
      const targetNumber = hasHistoricalEntries ? 'BV-CLEAR-SYNTH-ACC' : 'BV-CLEAR-DEP';
      const targetCode = hasHistoricalEntries ? 'CLEARING_SYNTH_ACC_INR' : 'CLEARING_DEPOSIT_INR';

      if (!hasHistoricalEntries) {
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
      }
      await admin.query(`
        INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
        VALUES ($1, $2, 'CLEARING_OTHER_INR', 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
      `, [differentId, targetNumber]);

      await assert.rejects(
        runMigrationSql([
          { id: expectedId, accountNumber: targetNumber, systemCode: targetCode },
        ]),
        /identifier mismatch|Conflicting existing account records/i,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('rejects conflicting systemCode identifier mismatch', async () => {
    await admin.query('BEGIN');
    try {
      const expectedId = hasHistoricalEntries ? randomUUID() : CLEARING_DEPOSIT_ID;
      const differentId = randomUUID();
      const targetNumber = hasHistoricalEntries ? 'BV-CLEAR-SYNTH-CODE' : 'BV-CLEAR-DEP';
      const targetCode = hasHistoricalEntries ? 'CLEARING_SYNTH_CODE_INR' : 'CLEARING_DEPOSIT_INR';

      if (!hasHistoricalEntries) {
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
      }
      await admin.query(`
        INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
        VALUES ($1, $2, $3, 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
      `, [differentId, `BV-DIFFERENT-${differentId.slice(0, 8)}`, targetCode]);

      await assert.rejects(
        runMigrationSql([
          { id: expectedId, accountNumber: targetNumber, systemCode: targetCode },
        ]),
        /identifier mismatch|Conflicting existing account records/i,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('rejects cross-record identifier collision', async () => {
    await admin.query('BEGIN');
    try {
      const expectedId = hasHistoricalEntries ? randomUUID() : CLEARING_DEPOSIT_ID;
      const otherId = randomUUID();
      const targetNumber = hasHistoricalEntries ? 'BV-CLEAR-SYNTH-XREC' : 'BV-CLEAR-DEP';
      const targetCode = hasHistoricalEntries ? 'CLEARING_SYNTH_XREC_INR' : 'CLEARING_DEPOSIT_INR';

      if (!hasHistoricalEntries) {
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
      }
      // Row 1 has the expected UUID
      await admin.query(`
        INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
        VALUES ($1, $2, 'CLEARING_COLLIDE_1', 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
      `, [expectedId, `BV-COLLIDE-1-${expectedId.slice(0, 8)}`]);
      // Row 2 has the expected systemCode
      await admin.query(`
        INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
        VALUES ($1, $2, $3, 'SYSTEM_CLEARING', 'ACTIVE', 0, 'INR', clock_timestamp())
      `, [otherId, `BV-COLLIDE-2-${otherId.slice(0, 8)}`, targetCode]);

      await assert.rejects(
        runMigrationSql([
          { id: expectedId, accountNumber: targetNumber, systemCode: targetCode },
        ]),
        /Conflicting existing account records collide on identifiers/i,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('rejects unexpected account status (e.g. CLOSED)', async () => {
    await admin.query('BEGIN');
    try {
      const expectedId = hasHistoricalEntries ? randomUUID() : CLEARING_DEPOSIT_ID;
      const targetNumber = hasHistoricalEntries ? 'BV-CLEAR-SYNTH-STAT' : 'BV-CLEAR-DEP';
      const targetCode = hasHistoricalEntries ? 'CLEARING_SYNTH_STAT_INR' : 'CLEARING_DEPOSIT_INR';

      if (!hasHistoricalEntries) {
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
      }
      await admin.query(`
        INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
        VALUES ($1, $2, $3, 'SYSTEM_CLEARING', 'CLOSED', 0, 'INR', clock_timestamp())
      `, [expectedId, targetNumber, targetCode]);

      await assert.rejects(
        runMigrationSql([
          { id: expectedId, accountNumber: targetNumber, systemCode: targetCode },
        ]),
        /unexpected status/i,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('rejects unexpected balancePaise cache discrepancy', async () => {
    await admin.query('BEGIN');
    try {
      const expectedId = hasHistoricalEntries ? randomUUID() : CLEARING_DEPOSIT_ID;
      const targetNumber = hasHistoricalEntries ? 'BV-CLEAR-SYNTH-BAL' : 'BV-CLEAR-DEP';
      const targetCode = hasHistoricalEntries ? 'CLEARING_SYNTH_BAL_INR' : 'CLEARING_DEPOSIT_INR';

      if (!hasHistoricalEntries) {
        await admin.query(`DELETE FROM public."Account" WHERE id IN ($1, $2)`, [CLEARING_DEPOSIT_ID, CLEARING_WITHDRAWAL_ID]);
      }
      // Insert row with balancePaise = 500 when no ledger entries exist
      await admin.query(`
        INSERT INTO public."Account" ("id","accountNumber","systemCode","type","status","balancePaise","currencyCode","updatedAt")
        VALUES ($1, $2, $3, 'SYSTEM_CLEARING', 'ACTIVE', 500, 'INR', clock_timestamp())
      `, [expectedId, targetNumber, targetCode]);

      await assert.rejects(
        runMigrationSql([
          { id: expectedId, accountNumber: targetNumber, systemCode: targetCode },
        ]),
        /balance cache 500 differs from ledger total 0/i,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('allows deposit posting to succeed once provisioned without clearing_account_unavailable', async () => {
    // Ensure clearing accounts are provisioned via migration SQL
    await runMigrationSql();

    // Create a customer user and account committed so runtime can see it
    const userId = randomUUID();
    const customerAccountId = randomUUID();
    await admin.query('BEGIN');
    try {
      await admin.query(`
        INSERT INTO public."User" (id, email, "passwordHash", role, "isActive", "updatedAt")
        VALUES ($1, $2, 'test-hash', 'ACCOUNT_HOLDER', true, clock_timestamp())
      `, [userId, `${userId}@example.test`]);

      await admin.query(`
        INSERT INTO public."Account" (id, "accountNumber", type, status, "balancePaise", "currencyCode", "updatedAt")
        VALUES ($1, $2, 'PERSONAL', 'ACTIVE', 0, 'INR', clock_timestamp())
      `, [customerAccountId, `BV-DEP-${userId.slice(0, 8)}`]);

      await admin.query(`
        INSERT INTO public."AccountPermission" (id, "userId", "accountId", "canView", "canDeposit", "canWithdraw", "canTransfer", "updatedAt")
        VALUES ($1, $2, $3, true, true, true, true, clock_timestamp())
      `, [randomUUID(), userId, customerAccountId]);

      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }

    try {
      const initialClearingRes = await admin.query('SELECT "balancePaise" FROM public."Account" WHERE id = $1', [CLEARING_DEPOSIT_ID]);
      const initialClearingBalance = BigInt(initialClearingRes.rows[0].balancePaise);

      // Call deposit posting function as balancevault_runtime inside a runtime transaction
      await runtime.query('BEGIN');
      try {
        const depositAmount = 50000n; // 500.00 INR
        const idempotencyKey = `dep-test-${randomUUID()}`;
        const requestHash = canonicalRequestHash({
          type: 'DEPOSIT',
          sourceAccountId: null,
          destinationAccountId: customerAccountId,
          amountPaise: depositAmount,
        });

        const { rows } = await runtime.query(`
          SELECT * FROM public.balancevault_post_transaction(
            $1::uuid,
            'DEPOSIT'::public."JournalTransactionType",
            NULL::uuid,
            $2::uuid,
            $3::bigint,
            $4::text,
            $5::char(64)
          )
        `, [userId, customerAccountId, depositAmount.toString(), idempotencyKey, requestHash]);

        assert.equal(rows[0].response_status, 201);
        assert.equal(rows[0].response_body.status, 'POSTED');
        assert.notEqual(rows[0].response_body.reason, 'clearing_account_unavailable');

        // Check customer balance increased in transaction
        const customerAcc = await runtime.query('SELECT "balancePaise" FROM public."Account" WHERE id = $1', [customerAccountId]);
        assert.equal(BigInt(customerAcc.rows[0].balancePaise), depositAmount);

        // Check clearing account balance debited (negative in double-entry)
        const clearAcc = await runtime.query('SELECT "balancePaise" FROM public."Account" WHERE id = $1', [CLEARING_DEPOSIT_ID]);
        assert.equal(BigInt(clearAcc.rows[0].balancePaise), initialClearingBalance - depositAmount);
      } finally {
        await runtime.query('ROLLBACK');
      }
    } finally {
      // Clean up customer fixture in an atomic transaction
      await admin.query('BEGIN');
      try {
        await admin.query(`DELETE FROM public."AccountPermission" WHERE "accountId" = $1`, [customerAccountId]);
        await admin.query(`DELETE FROM public."Account" WHERE id = $1`, [customerAccountId]);
        await admin.query(`DELETE FROM public."User" WHERE id = $1`, [userId]);
        await admin.query('COMMIT');
      } catch (err) {
        await admin.query('ROLLBACK');
        throw err;
      }
    }
  });
});
