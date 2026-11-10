import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(apiDirectory, '../..');
const prismaCli = path.join(repositoryRoot, 'node_modules', 'prisma', 'build', 'index.js');
const migrationName = '20261109000000_admin_transaction_access';

function runPrismaDeploy(configPath = path.join(apiDirectory, 'prisma.migrate.config.js')) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      prismaCli,
      'migrate',
      'deploy',
      '--config',
      configPath,
    ], { cwd: apiDirectory, env: process.env, stdio: 'inherit' });
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

async function needsPostingOwnerCreate(client) {
  const current = await client.query('SELECT current_user AS role');
  if (current.rows[0]?.role !== 'balancevault_migration_owner') {
    throw new Error('MIGRATION_DATABASE_URL must connect as balancevault_migration_owner');
  }

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
    `SELECT pg_catalog.has_schema_privilege('balancevault_posting_owner', 'public', 'CREATE') AS allowed`,
  );
  if (privilege.rows[0]?.allowed) return false;
  await client.query('GRANT CREATE ON SCHEMA public TO balancevault_posting_owner');
  const granted = await client.query(
    `SELECT pg_catalog.has_schema_privilege('balancevault_posting_owner', 'public', 'CREATE') AS allowed`,
  );
  if (!granted.rows[0]?.allowed) throw new Error('Could not prepare the posting-owner schema privilege');
  console.info('Temporary posting-owner CREATE privilege prepared for the pending function replacement.');
  return true;
}

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');

  const client = new pg.Client({ connectionString });
  let addedPrivilege = false;
  let deployExitCode = 1;
  let temporaryMigrationDirectory;
  try {
    await client.connect();
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
      const temporary = await createPreAdminMigrationConfig();
      temporaryMigrationDirectory = temporary.temporaryDirectory;
      const prefixExitCode = await runPrismaDeploy(temporary.configPath);
      if (prefixExitCode !== 0) {
        deployExitCode = prefixExitCode;
      } else {
        addedPrivilege = await needsPostingOwnerCreate(client);
        deployExitCode = await runPrismaDeploy();
      }
    } else {
      deployExitCode = await runPrismaDeploy();
    }
  } finally {
    if (addedPrivilege) {
      try {
        await client.query('REVOKE CREATE ON SCHEMA public FROM balancevault_posting_owner');
        console.info('Temporary posting-owner CREATE privilege removed.');
      } catch {
        console.error('Migration cleanup failed: remove the temporary CREATE privilege from balancevault_posting_owner before continuing.');
        deployExitCode = 1;
      }
    }
    await client.end().catch(() => {});
    if (temporaryMigrationDirectory) {
      await rm(temporaryMigrationDirectory, { recursive: true, force: true });
    }
  }
  process.exitCode = deployExitCode;
}

main().catch((error) => {
  const code = typeof error?.code === 'string' ? ` (database code ${error.code})` : '';
  console.error(`Migration preflight failed${code}; verify the migration login, schema ownership, and migration state.`);
  process.exitCode = 1;
});
