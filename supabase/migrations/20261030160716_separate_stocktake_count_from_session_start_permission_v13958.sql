DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.save_stocktake_count_v3_internal(uuid,numeric,text,numeric,boolean)'::regprocedure) INTO d;
 n:=replace(d,
  'v_can_count := public.authorize_action(''action:stocktake:count'',''stocktake_session'',v_session.id,v_session.warehouse_id,jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline),true)' || E'\n' ||
  '      OR public.authorize_action(''action:stocktake:start'',''stocktake_session'',v_session.id,v_session.warehouse_id,jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline),true);',
  'v_can_count := public.authorize_action(''action:stocktake:count'',''stocktake_session'',v_session.id,v_session.warehouse_id,jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline),true);');
 IF n=d THEN RAISE EXCEPTION 'stocktake count/start fallback not found'; END IF;
 EXECUTE n;
END;
$migration$;
