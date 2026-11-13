import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(apiDirectory, '../..');
const prismaCli = path.join(repositoryRoot, 'node_modules', 'prisma', 'build', 'index.js');
const migrationName = '20261109000000_admin_transaction_access';
const expectedDatabase = 'neondb';
const expectedMigrationRole = 'balancevault_migration_owner';
const expectedPostingOwner = 'balancevault_posting_owner';

class MigrationPreflightError extends Error {}

function validateMigrationTarget(env) {
  const connectionString = env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new MigrationPreflightError('MIGRATION_DATABASE_URL is required.');

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new MigrationPreflightError('MIGRATION_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new MigrationPreflightError('MIGRATION_DATABASE_URL must use PostgreSQL.');
  }

  const isLocalDisposable = (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    && decodeURIComponent(url.pathname.slice(1)).endsWith('_test')
    && decodeURIComponent(url.pathname.slice(1)) !== 'balancevault_dev';

  if (!isLocalDisposable) {
    const expectedHostValue = env.MIGRATION_EXPECTED_NEON_HOST?.trim();
    if (!expectedHostValue) {
      throw new MigrationPreflightError('MIGRATION_EXPECTED_NEON_HOST must be set to the expected Neon production hostname.');
    }
    let expectedHostUrl;
    try {
      expectedHostUrl = new URL(`https://${expectedHostValue}`);
    } catch {
      throw new MigrationPreflightError('MIGRATION_EXPECTED_NEON_HOST must be an exact *.neon.tech hostname without a port.');
    }
    const expectedHost = expectedHostValue.toLowerCase();
    if (expectedHostUrl.hostname !== expectedHost || expectedHostUrl.host !== expectedHost
      || !expectedHost.endsWith('.neon.tech')) {
      throw new MigrationPreflightError('MIGRATION_EXPECTED_NEON_HOST must be an exact *.neon.tech hostname without a port.');
    }
    if (url.hostname.toLowerCase() !== expectedHost || !url.hostname.toLowerCase().endsWith('.neon.tech')) {
      throw new MigrationPreflightError('MIGRATION_DATABASE_URL does not target MIGRATION_EXPECTED_NEON_HOST.');
    }
    if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase) {
      throw new MigrationPreflightError('MIGRATION_DATABASE_URL must target database neondb.');
    }
    if (!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')?.toLowerCase())) {
      throw new MigrationPreflightError('MIGRATION_DATABASE_URL must require TLS using sslmode=require, verify-ca, or verify-full.');
    }
  }

  if (decodeURIComponent(url.username) !== expectedMigrationRole) {
    throw new MigrationPreflightError('MIGRATION_DATABASE_URL must authenticate as balancevault_migration_owner.');
  }
  return { url, isLocalDisposable };
}

async function verifyMigrationIdentity(client, isLocalDisposable = false) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const { rows: [identity] } = await client.query(`
      SELECT current_database() AS database,
             current_user AS current_role,
             session_user AS login_role,
             current_setting('transaction_read_only') AS read_only
    `);
    if (identity?.read_only !== 'on') {
      throw new MigrationPreflightError('Migration identity preflight did not establish a read-only transaction.');
    }
    if (!isLocalDisposable && identity.database !== expectedDatabase) {
      throw new MigrationPreflightError('MIGRATION_DATABASE_URL connected to a database other than neondb.');
    }
    if (identity.current_role !== expectedMigrationRole || identity.login_role !== expectedMigrationRole) {
      throw new MigrationPreflightError('MIGRATION_DATABASE_URL must connect and remain as balancevault_migration_owner.');
    }
  } finally {
    await client.query('ROLLBACK');
  }
}

function runPrismaDeploy(configPath = path.join(apiDirectory, 'prisma.migrate.config.js'), env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      prismaCli,
      'migrate',
      'deploy',
      '--config',
      configPath,
    ], { cwd: apiDirectory, env, stdio: 'inherit' });
    const forwardInterrupt = (signal) => child.kill(signal);
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardInterrupt);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', forwardInterrupt);
      process.off('SIGTERM', forwardInterrupt);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function createPreAdminMigrationConfig() {
  const source = path.join(apiDirectory, 'prisma', 'migrations');
  const temporaryDirectory = await mkdtemp(path.join(apiDirectory, '.migrate-before-admin-'));
  const temporaryMigrations = path.join(temporaryDirectory, 'migrations');
  await mkdir(temporaryMigrations, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isDirectory() && entry.name < migrationName)
    .map((entry) => entry.name)
    .sort();
  if (!migrationNames.length || !entries.some((entry) => entry.isDirectory() && entry.name === migrationName)) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw new Error(`Could not construct migration prefix ending before ${migrationName}`);
  }

  for (const name of migrationNames) {
    await cp(path.join(source, name), path.join(temporaryMigrations, name), { recursive: true });
  }
  await cp(path.join(source, 'migration_lock.toml'), path.join(temporaryMigrations, 'migration_lock.toml'));

  const configPath = path.join(temporaryDirectory, 'prisma.migrate.config.js');
  const schemaPath = path.join(apiDirectory, 'prisma', 'schema.prisma');
  await writeFile(configPath, `
    import { defineConfig, env } from 'prisma/config';
    export default defineConfig({
      schema: ${JSON.stringify(schemaPath)},
      migrations: { path: ${JSON.stringify(temporaryMigrations)} },
      datasource: { url: env('MIGRATION_DATABASE_URL') },
    });
  `);
  return { configPath, temporaryDirectory };
}

