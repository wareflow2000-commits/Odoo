DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.get_stock_summary_by_storage_area(timestamptz,timestamptz,uuid,uuid,uuid)'::regprocedure) INTO d;
 n := replace(d,
  '  v_role text;' || E'\n' || '  v_status text;' || E'\n' || '  v_assigned uuid[];',
  '  v_status text;' || E'\n' || '  v_report_permission text;');
 IF n=d THEN RAISE EXCEPTION 'report function declarations not found'; END IF;
 d:=n;
 n:=replace(d,
  '  IF NOT (' || E'\n' ||
  '    public.current_user_has_permission(''page:reports:access'')' || E'\n' ||
  '    OR public.current_user_has_permission(''table:reports:view'')' || E'\n' ||
  '  ) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''You do not have permission to view stock summary reports'';' || E'\n' ||
  '  END IF;' || E'\n','');
 IF n=d THEN RAISE EXCEPTION 'report global permission block not found'; END IF;
 d:=n;
 n:=replace(d,
  '  SELECT p.role,p.status,COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[])' || E'\n' ||
  '    INTO v_role,v_status,v_assigned' || E'\n' ||
  '  FROM public.profiles p WHERE p.id=v_user_id;',
  '  SELECT p.status INTO v_status FROM public.profiles p WHERE p.id=v_user_id;');
 IF n=d THEN RAISE EXCEPTION 'report profile select not found'; END IF;
 d:=n;
 n:=replace(d,
  '  ELSIF NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE public.current_user_can_access_warehouse(w.id)) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''No warehouse is accessible to this account'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;',
  '  ELSIF NOT EXISTS (SELECT 1 FROM public.warehouses w WHERE public.current_user_can_access_warehouse(w.id)) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''No warehouse is accessible to this account'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;' || E'\n' ||
  '  IF public.authorize_action(''table:reports:view'',''report_stock_summary'',NULL,p_warehouse_id,' ||
  'jsonb_build_object(''start_date'',p_start_date,''end_date'',p_end_date,''storage_area_id'',p_storage_area_id,''category_id'',p_category_id),false) THEN' || E'\n' ||
  '    v_report_permission := ''table:reports:view'';' || E'\n' ||
  '  ELSIF public.authorize_action(''page:reports:access'',''report_stock_summary'',NULL,p_warehouse_id,' ||
  'jsonb_build_object(''start_date'',p_start_date,''end_date'',p_end_date,''storage_area_id'',p_storage_area_id,''category_id'',p_category_id),false) THEN' || E'\n' ||
  '    v_report_permission := ''page:reports:access'';' || E'\n' ||
  '  ELSE' || E'\n' ||
  '    RAISE EXCEPTION ''You do not have permission to view stock summary reports in this warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
  '  END IF;' || E'\n' ||
  '  PERFORM public.authorize_action(v_report_permission,''report_stock_summary'',NULL,p_warehouse_id,' ||
  'jsonb_build_object(''start_date'',p_start_date,''end_date'',p_end_date,''storage_area_id'',p_storage_area_id,''category_id'',p_category_id),true);');
 IF n=d THEN RAISE EXCEPTION 'report contextual authorization insertion failed'; END IF;
 EXECUTE n;

 CREATE OR REPLACE FUNCTION public.list_stocktake_lines_secure()
 RETURNS TABLE(
  id uuid, session_id uuid, item_id uuid, shelf_id uuid, system_qty numeric,
  counted_qty numeric, variance numeric, is_settled boolean, settled_at timestamptz,
  created_at timestamptz, batch_no text, expiry_date date
 )
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog','public','auth','pg_temp'
 AS $function$
 DECLARE v_user_id uuid := auth.uid();
 BEGIN
  IF v_user_id IS NULL OR NOT public.current_user_is_active() THEN
   RAISE EXCEPTION 'An active authenticated user is required';
  END IF;
  RETURN QUERY
  SELECT l.id,l.session_id,l.item_id,l.shelf_id,
   CASE WHEN public.authorize_action(
    'action:stocktake:view_system_qty','stocktake_session',s.id,s.warehouse_id,
    jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false
   ) THEN l.system_qty ELSE NULL::numeric END,
   l.counted_qty,
   CASE WHEN public.authorize_action(
    'action:stocktake:view_system_qty','stocktake_session',s.id,s.warehouse_id,
    jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false
   ) THEN l.variance ELSE NULL::numeric END,
   l.is_settled,l.settled_at,l.created_at,l.batch_no,l.expiry_date
  FROM public.stocktake_lines l
  JOIN public.stocktake_sessions s ON s.id=l.session_id
  WHERE public.current_user_can_access_warehouse(s.warehouse_id)
   AND (
    public.authorize_action('page:stocktake:access','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('table:stocktake:view','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('action:stocktake:start','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('action:stocktake:count','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('action:stocktake:submit','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('action:stocktake:approve','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('action:stocktake:settle','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('action:stocktake:close','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
    OR public.authorize_action('action:stocktake:manage','stocktake_session',s.id,s.warehouse_id,
     jsonb_build_object('owner_id',s.created_by,'status',s.status,'review_status',s.review_status),false)
   );
 END;
 $function$;

 SELECT pg_get_functiondef('public.next_transaction_reference()'::regprocedure) INTO d;
 n:=replace(d,
  '  IF NOT (' || E'\n' ||
  '    public.current_user_has_permission(''action:transaction:grn:create'')' || E'\n' ||
  '    OR public.current_user_has_permission(''action:transaction:issue:create'')' || E'\n' ||
  '    OR public.current_user_has_permission(''action:transaction:adjustment:create'')' || E'\n' ||
  '    OR public.current_user_has_permission(''action:stock_transfer:create'')' || E'\n' ||
  '  ) THEN' || E'\n' ||
  '    RAISE EXCEPTION ''Permission denied to generate a transaction reference'';' || E'\n' ||
  '  END IF;' || E'\n',
  '  -- Reference allocation is harmless; the create/post RPC enforces action and warehouse authorization.' || E'\n');
 IF n=d THEN RAISE EXCEPTION 'reference generator permission block not found'; END IF;
 EXECUTE n;

 SELECT pg_get_functiondef('public.process_sync_batch_v2_impl(text,jsonb)'::regprocedure) INTO d;
 n:=replace(d,
  'v_permission := ''action:transaction:issue:create'';' || E'\n' ||
  '      IF NOT (SELECT public.current_user_has_permission(v_permission)) THEN' || E'\n' ||
  '        RAISE EXCEPTION ''Permission denied for operation type %'', v_operation_type;' || E'\n' ||
  '      END IF;' || E'\n','');
 IF n=d THEN RAISE EXCEPTION 'offline worker early permission check not found'; END IF;
 d:=n;
 n:=replace(d,
  '                    RAISE EXCEPTION ''Offline ISSUE requires exactly one explicitly assigned and accessible warehouse'' USING ERRCODE = ''42501'';' || E'\n' ||
  '                  END IF;',
  '                    RAISE EXCEPTION ''Offline ISSUE requires exactly one explicitly assigned and accessible warehouse'' USING ERRCODE = ''42501'';' || E'\n' ||
  '                  END IF;' || E'\n' ||
  '                  IF NOT public.authorize_action(''action:transaction:issue:create'',''transaction'',v_transaction_id,v_warehouse_id,' ||
  'jsonb_build_object(''owner_id'',v_user_id,''transaction_type'',''ISSUE'',''offline'',true),true) THEN' || E'\n' ||
  '                    RAISE EXCEPTION ''Permission denied for offline ISSUE in this warehouse'' USING ERRCODE=''42501'';' || E'\n' ||
  '                  END IF;');
 IF n=d THEN RAISE EXCEPTION 'offline worker contextual authorization insertion failed'; END IF;
 EXECUTE n;

 REVOKE ALL ON FUNCTION public.process_sync_batch_v2_impl(text,jsonb) FROM PUBLIC,anon,authenticated;
END;
$migration$;
