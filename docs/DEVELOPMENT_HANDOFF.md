# BalanceVault development handoff

## Architecture

BalanceVault is a JavaScript/npm-workspaces monorepo. `apps/web` contains the React/Vite client. `apps/api` contains the Express API, authentication and authorization middleware, route validation, Prisma 7 clients, and PostgreSQL migrations. PostgreSQL functions control all financial posting and sensitive provisioning. Redis provides shared authentication rate limits.

Money is represented as integer paise. Posted transactions contain balanced immutable ledger entries. PostgreSQL serializes account access, checks permissions and status, prevents overdrafts, records idempotency results, and updates account balances in the same transaction.

## Database identities

- `balancevault_migration_owner`: migration-only login, database/schema owner, `NOINHERIT`; migrations explicitly set function owner roles when required.
- `balancevault_runtime`: ordinary API database operations and approved function calls; no direct table writes and no access to `User.passwordHash`.
- `balancevault_auth_runtime`: read-only credential verification role with column-scoped hash access.
- `balancevault_posting_owner`, `balancevault_account_owner`, `balancevault_auth_owner`, `balancevault_provisioning_owner`: restricted `NOLOGIN` owners for specific definer functions.
- `balancevault_bootstrap_operator`: isolated capability for the first administrator bootstrap.

Use separate login identities and credentials. The API must never receive migration or bootstrap credentials. Follow the comments and grants in `apps/api/prisma/roles.sql`; set passwords through a protected database prompt or secret manager rather than SQL files.

## Migration history

The repository contains twelve ordered migrations, ending in `20261110000000_account_holder_deposits`. They create the ledger and access controls, onboarding/profile workflows, privileged-user provisioning, password-hash isolation, actor assertions, constant-time HMAC comparison, ADMIN transaction access, and account-holder deposit access. Use only forward migrations. Never edit a migration already applied to an environment.

Provision database roles and an empty database first. The migration login must own the database and `public` schema. Apply migrations through the protected migration job using `MIGRATION_DATABASE_URL`; verify with `npm run db:migrate` and `prisma migrate status`. Provision the actor assertion key using the protected CLI after migrations. Bootstrap the first administrator separately with `BALANCEVAULT_BOOTSTRAP_DATABASE_URL`.

## Environment configuration

Use `.env.example` for variable names. Important separation:

- API runtime: `DATABASE_URL`, `AUTH_DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `BALANCEVAULT_ACTOR_ASSERTION_KEY`, `WEB_ORIGIN`, and pool/time limits.
- Migration job only: `MIGRATION_DATABASE_URL`.
- One-time bootstrap only: `BALANCEVAULT_BOOTSTRAP_DATABASE_URL`.
- Browser build: `VITE_API_BASE_URL`.

Do not copy actual secret values into docs, support tickets, or Git.

## Current verification

The current source and migrations were verified on fresh, disposable PostgreSQL 17.11 databases for the API, privileged provisioning, and BIGINT boundary tests. All ten existing migrations applied successfully to each database. The backend suite ran 60 tests: 60 passed, 0 failed, 0 skipped. This includes PostgreSQL checks for journal invariants, concurrent overdrafts and transfers, a deterministic account-freeze race, BIGINT overflow rollback, idempotent retries, HMAC actor/action/argument binding, expired/malformed assertion failures, concurrent assertion replay, bootstrap isolation, reconciliation read-only enforcement, and password-hash privileges. The frontend suite ran 9 tests: 9 passed, 0 failed, 0 skipped. Prisma validation and client generation succeeded, and the production frontend build succeeded.

The npm registry was reachable for the final audit. `npm audit` reports two moderate entries for the same `minimatch` denial-of-service advisory, pulled through development-only `nodemon`; no high or critical vulnerabilities were reported. `npm audit fix` made no changes because the current `nodemon` dependency range still selects vulnerable `minimatch` 10.x, while the advisory fix is `minimatch` 11.0.1+. The configured CI gate (`npm audit --audit-level=high`) exits successfully but this moderate development-tool finding remains for a future compatible upstream release. No production deployment was performed. `balancevault_dev` was not connected to or modified. No commit or push was made.

The read-only reconciliation command is `npm run ledger:reconcile -w apps/api` with `RECONCILIATION_DATABASE_URL` set to a non-superuser login that inherits only `balancevault_runtime`. It scans a repeatable-read read-only snapshot and exits with a discrepancy status without changing balances. Scheduling and alerting remain deployment responsibilities.

No production deployment was performed. `balancevault_dev` was not connected to or modified. No commit or push was made.

## Deployment sequence

1. Provision production roles from reviewed `apps/api/prisma/roles.sql` with a database administrator.
2. Create the production database and assign its schema to the dedicated migration owner. Configure only the migration job with `MIGRATION_DATABASE_URL`.
3. Take and verify an encrypted backup. Run `npm ci`, Prisma validation/generation, tests against disposable databases, and the production build.
4. Apply migrations in a protected release job with `npm run db:migrate`; verify the migration status and role grants.
5. Provision the actor assertion verifier using `npm run admin:provision-actor-key -w apps/api` in a restricted job. The matching key must be provided to the API from secret management.
6. Bootstrap the first administrator with the isolated operator login. Do not configure bootstrap credentials on the API service.
7. Configure runtime database identities, Redis TLS/ACL, JWT and assertion secrets, exact HTTPS `WEB_ORIGIN`, `NODE_ENV=production`, and `VITE_API_BASE_URL`.
8. Deploy the API and static frontend. Check `/api/health`, `/api/ready`, authentication, and a controlled low-risk workflow. Monitor audit events, service errors, pool usage, and Redis health.

This repository does not deploy itself, create accounts with a cloud provider, or deliver invitation email.

## Backup and recovery

Before each migration, use a protected PostgreSQL backup job, for example `pg_dump --format=custom --file=balancevault-$(date +%Y%m%dT%H%M%S).dump "$DATABASE_URL"`. Store the dump encrypted with access separate from the database. Record the schema/migration version and verify the dump can be listed and restored to an isolated recovery database.

For recovery, restore the backup to a new database with `pg_restore --no-owner --dbname="$RECOVERY_DATABASE_URL" backup.dump`, provision the required roles and ownership, and run schema/data validation before any traffic cutover. For an application rollback, first assess compatibility with the already-applied schema; do not reverse or rewrite a migration to restore old application behavior. Preserve the failed environment for investigation and follow the provider's approved cutover procedure.

## Outstanding operational work

- Configure and rehearse production secret management, database backups, and restoration.
- Integrate invitation delivery and operational alerting.
- Plan a coordinated actor assertion key rotation process.
- Schedule ledger-to-balance reconciliation and define exception handling.
- Complete an independent security review before handling real customer funds.
