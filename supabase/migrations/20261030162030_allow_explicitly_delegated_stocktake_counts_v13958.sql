DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.save_stocktake_count_v3_internal(uuid,numeric,text,numeric,boolean)'::regprocedure) INTO d;
 n:=replace(d,
  '  v_can_manage := public.authorize_action(''action:stocktake:manage'',''stocktake_session'',v_session.id,v_session.warehouse_id,jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline),true);' || E'\n' ||
  '  IF v_session.created_by = v_user_id THEN' || E'\n' ||
  '    v_can_count := public.authorize_action(''action:stocktake:count'',''stocktake_session'',v_session.id,v_session.warehouse_id,jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline),true);' || E'\n' ||
  '    IF NOT v_can_count AND NOT v_can_manage THEN RAISE EXCEPTION ''Count permission required'' USING ERRCODE=''42501''; END IF;' || E'\n' ||
  '  ELSIF NOT v_can_manage THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Only the creator or a user with stocktake manage permission may count this session'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;',
  '  v_can_manage := public.authorize_action(''action:stocktake:manage'',''stocktake_session'',v_session.id,v_session.warehouse_id,jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline),true);' || E'\n' ||
  '  v_can_count := public.authorize_action(''action:stocktake:count'',''stocktake_session'',v_session.id,v_session.warehouse_id,jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status,''offline'',p_offline),true);' || E'\n' ||
  '  IF NOT v_can_count AND NOT v_can_manage THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Count permission required'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;');
 IF n=d THEN RAISE EXCEPTION 'stocktake creator-only count authorization block not found'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.save_offline_stocktake_count(uuid,numeric,text,numeric)'::regprocedure) INTO d;
 n:=regexp_replace(d,
  E'\\s*IF v_session.created_by IS DISTINCT FROM v_user_id THEN\\s*RAISE EXCEPTION ''Offline stocktake count must remain bound to the session creator''\\s*USING ERRCODE=''42501'';\\s*END IF;',
  '', 'g');
 IF n=d THEN RAISE EXCEPTION 'offline stocktake creator-only wrapper check not found'; END IF;
 EXECUTE n;
END;
$migration$;
