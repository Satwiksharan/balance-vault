BEGIN;

-- Deposits are granted only to the initial account holder. Withdrawals and
-- transfers remain denied until separately authorized.
GRANT CREATE ON SCHEMA public TO balancevault_account_owner;
SET ROLE balancevault_account_owner;
CREATE OR REPLACE FUNCTION public.create_customer_account(
  p_actor_id uuid,
  p_account_number text,
  p_account_type public."AccountType",
  p_holder_user_id uuid
)
RETURNS TABLE (
  id uuid,
  "accountNumber" text,
  type public."AccountType",
  status public."AccountStatus",
  "currencyCode" character(3),
  "createdAt" timestamptz(6)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_customer_account$
DECLARE
  v_actor_role public."UserRole";
  v_actor_active boolean;
  v_holder_role public."UserRole";
  v_holder_active boolean;
  v_account_id uuid := pg_catalog.gen_random_uuid();
  v_now timestamptz(6) := pg_catalog.clock_timestamp();
BEGIN
  IF p_actor_id IS NULL
     OR p_holder_user_id IS NULL
     OR p_account_type IS NULL
     OR p_account_type NOT IN ('PERSONAL'::public."AccountType", 'BUSINESS'::public."AccountType")
     OR p_account_number IS NULL
     OR p_account_number IS DISTINCT FROM pg_catalog.btrim(p_account_number)
     OR pg_catalog.length(p_account_number) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION 'Invalid customer account creation input'
      USING ERRCODE = '22023';
  END IF;

  SELECT u."role", u."isActive"
    INTO v_actor_role, v_actor_active
    FROM public."User" AS u
   WHERE u."id" = p_actor_id;
  IF NOT FOUND OR v_actor_active IS DISTINCT FROM true OR v_actor_role <> 'ADMIN'::public."UserRole" THEN
    RAISE EXCEPTION 'Active ADMIN actor required'
      USING ERRCODE = '42501';
  END IF;

  SELECT u."role", u."isActive"
    INTO v_holder_role, v_holder_active
    FROM public."User" AS u
   WHERE u."id" = p_holder_user_id;
  IF NOT FOUND OR v_holder_active IS DISTINCT FROM true OR v_holder_role <> 'ACCOUNT_HOLDER'::public."UserRole" THEN
    RAISE EXCEPTION 'Active ACCOUNT_HOLDER required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."Account"
    ("id", "accountNumber", "systemCode", "type", "status", "balancePaise", "currencyCode", "createdAt", "updatedAt")
  VALUES
    (v_account_id, p_account_number, NULL, p_account_type, 'ACTIVE'::public."AccountStatus", 0, 'INR', v_now, v_now);

  INSERT INTO public."AccountPermission"
    ("id", "userId", "accountId", "canView", "canDeposit", "canWithdraw", "canTransfer", "createdAt", "updatedAt")
  VALUES
    (pg_catalog.gen_random_uuid(), p_holder_user_id, v_account_id, true, true, false, false, v_now, v_now);

  INSERT INTO public."AuditLog"
    ("id", "actorId", "action", "entityType", "entityId", "metadata", "createdAt")
  VALUES
    (pg_catalog.gen_random_uuid(), p_actor_id, 'ACCOUNT_CREATED', 'Account', v_account_id,
     pg_catalog.jsonb_build_object(
       'accountNumber', p_account_number,
       'accountType', p_account_type,
       'initialHolderId', p_holder_user_id
     ), v_now);

  RETURN QUERY
    SELECT a."id", a."accountNumber", a."type", a."status", a."currencyCode", a."createdAt"
      FROM public."Account" AS a
     WHERE a."id" = v_account_id;
END;
$create_customer_account$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM balancevault_account_owner;
REVOKE CREATE ON SCHEMA public FROM balancevault_posting_owner;

-- Existing accounts created by the application have an ACCOUNT_CREATED event.
-- Require it before granting missing deposit capability so the backfill can be
-- attributed to the administrator who created the account.
DO $verify_deposit_backfill_audit$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."AccountPermission" AS p
      JOIN public."Account" AS a ON a."id" = p."accountId"
      JOIN public."User" AS u ON u."id" = p."userId"
     WHERE p."canView" IS TRUE
       AND p."canDeposit" IS FALSE
       AND a."systemCode" IS NULL
       AND a."type" IN ('PERSONAL'::public."AccountType", 'BUSINESS'::public."AccountType")
       AND a."currencyCode" = 'INR'
       AND u."role" = 'ACCOUNT_HOLDER'::public."UserRole"
       AND NOT EXISTS (
         SELECT 1 FROM public."AuditLog" AS log
          WHERE log."action" = 'ACCOUNT_CREATED'
            AND log."entityType" = 'Account'
            AND log."entityId" = a."id"
       )
  ) THEN
    RAISE EXCEPTION 'Cannot backfill account-holder deposits without account-creation audit records';
  END IF;
END;
$verify_deposit_backfill_audit$;

WITH eligible AS MATERIALIZED (
  SELECT p."id", p."userId", p."accountId", created."actorId"
    FROM public."AccountPermission" AS p
    JOIN public."Account" AS a ON a."id" = p."accountId"
    JOIN public."User" AS u ON u."id" = p."userId"
    JOIN LATERAL (
      SELECT log."actorId"
        FROM public."AuditLog" AS log
       WHERE log."action" = 'ACCOUNT_CREATED'
         AND log."entityType" = 'Account'
         AND log."entityId" = a."id"
       ORDER BY log."createdAt" DESC, log."id" DESC
       LIMIT 1
    ) AS created ON true
   WHERE p."canView" IS TRUE
     AND p."canDeposit" IS FALSE
     AND a."systemCode" IS NULL
     AND a."type" IN ('PERSONAL'::public."AccountType", 'BUSINESS'::public."AccountType")
     AND a."currencyCode" = 'INR'
     AND u."role" = 'ACCOUNT_HOLDER'::public."UserRole"
), updated AS (
  UPDATE public."AccountPermission" AS p
     SET "canDeposit" = true, "updatedAt" = pg_catalog.clock_timestamp()
    FROM eligible AS e
   WHERE p."id" = e."id"
     AND p."canDeposit" IS FALSE
  RETURNING p."id", p."userId", p."accountId"
)
INSERT INTO public."AuditLog"
  ("id", "actorId", "action", "entityType", "entityId", "metadata", "createdAt")
SELECT pg_catalog.gen_random_uuid(), e."actorId", 'ACCOUNT_DEPOSIT_ACCESS_ENABLED',
       'Account', u."accountId",
       pg_catalog.jsonb_build_object('userId', u."userId", 'permissionId', u."id", 'reason', 'account_holder_deposit_policy'),
       pg_catalog.clock_timestamp()
  FROM updated AS u
  JOIN eligible AS e ON e."id" = u."id";

COMMIT;
