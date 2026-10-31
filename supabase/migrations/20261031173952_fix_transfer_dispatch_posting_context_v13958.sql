-- Route both sides of a transfer dispatch through the immutable-voucher
-- lifecycle. Only the internal v3 -> v2 -> line-writer path can create the
-- transaction-local dispatch context; status posting rechecks the exact
-- order, warehouse and contextual authorization before approval.

ALTER TABLE public.wms_transfer_scope_context
  ADD COLUMN IF NOT EXISTS order_id uuid;
ALTER TABLE public.wms_transfer_scope_context
  ADD COLUMN IF NOT EXISTS source_warehouse_id uuid;
ALTER TABLE public.wms_transfer_scope_context
  ADD COLUMN IF NOT EXISTS destination_warehouse_id uuid;
ALTER TABLE public.wms_transfer_scope_context
  ADD COLUMN IF NOT EXISTS reference_no text;
ALTER TABLE public.wms_transfer_scope_context
  ALTER COLUMN transfer_id DROP NOT NULL;

ALTER TABLE public.wms_transfer_scope_context
  DROP CONSTRAINT IF EXISTS wms_transfer_scope_context_context_type_check;
ALTER TABLE public.wms_transfer_scope_context
  ADD CONSTRAINT wms_transfer_scope_context_context_type_check
  CHECK (context_type = ANY (ARRAY[
    'REJECT_RECEIPT'::text,
    'FINALIZE_SOURCE'::text,
    'RECEIVE_RECEIPT'::text,
    'DISPATCH_ORDER'::text
  ]));

ALTER TABLE public.wms_transfer_scope_context
  DROP CONSTRAINT IF EXISTS wms_transfer_scope_context_payload_check;
ALTER TABLE public.wms_transfer_scope_context
  ADD CONSTRAINT wms_transfer_scope_context_payload_check
  CHECK (
    (context_type='DISPATCH_ORDER'
      AND transfer_id IS NULL
      AND order_id IS NOT NULL
      AND source_warehouse_id IS NOT NULL
      AND destination_warehouse_id IS NOT NULL
      AND NULLIF(btrim(reference_no),'') IS NOT NULL)
    OR
    (context_type<>'DISPATCH_ORDER' AND transfer_id IS NOT NULL)
  );

