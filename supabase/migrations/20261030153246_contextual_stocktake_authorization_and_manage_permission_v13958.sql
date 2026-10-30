INSERT INTO public.permissions(key,description)
VALUES ('action:stocktake:manage','Manage stocktake sessions created by other users within assigned warehouse scope')
ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description;

DO $migration$
DECLARE d text; n text;
BEGIN
  SELECT pg_get_functiondef('public.populate_stocktake_session_lines(uuid)'::regprocedure) INTO d;
  n := replace(d,'  v_count integer;' || E'\n','  v_count integer;' || E'\n' || '  v_can_manage boolean;' || E'\n');
  IF n=d THEN RAISE EXCEPTION 'populate stocktake declaration not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You do not have permission to populate stocktake sessions'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n\n','');
  IF n=d THEN RAISE EXCEPTION 'populate stocktake early start check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF v_session.created_by IS DISTINCT FROM v_user_id' || E'\n' ||
    '     AND NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the stocktake creator or a manager may populate this session''' || E'\n' ||
    '      USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n','');
  IF n=d THEN RAISE EXCEPTION 'populate stocktake legacy manager check not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You cannot populate a session outside your assigned warehouses'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You cannot populate a session outside your assigned warehouses'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  v_can_manage := public.authorize_action(''action:stocktake:manage'',''stocktake_session'',p_session_id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true);' || E'\n' ||
    '  IF v_session.created_by = v_user_id THEN' || E'\n' ||
    '    IF NOT public.authorize_action(''action:stocktake:start'',''stocktake_session'',p_session_id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true) THEN' || E'\n' ||
    '      RAISE EXCEPTION ''You do not have permission to populate this session'' USING ERRCODE=''42501'';' || E'\n' ||
    '    END IF;' || E'\n' ||
    '  ELSIF NOT v_can_manage THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the creator or a user with stocktake manage permission may populate this session'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'populate stocktake contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.save_stocktake_count(uuid,numeric)'::regprocedure) INTO d;
  n := replace(d,'  v_session public.stocktake_sessions%ROWTYPE;' || E'\n',
                 '  v_session public.stocktake_sessions%ROWTYPE;' || E'\n' ||
                 '  v_can_count boolean;' || E'\n' || '  v_can_manage boolean;' || E'\n');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count declarations not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:count'')' || E'\n' ||
    '     AND NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Count permission required'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n\n','');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count early permission block not found'; END IF;
  d := n;
  n := replace(d,
    '  -- SECURITY DEFINER bypasses table RLS, so explicitly enforce the same owner/manager rule.' || E'\n' ||
    '  IF v_session.created_by IS DISTINCT FROM v_user' || E'\n' ||
    '     AND NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the stocktake creator or a manager may count this session''' || E'\n' ||
    '      USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n\n','');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count legacy owner/manager block not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  v_can_manage := public.authorize_action(''action:stocktake:manage'',''stocktake_session'',v_session.id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true);' || E'\n' ||
    '  IF v_session.created_by = v_user THEN' || E'\n' ||
    '    v_can_count := public.authorize_action(''action:stocktake:count'',''stocktake_session'',v_session.id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true)' || E'\n' ||
    '      OR public.authorize_action(''action:stocktake:start'',''stocktake_session'',v_session.id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true);' || E'\n' ||
    '    IF NOT v_can_count AND NOT v_can_manage THEN RAISE EXCEPTION ''Count permission required'' USING ERRCODE=''42501''; END IF;' || E'\n' ||
    '  ELSIF NOT v_can_manage THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the creator or a user with stocktake manage permission may count this session'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.save_stocktake_count_v3(uuid,numeric,text,numeric)'::regprocedure) INTO d;
  n := replace(d,'  v_user_id uuid := auth.uid();' || E'\n',
                 '  v_user_id uuid := auth.uid();' || E'\n' ||
                 '  v_can_count boolean;' || E'\n' || '  v_can_manage boolean;' || E'\n');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count_v3 declarations not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:count'')' || E'\n' ||
    '     AND NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Count permission required'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n\n','');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count_v3 early permission block not found'; END IF;
  d := n;
  n := replace(d,
    '  IF v_session.created_by IS DISTINCT FROM v_user_id' || E'\n' ||
    '     AND NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the stocktake creator or a manager may count this session''' || E'\n' ||
    '      USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n\n','');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count_v3 legacy owner/manager block not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_session.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  v_can_manage := public.authorize_action(''action:stocktake:manage'',''stocktake_session'',v_session.id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true);' || E'\n' ||
    '  IF v_session.created_by = v_user_id THEN' || E'\n' ||
    '    v_can_count := public.authorize_action(''action:stocktake:count'',''stocktake_session'',v_session.id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true)' || E'\n' ||
    '      OR public.authorize_action(''action:stocktake:start'',''stocktake_session'',v_session.id,v_session.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_session.created_by,''status'',v_session.status,''review_status'',v_session.review_status),true);' || E'\n' ||
    '    IF NOT v_can_count AND NOT v_can_manage THEN RAISE EXCEPTION ''Count permission required'' USING ERRCODE=''42501''; END IF;' || E'\n' ||
    '  ELSIF NOT v_can_manage THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the creator or a user with stocktake manage permission may count this session'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count_v3 contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.submit_stocktake_for_review(uuid)'::regprocedure) INTO d;
  n := replace(d,'  v_counted integer;' || E'\n','  v_counted integer;' || E'\n' || '  v_can_submit boolean;' || E'\n' || '  v_can_manage boolean;' || E'\n');
  IF n=d THEN RAISE EXCEPTION 'submit_stocktake_for_review declarations not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:submit'')' || E'\n' ||
    '     AND NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Submit permission required'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n\n','');
  IF n=d THEN RAISE EXCEPTION 'submit stocktake early permission block not found'; END IF;
  d := n;
  n := replace(d,
    '  IF v_s.created_by IS DISTINCT FROM v_user' || E'\n' ||
    '     AND NOT public.current_user_has_permission(''action:stocktake:start'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the stocktake creator or a manager may submit this session''' || E'\n' ||
    '      USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n','');
  IF n=d THEN RAISE EXCEPTION 'submit stocktake legacy owner/manager block not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Warehouse not assigned'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  v_can_manage := public.authorize_action(''action:stocktake:manage'',''stocktake_session'',p_session_id,v_s.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_s.created_by,''status'',v_s.status,''review_status'',v_s.review_status),true);' || E'\n' ||
    '  IF v_s.created_by = v_user THEN' || E'\n' ||
    '    v_can_submit := public.authorize_action(''action:stocktake:submit'',''stocktake_session'',p_session_id,v_s.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_s.created_by,''status'',v_s.status,''review_status'',v_s.review_status),true)' || E'\n' ||
    '      OR public.authorize_action(''action:stocktake:start'',''stocktake_session'',p_session_id,v_s.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_s.created_by,''status'',v_s.status,''review_status'',v_s.review_status),true);' || E'\n' ||
    '    IF NOT v_can_submit AND NOT v_can_manage THEN RAISE EXCEPTION ''Submit permission required'' USING ERRCODE=''42501''; END IF;' || E'\n' ||
    '  ELSIF NOT v_can_manage THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Only the creator or a user with stocktake manage permission may submit this session'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'submit stocktake contextual authorization insertion failed'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.review_stocktake_session(uuid,boolean,text)'::regprocedure) INTO d;
  n := replace(d,
    '  IF NOT public.current_user_has_permission(''action:stocktake:approve'') THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Approval permission required'';' || E'\n' ||
    '  END IF;' || E'\n\n','');
  IF n=d THEN RAISE EXCEPTION 'review stocktake early permission block not found'; END IF;
  d := n;
  n := replace(d,
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You cannot review a stocktake outside your assigned warehouses'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;',
    '  IF NOT public.current_user_can_access_warehouse(v_s.warehouse_id) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''You cannot review a stocktake outside your assigned warehouses'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;' || E'\n' ||
    '  IF NOT public.authorize_action(''action:stocktake:approve'',''stocktake_session'',p_session_id,v_s.warehouse_id,' ||
    'jsonb_build_object(''owner_id'',v_s.created_by,''submitted_by'',v_s.submitted_by,''status'',v_s.status,''review_status'',v_s.review_status),true) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Approval permission required for this stocktake session'' USING ERRCODE=''42501'';' || E'\n' ||
    '  END IF;');
  IF n=d THEN RAISE EXCEPTION 'review stocktake contextual authorization insertion failed'; END IF;
  EXECUTE n;
END;
$migration$;
