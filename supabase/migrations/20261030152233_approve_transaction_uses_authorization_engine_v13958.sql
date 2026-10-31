DO $migration$
DECLARE d text; n text; p1 integer; p2 integer;
BEGIN
 SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure) INTO d;
 n := replace(d, '  v_actor_role text;' || E'\n', '');
 IF n=d THEN RAISE EXCEPTION 'approve_transaction actor role declaration not found'; END IF;
 d := n;
 n := replace(d, '  v_actor_permissions text[];' || E'\n', '');
 IF n=d THEN RAISE EXCEPTION 'approve_transaction actor permissions declaration not found'; END IF;
 d := n;
 n := replace(d,
   '  SELECT p.role, p.status, COALESCE(p.custom_permissions, ARRAY[]::text[]),' || E'\n' ||
   '         COALESCE(p.can_approve_without_workflow, false)' || E'\n' ||
   '    INTO v_actor_role, v_actor_status, v_actor_permissions, v_can_auto_approve',
   '  SELECT p.status, COALESCE(p.can_approve_without_workflow, false)' || E'\n' ||
   '    INTO v_actor_status, v_can_auto_approve');
 IF n=d THEN RAISE EXCEPTION 'approve_transaction profile authorization load not found'; END IF;
 d := n;
 p1 := position('SELECT EXISTS (' in d);
 p2 := position('v_has_approve_permission :=' in d);
 IF p1=0 OR p2=0 OR p2<=p1 THEN RAISE EXCEPTION 'approve_transaction create permission block boundaries not found'; END IF;
 n := left(d,p1-1) ||
   '  v_has_create_permission := public.current_user_has_permission(CASE v_tx_rec.transaction_type' || E'\n' ||
   '    WHEN ''GRN'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '    WHEN ''ISSUE'' THEN ''action:transaction:issue:create''' || E'\n' ||
   '    WHEN ''RETURN_TO_SUPPLIER'' THEN ''action:transaction:issue:create''' || E'\n' ||
   '    WHEN ''RETURN_FROM_CUSTOMER'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '    WHEN ''ADJUSTMENT_IN'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '    WHEN ''ADJUSTMENT_OUT'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '    WHEN ''OPENING_BALANCE'' THEN ''action:transaction:adjustment:create''' || E'\n' ||
   '    WHEN ''RETURN_FROM_USAGE'' THEN ''action:transaction:grn:create''' || E'\n' ||
   '    ELSE ''action:transaction:never''' || E'\n' ||
   '  END);' || E'\n\n  ' ||
   substr(d,p2);
 EXECUTE n;
END;
$migration$;
