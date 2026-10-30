-- Remove legacy role-name bypasses from transaction rejection, opening balances,
-- stocktake visibility and warehouse creation. Explicit grants are authoritative.
DO $migration$
DECLARE d text; n text;
BEGIN
  SELECT pg_get_functiondef('public.reject_transaction(uuid,text)'::regprocedure) INTO d;
  n := regexp_replace(d,
    'IF NOT public\.current_user_has_permission\(''action:transaction:reject''\)\s+AND v_profile\.role NOT IN \(''SUPER_ADMIN'',''ADMIN'',''MANAGER''\) THEN',
    'IF NOT public.current_user_has_permission(''action:transaction:reject'') THEN','g');
  IF n = d THEN RAISE EXCEPTION 'reject_transaction authorization pattern not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.current_user_can_create_warehouse()'::regprocedure) INTO d;
  n := replace(d, '      AND p.role IN (''SUPER_ADMIN'',''ADMIN'')' || E'\n', '');
  IF n = d THEN RAISE EXCEPTION 'current_user_can_create_warehouse role bypass pattern not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.create_opening_balance_vouchers(jsonb)'::regprocedure) INTO d;
  n := regexp_replace(d,
    '  IF v_profile\.role NOT IN \(''SUPER_ADMIN'',''MANAGER''\) THEN\s+RAISE EXCEPTION ''Only a manager or super administrator may create opening balances'';\s+END IF;\s+',
    '', 'g');
  IF n = d THEN RAISE EXCEPTION 'create_opening_balance_vouchers role bypass pattern not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.create_transaction_with_lines(uuid,jsonb,jsonb)'::regprocedure) INTO d;
  n := regexp_replace(d,
    '  -- Opening balances are privileged initial accounting entries, not ordinary adjustments\.\s+IF v_type = ''OPENING_BALANCE'' AND v_role NOT IN \(''SUPER_ADMIN'', ''MANAGER''\) THEN\s+RAISE EXCEPTION ''Only a manager or super administrator may create an opening balance'';\s+END IF;\s+',
    '', 'g');
  IF n = d THEN RAISE EXCEPTION 'create_transaction_with_lines role bypass pattern not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.list_stocktake_lines_secure()'::regprocedure) INTO d;
  n := regexp_replace(d,
    '  v_can_view :=\s+v_role IN \(''SUPER_ADMIN'',''ADMIN'',''MANAGER''\)\s+OR v_custom && ARRAY\[.*?\]::text\[\]\s+OR EXISTS \(\s+SELECT 1 FROM public\.role_permissions rp\s+WHERE rp\.role_name=v_role\s+AND rp\.permission_key IN \(.*?\)\s+\);',
    '  v_can_view := public.current_user_has_permission(''page:stocktake:access'')' || E'\n' ||
    '    OR public.current_user_has_permission(''table:stocktake:view'')' || E'\n' ||
    '    OR public.current_user_has_permission(''action:stocktake:start'')' || E'\n' ||
    '    OR public.current_user_has_permission(''action:stocktake:count'')' || E'\n' ||
    '    OR public.current_user_has_permission(''action:stocktake:submit'')' || E'\n' ||
    '    OR public.current_user_has_permission(''action:stocktake:approve'')' || E'\n' ||
    '    OR public.current_user_has_permission(''action:stocktake:settle'')' || E'\n' ||
    '    OR public.current_user_has_permission(''action:stocktake:close'');',
    'gs');
  IF n = d THEN RAISE EXCEPTION 'list_stocktake_lines_secure view permission pattern not found'; END IF;
  d := n;
  n := regexp_replace(d,
    '  v_can_view_system :=\s+v_role IN \(''SUPER_ADMIN'',''ADMIN'',''MANAGER''\)\s+OR v_custom @> ARRAY\[''action:stocktake:view_system_qty''\]::text\[\]\s+OR EXISTS \(\s+SELECT 1 FROM public\.role_permissions rp\s+WHERE rp\.role_name=v_role AND rp\.permission_key=''action:stocktake:view_system_qty''\s+\);',
    '  v_can_view_system := public.current_user_has_permission(''action:stocktake:view_system_qty'');',
    'gs');
  IF n = d THEN RAISE EXCEPTION 'list_stocktake_lines_secure system quantity permission pattern not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure) INTO d;
  n := regexp_replace(d,
    '  -- Apply the same guard at posting time, so an already-created request cannot bypass it\.\s+IF v_tx_rec\.transaction_type = ''OPENING_BALANCE''\s+AND v_actor_role NOT IN \(''SUPER_ADMIN'', ''MANAGER''\) THEN\s+RAISE EXCEPTION ''Only a manager or super administrator may approve an opening balance'';\s+END IF;\s+',
    '', 'g');
  IF n = d THEN RAISE EXCEPTION 'approve_transaction opening-balance role pattern not found'; END IF;
  d := n;
  n := regexp_replace(d,
    'IF \(\(NOT v_require_approval\)\s+AND v_actor_role IN \(''SUPER_ADMIN'', ''MANAGER'', ''ADMIN''\)\)\s+OR \(v_can_auto_approve AND v_has_auto_permission AND v_has_create_permission\) THEN',
    'IF v_can_auto_approve AND v_has_auto_permission AND v_has_create_permission THEN','g');
  IF n = d THEN RAISE EXCEPTION 'approve_transaction self approval bypass pattern not found'; END IF;
  d := n;
  n := regexp_replace(d,
    'ELSIF v_actor_role IN \(''SUPER_ADMIN'', ''MANAGER'', ''ADMIN''\) THEN\s+NULL; -- elevated approver, but not self-approval\s+ELSIF v_has_approve_permission THEN',
    'ELSIF v_has_approve_permission THEN','g');
  IF n = d THEN RAISE EXCEPTION 'approve_transaction elevated approver bypass pattern not found'; END IF;
  d := n;
  n := regexp_replace(d,
    'SELECT EXISTS \(\s+SELECT 1 FROM public\.role_permissions rp\s+WHERE rp\.role_name = v_actor_role\s+AND rp\.permission_key = ''action:transaction:approve''\s+\) OR v_actor_permissions @> ARRAY\[''action:transaction:approve''\]::text\[\]\s+INTO v_has_approve_permission;',
    'v_has_approve_permission := public.current_user_has_permission(''action:transaction:approve'');','g');
  IF n = d THEN RAISE EXCEPTION 'approve_transaction explicit approval grant block not found'; END IF;
  d := n;
  n := regexp_replace(d,
    'SELECT EXISTS \(\s+SELECT 1 FROM public\.role_permissions rp\s+WHERE rp\.role_name = v_actor_role\s+AND rp\.permission_key = ''action:transaction:auto_approve''\s+\) OR v_actor_permissions @> ARRAY\[''action:transaction:auto_approve''\]::text\[\]\s+INTO v_has_auto_permission;',
    'v_has_auto_permission := public.current_user_has_permission(''action:transaction:auto_approve'');','g');
  IF n = d THEN RAISE EXCEPTION 'approve_transaction auto approval grant block not found'; END IF;
  EXECUTE n;
END;
$migration$;
