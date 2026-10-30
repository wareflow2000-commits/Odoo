-- A zero-quantity receipt is valid when the receiver returns the entire
-- outstanding quantity. No destination shelf is required in that path, but
-- the destination warehouse must still be recorded in the audit event.
-- Also remove redundant local shelf/profile reads and a duplicated wrapper
-- warehouse-scope predicate without changing the authorization contract.
DO $migration$
DECLARE
  d text;
  n text;
  redundant_profile_declaration text;
  redundant_profile_read text;
  redundant_shelf_assignment text;
  shelf_guard text;
  audit_old text;
  audit_new text;
  wrapper_def text;
  wrapper_new text;
  duplicate_wrapper_guard text;
BEGIN
  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text)'::regprocedure
  ) INTO d;

  redundant_profile_declaration := '  v_user uuid:=auth.uid(); v_profile public.profiles%ROWTYPE; v_t public.stock_transfers%ROWTYPE;';
  IF position(redundant_profile_declaration IN d)>0 THEN
    d := replace(d, redundant_profile_declaration,
      '  v_user uuid:=auth.uid(); v_t public.stock_transfers%ROWTYPE;');
  END IF;

  redundant_profile_read := '  SELECT * INTO v_profile FROM public.profiles WHERE id=v_user AND status=''ACTIVE'';' || E'\n';
  IF position(redundant_profile_read IN d)>0 THEN
    d := replace(d, redundant_profile_read, '');
  END IF;

  redundant_shelf_assignment := '  IF p_received_quantity>0 THEN v_t.destination_shelf_id:=COALESCE(p_destination_shelf_id,v_t.destination_shelf_id); END IF;' || E'\n';
  IF position(redundant_shelf_assignment IN d)>0 THEN
    d := replace(d, redundant_shelf_assignment, '');
  END IF;

  shelf_guard := '  v_t.destination_shelf_id := COALESCE(p_destination_shelf_id, v_t.destination_shelf_id);' || E'\n' ||
    '  IF v_t.destination_shelf_id IS NULL THEN' || E'\n' ||
    '    RAISE EXCEPTION ''A destination shelf is required for receipt'';' || E'\n' ||
    '  END IF;' || E'\n';
  IF position(shelf_guard IN d)>0 THEN
    n := replace(d, shelf_guard, '');
    IF n=d THEN RAISE EXCEPTION 'Could not remove unconditional destination shelf guard'; END IF;
    d := n;
  ELSIF position('A destination shelf is required for receipt' IN d)>0 THEN
    RAISE EXCEPTION 'Unexpected destination shelf guard remains in receipt function';
  END IF;

  audit_old := 'VALUES(v_user,''STOCK_TRANSFER_RECEIPT_RECONCILED'',''STOCK_TRANSFER'',p_transfer_id::text,v_dst.warehouse_id,v_t.reference_no,';
  audit_new := 'VALUES(v_user,''STOCK_TRANSFER_RECEIPT_RECONCILED'',''STOCK_TRANSFER'',p_transfer_id::text,COALESCE(v_dst.warehouse_id,v_t.destination_warehouse_id),v_t.reference_no,';
  duplicate_wrapper_guard := '  IF NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n';
  -- Keep exactly one destination-warehouse authorization check in the inner
  -- receipt writer; the previous duplicate added no protection.
  IF position(duplicate_wrapper_guard IN d)>0 THEN
    n := replace(d, duplicate_wrapper_guard, '');
    IF n=d THEN RAISE EXCEPTION 'Could not remove duplicate inner receipt warehouse guard'; END IF;
    d := n;
  END IF;

  IF position(audit_new IN d)=0 THEN
    IF position(audit_old IN d)=0 THEN RAISE EXCEPTION 'Transfer receipt audit insert did not match expected definition'; END IF;
    n := replace(d, audit_old, audit_new);
    IF n=d THEN RAISE EXCEPTION 'Could not correct transfer receipt audit warehouse'; END IF;
    d := n;
  END IF;

  EXECUTE d;

  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text,uuid)'::regprocedure
  ) INTO wrapper_def;
  duplicate_wrapper_guard := '  IF NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n';
  IF position(duplicate_wrapper_guard IN wrapper_def)>0 THEN
    wrapper_new := replace(wrapper_def, duplicate_wrapper_guard, '');
    IF wrapper_new=wrapper_def THEN RAISE EXCEPTION 'Could not remove duplicate transfer wrapper warehouse guard'; END IF;
    EXECUTE wrapper_new;
  END IF;
END;
$migration$;

DO $verify$
DECLARE
  d text;
  wrapper_def text;
  scope_guard text;
BEGIN
  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text)'::regprocedure
  ) INTO d;
  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text,uuid)'::regprocedure
  ) INTO wrapper_def;

  IF position('IF p_received_quantity>0 THEN' IN d)=0
     OR (length(d)-length(replace(d,'current_user_can_access_warehouse(v_transfer.destination_warehouse_id)','')))/length('current_user_can_access_warehouse(v_transfer.destination_warehouse_id)') <> 1
     OR position('COALESCE(v_dst.warehouse_id,v_t.destination_warehouse_id)' IN d)=0
     OR position('A destination shelf is required for receipt' IN d)>0
     OR position('v_profile' IN d)>0
     OR position('v_t.destination_shelf_id:=COALESCE(p_destination_shelf_id,v_t.destination_shelf_id)' IN d)>0 THEN
    RAISE EXCEPTION 'Zero-quantity transfer return regression verification failed';
  END IF;

  scope_guard := 'current_user_can_access_warehouse(v_transfer.destination_warehouse_id)';
  IF (length(wrapper_def)-length(replace(wrapper_def,scope_guard,'')))/length(scope_guard) <> 1 THEN
    RAISE EXCEPTION 'Transfer receipt wrapper warehouse-scope guard is not singular';
  END IF;
END;
$verify$;
