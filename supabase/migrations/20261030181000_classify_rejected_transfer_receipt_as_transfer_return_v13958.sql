-- A rejected transfer receipt returns stock to its source warehouse.
-- It is a transfer-return movement, not an inventory adjustment.
DO $migration$
DECLARE
  d text;
  n text;
  old_header text := 'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''ADJUSTMENT_IN'',''APPROVED''';
  new_header text := 'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''TRANSFER_RETURN'',''APPROVED''';
  old_ledger text := 'p_transaction_type:=''ADJUSTMENT_IN''';
  new_ledger text := 'p_transaction_type:=''TRANSFER_RETURN''';
  profile_decl text := ' v_user uuid:=auth.uid(); v_profile public.profiles%ROWTYPE; v_transfer public.stock_transfers%ROWTYPE;';
  profile_read text := ' SELECT * INTO v_profile FROM public.profiles WHERE id=v_user AND status=''ACTIVE'';' || E'\n';
BEGIN
  SELECT pg_get_functiondef('public.reject_stock_transfer_receipt(uuid,text)'::regprocedure) INTO d;

  IF position(new_header IN d)=0 THEN
    IF position(old_header IN d)=0 THEN RAISE EXCEPTION 'Rejected transfer transaction header classification not found'; END IF;
    n := replace(d,old_header,new_header);
    IF n=d THEN RAISE EXCEPTION 'Could not classify rejected transfer header as TRANSFER_RETURN'; END IF;
    d := n;
  END IF;

  IF position(new_ledger IN d)=0 THEN
    IF position(old_ledger IN d)=0 THEN RAISE EXCEPTION 'Rejected transfer ledger classification not found'; END IF;
    n := replace(d,old_ledger,new_ledger);
    IF n=d THEN RAISE EXCEPTION 'Could not classify rejected transfer ledger as TRANSFER_RETURN'; END IF;
    d := n;
  END IF;

  IF position(profile_decl IN d)>0 THEN
    d := replace(d,profile_decl,
      ' v_user uuid:=auth.uid(); v_transfer public.stock_transfers%ROWTYPE;');
  END IF;
  IF position(profile_read IN d)>0 THEN
    d := replace(d,profile_read,'');
  END IF;

  EXECUTE d;
END;
$migration$;


