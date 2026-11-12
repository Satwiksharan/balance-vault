# Free hackathon demo deployment

This guide deploys the React/Vite frontend to Vercel, the Express API to Render, PostgreSQL to Neon, and Redis to Upstash. Use synthetic demo data only. This setup is for a hackathon demo, not real funds or production availability. Render's free web service sleeps after 15 idle minutes and may take about a minute to wake; Neon/Upstash free plans have their own usage and availability limits.

## 1. Create a fresh Neon demo database

Create a new Neon project/branch and database for the demo (PostgreSQL 17). Keep this separate from every local or existing database. In Neon, use the direct, non-pooled endpoint for role provisioning and migrations; use TLS connection strings (`sslmode=require`). Do not use the Neon project owner as an API login.

Run the repository role script as the Neon project owner from a terminal. Use a connection string without its password so `psql` prompts for it:

```sh
psql "host=<NEON_DIRECT_HOST> dbname=<DEMO_DATABASE> user=<NEON_PROJECT_OWNER> sslmode=require" \
  -v ON_ERROR_STOP=1 -f apps/api/prisma/roles.sql
```

Neon does not expose a PostgreSQL role with the actual `SUPERUSER` attribute. The role declarations in `roles.sql` set restrictive `NOSUPERUSER`/`NOCREATEDB`/`NOCREATEROLE`/`NOREPLICATION`/`NOBYPASSRLS` attributes when creating the roles. The later `ALTER ROLE` statements repeat the non-superuser restrictions and normalize `LOGIN`/`INHERIT`; they omit only `NOSUPERUSER`, which Neon rejects because it is an attempt to change the `SUPERUSER` attribute. Run this as the Neon project owner, whose delegated role-management privileges are needed for the remaining role-attribute changes. If you previously ran this file and it stopped at the first `ALTER ROLE`, rerun the whole file after updating; the role creation block uses `IF NOT EXISTS`, and the grants are repeatable. Then verify all eight roles' attributes before proceeding, especially if any role existed before this script was run:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls, rolinherit
FROM pg_catalog.pg_roles
WHERE rolname IN (
  'balancevault_migration_owner', 'balancevault_posting_owner',
  'balancevault_runtime', 'balancevault_auth_owner',
  'balancevault_account_owner', 'balancevault_provisioning_owner',
  'balancevault_bootstrap_operator', 'balancevault_auth_runtime'
)
ORDER BY rolname;
```

Reconnect interactively as the Neon project owner. `psql` prompts for its password; the session is needed for the `\password` prompts below:

```sh
psql "host=<NEON_DIRECT_HOST> dbname=<DEMO_DATABASE> user=<NEON_PROJECT_OWNER> sslmode=require"
```

Set passwords without putting them in SQL or shell history, then create the two runtime login roles and the one-time bootstrap login. Keep these login roles separate:

```sql
\password balancevault_migration_owner
CREATE ROLE balancevault_api_login NOLOGIN;
```

Then enter these `psql` meta-commands and SQL statements (repeat `\password`/`ALTER ROLE`/`GRANT` for the auth and bootstrap logins):

```text
\password balancevault_api_login
```

```sql
ALTER ROLE balancevault_api_login LOGIN;
GRANT balancevault_runtime TO balancevault_api_login;

CREATE ROLE balancevault_auth_login NOLOGIN;
```

```text
\password balancevault_auth_login
```

```sql
ALTER ROLE balancevault_auth_login LOGIN;
GRANT balancevault_auth_runtime TO balancevault_auth_login;