DO $line_patch$
DECLARE
  d text;
  n text;
  decl_old text := '  v_src_tx uuid; v_dst_tx uuid; v_status text; v_src_area uuid; v_dst_area uuid; v_lock_key text;' || E'\n' || 'BEGIN';
  decl_new text := '  v_src_tx uuid; v_dst_tx uuid; v_status text; v_src_area uuid; v_dst_area uuid; v_lock_key text;' || E'\n' ||
    '  v_context_order_id uuid;' || E'\n' || 'BEGIN';
  permission_old text := '  IF NOT public.current_user_has_permission(''action:stock_transfer:create'') THEN RAISE EXCEPTION ''Permission denied to create stock transfers'' USING ERRCODE=''42501''; END IF;';
  permission_new text := '  IF NOT EXISTS (SELECT 1 FROM public.wms_transfer_scope_context c' || E'\n' ||
    '    WHERE c.transaction_id=txid_current() AND c.actor_id=v_user AND c.context_type=''DISPATCH_ORDER'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''A validated transfer-dispatch context is required'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;';
  source_shelf_old text := '  SELECT * INTO v_src FROM public.shelves WHERE id=p_source_shelf_id;' || E'\n' ||
    '  IF NOT FOUND THEN RAISE EXCEPTION ''Source shelf not found''; END IF;';
  source_shelf_new text := source_shelf_old || E'\n' ||
    '  SELECT c.order_id INTO v_context_order_id' || E'\n' ||
    '  FROM public.wms_transfer_scope_context c' || E'\n' ||
    '  WHERE c.transaction_id=txid_current() AND c.actor_id=v_user' || E'\n' ||
    '    AND c.context_type=''DISPATCH_ORDER''' || E'\n' ||
    '    AND c.source_warehouse_id=v_src.warehouse_id' || E'\n' ||
    '    AND c.destination_warehouse_id=p_destination_warehouse_id;' || E'\n' ||
    '  IF NOT FOUND THEN RAISE EXCEPTION ''Transfer dispatch context does not match the selected warehouses'' USING ERRCODE=''42501''; END IF;';
  existing_old text := '  IF FOUND THEN' || E'\n' ||
    '    IF v_existing.created_by IS DISTINCT FROM v_user';
  existing_new text := '  IF FOUND THEN' || E'\n' ||
    '    IF v_existing.transfer_order_id IS DISTINCT FROM v_context_order_id THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Idempotency conflict: transfer ID already belongs to another order'' USING ERRCODE=''23505'';' || E'\n' ||
    '    END IF;' || E'\n' ||
    '    IF v_existing.created_by IS DISTINCT FROM v_user';
  source_header_old text := 'VALUES(v_src_tx,btrim(p_reference_no)||''-OUT'',''ADJUSTMENT_OUT'',''APPROVED'',';
  source_header_new text := 'VALUES(v_src_tx,btrim(p_reference_no)||''-OUT'',''ADJUSTMENT_OUT'',''PENDING_APPROVAL'',';
  source_line text := '  INSERT INTO public.transaction_lines(transaction_id,item_id,shelf_id,quantity,balance_before,balance_after,batch_no,expiry_date,storage_area_id,notes)' || E'\n' ||
    '  VALUES(v_src_tx,p_item_id,p_source_shelf_id,p_quantity,v_src_qty,v_src_after,v_batch,v_effective_expiry,v_src_area,''Transfer=''||p_transfer_id::text||''; direction=OUT'');';
  source_line_posted text := source_line || E'\n' ||
    '  UPDATE public.transactions SET status=''APPROVED'' WHERE id=v_src_tx AND status=''PENDING_APPROVAL'';' || E'\n' ||
    '  IF NOT FOUND THEN RAISE EXCEPTION ''Transfer source voucher could not be posted''; END IF;';
  destination_header_old text := 'VALUES(v_dst_tx,btrim(p_reference_no)||''-IN'',''ADJUSTMENT_IN'',''APPROVED'',';
  destination_header_new text := 'VALUES(v_dst_tx,btrim(p_reference_no)||''-IN'',''ADJUSTMENT_IN'',''PENDING_APPROVAL'',';
  destination_line text := '    INSERT INTO public.transaction_lines(transaction_id,item_id,shelf_id,quantity,balance_before,balance_after,batch_no,expiry_date,storage_area_id,notes)' || E'\n' ||
    '    VALUES(v_dst_tx,p_item_id,p_destination_shelf_id,p_quantity,v_dst_qty,v_dst_after,v_batch,v_effective_expiry,v_dst_area,''Transfer=''||p_transfer_id::text||''; direction=IN'');';
  destination_line_posted text := destination_line || E'\n' ||
    '    UPDATE public.transactions SET status=''APPROVED'' WHERE id=v_dst_tx AND status=''PENDING_APPROVAL'';' || E'\n' ||
    '    IF NOT FOUND THEN RAISE EXCEPTION ''Transfer destination voucher could not be posted''; END IF;';
