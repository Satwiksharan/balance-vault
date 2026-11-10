import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { createActorAssertion } from '../src/config/actor-assertion.js';

const testActorKey = process.env.BALANCEVAULT_TEST_ACTOR_ASSERTION_KEY ?? 'ef'.repeat(32);
process.env.BALANCEVAULT_ACTOR_ASSERTION_KEY = testActorKey;

const { Client } = pg;
const adminUrl = process.env.BALANCEVAULT_TEST_DATABASE_URL;
const runtimeUrl = process.env.BALANCEVAULT_TEST_RUNTIME_DATABASE_URL;
const databaseName = adminUrl ? new URL(adminUrl).pathname.slice(1) : '';
const enabled = Boolean(adminUrl && runtimeUrl);
if (enabled && (!databaseName.endsWith('_test') || databaseName === 'balancevault_dev'
  || new URL(runtimeUrl).pathname.slice(1) !== databaseName)) {
  throw new Error('Profile integration tests require matching disposable *_test database URLs.');
}

let admin;
let runtime;
async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS database_name');
  assert.equal(rows[0].database_name, databaseName);
  return client;
}

before(async () => {
  if (!enabled) return;
  admin = await connect(adminUrl);
  runtime = await connect(runtimeUrl);
  await admin.query('SET ROLE balancevault_auth_owner');
  try {
    await admin.query(
      `INSERT INTO balancevault_auth_private.actor_assertion_key (singleton, secret)
       VALUES (true, $1)
       ON CONFLICT (singleton) DO UPDATE SET secret = EXCLUDED.secret`,
      [Buffer.from(testActorKey, 'hex')],
    );
  } finally {
    await admin.query('RESET ROLE');
  }
});
after(async () => { if (runtime) await runtime.end(); if (admin) await admin.end(); });

test('profiles, password changes, user status and account onboarding preserve database boundaries', { skip: !enabled }, async () => {
  const adminId = randomUUID();
  const adminHash = await bcrypt.hash('disposable-admin-password', 10);
  await admin.query(
    `INSERT INTO public."User" (id,"fullName",email,"passwordHash",role,"isActive","updatedAt")
     VALUES ($1,'Test Administrator',$2,$3,'ADMIN',true,clock_timestamp())`,
    [adminId, `${adminId}@example.test`, adminHash],
  );

  const holderId = randomUUID();
  const hash = await bcrypt.hash('disposable-holder-password', 10);
  const created = await runtime.query(
    'SELECT * FROM public.create_account_holder_profile($1,$2,$3,$4)',
    [holderId, 'Test Holder', `${holderId}@example.test`, hash],
  );
  assert.equal(created.rows[0].fullName, 'Test Holder');
  assert.equal(created.rows[0].role, 'ACCOUNT_HOLDER');
  assert.equal(created.rows[0].isActive, true);
  assert.equal(Object.hasOwn(created.rows[0], 'passwordHash'), false);

  const updated = await runtime.query('SELECT * FROM public.update_user_profile($1,$2)', [holderId, 'Updated Holder']);
  assert.equal(updated.rows[0].fullName, 'Updated Holder');
  const nextHash = await bcrypt.hash('new-disposable-holder-password', 10);
  await assert.rejects(
    runtime.query('SELECT public.change_user_password($1,0,$2)', [holderId, nextHash]),
    (error) => error.code === '42501',
    'runtime cannot invoke the legacy UUID-trusting password function',
  );
  const assertion = createActorAssertion(holderId, 'CHANGE_PASSWORD', [holderId, 0, nextHash]);
  const changed = await runtime.query(
    'SELECT public.change_user_password_asserted($1,0,$2,$3,$4,$5,$6) AS version',
    [holderId, nextHash, assertion.issuedAt, assertion.nonce, assertion.contextHash, assertion.signature],
  );
  assert.equal(changed.rows[0].version, 1);
  await assert.rejects(runtime.query('SELECT public.change_user_password($1,0,$2)', [holderId, hash]));

  const request = await runtime.query('SELECT * FROM public.request_account_opening($1,\'PERSONAL\')', [holderId]);
  const opened = await runtime.query('SELECT * FROM public.approve_account_opening($1,$2,$3)', [adminId, request.rows[0].id, `BV-${randomUUID()}`]);
  const permission = await admin.query(
    `SELECT "canView","canDeposit","canWithdraw","canTransfer" FROM public."AccountPermission" WHERE "userId"=$1 AND "accountId"=$2`,
    [holderId, opened.rows[0].id],
  );
  assert.deepEqual(permission.rows[0], { canView: true, canDeposit: true, canWithdraw: false, canTransfer: false });

  await assert.rejects(
    runtime.query('SELECT public.admin_set_user_active($1,$2,false) AS changed', [adminId, holderId]),
    (error) => error.code === '23514',
    'the sole active account holder cannot be deactivated',
  );
  assert.equal((await admin.query('SELECT "isActive" FROM public."User" WHERE id=$1', [holderId])).rows[0].isActive, true);
  await assert.rejects(runtime.query('UPDATE public."User" SET role=\'ADMIN\' WHERE id=$1', [holderId]), (error) => error.code === '42501');
  await assert.rejects(runtime.query('INSERT INTO public."User" (id,email,"passwordHash") VALUES ($1,$2,\'x\')', [randomUUID(), `${randomUUID()}@example.test`]), (error) => error.code === '42501');
  await assert.rejects(runtime.query('UPDATE public."Account" SET "balancePaise"=1 WHERE id=$1', [opened.rows[0].id]), (error) => error.code === '42501');
});