CREATE ROLE balancevault_bootstrap_login NOLOGIN;
```

```text
\password balancevault_bootstrap_login
```

```sql
ALTER ROLE balancevault_bootstrap_login LOGIN;
GRANT balancevault_bootstrap_operator TO balancevault_bootstrap_login;
ALTER DATABASE <DEMO_DATABASE> OWNER TO balancevault_migration_owner;
ALTER SCHEMA public OWNER TO balancevault_migration_owner;
```

The API logins must be SQL-created roles with only their respective `balancevault_runtime` or `balancevault_auth_runtime` membership. Do not create them through Neon Console/API role creation, which grants Neon administrative membership. The Neon error reported so far occurred before `roles.sql` reached its membership grants; therefore role grants, database/schema ownership transfer, and migration-time function ownership have not yet been verified on Neon. Test those steps on this fresh demo database before proceeding. The migrations rely on `balancevault_migration_owner` owning the database and `public` schema, having `SET ROLE` membership in the restricted function-owner roles, and assigning SECURITY DEFINER functions to those owners. If Neon rejects any operation or the API's startup privilege checks reject the runtime identities, stop: do not substitute the Neon owner or an administrator login for an app login. No existing migration file has been changed for Neon compatibility.

Run migrations from a trusted terminal using the dedicated migration-owner direct connection, not from the Render app or a pooled endpoint. If `20261109000000_admin_transaction_access` is pending, `npm run db:migrate` first applies earlier migrations, then temporarily grants schema `CREATE` to the non-login `balancevault_posting_owner` while the remaining migrations run. It removes only the grant it added. Do not add a manual grant. At the shell prompt, enter the full URI into the hidden input:

```sh
read -rs MIGRATION_DATABASE_URL
export MIGRATION_DATABASE_URL
npm run db:migrate
```

After migrations, create the assertion key once, store the same value in Render, and provision its verifier in Neon:

```sh
export BALANCEVAULT_ACTOR_ASSERTION_KEY="$(openssl rand -hex 32)"
npm run admin:provision-actor-key -w apps/api
```

Do not print or commit the key. Keep it available only long enough to enter it in Render's environment settings, then unset it and `MIGRATION_DATABASE_URL`.

## 2. Create Upstash Redis

Create an Upstash Redis database in a region close to the Render service. In its **Connect → TCP** section, copy the TLS connection string beginning with `rediss://` and retain it as `REDIS_URL`. The API uses the standard Redis TCP protocol through `node-redis`; do not use the Upstash REST URL/token variables. Store the connection string only in Render's secret environment settings.

## 3. Create the Render API service

Create a Render Blueprint from this repository and select `render.yaml`, or create a Node web service with the same settings:

- Root directory: repository root (`.`)
- Node.js version: `24.x`
- Runtime: Node 24 from `.node-version`
- Plan: Free
- Build command: `npm ci && DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm run db:generate`
- Start command: `npm start`
- Health check: `/api/ready`
- Auto-deploy: disabled in the blueprint; deploy manually after configuration

The `DATABASE_URL` in the build command is a local placeholder used only to let Prisma generate its client. It is not a database credential and is not present in the running service environment. Render supplies `PORT`; the server binds to `0.0.0.0`.

Set these Render variables:

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `WEB_ORIGIN` | Exact Vercel production origin, e.g. `https://<project>.vercel.app` (no trailing slash) |
| `DATABASE_URL` | Neon pooled TLS URL for `balancevault_api_login`; include `sslmode=require` |
| `AUTH_DATABASE_URL` | Separate Neon pooled TLS URL for `balancevault_auth_login`; include `sslmode=require` |
| `REDIS_URL` | Upstash TCP URL beginning `rediss://` |
| `JWT_ACCESS_SECRET` | At least 32 random bytes; Render blueprint generates a value |
| `BALANCEVAULT_ACTOR_ASSERTION_KEY` | Same 32-byte-or-longer hex key provisioned in Neon |
| `DATABASE_POOL_MAX` | `3` for this small demo instance |

Do not add `MIGRATION_DATABASE_URL`, `BALANCEVAULT_BOOTSTRAP_DATABASE_URL`, or `RECONCILIATION_DATABASE_URL` to the running API. `PORT` is supplied by Render; connection/readiness timeout variables can use their defaults.

## 4. Bootstrap the first administrator

Run the one-time bootstrap CLI locally from a trusted terminal. Use a direct Neon URL for the separate bootstrap login and enter the URL using hidden input. The CLI asks you to confirm the database name and reads the admin password without echoing it:

```sh
read -rs BALANCEVAULT_BOOTSTRAP_DATABASE_URL
export BALANCEVAULT_BOOTSTRAP_DATABASE_URL
npm run admin:bootstrap -w apps/api
unset BALANCEVAULT_BOOTSTRAP_DATABASE_URL
```

Never set the bootstrap URL on Render. This command creates only the first ADMIN; auditors/admins after that use the existing invitation workflow.

## 4a. Exceptional direct provisioning for a jury demo

Use the invitation workflow for additional administrators whenever possible. For a controlled jury demo only, an authorized database owner can create a separate active administrator directly. This bypasses invitation controls and must not be used for production provisioning. Connect to the intended demo database using the direct Neon endpoint and the authorized owner login; do not grant permanent `INSERT` privileges to an application login. Confirm the active administrator ID below belongs to the demo database before running the transaction.

Generate a bcrypt hash locally using a temporary password that meets the application's password requirements. Do not put the password or hash in this repository, shell history, a SQL file, or a shared jury document. For example, from `apps/api` use a local Node script with the installed `bcrypt` package and enter the password through a hidden prompt; provide only the resulting hash to the SQL session. A cost factor of 12 is supported. Deliver the temporary password to the jury through a private channel and rotate it after the demo.

Replace `<ADMIN_NAME>`, `<ADMIN_EMAIL>`, and `<BCRYPT_HASH>` before execution. Keep the actor ID set to the active demo administrator. The transaction checks that actor and records the new administrator in `AuditLog`:

