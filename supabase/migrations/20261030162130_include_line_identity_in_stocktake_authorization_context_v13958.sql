DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.save_stocktake_count_v3_internal(uuid,numeric,text,numeric,boolean)'::regprocedure) INTO d;
 n:=replace(d,
  'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline)',
  'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline,''line_id'',p_line_id,''item_id'',v_line.item_id,''shelf_id'',v_line.shelf_id)');
 IF n=d THEN RAISE EXCEPTION 'stocktake count audit context anchor not found'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.list_stocktake_lines_secure()'::regprocedure) INTO d;
 n:=replace(d,
  'jsonb_build_object(''owner_id'',s.created_by,''status'',s.status,''review_status'',s.review_status)',
  'jsonb_build_object(''owner_id'',s.created_by,''status'',s.status,''review_status'',s.review_status,''line_id'',l.id,''item_id'',l.item_id,''shelf_id'',l.shelf_id)');
 IF n=d THEN RAISE EXCEPTION 'stocktake line read context anchor not found'; END IF;
 EXECUTE n;
END;
$migration$;
