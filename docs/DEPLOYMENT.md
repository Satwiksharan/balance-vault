# Backend deployment configuration

## Render service

Create a Node web service with the repository root as its root directory:

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Runtime: Node 24 (also pinned by `.node-version`)
- Liveness check path: `/api/health`
- Readiness check path: `/api/ready`

The API listens on `0.0.0.0` and uses Render's `PORT` variable, falling back to `API_PORT` for local development. The frontend should be deployed separately as a static site. Set its `VITE_API_BASE_URL` to the HTTPS URL of this API.

## API environment

Required on the API service:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Enables production origin and TLS validation. |
| `DATABASE_URL` | PostgreSQL URL for a dedicated login that inherits `balancevault_runtime`; never use an owner, migration, or superuser login. Production requires `sslmode=require`, `verify-ca`, or `verify-full`. |
| `AUTH_DATABASE_URL` | Separate read-only login inheriting only `balancevault_auth_runtime`. It is used only for credential verification and can read the bcrypt hash column. |
| `BALANCEVAULT_ACTOR_ASSERTION_KEY` | At least 32 random bytes encoded as hex. Configure the same secret in the API secret manager and the protected PostgreSQL verifier row. Never log or commit it. |
| `JWT_ACCESS_SECRET` | At least 32 bytes; generate a random value, for example `openssl rand -base64 48`, and store it in Render's secret environment. |
| `WEB_ORIGIN` | Comma-separated exact HTTPS browser origins allowed by CORS. |
| `PORT` | Supplied by Render. |
| `DATABASE_POOL_MAX` | Optional per-instance pool cap; defaults to 10. Set based on database connection limits and the maximum number of service instances. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Optional connection timeout; defaults to 5000. |
| `DATABASE_READY_TIMEOUT_MS` | Optional readiness query timeout; defaults to 1500 ms. |
| `REDIS_URL` | Required Redis-compatible URL for shared auth limits (`redis://` or `rediss://`). Use a private Redis/Valkey service with TLS and ACL credentials where supported. |

`MIGRATION_DATABASE_URL` and `MIGRATION_EXPECTED_NEON_HOST` belong only in a protected deployment/migration job, never on the running API service. Set the latter to the exact Neon production hostname used by the former, without a scheme, port, or path. The runner rejects missing or mismatched hostnames, non-Neon URLs, non-TLS URLs, databases other than `neondb`, and logins other than `balancevault_migration_owner`. It confirms both PostgreSQL `current_user` and `session_user` in a read-only transaction before checking migration history, granting privileges, or invoking Prisma. Run `npm run db:migrate -w apps/api` as a separate release step using the migration login. The migration login must own the target database and `public` schema, be `NOINHERIT`, and have explicit membership with `SET` capability for the relevant `NOLOGIN` function-owner roles. Provision the database roles before migration with an administrator applying `apps/api/prisma/roles.sql`.

The migration command uses `apps/api/scripts/migrate-deploy.js`. If `20261109000000_admin_transaction_access` is pending, the runner first applies the migrations before it, then temporarily grants `CREATE` on `public` to the non-login `balancevault_posting_owner` while Prisma applies the remaining migrations. It revokes only a grant it added, including after a failed migration. This order matters because the initial migration revokes `CREATE` on `public`; PostgreSQL requires the function owner to also have schema `CREATE` when replacing its existing function. Runtime roles receive no schema `CREATE`. Existing installations that already applied `20261109000000_admin_transaction_access` do not receive this temporary grant. If that migration is recorded as failed, resolve its state explicitly after verifying the transaction rolled back; the runner will not silently reset migration history.

The API uses separate database identities: `DATABASE_URL` inherits only `balancevault_runtime`; `AUTH_DATABASE_URL` inherits only the read-only `balancevault_auth_runtime`. Runtime has column-scoped User reads and cannot select `passwordHash`. The authentication connection can read only the fields required to verify credentials. Provision its login separately; do not reuse the API runtime login.

