# BalanceVault API

All protected endpoints require `Authorization: Bearer <access-token>`. The API verifies the token and reloads the active user's current role from PostgreSQL. The user ID and role in request bodies, query parameters, and path parameters never establish identity. Amounts are INR paise represented as decimal integer strings where returned.

## Authentication

- `POST /api/auth/register` accepts `{ "name": "Asha Rao", "email": "asha@example.com", "password": "at least 12 characters" }`. It always creates an `ACCOUNT_HOLDER` and returns `201` with `{ accessToken, tokenType, expiresIn, user }`.
- `POST /api/auth/login` accepts `{ "email": "asha@example.com", "password": "…" }` and returns the same token response. Unknown email, wrong password, and inactive user share a generic `401` response.
- `POST /api/auth/accept-invitation` accepts `{ "token": "one-time-token", "password": "at least 12 characters" }`. See the invitation section below.
- `POST /api/auth/change-password` requires authentication and accepts `{ "currentPassword": "…", "newPassword": "at least 12 characters" }`. Current sessions are invalidated; sign in again after a successful change.

Login, registration, invitation acceptance, and password changes use shared Redis rate limits. They fail closed if Redis is unavailable.

## Accounts

- `GET /api/accounts` lists customer accounts available to the caller. ADMIN sees all customer accounts; ACCOUNT_HOLDER and AUDITOR see only accounts with `canView=true`. Clearing accounts are excluded.
- `GET /api/accounts/{accountId}` returns a visible customer account summary.
- `GET /api/accounts/{accountId}/balance` returns `{ accountId, balancePaise, currencyCode }`; `balancePaise` is an integer string.
- `POST /api/accounts` is ADMIN-only and accepts `{ "accountNumber": "BV-10021", "accountType": "PERSONAL", "holderUserId": "uuid" }`. Account and initial view permission are created through a protected PostgreSQL function.

Unknown and unauthorized account IDs return `404` to avoid disclosing account existence. Invalid IDs and request bodies return `400`; a duplicate account number returns `409`.

## Financial transactions

All posting requests require an authenticated caller and an `Idempotency-Key` header. Amounts are positive integer paise; decimal currency amounts are not accepted.

- `POST /api/deposits` accepts `{ "accountId": "uuid", "amountPaise": "12500" }`.
- `POST /api/withdrawals` accepts `{ "accountId": "uuid", "amountPaise": "5000" }`.
- `POST /api/transfers` accepts `{ "sourceAccountId": "uuid", "destinationAccountId": "uuid", "amountPaise": "2500" }`.
- `GET /api/transfers/{transferId}` returns a posted transfer only when the caller can view both customer accounts (ADMIN may read any customer-to-customer transfer).

Active ADMIN users may post deposits, withdrawals, and transfers against any eligible customer accounts. ACCOUNT_HOLDER users must have the operation-specific account capability (`canDeposit`, `canWithdraw`, or `canTransfer`) for the relevant account. AUDITOR users cannot post transactions. The database also checks account status, funds, and transfer eligibility. A repeated idempotency key with the same payload replays its original result; reusing it with different arguments returns `409`. Insufficient funds and other financial refusals are persisted as refused attempts and do not create ledger entries. Backend database errors are returned as generic `500` errors.

## Account statement

`GET /api/accounts/{accountId}/statement?limit=25&cursor={opaqueCursor}`

Returns a page for one customer account. An administrator can read customer accounts. An account holder or auditor must have `AccountPermission.canView=true` for that account. Internal clearing accounts are never returned. An inaccessible or unknown account returns `404`.

`limit` is optional and defaults to 25; allowed values are integers from 1 through 100. `cursor` is the opaque `nextCursor` returned by the previous page. Ledger rows use `accountPostingSequence` as their authoritative running-balance order. The statement query runs in a PostgreSQL `REPEATABLE READ` transaction so its account authorization and event page use one database snapshot.

Example:

```json
{
  "account": {
    "id": "d7299992-533e-4438-b76a-f488d88ab997",
    "accountNumber": "BV-10021",
    "type": "PERSONAL",
    "currencyCode": "INR"
  },
  "events": [
    {
      "id": "08ec5f76-4bd4-4cec-a8b3-23a38ce55808",
      "type": "DEPOSIT",
      "amountPaise": "125000",
      "status": "POSTED",
      "timestamp": "2026-11-07T10:30:00.000Z",
      "reference": null,
      "actor": { "id": "581f1383-b2c6-4254-9a06-16c2ded715fc", "role": "ADMIN" },
      "runningBalancePaise": "125000"
    },
    {
      "id": "a2dd2ced-6dfa-4dce-b470-f1bf90f14921",
      "type": "WITHDRAWAL",
      "amountPaise": "200000",
      "status": "REFUSED",
      "timestamp": "2026-11-07T10:35:00.000Z",
      "reference": "a2dd2ced-6dfa-4dce-b470-f1bf90f14921",
      "actor": { "id": "581f1383-b2c6-4254-9a06-16c2ded715fc", "role": "ADMIN" },
      "runningBalancePaise": "125000",
      "refusalReason": "insufficient_funds"
    }
  ],
  "nextCursor": null
}
```

Posted entries have signed `amountPaise`: credits are positive and debits negative. Refused attempts show their requested positive amount, a refusal reason, and an unchanged running balance. Their reference is the attempt ID because refused attempts have no journal reference.