```sql
BEGIN;

DO $$
DECLARE
  v_user_id uuid := gen_random_uuid();
  v_actor_id uuid := 'eacd8dcc-c903-4491-bbcf-b41c13272feb';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."User"
    WHERE id = v_actor_id AND role = 'ADMIN' AND "isActive" = true
  ) THEN
    RAISE EXCEPTION 'Active admin not found';
  END IF;

  INSERT INTO public."User" (
    id, "fullName", email, "passwordHash", role, "isActive", "updatedAt"
  ) VALUES (
    v_user_id, '<ADMIN_NAME>', '<ADMIN_EMAIL>', '<BCRYPT_HASH>',
    'ADMIN', true, NOW()
  );

  INSERT INTO public."AuditLog" (
    id, "actorId", action, "entityType", "entityId", metadata, "createdAt"
  ) VALUES (
    gen_random_uuid(), v_actor_id, 'ADMIN_CREATED_DIRECTLY', 'User', v_user_id,
    '{"role":"ADMIN","method":"direct_sql"}'::jsonb, NOW()
  );

  RAISE NOTICE 'New admin created: %', v_user_id;
END $$;

COMMIT;
```

If any statement fails, the transaction must be rolled back. Afterward, verify the new account can sign in and that the audit event is visible. Do not publish a working password in this guide. The existing jury test administrator is `BV-ADMIN` (`bv@gmail.com`, user ID `eacd8dcc-c903-4491-bbcf-b41c13272feb`); share its temporary password only through the private jury channel and change it after the demo.

## 5. Create the Vercel frontend

Import the repository into Vercel. Keep the project root directory at the repository root so Vercel can use the root npm workspaces and lockfile. The checked-in `vercel.json` sets the Vite framework, install/build commands, `apps/web/dist` output, SPA deep-link rewrites, and frontend security headers.

Set this Vercel **Production** build variable before deploying:

| Name | Value |
| --- | --- |
| `VITE_API_BASE_URL` | `https://balancevault-hackathon-api.onrender.com` |

`VITE_API_BASE_URL` is embedded in the static JavaScript bundle; changing it requires a new Vercel build. The checked-in CSP allows this same API origin. If the Render service receives a different hostname, update both this value and the `connect-src` origin in `vercel.json` before rebuilding. Preview deployments are not CORS-enabled by default; use the stable production Vercel origin for the demo.

Copy the Vercel production origin into Render's `WEB_ORIGIN`, save, and deploy/restart the Render service. Then verify:

1. `https://<render-service>.onrender.com/api/health` returns healthy.
2. `https://<render-service>.onrender.com/api/ready` returns ready.
3. The Vercel home page and direct links such as `/login` load with a hard refresh.
4. Browser developer tools show successful API requests, TLS connections, and no CORS/CSP errors.
5. Login, account views, and audit views work using synthetic demo accounts only.

### Troubleshooting invitations and deposits

If creating an ADMIN/AUDITOR invitation returns **“Administrator authorization is required”**, check that the `20261108002000_security_hardening` and `20261108003000_constant_time_actor_assertion` migrations are applied, and that the API's `BALANCEVAULT_ACTOR_ASSERTION_KEY` matches the verifier provisioned in this same Neon database. Provision the verifier through the protected command in section 1; the key itself must never be printed or committed. A missing verifier is a separate setup error, and changing an already provisioned key requires the documented coordinated rotation procedure.

Active ADMIN users can post deposits, withdrawals, and transfers on eligible customer accounts. `ACCOUNT_HOLDER` users need the matching account permission (`canDeposit`, `canWithdraw`, or `canTransfer`) for the selected account. After applying the account-holder transaction-access migration, new accounts grant all three transaction capabilities and view access to their initial holder. The migration backfills only audited initial-holder permission rows and records audit events. Holder transfers require `canTransfer` on the source and `canView` on the destination. An ADMIN may use the transaction actions in the operations workspace; all postings still go through the audited PostgreSQL ledger function. Do not work around a refusal by changing ledger balances directly.

Do not use real funds, real credentials, or sensitive personal data in this free demo. Render documents free web services as non-production and subject to sleep/restarts; Neon/Upstash free-tier quotas and persistence/availability should be checked in their current dashboards before the demo.

## Provider references

- [Vercel Vite deployment](https://vercel.com/docs/frameworks/frontend/vite)
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Render web services](https://render.com/docs/web-services)
- [Render free services and limits](https://render.com/docs/free)
- [Neon application connections](https://neon.com/docs/connect/connect-from-any-app)
- [Neon role management](https://neon.com/docs/manage/roles)
- [Upstash Redis with Render](https://upstash.com/docs/redis/quickstarts/render)
