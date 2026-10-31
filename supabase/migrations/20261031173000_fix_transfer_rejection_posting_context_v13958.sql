-- Transfer receipt rejection must follow the immutable voucher lifecycle.
-- Create the source-return voucher as pending, insert its line, then approve it
-- only while the transaction-local REJECT_RECEIPT context is present and valid.

DO $reject_function_patch$
DECLARE
  v_definition text;
  v_updated text;
  v_header_old text :=
    'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''ADJUSTMENT_IN'',''APPROVED'',v_shelf.warehouse_id';
  v_header_new text :=
    'VALUES(v_tx,v_transfer.reference_no||''-REJECT-RETURN'',''ADJUSTMENT_IN'',''PENDING_APPROVAL'',v_shelf.warehouse_id';
  v_line_anchor text :=
    'VALUES(v_tx,v_transfer.item_id,v_transfer.source_shelf_id,v_transfer.quantity,v_before,v_after,v_transfer.batch_no,v_transfer.expiry_date,v_area,''Transfer=''||p_transfer_id::text||''; direction=REJECTED_RETURN; reason=''||btrim(p_reason));';
  v_line_replacement text := v_line_anchor || E'\n' ||
    ' UPDATE public.transactions SET status=''APPROVED'' WHERE id=v_tx AND status=''PENDING_APPROVAL'';' || E'\n' ||
    ' IF NOT FOUND THEN RAISE EXCEPTION ''Rejected transfer return voucher could not be posted''; END IF;';
BEGIN
  SELECT pg_get_functiondef(
    'public.reject_stock_transfer_receipt(uuid,text)'::regprocedure
  ) INTO v_definition;

  IF position('Rejected transfer return voucher could not be posted' IN v_definition)=0 THEN
    IF position(v_header_old IN v_definition)=0 THEN
      RAISE EXCEPTION 'Rejected transfer voucher header anchor not found';
    END IF;
    v_updated:=replace(v_definition,v_header_old,v_header_new);
    IF v_updated=v_definition THEN
      RAISE EXCEPTION 'Rejected transfer voucher header status patch made no change';
    END IF;
    IF position(v_line_anchor IN v_updated)=0 THEN
      RAISE EXCEPTION 'Rejected transfer voucher line anchor not found';
    END IF;
    v_updated:=replace(v_updated,v_line_anchor,v_line_replacement);
    IF v_updated=v_definition THEN
      RAISE EXCEPTION 'Rejected transfer voucher posting patch made no change';
    END IF;
    EXECUTE v_updated;
  END IF;
END;
$reject_function_patch$;

-- Permit only this tightly bound rejection posting transition. The transfer
-- must still be IN_TRANSIT, the actor must retain destination scope, and the
-- existing action authorization is re-evaluated by the status trigger.
DO $status_guard_patch$
DECLARE
  v_definition text;
  v_updated text;
  v_anchor text :=
    '  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN' || E'\n' ||
    '    RETURN NEW;' || E'\n' ||
    '  END IF;';
  v_rejection_context text :=
    '  -- REJECT_RECEIPT_CONTEXT_APPROVAL: narrow internal posting exception.' || E'\n' ||
    '  IF OLD.status=''PENDING_APPROVAL''' || E'\n' ||
    '     AND NEW.status=''APPROVED''' || E'\n' ||
    '     AND v_user_id IS NOT NULL AND NEW.created_by=v_user_id' || E'\n' ||
    '     AND NEW.transaction_type=''ADJUSTMENT_IN''' || E'\n' ||
    '     AND EXISTS (' || E'\n' ||
    '       SELECT 1' || E'\n' ||
    '       FROM public.wms_transfer_scope_context c' || E'\n' ||
    '       JOIN public.stock_transfers st ON st.id=c.transfer_id' || E'\n' ||
    '       WHERE c.transaction_id=txid_current()' || E'\n' ||
    '         AND c.actor_id=v_user_id' || E'\n' ||
    '         AND c.context_type=''REJECT_RECEIPT''' || E'\n' ||
    '         AND st.status=''IN_TRANSIT''' || E'\n' ||
    '         AND NEW.warehouse_id=st.source_warehouse_id' || E'\n' ||
    '         AND NEW.reference_no=st.reference_no||''-REJECT-RETURN''' || E'\n' ||
    '         AND public.current_user_can_access_warehouse(st.destination_warehouse_id)' || E'\n' ||
    '         AND public.authorize_action(''action:stock_transfer:reject_receipt'',''stock_transfer'',st.id,st.destination_warehouse_id,' || E'\n' ||
    '           jsonb_build_object(''status'',st.status,''source_warehouse_id'',st.source_warehouse_id,''destination_warehouse_id'',st.destination_warehouse_id),true)' || E'\n' ||
    '     ) THEN' || E'\n' ||
    '    RETURN NEW;' || E'\n' ||
    '  END IF;';
BEGIN
  SELECT pg_get_functiondef(
    'public.guard_transaction_status_change()'::regprocedure
  ) INTO v_definition;

  IF position('REJECT_RECEIPT_CONTEXT_APPROVAL' IN v_definition)=0 THEN
    IF position(v_anchor IN v_definition)=0 THEN
      RAISE EXCEPTION 'Transaction status guard early insertion anchor not found';
    END IF;
    v_updated:=replace(v_definition,v_anchor,v_anchor||E'\n'||v_rejection_context);
    IF v_updated=v_definition THEN
      RAISE EXCEPTION 'Transaction status guard rejection context patch made no change';
    END IF;
    EXECUTE v_updated;
  END IF;
END;
$status_guard_patch$;

DO $verify$
DECLARE
  v_reject_definition text;
  v_guard_definition text;
BEGIN
  SELECT pg_get_functiondef('public.reject_stock_transfer_receipt(uuid,text)'::regprocedure)
    INTO v_reject_definition;
  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure)
    INTO v_guard_definition;

  IF position('PENDING_APPROVAL' IN v_reject_definition)=0
     OR position('Rejected transfer return voucher could not be posted' IN v_reject_definition)=0
     OR position('REJECT_RECEIPT' IN v_guard_definition)=0
     OR position('action:stock_transfer:reject_receipt' IN v_guard_definition)=0
     OR position('st.status=''IN_TRANSIT''' IN v_guard_definition)=0 THEN
    RAISE EXCEPTION 'Transfer rejection immutable-voucher posting verification failed';
  END IF;
END;
$verify$;
