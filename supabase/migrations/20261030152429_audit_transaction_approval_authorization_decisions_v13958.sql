DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure) INTO d;
 n := regexp_replace(d,
   'v_has_create_permission := public\.current_user_has_permission\(CASE v_tx_rec\.transaction_type.*?END\);',
   'v_has_create_permission := public.authorize_action(CASE v_tx_rec.transaction_type' || E'\n' ||
   '    WHEN ''GRN'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '    WHEN ''ISSUE'' THEN ''action:transaction:issue:create''' || E'\n' ||
   '    WHEN ''RETURN_TO_SUPPLIER'' THEN ''action:transaction:issue:create''' || E'\n' ||
   '    WHEN ''RETURN_FROM_CUSTOMER'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '    WHEN ''ADJUSTMENT_IN'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '    WHEN ''ADJUSTMENT_OUT'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '    WHEN ''OPENING_BALANCE'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '    WHEN ''RETURN_FROM_USAGE'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '    ELSE ''action:transaction:never''' || E'\n' ||
   '  END, ''transaction'', p_transaction_id, v_tx_rec.warehouse_id,' || E'\n' ||
   '  jsonb_build_object(''owner_id'',v_tx_rec.created_by,''status'',v_tx_rec.status,''transaction_type'',v_tx_rec.transaction_type), true);',
   'gs');
 IF n=d THEN RAISE EXCEPTION 'approve_transaction create decision logging replacement failed'; END IF;
 d := n;
 n := replace(d,
   'v_has_approve_permission := public.current_user_has_permission(''action:transaction:approve'');',
   'v_has_approve_permission := public.authorize_action(''action:transaction:approve'',''transaction'',p_transaction_id,v_tx_rec.warehouse_id,jsonb_build_object(''owner_id'',v_tx_rec.created_by,''status'',v_tx_rec.status,''transaction_type'',v_tx_rec.transaction_type),true);');
 IF n=d THEN RAISE EXCEPTION 'approve_transaction approval decision logging replacement failed'; END IF;
 d := n;
 n := replace(d,
   'v_has_auto_permission := public.current_user_has_permission(''action:transaction:auto_approve'');',
   'v_has_auto_permission := public.authorize_action(''action:transaction:auto_approve'',''transaction'',p_transaction_id,v_tx_rec.warehouse_id,jsonb_build_object(''owner_id'',v_tx_rec.created_by,''status'',v_tx_rec.status,''transaction_type'',v_tx_rec.transaction_type),true);');
 IF n=d THEN RAISE EXCEPTION 'approve_transaction auto decision logging replacement failed'; END IF;
 EXECUTE n;
END;
$migration$;