BEGIN
  SELECT pg_get_functiondef(
    'public.dispatch_stock_transfer_order_line(uuid,text,uuid,numeric,text,date,uuid,uuid,text,uuid)'::regprocedure
  ) INTO d;

  IF position(decl_new IN d)=0 THEN
    IF position(decl_old IN d)=0 THEN RAISE EXCEPTION 'Transfer line declaration anchor not found'; END IF;
    d:=replace(d,decl_old,decl_new);
  END IF;
  IF position(permission_new IN d)=0 THEN
    IF position(permission_old IN d)=0 THEN RAISE EXCEPTION 'Transfer line permission anchor not found'; END IF;
    d:=replace(d,permission_old,permission_new);
  END IF;
  IF position(source_shelf_new IN d)=0 THEN
    IF position(source_shelf_old IN d)=0 THEN RAISE EXCEPTION 'Transfer source shelf anchor not found'; END IF;
    d:=replace(d,source_shelf_old,source_shelf_new);
  END IF;
  IF position(existing_new IN d)=0 THEN
    IF position(existing_old IN d)=0 THEN RAISE EXCEPTION 'Transfer line idempotency anchor not found'; END IF;
    d:=replace(d,existing_old,existing_new);
  END IF;
  IF position(source_header_new IN d)=0 THEN
    IF position(source_header_old IN d)=0 THEN RAISE EXCEPTION 'Transfer source header status anchor not found'; END IF;
    d:=replace(d,source_header_old,source_header_new);
  END IF;
  IF position(source_line_posted IN d)=0 THEN
    IF position(source_line IN d)=0 THEN RAISE EXCEPTION 'Transfer source line insert anchor not found'; END IF;
    d:=replace(d,source_line,source_line_posted);
  END IF;
  IF position(destination_header_new IN d)=0 THEN
    IF position(destination_header_old IN d)=0 THEN RAISE EXCEPTION 'Transfer destination header status anchor not found'; END IF;
    d:=replace(d,destination_header_old,destination_header_new);
  END IF;
  IF position(destination_line_posted IN d)=0 THEN
    IF position(destination_line IN d)=0 THEN RAISE EXCEPTION 'Transfer destination line insert anchor not found'; END IF;
    d:=replace(d,destination_line,destination_line_posted);
  END IF;

  EXECUTE d;
END;
$line_patch$;

DO $order_patch$
DECLARE
  d text;
  n text;
  permission_old text := '  IF NOT public.current_user_has_permission(''action:stock_transfer:create'') THEN RAISE EXCEPTION ''Permission denied to create stock transfers''; END IF;';
  permission_new text := '  -- This internal writer repeats the contextual source and destination checks' || E'\n' ||
    '  -- performed by v3; a global permission-only check would reject bounded user grants.' || E'\n' ||
    '  IF NOT public.authorize_action(''action:stock_transfer:create'',''stock_transfer_order'',p_order_id,p_source_warehouse_id,' || E'\n' ||
    '       jsonb_build_object(''owner_id'',v_user,''source_warehouse_id'',p_source_warehouse_id,''destination_warehouse_id'',p_destination_warehouse_id),true)' || E'\n' ||
    '     OR NOT public.authorize_action(''action:stock_transfer:create'',''stock_transfer_order'',p_order_id,p_destination_warehouse_id,' || E'\n' ||
    '       jsonb_build_object(''owner_id'',v_user,''source_warehouse_id'',p_source_warehouse_id,''destination_warehouse_id'',p_destination_warehouse_id),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to dispatch transfer within the selected warehouse scope'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;';
  lines_anchor text := '  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM ''array'' OR jsonb_array_length(p_lines)=0 THEN RAISE EXCEPTION ''At least one transfer line is required''; END IF;';
  lines_new text := lines_anchor || E'\n' || permission_new;
  order_insert text := '  VALUES(p_order_id,btrim(p_reference_no),p_source_warehouse_id,p_destination_warehouse_id,v_operation,''DRAFT'',p_notes,v_user);';
  order_insert_new text := order_insert || E'\n' ||
    '  INSERT INTO public.wms_transfer_scope_context(transaction_id,transfer_id,actor_id,context_type,order_id,source_warehouse_id,destination_warehouse_id,reference_no)' || E'\n' ||
    '  VALUES(txid_current(),NULL,v_user,''DISPATCH_ORDER'',p_order_id,p_source_warehouse_id,p_destination_warehouse_id,btrim(p_reference_no));';
  loop_end text := '  v_status:=CASE WHEN p_source_warehouse_id=p_destination_warehouse_id THEN ''COMPLETED'' ELSE ''IN_TRANSIT'' END;';
  loop_end_new text := '  DELETE FROM public.wms_transfer_scope_context' || E'\n' ||
    '  WHERE transaction_id=txid_current() AND actor_id=v_user AND context_type=''DISPATCH_ORDER'' AND order_id=p_order_id;' || E'\n' ||
    loop_end;
