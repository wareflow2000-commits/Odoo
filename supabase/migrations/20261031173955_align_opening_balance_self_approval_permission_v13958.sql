-- Keep opening-balance self-approval aligned with the dedicated
-- opening_balance:create grant used when the opening-balance voucher is created.
-- Do not treat opening balances as generic stock adjustments.
DO $migration$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_old text := 'WHEN ''OPENING_BALANCE'' THEN ''action:transaction:adjustment:create''';
  v_new text := 'WHEN ''OPENING_BALANCE'' THEN ''action:transaction:opening_balance:create''';
  v_updated text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.approve_transaction(uuid)'::regprocedure,
    'public.guard_transaction_status_change()'::regprocedure
  ]
  LOOP
    SELECT pg_get_functiondef(v_signature) INTO v_definition;
    IF position(v_new IN v_definition)=0 THEN
      IF position(v_old IN v_definition)=0 THEN
        RAISE EXCEPTION 'Opening-balance authorization mapping not found in %',v_signature;
      END IF;
      v_updated:=replace(v_definition,v_old,v_new);
      IF v_updated=v_definition THEN
        RAISE EXCEPTION 'Could not update opening-balance authorization mapping in %',v_signature;
      END IF;
      EXECUTE v_updated;
    END IF;
  END LOOP;
END;
$migration$;

DO $verify$
DECLARE
  v_approval text;
  v_guard text;
BEGIN
  SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure) INTO v_approval;
  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure) INTO v_guard;

  IF position('WHEN ''OPENING_BALANCE'' THEN ''action:transaction:opening_balance:create''' IN v_approval)=0
     OR position('WHEN ''OPENING_BALANCE'' THEN ''action:transaction:opening_balance:create''' IN v_guard)=0
     OR position('WHEN ''OPENING_BALANCE'' THEN ''action:transaction:adjustment:create''' IN v_approval)>0
     OR position('WHEN ''OPENING_BALANCE'' THEN ''action:transaction:adjustment:create''' IN v_guard)>0 THEN
    RAISE EXCEPTION 'Opening-balance self-approval permission mapping is inconsistent';
  END IF;
END;
$verify$;
