BEGIN;

-- Reinstall the posting function with FK-safe refusal evidence.
-- Missing accounts are recorded as NULL; existing account references are preserved.
GRANT CREATE ON SCHEMA public TO balancevault_posting_owner;
SET ROLE balancevault_posting_owner;

CREATE OR REPLACE FUNCTION public.balancevault_post_transaction(
  p_actor_id uuid,
  p_type public."JournalTransactionType",
  p_source_account_id uuid,
  p_destination_account_id uuid,
  p_amount_paise bigint,
  p_idempotency_key text,
  p_request_hash char(64)
) RETURNS TABLE(response_status integer, response_body jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, balancevault_private, pg_temp
AS $post$
DECLARE
  v_idem public."IdempotencyRecord"%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_journal uuid := gen_random_uuid();
  v_user public."User"%ROWTYPE;
  v_source public."Account"%ROWTYPE;
  v_destination public."Account"%ROWTYPE;
  v_clear public."Account"%ROWTYPE;
  v_reason text;
  v_body jsonb;
  v_status integer;
  v_existing integer;
  v_next bigint;
  v_account_id uuid;
  v_posting integer := 0;
  v_audit_action text := 'TRANSACTION_POSTED';
  v_audit_entity text := 'JournalTransaction';
BEGIN
  IF p_actor_id IS NULL OR p_type IS NULL OR p_amount_paise IS NULL
     OR p_amount_paise <= 0 OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 255
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'Invalid financial request arguments' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_user FROM public."User" u WHERE u."id"=p_actor_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown transaction actor' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."IdempotencyRecord" ("id","userId","idempotencyKey","canonicalRequestHash","expiresAt")
  VALUES (v_id,p_actor_id,p_idempotency_key,lower(p_request_hash),clock_timestamp() + interval '24 hours')
  ON CONFLICT ("userId","idempotencyKey") DO NOTHING;
  GET DIAGNOSTICS v_existing = ROW_COUNT;
  v_existing := CASE WHEN v_existing = 0 THEN 1 ELSE 0 END;
  SELECT * INTO v_idem FROM public."IdempotencyRecord" r
   WHERE r."userId" = p_actor_id AND r."idempotencyKey" = p_idempotency_key FOR UPDATE;
  IF v_existing = 1 THEN
    IF v_idem."canonicalRequestHash" <> lower(p_request_hash) THEN
      INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
      VALUES (gen_random_uuid(),p_actor_id,'IDEMPOTENCY_CONFLICT','IdempotencyRecord',v_idem."id",
              jsonb_build_object('requestHash',lower(p_request_hash),'storedRequestHash',v_idem."canonicalRequestHash"));
      RETURN QUERY SELECT 409, jsonb_build_object('error','idempotency_key_conflict'); RETURN;
    END IF;
    IF v_idem."responseStatus" IS NULL OR v_idem."responseBody" IS NULL THEN
      RAISE EXCEPTION 'Concurrent idempotency owner committed incomplete record' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
    VALUES (gen_random_uuid(),p_actor_id,'IDEMPOTENCY_REPLAY','IdempotencyRecord',v_idem."id",
            jsonb_build_object('requestHash',v_idem."canonicalRequestHash",'originalResponseStatus',v_idem."responseStatus"));
    RETURN QUERY SELECT v_idem."responseStatus", v_idem."responseBody"; RETURN;
  END IF;

  IF NOT v_user."isActive" THEN v_reason := 'actor_inactive';
  ELSIF v_user."role"='AUDITOR' THEN v_reason := 'role_forbidden';
  END IF;

  IF p_type='DEPOSIT' THEN
    IF p_source_account_id IS NOT NULL OR p_destination_account_id IS NULL THEN v_reason := COALESCE(v_reason,'invalid_accounts'); END IF;
  ELSIF p_type='WITHDRAWAL' THEN
    IF p_source_account_id IS NULL OR p_destination_account_id IS NOT NULL THEN v_reason := COALESCE(v_reason,'invalid_accounts'); END IF;
  ELSE
    IF p_source_account_id IS NULL OR p_destination_account_id IS NULL OR p_source_account_id=p_destination_account_id THEN v_reason := COALESCE(v_reason,'invalid_accounts'); END IF;
  END IF;

  FOR v_account_id IN
    SELECT x FROM unnest(ARRAY[p_source_account_id,p_destination_account_id]) AS ids(x)
     WHERE x IS NOT NULL GROUP BY x ORDER BY x
  LOOP
    PERFORM 1 FROM public."Account" a WHERE a."id"=v_account_id FOR UPDATE;
  END LOOP;
  IF p_source_account_id IS NOT NULL THEN SELECT * INTO v_source FROM public."Account" WHERE "id"=p_source_account_id; END IF;
  IF p_destination_account_id IS NOT NULL THEN SELECT * INTO v_destination FROM public."Account" WHERE "id"=p_destination_account_id; END IF;

  IF v_reason IS NULL AND p_type='TRANSFER' THEN
    IF v_source."id" IS NULL OR v_destination."id" IS NULL
       OR v_source."type" NOT IN ('PERSONAL','BUSINESS')
       OR v_destination."type" NOT IN ('PERSONAL','BUSINESS')
       OR v_source."systemCode" IS NOT NULL OR v_destination."systemCode" IS NOT NULL
       OR v_source."currencyCode" <> 'INR' OR v_destination."currencyCode" <> 'INR'
       OR v_source."status"<>'ACTIVE' OR v_destination."status"<>'ACTIVE' THEN v_reason := 'account_unavailable';
    ELSIF v_user."role" <> 'ADMIN' AND NOT EXISTS (
      SELECT 1 FROM public."AccountPermission" p
       WHERE p."userId"=p_actor_id AND p."accountId"=p_source_account_id AND p."canTransfer"
    ) THEN v_reason := 'not_authorized';
    ELSIF v_user."role" <> 'ADMIN' AND NOT EXISTS (
      SELECT 1 FROM public."AccountPermission" p
       WHERE p."userId"=p_actor_id AND p."accountId"=p_destination_account_id AND p."canView"
    ) THEN v_reason := 'not_authorized';
    ELSIF v_source."balancePaise" < p_amount_paise THEN v_reason := 'insufficient_funds';
    END IF;
  ELSIF v_reason IS NULL AND p_type='DEPOSIT' THEN
    IF v_destination."id" IS NULL
       OR v_destination."type" NOT IN ('PERSONAL','BUSINESS')
       OR v_destination."systemCode" IS NOT NULL
       OR v_destination."currencyCode" <> 'INR'
       OR v_destination."status"<>'ACTIVE' THEN v_reason := 'account_unavailable';
    ELSIF v_user."role" <> 'ADMIN' AND NOT EXISTS (
      SELECT 1 FROM public."AccountPermission" p
       WHERE p."userId"=p_actor_id AND p."accountId"=p_destination_account_id AND p."canDeposit"
    ) THEN v_reason := 'not_authorized';
    END IF;
  ELSIF v_reason IS NULL THEN
    IF v_source."id" IS NULL
       OR v_source."type" NOT IN ('PERSONAL','BUSINESS')
       OR v_source."systemCode" IS NOT NULL
       OR v_source."currencyCode" <> 'INR'
       OR v_source."status"<>'ACTIVE' THEN v_reason := 'account_unavailable';
    ELSIF v_user."role" <> 'ADMIN' AND NOT EXISTS (
      SELECT 1 FROM public."AccountPermission" p
       WHERE p."userId"=p_actor_id AND p."accountId"=p_source_account_id AND p."canWithdraw"
    ) THEN v_reason := 'not_authorized';
    ELSIF v_source."balancePaise" < p_amount_paise THEN v_reason := 'insufficient_funds';
    END IF;
  END IF;
  IF v_reason IS NULL AND v_user."role" NOT IN ('ADMIN','ACCOUNT_HOLDER') THEN v_reason := 'role_forbidden'; END IF;

  IF v_reason IS NOT NULL THEN
    v_status := 403;
    IF v_reason='insufficient_funds' THEN v_status := 422; END IF;
    IF v_reason='account_unavailable' THEN v_status := 409; END IF;
    v_body := jsonb_build_object('status','REFUSED','reason',v_reason);
    INSERT INTO public."TransactionAttempt" ("id","actorId","sourceAccountId","destinationAccountId","type","requestedAmountPaise","status","refusalReason","idempotencyRecordId")
    VALUES (v_attempt,p_actor_id,v_source."id",v_destination."id",p_type,p_amount_paise,'REFUSED',v_reason,v_id);
    INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
    VALUES (gen_random_uuid(),p_actor_id,'TRANSACTION_REFUSED','TransactionAttempt',v_attempt,jsonb_build_object('reason',v_reason,'type',p_type));
    UPDATE public."IdempotencyRecord" SET "responseStatus"=v_status,"responseBody"=v_body WHERE "id"=v_id;
    RETURN QUERY SELECT v_status,v_body; RETURN;
  END IF;

  IF p_type='DEPOSIT' THEN
    SELECT * INTO v_clear FROM public."Account" WHERE "systemCode"='CLEARING_DEPOSIT_INR' AND "type"='SYSTEM_CLEARING' AND "currencyCode"='INR' AND "status"='ACTIVE' FOR UPDATE;
  ELSIF p_type='WITHDRAWAL' THEN
    SELECT * INTO v_clear FROM public."Account" WHERE "systemCode"='CLEARING_WITHDRAWAL_INR' AND "type"='SYSTEM_CLEARING' AND "currencyCode"='INR' AND "status"='ACTIVE' FOR UPDATE;
  END IF;
  IF p_type<>'TRANSFER' AND NOT FOUND THEN
    v_reason := 'clearing_account_unavailable'; v_status:=409;
    v_body:=jsonb_build_object('status','REFUSED','reason',v_reason);
    INSERT INTO public."TransactionAttempt" ("id","actorId","sourceAccountId","destinationAccountId","type","requestedAmountPaise","status","refusalReason","idempotencyRecordId")
    VALUES (v_attempt,p_actor_id,v_source."id",v_destination."id",p_type,p_amount_paise,'REFUSED',v_reason,v_id);
    INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
    VALUES (gen_random_uuid(),p_actor_id,'TRANSACTION_REFUSED','TransactionAttempt',v_attempt,jsonb_build_object('reason',v_reason,'type',p_type));
    UPDATE public."IdempotencyRecord" SET "responseStatus"=v_status,"responseBody"=v_body WHERE "id"=v_id;
    RETURN QUERY SELECT v_status,v_body; RETURN;
  END IF;

  INSERT INTO public."JournalTransaction" ("id","type","status","actorId") VALUES (v_journal,p_type,'PENDING',p_actor_id);
  FOR v_account_id IN
    SELECT x FROM unnest(ARRAY[p_source_account_id,p_destination_account_id,CASE WHEN p_type='TRANSFER' THEN NULL ELSE v_clear."id" END]) ids(x)
     WHERE x IS NOT NULL GROUP BY x ORDER BY x
  LOOP
    v_posting := v_posting + 1;
    SELECT COALESCE(max("accountPostingSequence"),0)+1 INTO v_next FROM public."LedgerEntry" WHERE "accountId"=v_account_id;
    IF v_account_id=p_source_account_id THEN
      INSERT INTO public."LedgerEntry" ("id","journalTransactionId","accountId","amountPaise","postingSequence","accountPostingSequence")
      VALUES (gen_random_uuid(),v_journal,v_account_id,CASE WHEN p_type IN ('TRANSFER','WITHDRAWAL') THEN -p_amount_paise ELSE p_amount_paise END,v_posting,v_next);
      UPDATE public."Account" SET "balancePaise"="balancePaise"+CASE WHEN p_type IN ('TRANSFER','WITHDRAWAL') THEN -p_amount_paise ELSE p_amount_paise END,"updatedAt"=clock_timestamp() WHERE "id"=v_account_id;
    ELSIF v_account_id=p_destination_account_id THEN
      INSERT INTO public."LedgerEntry" ("id","journalTransactionId","accountId","amountPaise","postingSequence","accountPostingSequence")
      VALUES (gen_random_uuid(),v_journal,v_account_id,p_amount_paise,v_posting,v_next);
      UPDATE public."Account" SET "balancePaise"="balancePaise"+p_amount_paise,"updatedAt"=clock_timestamp() WHERE "id"=v_account_id;
    ELSE
      INSERT INTO public."LedgerEntry" ("id","journalTransactionId","accountId","amountPaise","postingSequence","accountPostingSequence")
      VALUES (gen_random_uuid(),v_journal,v_account_id,CASE WHEN p_type='DEPOSIT' THEN -p_amount_paise ELSE p_amount_paise END,v_posting,v_next);
      UPDATE public."Account" SET "balancePaise"="balancePaise"+CASE WHEN p_type='DEPOSIT' THEN -p_amount_paise ELSE p_amount_paise END,"updatedAt"=clock_timestamp() WHERE "id"=v_account_id;
    END IF;
  END LOOP;
  UPDATE public."JournalTransaction" SET "status"='POSTED' WHERE "id"=v_journal;
  INSERT INTO public."TransactionAttempt" ("id","actorId","sourceAccountId","destinationAccountId","type","requestedAmountPaise","status","idempotencyRecordId")
  VALUES (v_attempt,p_actor_id,p_source_account_id,p_destination_account_id,p_type,p_amount_paise,'POSTED',v_id);
  v_status:=201;
  v_body:=jsonb_build_object('status','POSTED','journalTransactionId',v_journal,'amountPaise',p_amount_paise);
  UPDATE public."IdempotencyRecord"
     SET "responseStatus"=v_status,"responseBody"=v_body,"resultJournalTransactionId"=v_journal
   WHERE "id"=v_id;
  INSERT INTO public."AuditLog" ("id","actorId","action","entityType","entityId","metadata")
  VALUES (gen_random_uuid(),p_actor_id,v_audit_action,v_audit_entity,v_journal,v_body);
  RETURN QUERY SELECT v_status,v_body;
END;
$post$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM balancevault_posting_owner;

COMMIT;