async function needsPostingOwnerCreate(client, onGrantAttempt) {
  const history = await client.query("SELECT pg_catalog.to_regclass('public.\"_prisma_migrations\"') IS NOT NULL AS exists");
  if (history.rows[0].exists) {
    const failed = await client.query(
      `SELECT 1 FROM public."_prisma_migrations"
        WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL
        LIMIT 1`,
      [migrationName],
    );
    if (failed.rowCount) {
      throw new Error(`Migration ${migrationName} has a failed state; resolve it explicitly before retrying`);
    }
    const applied = await client.query(
      `SELECT 1 FROM public."_prisma_migrations"
        WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        LIMIT 1`,
      [migrationName],
    );
    if (applied.rowCount) return false;
  }

  const privilege = await client.query(
    'SELECT pg_catalog.has_schema_privilege($1, $2, $3) AS allowed',
    [expectedPostingOwner, 'public', 'CREATE'],
  );
  if (privilege.rows[0]?.allowed) return false;
  onGrantAttempt();
  await client.query(`GRANT CREATE ON SCHEMA public TO ${expectedPostingOwner}`);
  return true;
}

async function verifyPostingOwnerCreate(client, logger) {
  const privilege = await client.query(
    'SELECT pg_catalog.has_schema_privilege($1, $2, $3) AS allowed',
    [expectedPostingOwner, 'public', 'CREATE'],
  );
  if (!privilege.rows[0]?.allowed) throw new Error('Could not prepare the posting-owner schema privilege');
  logger.info('Temporary posting-owner CREATE privilege prepared for the pending function replacement.');
}

export async function main({
  env = process.env,
  createClient = (options) => new pg.Client({ keepAlive: true, keepAliveInitialDelayMillis: 1000, ...options }),
  deploy = runPrismaDeploy,
  preparePreAdminConfig = createPreAdminMigrationConfig,
  logger = console,
} = {}) {
  const { isLocalDisposable } = validateMigrationTarget(env);
  const client = createClient({ connectionString: env.MIGRATION_DATABASE_URL });
  if (typeof client?.on === 'function') {
    client.on('error', (err) => {
      logger.warn?.(`Migration database client connection event: ${err?.message ?? err}`);
    });
  }
  let clientConnected = false;
  let addedPrivilege = false;
  let deployExitCode = 1;
  let cleanupFailed = false;
  let temporaryMigrationDirectory;
  try {
    await client.connect();
    clientConnected = true;

    // This read-only identity check must remain ahead of every deploy and grant.
    await verifyMigrationIdentity(client, isLocalDisposable);

    const history = await client.query("SELECT pg_catalog.to_regclass('public.\"_prisma_migrations\"') IS NOT NULL AS exists");
    let targetApplied = false;
    if (history.rows[0].exists) {
      const failed = await client.query(
        `SELECT 1 FROM public."_prisma_migrations"
          WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL
          LIMIT 1`,
        [migrationName],
      );
      if (failed.rowCount) throw new Error(`Migration ${migrationName} has a failed state; resolve it explicitly before retrying`);
      const applied = await client.query(
        `SELECT 1 FROM public."_prisma_migrations"
          WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL
          LIMIT 1`,
        [migrationName],
      );
      targetApplied = Boolean(applied.rowCount);
    }

    if (!targetApplied) {
      const temporary = await preparePreAdminConfig();
      temporaryMigrationDirectory = temporary.temporaryDirectory;
      const prefixExitCode = await deploy(temporary.configPath, env);
      if (prefixExitCode !== 0) {
        deployExitCode = prefixExitCode;
      } else {
        await needsPostingOwnerCreate(client, () => { addedPrivilege = true; });
        if (addedPrivilege) await verifyPostingOwnerCreate(client, logger);
        deployExitCode = await deploy(path.join(apiDirectory, 'prisma.migrate.config.js'), env);
      }
    } else {
      deployExitCode = await deploy(path.join(apiDirectory, 'prisma.migrate.config.js'), env);
    }
  } finally {
    if (addedPrivilege) {
      try {
        await client.query('REVOKE CREATE ON SCHEMA public FROM balancevault_posting_owner');
        logger.info('Temporary posting-owner CREATE privilege removed.');
      } catch {
        logger.error('Migration cleanup failed: could not revoke CREATE on public from balancevault_posting_owner. Verify and revoke this temporary grant before continuing.');
        cleanupFailed = true;
      }
    }
    if (clientConnected) {
      try {
        await client.end();
      } catch {
        logger.error('Migration cleanup failed: could not close the migration database connection.');
        cleanupFailed = true;
      }
    }
    if (temporaryMigrationDirectory) {
      try {
        await rm(temporaryMigrationDirectory, { recursive: true, force: true });
      } catch {
        logger.error('Migration cleanup failed: could not remove the temporary migration directory.');
        cleanupFailed = true;
      }
    }
  }
  return cleanupFailed ? 1 : deployExitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      if (error instanceof MigrationPreflightError) {
        console.error(`Migration preflight failed: ${error.message}`);
      } else {
        const code = typeof error?.code === 'string' ? ` (database code ${error.code})` : '';
        console.error(`Migration runner failed${code}; verify the migration target, owner role, and migration state.`);
      }
      process.exitCode = 1;
    });
}
