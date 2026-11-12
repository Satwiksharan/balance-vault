import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../scripts/migrate-deploy.js';

const expectedHost = 'ep-production-example.neon.tech';
const migrationUrl = `postgresql://balancevault_migration_owner:placeholder@${expectedHost}/neondb?sslmode=require`;
const validEnv = {
  MIGRATION_DATABASE_URL: migrationUrl,
  MIGRATION_EXPECTED_NEON_HOST: expectedHost,
};

function fakeClient(identity, { failGrant = false, failRevoke = true } = {}) {
  const operations = [];
  let privilegeChecks = 0;
  return {
    operations,
    async connect() {
      operations.push('connect');
    },
    async query(sql) {
      operations.push(sql.trim());
      if (sql.includes('current_database()')) return { rows: [identity] };
      if (sql.includes('to_regclass')) return { rows: [{ exists: false }] };
      if (sql.includes('has_schema_privilege')) {
        privilegeChecks += 1;
        return { rows: [{ allowed: privilegeChecks > 1 }] };
      }
      if (sql.startsWith('GRANT') && failGrant) throw new Error('simulated ambiguous grant failure');
      if (sql.startsWith('REVOKE') && failRevoke) throw new Error('simulated cleanup failure');
      return { rows: [], rowCount: 0 };
    },
    async end() {
      operations.push('end');
    },
  };
}

for (const [label, identity] of [
  ['incorrect database identity', {
    database: 'balancevault_dev',
    current_role: 'balancevault_migration_owner',
    login_role: 'balancevault_migration_owner',
    read_only: 'on',
  }],
  ['incorrect migration login', {
    database: 'neondb',
    current_role: 'neondb_owner',
    login_role: 'neondb_owner',
    read_only: 'on',
  }],
]) {
  test(`migration runner refuses ${label} before any migration operation`, async () => {
    const client = fakeClient(identity);
    let deployCount = 0;
    let prepareCount = 0;

    await assert.rejects(main({
      env: validEnv,
      createClient: () => client,
      deploy: async () => { deployCount += 1; return 0; },
      preparePreAdminConfig: async () => { prepareCount += 1; return { configPath: '/unused' }; },
      logger: { info() {}, error() {} },
    }));

    assert.equal(deployCount, 0);
    assert.equal(prepareCount, 0);
    assert.deepEqual(client.operations, [
      'connect',
      'BEGIN TRANSACTION READ ONLY',
      `SELECT current_database() AS database,
             current_user AS current_role,
             session_user AS login_role,
             current_setting('transaction_read_only') AS read_only`,
      'ROLLBACK',
      'end',
    ]);
  });
}

test('migration runner rejects a configured target database mismatch before connecting', async () => {
  let connectCount = 0;
  let deployCount = 0;

  await assert.rejects(main({
    env: {
      ...validEnv,
      MIGRATION_DATABASE_URL: migrationUrl.replace('/neondb?', '/balancevault_dev?'),
    },
    createClient: () => {
      connectCount += 1;
      return fakeClient({});
    },
    deploy: async () => { deployCount += 1; return 0; },
    logger: { info() {}, error() {} },
  }));

  assert.equal(connectCount, 0);
  assert.equal(deployCount, 0);
});

test('migration runner rejects a Neon hostname mismatch before connecting', async () => {
  let connectCount = 0;
  let deployCount = 0;

  await assert.rejects(main({
    env: {
      ...validEnv,
      MIGRATION_DATABASE_URL: migrationUrl.replace(expectedHost, 'ep-staging-example.neon.tech'),
    },
    createClient: () => {
      connectCount += 1;
      return fakeClient({});
    },
    deploy: async () => { deployCount += 1; return 0; },
    logger: { info() {}, error() {} },
  }));

  assert.equal(connectCount, 0);
  assert.equal(deployCount, 0);
});

test('migration runner reports failed temporary-grant cleanup and exits non-zero', async () => {
  const client = fakeClient({
    database: 'neondb',
    current_role: 'balancevault_migration_owner',
    login_role: 'balancevault_migration_owner',
    read_only: 'on',
  });
  const operations = client.operations;
  const errors = [];
  let deployCount = 0;

  const exitCode = await main({
    env: validEnv,
    createClient: () => client,
    deploy: async () => {
      operations.push('deploy');
      deployCount += 1;
      return 0;
    },
    preparePreAdminConfig: async () => ({ configPath: '/unused' }),
    logger: {
      info() {},
      error(message) { errors.push(message); },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(deployCount, 2);
  assert.ok(operations.indexOf('ROLLBACK') < operations.indexOf('deploy'));
  assert.ok(operations.some((operation) => operation.startsWith('GRANT CREATE ON SCHEMA public')));
  assert.ok(operations.some((operation) => operation.startsWith('REVOKE CREATE ON SCHEMA public')));
  assert.ok(errors.some((message) => message.includes('could not revoke CREATE on public')));
});

test('migration runner attempts to revoke a grant when the GRANT request fails ambiguously', async () => {
  const client = fakeClient({
    database: 'neondb',
    current_role: 'balancevault_migration_owner',
    login_role: 'balancevault_migration_owner',
    read_only: 'on',
  }, { failGrant: true, failRevoke: false });
  let deployCount = 0;

  await assert.rejects(main({
    env: validEnv,
    createClient: () => client,
    deploy: async () => { deployCount += 1; return 0; },
    preparePreAdminConfig: async () => ({ configPath: '/unused' }),
    logger: { info() {}, error() {} },
  }));

  assert.equal(deployCount, 1);
  assert.ok(client.operations.some((operation) => operation.startsWith('GRANT CREATE ON SCHEMA public')));
  assert.ok(client.operations.some((operation) => operation.startsWith('REVOKE CREATE ON SCHEMA public')));
});
