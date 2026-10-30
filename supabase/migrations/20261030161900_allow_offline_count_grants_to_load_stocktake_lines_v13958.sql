DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.list_stocktake_lines_secure()'::regprocedure) INTO d;
 n:=replace(d,
  '        OR public.authorize_action(''action:stocktake:count'',''stocktake_session'',s.id,s.warehouse_id,' || E'\n' ||
  '          jsonb_build_object(''owner_id'',s.created_by,''status'',s.status,''review_status'',s.review_status),false)' || E'\n' ||
  '        OR public.authorize_action(''action:stocktake:submit''',
  '        OR public.authorize_action(''action:stocktake:count'',''stocktake_session'',s.id,s.warehouse_id,' || E'\n' ||
  '          jsonb_build_object(''owner_id'',s.created_by,''status'',s.status,''review_status'',s.review_status),false)' || E'\n' ||
  '        OR public.authorize_action(''action:stocktake:count'',''stocktake_session'',s.id,s.warehouse_id,' || E'\n' ||
  '          jsonb_build_object(''owner_id'',s.created_by,''status'',s.status,''review_status'',s.review_status,''offline'',true),false)' || E'\n' ||
  '        OR public.authorize_action(''action:stocktake:submit''');
 IF n=d THEN RAISE EXCEPTION 'stocktake offline-count visibility branch not found'; END IF;
 EXECUTE n;
END;
$migration$;