-- Rejected receipts are posted through the same immutable-voucher lifecycle as
-- other stock movements: insert a pending header, insert its line, then post.
-- The narrowly scoped transfer context authorizes only this internal return.
DO $posting$
DECLARE
  d text;
  n text;
  header_old text := 'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''TRANSFER_RETURN'',''APPROVED''';
  header_new text := 'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''TRANSFER_RETURN'',''PENDING_APPROVAL''';
  line_insert text := ' INSERT INTO public.transaction_lines(transaction_id,item_id,shelf_id,quantity,balance_before,balance_after,batch_no,expiry_date,storage_area_id,notes)' || E'\n' ||
    ' VALUES(v_tx,v_transfer.item_id,v_transfer.source_shelf_id,v_transfer.quantity,v_before,v_after,v_transfer.batch_no,v_transfer.expiry_date,v_area,''Transfer=''||p_transfer_id::text||''; direction=REJECTED_RETURN; reason=''||btrim(p_reason));';
  line_insert_new text := line_insert || E'\n' ||
    ' UPDATE public.transactions SET status=''APPROVED'' WHERE id=v_tx AND status=''PENDING_APPROVAL'';' || E'\n' ||
    ' IF NOT FOUND THEN RAISE EXCEPTION ''Rejected transfer return could not be posted''; END IF;';
  scope_insert_old text := 'IF TG_OP=''INSERT'' AND v_context_type=''REJECT_RECEIPT'' AND NEW.transaction_type=''ADJUSTMENT_IN'' AND NEW.status=''APPROVED''';
  scope_insert_new text := 'IF TG_OP=''INSERT'' AND v_context_type=''REJECT_RECEIPT'' AND NEW.transaction_type=''TRANSFER_RETURN'' AND NEW.status=''PENDING_APPROVAL''';
  scope_update_old text := '    ELSIF TG_OP=''UPDATE'' AND v_context_type=''FINALIZE_SOURCE''';
  scope_update_new text := '    ELSIF TG_OP=''UPDATE'' AND v_context_type=''REJECT_RECEIPT'' AND OLD.status=''PENDING_APPROVAL'' AND NEW.status=''APPROVED''' || E'\n' ||
    '       AND NEW.transaction_type=''TRANSFER_RETURN''' || E'\n' ||
    '       AND EXISTS (SELECT 1 FROM public.stock_transfers st WHERE st.id=v_transfer_id' || E'\n' ||
    '         AND NEW.reference_no=st.reference_no||''-REJECT-RETURN'' AND NEW.warehouse_id=st.source_warehouse_id' || E'\n' ||
    '         AND st.status=''IN_TRANSIT'' AND st.rejection_transaction_id IS NULL' || E'\n' ||
    '         AND public.current_user_can_access_warehouse(st.destination_warehouse_id)) THEN' || E'\n' ||
    '      v_transfer_exception := true;' || E'\n' ||
    '    ELSIF TG_OP=''UPDATE'' AND v_context_type=''FINALIZE_SOURCE''';
  line_scope_old text := 't.transaction_type=''ADJUSTMENT_IN'' AND t.status=''APPROVED''';
  line_scope_new text := 't.transaction_type=''TRANSFER_RETURN'' AND t.status=''PENDING_APPROVAL''';
  status_prefix text := 'BEGIN' || E'\n' ||
    '  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN';
  status_prefix_new text := 'BEGIN' || E'\n' ||
    '  -- A transfer receipt is a system-generated voucher authorized by the' || E'\n' ||
    '  -- receive RPC, not a user self-approval of a normal inventory voucher.' || E'\n' ||
    '  IF OLD.status=''PENDING_APPROVAL'' AND NEW.status=''APPROVED''' || E'\n' ||
    '     AND v_user_id IS NOT NULL AND NEW.created_by=v_user_id' || E'\n' ||
    '     AND NEW.transaction_type=''TRANSFER_IN''' || E'\n' ||
    '     AND EXISTS (' || E'\n' ||
    '       SELECT 1 FROM public.wms_transfer_scope_context c' || E'\n' ||
    '       JOIN public.stock_transfers st ON st.id=c.transfer_id' || E'\n' ||
    '       WHERE c.transaction_id=txid_current() AND c.actor_id=v_user_id' || E'\n' ||
    '         AND c.context_type=''RECEIVE_RECEIPT''' || E'\n' ||
    '         AND NEW.reference_no=st.reference_no||''-RCV-''||COALESCE(st.received_quantity,0)::text' || E'\n' ||
    '         AND NEW.warehouse_id=st.destination_warehouse_id' || E'\n' ||
    '         AND st.status IN (''IN_TRANSIT'',''PARTIALLY_RECEIVED'')' || E'\n' ||
    '         AND public.current_user_can_access_warehouse(st.destination_warehouse_id)' || E'\n' ||
    '         AND public.authorize_action(''action:stock_transfer:receive'',''stock_transfer'',st.id,' || E'\n' ||
    '           st.destination_warehouse_id,' || E'\n' ||
    '           jsonb_build_object(''status'',st.status,''source_warehouse_id'',st.source_warehouse_id,' || E'\n' ||
    '             ''destination_warehouse_id'',st.destination_warehouse_id),true)' || E'\n' ||
    '     ) THEN' || E'\n' ||
    '    RETURN NEW;' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  -- Only the authenticated actor who is rejecting an in-transit transfer may' || E'\n' ||
    '  -- post its paired source-side TRANSFER_RETURN voucher in this transaction.' || E'\n' ||
    '  IF OLD.status=''PENDING_APPROVAL'' AND NEW.status=''APPROVED''' || E'\n' ||
    '     AND v_user_id IS NOT NULL AND NEW.created_by=v_user_id' || E'\n' ||
    '     AND NEW.transaction_type=''TRANSFER_RETURN''' || E'\n' ||
    '     AND EXISTS (' || E'\n' ||
    '       SELECT 1 FROM public.wms_transfer_scope_context c' || E'\n' ||
    '       JOIN public.stock_transfers st ON st.id=c.transfer_id' || E'\n' ||
    '       WHERE c.transaction_id=txid_current() AND c.actor_id=v_user_id' || E'\n' ||
    '         AND c.context_type=''REJECT_RECEIPT''' || E'\n' ||
    '         AND NEW.reference_no=st.reference_no||''-REJECT-RETURN''' || E'\n' ||
    '         AND NEW.warehouse_id=st.source_warehouse_id' || E'\n' ||
    '         AND st.status=''IN_TRANSIT'' AND st.rejection_transaction_id IS NULL' || E'\n' ||
    '         AND public.current_user_can_access_warehouse(st.destination_warehouse_id)' || E'\n' ||
    '         AND public.authorize_action(''action:stock_transfer:reject_receipt'',''stock_transfer'',st.id,' || E'\n' ||
    '           st.destination_warehouse_id,' || E'\n' ||
    '           jsonb_build_object(''status'',st.status,''source_warehouse_id'',st.source_warehouse_id,' || E'\n' ||
    '             ''destination_warehouse_id'',st.destination_warehouse_id),true)' || E'\n' ||
    '     ) THEN' || E'\n' ||
    '    RETURN NEW;' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN';
