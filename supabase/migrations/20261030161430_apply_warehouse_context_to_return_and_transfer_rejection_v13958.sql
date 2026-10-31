DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.create_stock_return_request(uuid,text,text,uuid,numeric,text,date,uuid,text,text,text)'::regprocedure) INTO d;
 n:=replace(d,
  ' IF NOT public.current_user_has_permission(v_permission) THEN RAISE EXCEPTION ''Permission denied for return type %'',v_type; END IF;',
  ' IF NOT public.authorize_action(v_permission,''transaction'',p_return_id,' ||
  '(SELECT sh.warehouse_id FROM public.shelves sh WHERE sh.id=p_shelf_id),' ||
  'jsonb_build_object(''owner_id'',v_user,''transaction_type'',v_type,''return_request'',true),true) THEN ' ||
  'RAISE EXCEPTION ''Permission denied for return type % in this warehouse'',v_type USING ERRCODE=''42501''; END IF;');
 IF n=d THEN RAISE EXCEPTION 'stock return global permission check not found'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.reject_stock_transfer_order(uuid,text)'::regprocedure) INTO d;
 n:=replace(d,
  '  IF NOT public.current_user_has_permission(''action:stock_transfer:receive'') THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to reject a stock transfer receipt'';' || E'\n' ||
  '  END IF;' || E'\n','');
 IF n=d THEN RAISE EXCEPTION 'transfer order global permission check not found'; END IF;
 d:=n;
 n:=replace(d,
  '    v_total := v_total + 1;' || E'\n' ||
  '    IF NOT public.current_user_can_access_warehouse(v_line.destination_warehouse_id) THEN',
  '    v_total := v_total + 1;' || E'\n' ||
  '    IF NOT public.authorize_action(''action:stock_transfer:reject_receipt'',''stock_transfer'',v_line.id,' ||
  'v_line.destination_warehouse_id,jsonb_build_object(''operation'',''reject_receipt'',''status'',v_line.status,' ||
  '''order_id'',p_order_id,''source_warehouse_id'',v_line.source_warehouse_id),false) THEN' || E'\n' ||
  '      RAISE EXCEPTION ''Permission denied to reject this transfer receipt'' USING ERRCODE=''42501'';' || E'\n' ||
  '    END IF;' || E'\n' ||
  '    IF NOT public.current_user_can_access_warehouse(v_line.destination_warehouse_id) THEN');
 IF n=d THEN RAISE EXCEPTION 'transfer order contextual permission insertion failed'; END IF;
 EXECUTE n;
END;
$migration$;
