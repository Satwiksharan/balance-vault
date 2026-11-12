-- Provision stable system clearing accounts for INR deposit and withdrawal processing.
-- Enforces idempotent insertion and strict validation:
-- 1. Never relies solely on ON CONFLICT DO NOTHING.
-- 2. Validates existing rows by UUID, accountNumber, systemCode, type, status, currencyCode, and balancePaise.
-- 3. If an existing row matches all expected identifiers and attributes, it is preserved unchanged.
-- 4. If any identifier collides or attributes mismatch, stops the migration with an exception.
-- 5. Inserts only missing, validated system clearing accounts.
-- 6. Ensures no AccountPermission rows exist for system clearing accounts.
DO $provision_system_clearing_accounts$
DECLARE
  v_clearing_accounts CONSTANT jsonb := $json$[
    {
      "id": "00000000-0000-0000-0000-000000000012",
      "accountNumber": "BV-CLEAR-DEP",
      "systemCode": "CLEARING_DEPOSIT_INR"
    },
    {
      "id": "00000000-0000-0000-0000-000000000013",
      "accountNumber": "BV-CLEAR-WD",
      "systemCode": "CLEARING_WITHDRAWAL_INR"
    }
  ]$json$::jsonb;

  v_item jsonb;
  v_expected_id uuid;
  v_expected_account_number text;
  v_expected_system_code text;

  v_by_id public."Account"%ROWTYPE;
  v_by_number public."Account"%ROWTYPE;
  v_by_code public."Account"%ROWTYPE;
  v_existing public."Account"%ROWTYPE;

  v_has_id boolean;
  v_has_number boolean;
  v_has_code boolean;
  v_ledger_sum bigint;
  v_now timestamptz(6);
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_clearing_accounts)
  LOOP
    v_expected_id := (v_item->>'id')::uuid;
    v_expected_account_number := v_item->>'accountNumber';
    v_expected_system_code := v_item->>'systemCode';

    -- Look up existing records across all unique identifier constraints
    SELECT * INTO v_by_id FROM public."Account" WHERE "id" = v_expected_id;
    v_has_id := FOUND;

    SELECT * INTO v_by_number FROM public."Account" WHERE "accountNumber" = v_expected_account_number;
    v_has_number := FOUND;

    SELECT * INTO v_by_code FROM public."Account" WHERE "systemCode" = v_expected_system_code;
    v_has_code := FOUND;

    -- Case 1: Partial collision / cross-record conflict
    IF (v_has_id AND v_has_number AND v_by_id."id" IS DISTINCT FROM v_by_number."id")
       OR (v_has_id AND v_has_code AND v_by_id."id" IS DISTINCT FROM v_by_code."id")
       OR (v_has_number AND v_has_code AND v_by_number."id" IS DISTINCT FROM v_by_code."id")
    THEN
      RAISE EXCEPTION 'Conflicting existing account records collide on identifiers for % (id=%, accountNumber=%)',
        v_expected_system_code, v_expected_id, v_expected_account_number
        USING ERRCODE = '23505';
    END IF;

    -- Identify the single existing record, if any
    IF v_has_id THEN
      v_existing := v_by_id;
    ELSIF v_has_number THEN
      v_existing := v_by_number;
    ELSIF v_has_code THEN
      v_existing := v_by_code;
    ELSE
      v_existing := NULL;
    END IF;

    IF v_existing."id" IS NOT NULL THEN
      -- Case 2: Existing record found - validate all identifiers
      IF v_existing."id" IS DISTINCT FROM v_expected_id
         OR v_existing."accountNumber" IS DISTINCT FROM v_expected_account_number
         OR v_existing."systemCode" IS DISTINCT FROM v_expected_system_code
      THEN
        RAISE EXCEPTION 'System clearing account % identifier mismatch: expected (id=%, accountNumber=%, systemCode=%), found (id=%, accountNumber=%, systemCode=%)',
          v_expected_system_code,
          v_expected_id, v_expected_account_number, v_expected_system_code,
          v_existing."id", v_existing."accountNumber", v_existing."systemCode"
          USING ERRCODE = '23505';
      END IF;

      -- Validate classification and configuration attributes
      IF v_existing."type" IS DISTINCT FROM 'SYSTEM_CLEARING'::public."AccountType" THEN
        RAISE EXCEPTION 'System clearing account % has unexpected type % (expected SYSTEM_CLEARING)',
          v_expected_system_code, v_existing."type"
          USING ERRCODE = '23514';
      END IF;

      IF v_existing."status" IS DISTINCT FROM 'ACTIVE'::public."AccountStatus" THEN
        RAISE EXCEPTION 'System clearing account % has unexpected status % (expected ACTIVE)',
          v_expected_system_code, v_existing."status"
          USING ERRCODE = '23514';
      END IF;

      IF v_existing."currencyCode" IS DISTINCT FROM 'INR' THEN
        RAISE EXCEPTION 'System clearing account % has unexpected currencyCode % (expected INR)',
          v_expected_system_code, v_existing."currencyCode"
          USING ERRCODE = '23514';
      END IF;

      -- Validate balancePaise against double-entry ledger invariants:
      -- Fresh or unposted clearing accounts must have balancePaise = 0.
      -- If ledger entries exist, balancePaise must strictly match the ledger sum.
      SELECT COALESCE(sum("amountPaise"), 0)
        INTO v_ledger_sum
        FROM public."LedgerEntry"
       WHERE "accountId" = v_existing."id";

      IF v_existing."balancePaise"::numeric <> v_ledger_sum::numeric THEN
        RAISE EXCEPTION 'System clearing account % balance cache % differs from ledger total %',
          v_expected_system_code, v_existing."balancePaise", v_ledger_sum
          USING ERRCODE = '23514';
      END IF;

      -- Validate ownership rule: System accounts must not have user permissions
      IF EXISTS (SELECT 1 FROM public."AccountPermission" WHERE "accountId" = v_existing."id") THEN
        RAISE EXCEPTION 'System clearing account % must not have AccountPermission records',
          v_expected_system_code
          USING ERRCODE = '23514';
      END IF;

      -- Account is verified and correct: leave unchanged.
    ELSE
      -- Case 3: Completely missing - safely insert with 0 balancePaise
      v_now := pg_catalog.clock_timestamp();
      INSERT INTO public."Account" (
        "id",
        "accountNumber",
        "systemCode",
        "type",
        "status",
        "balancePaise",
        "currencyCode",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        v_expected_id,
        v_expected_account_number,
        v_expected_system_code,
        'SYSTEM_CLEARING'::public."AccountType",
        'ACTIVE'::public."AccountStatus",
        0,
        'INR',
        v_now,
        v_now
      );
    END IF;
  END LOOP;
END;
$provision_system_clearing_accounts$;