Invitation creation/revocation and password changes require a short-lived, single-use HMAC assertion signed by the API after JWT verification. PostgreSQL verifies it against a secret in the non-public `balancevault_auth_private` schema. After migrations, provision the same secret to PostgreSQL and the API using `npm run admin:provision-actor-key -w apps/api` in a protected environment with `MIGRATION_DATABASE_URL` and `BALANCEVAULT_ACTOR_ASSERTION_KEY` configured. The script refuses to replace an existing key; rotation requires a coordinated maintenance procedure.

`BALANCEVAULT_BOOTSTRAP_DATABASE_URL` belongs only in the one-time operator bootstrap environment. Its login must be granted membership in `balancevault_bootstrap_operator` out of band. Never configure this variable on the API service or reuse the runtime login. Run `npm run admin:bootstrap -w apps/api` once after migrations. The SQL function is single-use and the runtime role cannot execute it. Later ADMIN/AUDITOR roles are provisioned through expiring, revocable invitations in the ADMIN user-management UI. Email delivery is not integrated; an administrator must deliver the one-time invitation link securely.

For a same-region Render Postgres internal URL, add `sslmode=require&uselibpqcompat=true` to require encrypted transport while permitting Render's self-signed internal certificate. For an external Render URL, use Render's provided hostname and TLS URL; do not replace it with a resolved IP. Render documents that internal TLS uses self-signed certs while external connections use Render-managed certificates. The compatibility parameter also avoids node-postgres's current warning that `sslmode=require` maps to certificate verification in its default mode.

The migration owner should not be a superuser. The runtime login should be a member only of `balancevault_runtime`, with no membership in the migration, posting, authentication, or account function-owner roles. API startup checks this membership boundary and fails closed if it is violated.

The privileged-provisioning, security-hardening, and final constant-time assertion migrations explicitly use `BEGIN`/`COMMIT`; Prisma Migrate does not implicitly wrap PostgreSQL migration SQL in a transaction. Do not remove those boundaries. They make function creation, ownership transfer, and ACL changes atomic. The security-hardening migration also changes default function privileges for the migration owner so new functions do not receive `PUBLIC EXECUTE`.

Three earlier forward migrations—`20261107220000_qualify_account_opening_user_query`, `20261107230000_qualify_approval_actor_query`, and `20261108001000_audit_account_holder_registration`—do not contain explicit transaction boundaries. Their statements are transaction-capable, but those migration files have already been applied to disposable PostgreSQL databases and must not be rewritten. Treat partial failure as a migration-recovery event: preserve the database, inspect `prisma migrate status` and the exact partial objects as the migration owner, repair through a reviewed forward migration or documented migration resolution, and rehearse the same procedure on a fresh disposable database before production. Do not mark a partially applied migration successful without verifying every intended owner, grant, revoke, and function definition.

## Static frontend security headers

The API adds JSON-appropriate CSP, frame, content-type, referrer, permissions, and request-correlation headers. In production the API emits HSTS only when the request is HTTPS (including a correctly trusted TLS-terminating proxy). Configure equivalent headers at the static frontend host; API response headers do not protect the HTML application. For the current Vite build, use a policy equivalent to `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://<api-origin>; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests`. Replace `<api-origin>` with the exact deployed API origin, validate the built application in a browser, and keep HSTS enabled only on HTTPS hosts.

## Operational limitations

