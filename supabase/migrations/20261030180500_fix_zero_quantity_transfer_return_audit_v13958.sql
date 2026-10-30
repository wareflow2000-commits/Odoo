-- Harden transfer receipt posting under immutable voucher guards. Positive
-- receipts now post from PENDING_APPROVAL after their line is inserted; zero
-- receipts may return the entire remainder without a destination shelf.
-- Preserve destination warehouse audit context and remove redundant reads/guards.
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
  receipt_header_old text;
  receipt_header_new text;
  receipt_header_anchor text;
  receipt_context_insert text;
  receipt_line_insert text;
  receipt_line_posted text;
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
  IF position(audit_new IN d)=0 THEN
    IF position(audit_old IN d)=0 THEN RAISE EXCEPTION 'Transfer receipt audit insert did not match expected definition'; END IF;
    n := replace(d, audit_old, audit_new);
    IF n=d THEN RAISE EXCEPTION 'Could not correct transfer receipt audit warehouse'; END IF;
    d := n;
  END IF;

  -- Positive transfer receipts must not insert lines into an already-approved
  -- transaction. Bind a short-lived transaction-local context, insert pending,
  -- then approve through the dedicated transfer-receipt status guard.
  receipt_header_old := 'VALUES(v_tx,v_t.reference_no||''-RCV-''||COALESCE(v_t.received_quantity,0)::text,''TRANSFER_IN'',''APPROVED'',';
  receipt_header_new := 'VALUES(v_tx,v_t.reference_no||''-RCV-''||COALESCE(v_t.received_quantity,0)::text,''TRANSFER_IN'',''PENDING_APPROVAL'',';
  IF position(receipt_header_new IN d)=0 THEN
    IF position(receipt_header_old IN d)=0 THEN RAISE EXCEPTION 'Transfer receipt transaction header did not match'; END IF;
    n:=replace(d,receipt_header_old,receipt_header_new);
    IF n=d THEN RAISE EXCEPTION 'Could not defer transfer receipt posting'; END IF;
    d:=n;
  END IF;

  receipt_context_insert := '    INSERT INTO public.transactions(id,reference_no,transaction_type,status,warehouse_id,storage_area_id,notes,created_by)';
  IF position(receipt_context_insert IN d)>0
     AND position('''RECEIVE_RECEIPT''' IN d)=0 THEN
    n:=replace(d,receipt_context_insert,
      '    INSERT INTO public.wms_transfer_scope_context(transaction_id,transfer_id,actor_id,context_type)' || E'\n' ||
      '    VALUES(txid_current(),p_transfer_id,v_user,''RECEIVE_RECEIPT'');' || E'\n' ||
      receipt_context_insert);
    IF n=d THEN RAISE EXCEPTION 'Could not bind transfer receipt authorization context'; END IF;
    d:=n;
  END IF;

  receipt_line_insert := '    INSERT INTO public.transaction_lines(transaction_id,item_id,shelf_id,quantity,balance_before,balance_after,batch_no,expiry_date,storage_area_id,notes)' || E'\n' ||
    '    VALUES(v_tx,v_t.item_id,v_t.destination_shelf_id,p_received_quantity,v_before,v_after,COALESCE(v_t.batch_no,''''),v_t.expiry_date,v_area,''Transfer=''||p_transfer_id::text||''; direction=RECEIPT; actual=''||p_received_quantity::text);';
  receipt_line_posted := receipt_line_insert || E'\n' ||
    '    UPDATE public.transactions SET status=''APPROVED'' WHERE id=v_tx AND status=''PENDING_APPROVAL'';' || E'\n' ||
    '    IF NOT FOUND THEN RAISE EXCEPTION ''Transfer receipt voucher could not be posted''; END IF;' || E'\n' ||
    '    DELETE FROM public.wms_transfer_scope_context WHERE transaction_id=txid_current() AND transfer_id=p_transfer_id AND actor_id=v_user AND context_type=''RECEIVE_RECEIPT'';';
  IF position(receipt_line_posted IN d)=0 THEN
    IF position(receipt_line_insert IN d)=0 THEN RAISE EXCEPTION 'Transfer receipt line insert did not match'; END IF;
    n:=replace(d,receipt_line_insert,receipt_line_posted);
    IF n=d THEN RAISE EXCEPTION 'Could not add transfer receipt posting transition'; END IF;
    d:=n;
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

-- Permit the short-lived context used only by the guarded receipt writer.
ALTER TABLE public.wms_transfer_scope_context
  DROP CONSTRAINT IF EXISTS wms_transfer_scope_context_context_type_check;
ALTER TABLE public.wms_transfer_scope_context
  ADD CONSTRAINT wms_transfer_scope_context_context_type_check
  CHECK (context_type = ANY (ARRAY['REJECT_RECEIPT'::text,'FINALIZE_SOURCE'::text,'RECEIVE_RECEIPT'::text]));

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
     OR (length(d)-length(replace(d,'current_user_can_access_warehouse(v_t.destination_warehouse_id)','')))/length('current_user_can_access_warehouse(v_t.destination_warehouse_id)') <> 1
     OR position('COALESCE(v_dst.warehouse_id,v_t.destination_warehouse_id)' IN d)=0
     OR position('A destination shelf is required for receipt' IN d)>0
     OR position('v_profile' IN d)>0
     OR position('v_t.destination_shelf_id:=COALESCE(p_destination_shelf_id,v_t.destination_shelf_id)' IN d)>0 THEN
    RAISE EXCEPTION 'Zero-quantity transfer return regression verification failed';
  END IF;

  IF position('''TRANSFER_IN'',''PENDING_APPROVAL''' IN d)=0
     OR position('''RECEIVE_RECEIPT''' IN d)=0
     OR position('UPDATE public.transactions SET status=''APPROVED'' WHERE id=v_tx AND status=''PENDING_APPROVAL''' IN d)=0
     OR position('DELETE FROM public.wms_transfer_scope_context' IN d)=0 THEN
    RAISE EXCEPTION 'Positive transfer receipt must use the guarded pending-to-approved posting path';
  END IF;

  scope_guard := 'current_user_can_access_warehouse(v_transfer.destination_warehouse_id)';
  IF (length(wrapper_def)-length(replace(wrapper_def,scope_guard,'')))/length(scope_guard) <> 1 THEN
    RAISE EXCEPTION 'Transfer receipt wrapper warehouse-scope guard is not singular';
  END IF;
END;
$verify$;
