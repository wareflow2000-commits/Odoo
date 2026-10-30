-- A zero-quantity receipt is valid when the receiver returns the entire
-- outstanding quantity. In that path no destination shelf is needed and the
-- destination warehouse must still be recorded in the audit event.
DO $migration$
DECLARE
  d text;
  n text;
  shelf_guard text;
  audit_old text;
  audit_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text)'::regprocedure
  ) INTO d;

  shelf_guard := '  v_t.destination_shelf_id := COALESCE(p_destination_shelf_id, v_t.destination_shelf_id);' || E'\n' ||
    '  IF v_t.destination_shelf_id IS NULL THEN' || E'\n' ||
    '    RAISE EXCEPTION ''A destination shelf is required for receipt'';' || E'\n' ||
    '  END IF;' || E'\n';

  audit_old := 'VALUES(v_user,''STOCK_TRANSFER_RECEIPT_RECONCILED'',''STOCK_TRANSFER'',p_transfer_id::text,v_dst.warehouse_id,v_t.reference_no,';
  audit_new := 'VALUES(v_user,''STOCK_TRANSFER_RECEIPT_RECONCILED'',''STOCK_TRANSFER'',p_transfer_id::text,COALESCE(v_dst.warehouse_id,v_t.destination_warehouse_id),v_t.reference_no,';

  IF position(shelf_guard IN d)=0 THEN
    IF position('COALESCE(v_dst.warehouse_id,v_t.destination_warehouse_id)' IN d)=0 THEN
      RAISE EXCEPTION 'Transfer receipt function does not match the expected pre-fix definition';
    END IF;
  ELSE
    n := replace(d, shelf_guard, '');
    IF n=d THEN RAISE EXCEPTION 'Could not remove unconditional destination shelf guard'; END IF;
    d := n;
  END IF;

  IF position(audit_new IN d)=0 THEN
    IF position(audit_old IN d)=0 THEN RAISE EXCEPTION 'Transfer receipt audit insert did not match expected definition'; END IF;
    n := replace(d, audit_old, audit_new);
    IF n=d THEN RAISE EXCEPTION 'Could not correct transfer receipt audit warehouse'; END IF;
    d := n;
  END IF;

  EXECUTE d;
END;
$migration$;

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef(
    'public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text)'::regprocedure
  ) INTO d;

  IF position('v_t.destination_shelf_id := COALESCE(p_destination_shelf_id, v_t.destination_shelf_id);' IN d)>0
     OR position('COALESCE(v_dst.warehouse_id,v_t.destination_warehouse_id)' IN d)=0
     OR position('IF p_received_quantity>0 THEN' IN d)=0
     OR position('IF v_t.destination_shelf_id IS NULL THEN' IN d)>0 THEN
    RAISE EXCEPTION 'Zero-quantity transfer return regression verification failed';
  END IF;
END;
$verify$;