- `/api/health` is liveness only. `/api/ready` runs `SELECT 1` with a bounded timeout and returns only a generic status; it does not reveal database errors.
- Login and registration rate limits use a shared Redis store across API instances. Startup fails if Redis cannot connect. Requests fail closed with a generic 503 if the store becomes unavailable. Configure Redis with sufficient availability because login and registration will be unavailable during a Redis outage.
- For local development, install and start Redis, then use `REDIS_URL=redis://127.0.0.1:6379/0`. Auth endpoints intentionally do not fall back to per-process memory when Redis is unavailable.
- Pool limits apply per process. Multiply `DATABASE_POOL_MAX` by the maximum instance count and reserve connections for migrations and operations.
- The API logs only generic server-error events and error class names. Do not enable driver/SQL debug logging or log connection URLs in production.
- API responses carry a generated `X-Request-Id`; server error logs include that ID and the error class, but not request bodies or database details. Include the ID in support workflows without logging bearer tokens or passwords.
- This repository has no Render blueprint or automated role-provisioning pipeline. Configure secrets and the separate migration job in Render before deployment.
- The browser currently stores short-lived bearer tokens in `sessionStorage`; same-origin script injection could steal them. Production should not proceed until an end-to-end server-managed `HttpOnly; Secure; SameSite` session design with CSRF protection and tested session revocation is implemented, or the deployment owner explicitly accepts that documented risk after independent review.
- Recovery point objective (RPO), recovery time objective (RTO), and backup retention are not set in this repository. The service owner must define and approve them against business requirements before launch; no recovery target is claimed here.
- The read-only reconciliation command requires `RECONCILIATION_DATABASE_URL`, a non-superuser login inheriting only `balancevault_runtime`: `npm run ledger:reconcile -w apps/api`. It reports account ID, stored balance, ledger total, and difference; exit status 2 means discrepancies were found and requires investigation. It never updates data. Schedule and alert on it through the operations platform; scheduling is not implemented here.

## Release checklist

- [ ] Pin the supported Node 24 runtime and install from the committed lockfile with `npm ci`.
- [ ] Validate Prisma, generate the client, run API and frontend suites on disposable infrastructure, run the dependency audit, and build the production frontend.
- [ ] Provision the database roles using a reviewed copy of `apps/api/prisma/roles.sql`; confirm the migration login owns the database and `public` schema.
- [ ] Take an encrypted PostgreSQL custom-format backup and verify it can be listed and restored into an isolated recovery database.
- [ ] Run `npm run db:migrate` in the protected release job with `MIGRATION_DATABASE_URL`; then verify `prisma migrate status` and critical function ownership/ACLs.
- [ ] Provision the actor assertion key using the protected CLI after migration; configure the matching API key through the secret manager.
- [ ] Bootstrap the first administrator with the separate operator identity. Remove the bootstrap credential from the operator environment afterward.
- [ ] Configure runtime-only API secrets, Redis TLS/ACL, exact HTTPS `WEB_ORIGIN`, PostgreSQL TLS, pool limits, and the frontend API URL.
- [ ] Deploy API and frontend over HTTPS. Verify `/api/health`, `/api/ready`, login, account-scoped reads, a controlled ledger operation, and audit events.
- [ ] Confirm logs contain no tokens, hashes, connection strings, or database error details. Confirm alerts cover API, PostgreSQL, Redis, backups, and failed financial operations.
- [ ] Approve measurable RPO, RTO, backup retention, and a recurring read-only ledger reconciliation schedule with discrepancy alerting.
- [ ] Implement and verify the production browser session architecture; configure and test CSP/HSTS headers on the static frontend host.

Do not treat a successful application build as a completed deployment. The first live rollout still requires operator review of the target environment and a separate authorization to modify that environment.

## Backup and restoration

Use the provider's consistent PostgreSQL backup mechanism when available. A manual custom-format backup can be made with `pg_dump --format=custom --file=balancevault-$(date +%Y%m%dT%H%M%S).dump "$DATABASE_URL"`. Store it encrypted and separately from the production database. Record the migration version alongside the backup and verify the dump with `pg_restore --list backup.dump`.

Restore to a new, isolated recovery database, not over the running production database: `pg_restore --no-owner --dbname="$RECOVERY_DATABASE_URL" backup.dump`. Provision roles and ownership, run application-level consistency checks, and verify migration state before traffic cutover. A schema migration is not automatically reversible; choose a restore point and cutover procedure through the incident plan. Preserve the affected database and logs for investigation.

After restore, run the read-only ledger reconciliation command and investigate every reported mismatch before traffic is routed. It does not modify balances or journal rows. Define backup retention and verify a restore on a recurring schedule selected to meet the approved RPO/RTO; this repository does not perform or attest to those operational exercises.