BEGIN
  SELECT pg_get_functiondef(
    'public.dispatch_stock_transfer_order_v2(uuid,text,uuid,uuid,jsonb,text)'::regprocedure
  ) INTO d;

  IF position(permission_new IN d)=0 THEN
    IF position(permission_old IN d)=0 THEN RAISE EXCEPTION 'Transfer order permission anchor not found'; END IF;
    d:=replace(d,permission_old,'');
  END IF;
  IF position(lines_new IN d)=0 THEN
    IF position(lines_anchor IN d)=0 THEN RAISE EXCEPTION 'Transfer order line validation anchor not found'; END IF;
    d:=replace(d,lines_anchor,lines_new);
  END IF;
  IF position(order_insert_new IN d)=0 THEN
    IF position(order_insert IN d)=0 THEN RAISE EXCEPTION 'Transfer order insert anchor not found'; END IF;
    d:=replace(d,order_insert,order_insert_new);
  END IF;
  IF position(loop_end_new IN d)=0 THEN
    IF position(loop_end IN d)=0 THEN RAISE EXCEPTION 'Transfer order loop-end anchor not found'; END IF;
    d:=replace(d,loop_end,loop_end_new);
  END IF;

  EXECUTE d;
END;
$order_patch$;

DO $status_patch$
DECLARE
  d text;
  anchor text := '  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN' || E'\n' ||
    '    RETURN NEW;' || E'\n' ||
    '  END IF;';
  replacement text := anchor || E'\n' ||
    '  -- Dispatch source/destination vouchers are approved only inside the' || E'\n' ||
    '  -- internal order writer after the v3 wrapper authorized both warehouses.' || E'\n' ||
    '  IF OLD.status=''PENDING_APPROVAL'' AND NEW.status=''APPROVED''' || E'\n' ||
    '     AND v_user_id IS NOT NULL AND NEW.created_by=v_user_id' || E'\n' ||
    '     AND NEW.transaction_type IN (''ADJUSTMENT_OUT'',''ADJUSTMENT_IN'')' || E'\n' ||
    '     AND EXISTS (' || E'\n' ||
    '       SELECT 1 FROM public.wms_transfer_scope_context c' || E'\n' ||
    '       WHERE c.transaction_id=txid_current() AND c.actor_id=v_user_id' || E'\n' ||
    '         AND c.context_type=''DISPATCH_ORDER'' AND c.order_id IS NOT NULL' || E'\n' ||
    '         AND left(NEW.reference_no,length(c.reference_no||''-L''))=c.reference_no||''-L''' || E'\n' ||
    '         AND ((NEW.transaction_type=''ADJUSTMENT_OUT'' AND right(NEW.reference_no,4)=''-OUT''' || E'\n' ||
    '               AND NEW.warehouse_id=c.source_warehouse_id)' || E'\n' ||
    '           OR (NEW.transaction_type=''ADJUSTMENT_IN'' AND right(NEW.reference_no,3)=''-IN''' || E'\n' ||
    '               AND NEW.warehouse_id=c.destination_warehouse_id))' || E'\n' ||
    '         AND public.current_user_can_access_warehouse(NEW.warehouse_id)' || E'\n' ||
    '         AND public.authorize_action(''action:stock_transfer:create'',''stock_transfer_order'',c.order_id,NEW.warehouse_id,' || E'\n' ||
    '           jsonb_build_object(''owner_id'',v_user_id,''source_warehouse_id'',c.source_warehouse_id,' || E'\n' ||
    '             ''destination_warehouse_id'',c.destination_warehouse_id),true)' || E'\n' ||
    '     ) THEN' || E'\n' ||
    '    RETURN NEW;' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  -- Existing creator self-approval guard follows this dispatch-only exception.';
