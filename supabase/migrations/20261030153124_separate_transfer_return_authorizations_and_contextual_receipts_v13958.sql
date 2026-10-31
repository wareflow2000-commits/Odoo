INSERT INTO public.permissions(key,description) VALUES
 ('action:stock_transfer:return:create','Request a return for an inter-warehouse transfer'),
 ('action:stock_transfer:return:review','Review and accept or reject an inter-warehouse return request'),
 ('action:stock_transfer:return:receive','Physically receive an accepted inter-warehouse return')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text,uuid)'::regprocedure) INTO d;
 n := replace(d,
  '  IF NOT (SELECT public.current_user_has_permission(''action:stock_transfer:receive'')) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to receive stock transfers'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;' || E'\n','');
 IF n=d THEN RAISE EXCEPTION 'transfer receipt early permission check not found'; END IF;
 d := n;
 n := replace(d,
  '  IF NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;',
  '  IF NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;' || E'\n' ||
  '  IF NOT public.authorize_action(''action:stock_transfer:receive'',''stock_transfer'',p_transfer_id,v_transfer.destination_warehouse_id,' ||
  'jsonb_build_object(''status'',v_transfer.status,''source_warehouse_id'',v_transfer.source_warehouse_id,''destination_warehouse_id'',v_transfer.destination_warehouse_id),true) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to receive this stock transfer'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;');
 IF n=d THEN RAISE EXCEPTION 'transfer receipt contextual authorization insertion failed'; END IF;
 n := replace(n,
  E'\n  IF NOT public.current_user_can_access_warehouse(v_transfer.destination_warehouse_id) THEN\n    RAISE EXCEPTION ''User is not assigned to the destination warehouse'' USING ERRCODE=''42501'';\n  END IF;\n\n  v_hash :=',
  E'\n  v_hash :=');
 EXECUTE n;

 SELECT pg_get_functiondef('public.review_stock_transfer_return_request(uuid,text,text)'::regprocedure) INTO d;
 n := replace(d,
  'IF NOT public.current_user_has_permission(''action:stock_transfer:receive'') THEN' || E'\n' ||
  '                                                                                                           RAISE EXCEPTION ''Permission denied to review return requests'';' || E'\n' ||
  '                                                                                                             END IF;','');
 IF n=d THEN RAISE EXCEPTION 'return review early permission check not found'; END IF;
 d := n;
 n := replace(d,
  'IF NOT public.current_user_can_access_warehouse(v_t.source_warehouse_id) THEN RAISE EXCEPTION ''User is not assigned to the sending warehouse'' USING ERRCODE=''42501''; END IF;',
  'IF NOT public.current_user_can_access_warehouse(v_t.source_warehouse_id) THEN RAISE EXCEPTION ''User is not assigned to the sending warehouse'' USING ERRCODE=''42501''; END IF;' || E'\n' ||
  'IF NOT public.authorize_action(''action:stock_transfer:return:review'',''stock_transfer'',p_transfer_id,v_t.source_warehouse_id,' ||
  'jsonb_build_object(''status'',v_t.status,''return_review_status'',v_t.return_review_status),true) THEN' || E'\n' ||
  '  RAISE EXCEPTION ''Permission denied to review this return request'' USING ERRCODE=''42501'';' || E'\n' ||
  'END IF;');
 IF n=d THEN RAISE EXCEPTION 'return review contextual authorization insertion failed'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.confirm_stock_transfer_return(uuid)'::regprocedure) INTO d;
 n := replace(d,
  'IF NOT public.current_user_has_permission(''action:stock_transfer:receive'') THEN' || E'\n' ||
  '                                                                                          RAISE EXCEPTION ''Permission denied to confirm returned goods'';' || E'\n' ||
  '                                                                                            END IF;','');
 IF n=d THEN RAISE EXCEPTION 'return receipt early permission check not found'; END IF;
 d := n;
 n := replace(d,
  '  IF NOT public.current_user_can_access_warehouse(v_t.source_warehouse_id) THEN RAISE EXCEPTION ''User is not assigned to the sending warehouse'' USING ERRCODE=''42501''; END IF;',
  '  IF NOT public.current_user_can_access_warehouse(v_t.source_warehouse_id) THEN RAISE EXCEPTION ''User is not assigned to the sending warehouse'' USING ERRCODE=''42501''; END IF;' || E'\n' ||
  '  IF NOT public.authorize_action(''action:stock_transfer:return:receive'',''stock_transfer'',p_transfer_id,v_t.source_warehouse_id,' ||
  'jsonb_build_object(''status'',v_t.status,''return_review_status'',v_t.return_review_status),true) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to receive this returned transfer'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;');
 IF n=d THEN RAISE EXCEPTION 'return receipt contextual authorization insertion failed'; END IF;
 EXECUTE n;
END;
$migration$;
