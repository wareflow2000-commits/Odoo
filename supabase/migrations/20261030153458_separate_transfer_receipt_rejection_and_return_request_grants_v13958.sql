INSERT INTO public.permissions(key,description)
VALUES ('action:stock_transfer:reject_receipt','Reject an incoming stock-transfer receipt')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text,uuid)'::regprocedure) INTO d;
 n := replace(d,
  '  IF NOT public.authorize_action(''action:stock_transfer:receive'',''stock_transfer'',p_transfer_id,v_transfer.destination_warehouse_id,' ||
  'jsonb_build_object(''status'',v_transfer.status,''source_warehouse_id'',v_transfer.source_warehouse_id,''destination_warehouse_id'',v_transfer.destination_warehouse_id),true) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to receive this stock transfer'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;',
  '  IF NOT public.authorize_action(''action:stock_transfer:receive'',''stock_transfer'',p_transfer_id,v_transfer.destination_warehouse_id,' ||
  'jsonb_build_object(''status'',v_transfer.status,''source_warehouse_id'',v_transfer.source_warehouse_id,''destination_warehouse_id'',v_transfer.destination_warehouse_id),true) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to receive this stock transfer'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;' || E'\n' ||
  '  IF COALESCE(p_return_remaining,false) AND NOT public.authorize_action(''action:stock_transfer:return:create'',''stock_transfer'',p_transfer_id,v_transfer.destination_warehouse_id,' ||
  'jsonb_build_object(''status'',v_transfer.status,''source_warehouse_id'',v_transfer.source_warehouse_id,''destination_warehouse_id'',v_transfer.destination_warehouse_id),true) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to request return of the remaining transfer quantity'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;');
 IF n=d THEN RAISE EXCEPTION 'transfer return-request permission insertion failed'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.reject_stock_transfer_receipt(uuid,text)'::regprocedure) INTO d;
 n := replace(d,
  ' IF NOT public.current_user_has_permission(''action:stock_transfer:receive'') THEN RAISE EXCEPTION ''Permission denied to reject a transfer receipt''; END IF;' || E'\n','');
 IF n=d THEN RAISE EXCEPTION 'reject receipt early permission check not found'; END IF;
 d := n;
 n := replace(d,
  ' IF NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501''; END IF;',
  ' IF NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501''; END IF;' || E'\n' ||
  ' IF NOT public.authorize_action(''action:stock_transfer:reject_receipt'',''stock_transfer'',p_transfer_id,v_transfer.destination_warehouse_id,' ||
  'jsonb_build_object(''status'',v_transfer.status,''source_warehouse_id'',v_transfer.source_warehouse_id,''destination_warehouse_id'',v_transfer.destination_warehouse_id),true) THEN' || E'\n' ||
  '   RAISE EXCEPTION ''Permission denied to reject this transfer receipt'' USING ERRCODE=''42501'';' || E'\n' ||
  ' END IF;');
 IF n=d THEN RAISE EXCEPTION 'reject receipt contextual authorization insertion failed'; END IF;
 EXECUTE n;
END;
$migration$;