BEGIN
  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure) INTO d;
  IF position(replacement IN d)=0 THEN
    IF position(anchor IN d)=0 THEN RAISE EXCEPTION 'Transfer status guard receipt anchor not found'; END IF;
    d:=replace(d,anchor,replacement);
  END IF;
  EXECUTE d;
END;
$status_patch$;


DO $dispatch_wrapper_patch$
DECLARE
  d text;
  n text;
  decl_old text := '  v_source_tx uuid;' || E'\n' || '  v_st_item uuid;';
  decl_new text := '  v_source_tx uuid;' || E'\n' ||
    '  v_destination_tx uuid;' || E'\n' ||
    '  v_st_item uuid;';
  qty_anchor text := '    v_base_qty := v_entered * v_factor;';
  qty_new text := qty_anchor || E'\n' ||
    '    IF NULLIF(v_line->>''transfer_id'','''') IS NULL THEN' || E'\n' ||
    '      RAISE EXCEPTION ''TRANSFER_ID_REQUIRED: each transfer line must carry a stable id for safe retries'' USING ERRCODE=''22023'';' || E'\n' ||
    '    END IF;';
  select_old text := '    SELECT st.source_transaction_id, st.item_id, st.quantity, st.base_unit' || E'\n' ||
    '    INTO v_source_tx, v_st_item, v_st_qty, v_st_base';
  select_new text := '    SELECT st.source_transaction_id, st.destination_transaction_id, st.item_id, st.quantity, st.base_unit' || E'\n' ||
    '    INTO v_source_tx, v_destination_tx, v_st_item, v_st_qty, v_st_base';
  source_end text := '      WHERE tl.transaction_id = v_source_tx' || E'\n' ||
    '        AND tl.item_id = v_st_item' || E'\n' ||
    '        AND (tl.details->>''transfer_id'' IS NULL' || E'\n' ||
    '             OR tl.details->>''transfer_id'' = v_transfer_id::text);' || E'\n' ||
    '    END IF;';
  source_end_new text := '      WHERE tl.transaction_id = v_source_tx' || E'\n' ||
    '        AND tl.item_id = v_st_item' || E'\n' ||
    '        AND (tl.details->>''transfer_id'' IS NULL' || E'\n' ||
    '             OR tl.details->>''transfer_id'' = v_transfer_id::text);' || E'\n' ||
    '    END IF;' || E'\n' ||
    '    IF v_destination_tx IS NOT NULL THEN' || E'\n' ||
    '      UPDATE public.inventory_ledger l' || E'\n' ||
    '      SET metadata = COALESCE(l.metadata, ''{}''::jsonb) || jsonb_build_object(' || E'\n' ||
    '        ''entered_quantity'', (v_line->>''entered_quantity'')::numeric,' || E'\n' ||
    '        ''entered_unit'', v_line->>''entered_unit'',' || E'\n' ||
    '        ''conversion_factor'', (v_line->>''conversion_factor'')::numeric,' || E'\n' ||
    '        ''base_quantity'', v_st_qty,' || E'\n' ||
    '        ''base_unit'', v_st_base' || E'\n' ||
    '      )' || E'\n' ||
    '      WHERE l.source_id = v_destination_tx AND l.item_id = v_st_item' || E'\n' ||
    '        AND (l.metadata->>''transfer_id'' IS NULL OR l.metadata->>''transfer_id'' = v_transfer_id::text);' || E'\n' ||
    '      UPDATE public.transaction_ledger tl' || E'\n' ||
    '      SET details = COALESCE(tl.details, ''{}''::jsonb) || jsonb_build_object(' || E'\n' ||
    '        ''entered_quantity'', (v_line->>''entered_quantity'')::numeric,' || E'\n' ||
    '        ''entered_unit'', v_line->>''entered_unit'',' || E'\n' ||
    '        ''conversion_factor'', (v_line->>''conversion_factor'')::numeric,' || E'\n' ||
    '        ''base_quantity'', v_st_qty,' || E'\n' ||
    '        ''base_unit'', v_st_base' || E'\n' ||
    '      )' || E'\n' ||
    '      WHERE tl.transaction_id = v_destination_tx AND tl.item_id = v_st_item' || E'\n' ||
    '        AND (tl.details->>''transfer_id'' IS NULL OR tl.details->>''transfer_id'' = v_transfer_id::text);' || E'\n' ||
    '    END IF;';
BEGIN
  SELECT pg_get_functiondef(
    'public.dispatch_stock_transfer_order_v3(uuid,text,uuid,uuid,jsonb,text)'::regprocedure
  ) INTO d;

  IF position(decl_new IN d)=0 THEN
    IF position(decl_old IN d)=0 THEN RAISE EXCEPTION 'Dispatch v3 destination transaction declaration anchor not found'; END IF;
    d:=replace(d,decl_old,decl_new);
  END IF;
  IF position(qty_new IN d)=0 THEN
    IF position(qty_anchor IN d)=0 THEN RAISE EXCEPTION 'Dispatch v3 stable transfer id anchor not found'; END IF;
    d:=replace(d,qty_anchor,qty_new);
  END IF;
  IF position(select_new IN d)=0 THEN
    IF position(select_old IN d)=0 THEN RAISE EXCEPTION 'Dispatch v3 destination transaction lookup anchor not found'; END IF;
    d:=replace(d,select_old,select_new);
  END IF;
  IF position('WHERE tl.transaction_id = v_destination_tx' IN d)=0 THEN
    IF position(source_end IN d)=0 THEN RAISE EXCEPTION 'Dispatch v3 destination ledger metadata anchor not found'; END IF;
    d:=replace(d,source_end,source_end_new);
  END IF;

  EXECUTE d;
END;
$dispatch_wrapper_patch$;

DO $verify$
DECLARE
  d text;
BEGIN
  SELECT pg_get_functiondef('public.dispatch_stock_transfer_order_line(uuid,text,uuid,numeric,text,date,uuid,uuid,text,uuid)'::regprocedure) INTO d;
  IF position('PENDING_APPROVAL' IN d)=0
     OR position('Transfer source voucher could not be posted' IN d)=0
     OR position('Transfer destination voucher could not be posted' IN d)=0
     OR position('DISPATCH_ORDER' IN d)=0 THEN
    RAISE EXCEPTION 'Transfer line posting guard verification failed';
  END IF;

  SELECT pg_get_functiondef('public.dispatch_stock_transfer_order_v2(uuid,text,uuid,uuid,jsonb,text)'::regprocedure) INTO d;
  IF position('DISPATCH_ORDER' IN d)=0
     OR position('action:stock_transfer:create' IN d)=0
     OR position('current_user_has_permission(''action:stock_transfer:create'')' IN d)>0 THEN
    RAISE EXCEPTION 'Transfer order contextual authorization verification failed';
  END IF;

  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure) INTO d;
  IF position('DISPATCH_ORDER' IN d)=0
     OR position('stock_transfer_order' IN d)=0 THEN
    RAISE EXCEPTION 'Transfer dispatch status authorization verification failed';
  END IF;

  SELECT pg_get_functiondef(
    'public.dispatch_stock_transfer_order_v3(uuid,text,uuid,uuid,jsonb,text)'::regprocedure
  ) INTO d;
  IF position('TRANSFER_ID_REQUIRED' IN d)=0
     OR position('v_destination_tx' IN d)=0
     OR position('WHERE tl.transaction_id = v_destination_tx' IN d)=0 THEN
    RAISE EXCEPTION 'Transfer dispatch unit snapshot persistence verification failed';
  END IF;
END;
$verify$;