BEGIN
  SELECT pg_get_functiondef('public.reject_stock_transfer_receipt(uuid,text)'::regprocedure) INTO d;
  IF position(header_new IN d)=0 THEN
    IF position(header_old IN d)=0 THEN RAISE EXCEPTION 'Rejected transfer header status did not match expected definition'; END IF;
    n:=replace(d,header_old,header_new);
    IF n=d THEN RAISE EXCEPTION 'Could not defer rejected transfer posting'; END IF;
    d:=n;
  END IF;
  IF position(line_insert_new IN d)=0 THEN
    IF position(line_insert IN d)=0 THEN RAISE EXCEPTION 'Rejected transfer line insert did not match expected definition'; END IF;
    n:=replace(d,line_insert,line_insert_new);
    IF n=d THEN RAISE EXCEPTION 'Could not add controlled transfer-return posting transition'; END IF;
    d:=n;
  END IF;
  EXECUTE d;

  SELECT pg_get_functiondef('public.enforce_transaction_warehouse_scope()'::regprocedure) INTO d;
  IF position(scope_insert_new IN d)=0 THEN
    IF position(scope_insert_old IN d)=0 THEN RAISE EXCEPTION 'Transaction warehouse-scope insert guard did not match'; END IF;
    n:=replace(d,scope_insert_old,scope_insert_new);
    IF n=d THEN RAISE EXCEPTION 'Could not update transfer-return header scope exception'; END IF;
    d:=n;
  END IF;
  IF position(scope_update_new IN d)=0 THEN
    IF position(scope_update_old IN d)=0 THEN RAISE EXCEPTION 'Transaction warehouse-scope update anchor did not match'; END IF;
    n:=replace(d,scope_update_old,scope_update_new);
    IF n=d THEN RAISE EXCEPTION 'Could not add transfer-return approval scope exception'; END IF;
    d:=n;
  END IF;
  EXECUTE d;

  SELECT pg_get_functiondef('public.enforce_transaction_line_warehouse_scope()'::regprocedure) INTO d;
  IF position(line_scope_new IN d)=0 THEN
    IF position(line_scope_old IN d)=0 THEN RAISE EXCEPTION 'Transaction-line warehouse-scope exception did not match'; END IF;
    n:=replace(d,line_scope_old,line_scope_new);
    IF n=d THEN RAISE EXCEPTION 'Could not align transaction-line scope with TRANSFER_RETURN'; END IF;
    d:=n;
  END IF;
  EXECUTE d;

  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure) INTO d;
  IF position(status_prefix_new IN d)=0 THEN
    IF position(status_prefix IN d)=0 THEN RAISE EXCEPTION 'Transaction status guard anchor did not match'; END IF;
    n:=replace(d,status_prefix,status_prefix_new);
    IF n=d THEN RAISE EXCEPTION 'Could not add authorized internal transfer-return posting path'; END IF;
    d:=n;
  END IF;
  EXECUTE d;
END;
$posting$;

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef('public.reject_stock_transfer_receipt(uuid,text)'::regprocedure) INTO d;
  IF position('''-REJECT-RETURN'',''ADJUSTMENT_IN''' IN d)>0
     OR position('p_transaction_type:=''ADJUSTMENT_IN''' IN d)>0
     OR position('''-REJECT-RETURN'',''TRANSFER_RETURN''' IN d)=0
     OR position('p_transaction_type:=''TRANSFER_RETURN''' IN d)=0
     OR position('v_profile' IN d)>0 THEN
    RAISE EXCEPTION 'Rejected transfer return accounting classification verification failed';
  END IF;
  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure) INTO d;
  IF position('context_type=''REJECT_RECEIPT''' IN d)=0
     OR position('context_type=''RECEIVE_RECEIPT''' IN d)=0
     OR position('action:stock_transfer:receive' IN d)=0 THEN
    RAISE EXCEPTION 'Transfer receipt/rejection posting authorization guards are incomplete';
  END IF;
END;
$verify$;