Each page uses one repeatable-read snapshot. The current `TransactionAttempt` schema has no per-account posting sequence; refused-attempt placement is inferred from its `createdAt` relative to ledger rows. Since PostgreSQL's default timestamp is the transaction start time, a request delayed on a lock can have an attempt timestamp earlier than the moment it was actually refused. The immutable ledger-entry running balances remain ordered by `accountPostingSequence`.

Invalid account IDs, limits, or cursors return `400`; missing authentication returns `401`; inaccessible accounts return `404`. Database failures return a generic `500` response.

## Audit events

`GET /api/audit?page=1&perPage=25`

Permitted roles: `ADMIN` and `AUDITOR`. Returns audit records ordered by timestamp and ID, newest first. `page` starts at 1. `perPage` defaults to 25 and must be 1 through 100.

Admins can view all audit records; their actor details contain ID, email, and current role. Auditors see only records whose entity is an `Account` for an account where they have `canView` permission. Auditor actor details contain only ID and current role. Metadata is recursively redacted for keys associated with passwords, secrets, tokens, hashes, database connections, or SQL for both roles. For auditors, keys associated with email addresses, users, holders, or actors are also redacted. Other roles receive `403`.

Example:

```json
{
  "events": [
    {
      "id": "e05ba07c-7652-4222-a7bc-8261e19e6001",
      "action": "TRANSACTION_REFUSED",
      "entityType": "TransactionAttempt",
      "entityId": "a2dd2ced-6dfa-4dce-b470-f1bf90f14921",
      "metadata": { "reason": "insufficient_funds", "type": "WITHDRAWAL" },
      "createdAt": "2026-11-07T10:35:00.000Z",
      "actor": {
        "id": "581f1383-b2c6-4254-9a06-16c2ded715fc",
        "email": "admin@example.test",
        "role": "ADMIN"
      }
    }
  ],
  "page": 1,
  "perPage": 25,
  "hasMore": false
}
```

Invalid pagination returns `400`, missing authentication returns `401`, and callers other than admins or auditors receive `403`.
# Profile and onboarding APIs

All routes below require a bearer access token.

- `GET /api/users/me` returns `{ user: { id, fullName, email, role, isActive, createdAt } }`.
- `PATCH /api/users/me` accepts `{ "fullName": "Updated Name" }`. Email, role, and active status are not editable here.
- `POST /api/auth/change-password` accepts `{ "currentPassword": "…", "newPassword": "at least 12 characters" }`. It checks the current password, persists the bcrypt hash through a restricted function, invalidates older access tokens, and returns a message requiring a new login.
- `POST /api/account-requests` accepts `{ "requestedType": "PERSONAL" }` or `BUSINESS`. A duplicate pending request returns `409`.
- `GET /api/account-requests` returns the caller's requests. `GET /api/account-requests/admin/queue` is ADMIN-only.
- `POST /api/account-requests/admin/:id/approve` (ADMIN-only) accepts `{ "accountNumber": "…" }`; it uses the existing account creation function inside the request transaction, so the account and initial view permission commit together.
- `POST /api/account-requests/admin/:id/reject` (ADMIN-only) accepts an optional `{ "note": "…" }`.
- `GET /api/admin/users?page=1&perPage=25` and `PATCH /api/admin/users/:id/status` are ADMIN-only. The latter accepts only `{ "isActive": true|false }`; role changes remain controlled provisioning.

Common errors are JSON: `400` invalid input, `401` unauthenticated/current password invalid, `403` role denied, `404` unavailable request, and `409` duplicate pending request or account number. Database details are not returned.

## Privileged-user invitations

- `POST /api/admin/invitations` is ADMIN-only and accepts `{ "fullName": "Auditor Name", "email": "auditor@example.com", "role": "AUDITOR" }` (or `ADMIN`). The response contains a 256-bit random, single-use `token`; it is returned only at creation and must be shared securely. Copy the resulting `/accept-invitation#TOKEN` link immediately. PostgreSQL stores only the SHA-256 hash, and the response uses `Cache-Control: no-store`.
- `GET /api/admin/invitations` lists safe invitation metadata. It never returns token hashes or plaintext tokens.
- `POST /api/admin/invitations/:id/revoke` revokes an unaccepted invitation. Expired, revoked, and accepted tokens cannot be used.
- `POST /api/auth/accept-invitation` is public but Redis-rate-limited. It accepts `{ "token": "…", "password": "at least 12 characters" }`. The token is single-use; the API bcrypt-hashes the password before calling PostgreSQL. Success returns the normal safe authentication response.
- Role provisioning is audited at bootstrap, invitation creation, revocation, acceptance, and role assignment. Only ADMIN and AUDITOR invitations are allowed; public registration remains ACCOUNT_HOLDER-only.

## First administrator bootstrap

The first ADMIN is created only by an operator CLI, never by public registration or the runtime API. Configure `BALANCEVAULT_BOOTSTRAP_DATABASE_URL` for a dedicated login granted membership in `balancevault_bootstrap_operator`; do not use the API runtime login. Run `npm run admin:bootstrap -w apps/api`, confirm the displayed database name, then enter the name, email, and password interactively. Password input is hidden, bcrypt-hashed in the CLI, and only the hash reaches PostgreSQL. The database function is atomic, serialized, single-use, inaccessible to PUBLIC, and not executable by `balancevault_runtime`. The CLI does not fall back to `DATABASE_URL` or `MIGRATION_DATABASE_URL`.
