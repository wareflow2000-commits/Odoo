DO $migration$
DECLARE d text; n text;
BEGIN
  SELECT pg_get_functiondef('public.create_transaction_with_lines(uuid,jsonb,jsonb)'::regprocedure) INTO d;
  n := replace(d,
    '  IF NOT (SELECT public.current_user_has_permission(v_permission)) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to create transaction type %'', v_type;' || E'\n' ||
    '  END IF;' || E'\n\n' ||
    'v_warehouse_id := NULLIF(p_transaction->>''warehouse_id'','''')::uuid;',
    'v_warehouse_id := NULLIF(p_transaction->>''warehouse_id'','''')::uuid;');
  IF n=d THEN RAISE EXCEPTION 'create_transaction_with_lines early permission check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE w.id = v_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not found'';' || E'\n' ||
    '  END IF;',
    '  IF NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE w.id = v_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not found'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(v_permission,''transaction'',p_transaction_id,v_warehouse_id,' ||
    'jsonb_build_object(''owner_id'',auth.uid(),''transaction_type'',v_type),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to create transaction type %'',v_type USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'create_transaction_with_lines contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.create_opening_balance_vouchers(jsonb)'::regprocedure) INTO d;
  n := replace(d,
    'IF NOT public.current_user_has_permission(''action:transaction:adjustment:create'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to create opening balances'';' || E'\n' ||
    '  END IF;' || E'\n',
    '');
  IF n=d THEN RAISE EXCEPTION 'opening balance early permission check not found'; END IF;
  d := n;
  n := replace(d,
    '    IF NOT public.current_user_can_access_warehouse(v_warehouse) THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Opening-balance warehouse is outside the current user scope'' USING ERRCODE=''42501'';' || E'\n' ||
    '    END IF;',
    '    IF NOT public.current_user_can_access_warehouse(v_warehouse) THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Opening-balance warehouse is outside the current user scope'' USING ERRCODE=''42501'';' || E'\n' ||
    '    END IF;' || E'\n' ||
    '    IF NOT public.authorize_action(''action:transaction:adjustment:create'',''transaction'',NULL,v_warehouse,' ||
    'jsonb_build_object(''owner_id'',v_user,''transaction_type'',''OPENING_BALANCE''),true) THEN' || E'\n' ||
    '      RAISE EXCEPTION ''Permission denied for opening balance warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '    END IF;');
  IF n=d THEN RAISE EXCEPTION 'opening balance contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.reject_transaction(uuid,text)'::regprocedure) INTO d;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:transaction:reject'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to reject transactions'';' || E'\n' ||
    '  END IF;' || E'\n',
    '');
  IF n=d THEN RAISE EXCEPTION 'reject_transaction early permission check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_tx.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''User is not assigned to the transaction warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_tx.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''User is not assigned to the transaction warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(''action:transaction:reject'',''transaction'',p_transaction_id,v_tx.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_tx.created_by,''status'',v_tx.status,''transaction_type'',v_tx.transaction_type),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to reject this transaction'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'reject_transaction contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.create_stocktake_session_with_lines(uuid,uuid,text,text,text)'::regprocedure) INTO d;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You do not have permission to start stocktake sessions'';' || E'\n' ||
    '  END IF;' || E'\n',
    '');
  IF n=d THEN RAISE EXCEPTION 'stocktake creation early permission check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(p_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You cannot start a stocktake outside your assigned warehouses'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(p_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You cannot start a stocktake outside your assigned warehouses'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(''action:stocktake:start'',''stocktake_session'',NULL,p_warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_user_id,''stocktake_type'',p_stocktake_type,''count_mode'',p_count_mode),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You do not have permission to start stocktake in this warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'stocktake creation contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.close_stocktake_session_direct(uuid)'::regprocedure) INTO d;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:close'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Close permission required'';' || E'\n' ||
    '  END IF;' || E'\n',
    '');
  IF n=d THEN RAISE EXCEPTION 'stocktake close early permission check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You are not assigned to this stocktake warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You are not assigned to this stocktake warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(''action:stocktake:close'',''stocktake_session'',p_session_id,v_s.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_s.created_by,''status'',v_s.status,''review_status'',v_s.review_status),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Close permission required for this stocktake session'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'stocktake close contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.process_stocktake_settlement_with_direction(uuid,uuid[],text,jsonb)'::regprocedure) INTO d;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:settle'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Settlement permission required'';' || E'\n' ||
    '  END IF;' || E'\n',
    '');
  IF n=d THEN RAISE EXCEPTION 'stocktake settlement early permission check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(''action:stocktake:settle'',''stocktake_session'',p_session_id,v_s.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_s.created_by,''status'',v_s.status,''review_status'',v_s.review_status),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Settlement permission required for this stocktake session'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'stocktake settlement contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.dispatch_stock_transfer_order_v3(uuid,text,uuid,uuid,jsonb,text)'::regprocedure) INTO d;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stock_transfer:create'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to create stock transfers'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n',
    '');
  IF n=d THEN RAISE EXCEPTION 'transfer dispatch early permission check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(p_destination_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(p_destination_warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(''action:stock_transfer:create'',''stock_transfer_order'',p_order_id,p_source_warehouse_id,' ||
    'jsonb_build_object(''owner_id'',auth.uid(),''source_warehouse_id'',p_source_warehouse_id,''destination_warehouse_id'',p_destination_warehouse_id),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to dispatch from the source warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(''action:stock_transfer:create'',''stock_transfer_order'',p_order_id,p_destination_warehouse_id,' ||
    'jsonb_build_object(''owner_id'',auth.uid(),''source_warehouse_id'',p_source_warehouse_id,''destination_warehouse_id'',p_destination_warehouse_id),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Permission denied to dispatch to the destination warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'transfer dispatch contextual authorization insertion failed'; END IF;
  EXECUTE n;
END;
$migration$;
