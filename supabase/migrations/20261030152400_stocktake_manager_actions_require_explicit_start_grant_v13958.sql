DO $migration$
DECLARE d text; n text;
BEGIN
  SELECT pg_get_functiondef('public.populate_stocktake_session_lines(uuid)'::regprocedure) INTO d;
  n := replace(d,'AND NOT public.current_user_is_manager()',
                 'AND NOT public.current_user_has_permission(''action:stocktake:start'')');
  IF n=d THEN RAISE EXCEPTION 'populate_stocktake_session_lines manager check not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.save_stocktake_count(uuid,numeric)'::regprocedure) INTO d;
  n := replace(d,'AND NOT public.current_user_is_manager()',
                 'AND NOT public.current_user_has_permission(''action:stocktake:start'')');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count manager check not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.save_stocktake_count_v3(uuid,numeric,text,numeric)'::regprocedure) INTO d;
  n := replace(d,'AND NOT public.current_user_is_manager()',
                 'AND NOT public.current_user_has_permission(''action:stocktake:start'')');
  IF n=d THEN RAISE EXCEPTION 'save_stocktake_count_v3 manager check not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.submit_stocktake_for_review(uuid)'::regprocedure) INTO d;
  n := replace(d,'AND NOT public.current_user_is_manager()',
                 'AND NOT public.current_user_has_permission(''action:stocktake:start'')');
  IF n=d THEN RAISE EXCEPTION 'submit_stocktake_for_review manager check not found'; END IF;
  EXECUTE n;

  SELECT pg_get_functiondef('public.review_stocktake_session(uuid,boolean,text)'::regprocedure) INTO d;
  n := replace(d,
    'IF NOT public.current_user_has_permission(''action:stocktake:approve'')' || E'\n' ||
    '     AND NOT public.current_user_is_manager() THEN',
    'IF NOT public.current_user_has_permission(''action:stocktake:approve'') THEN');
  IF n=d THEN RAISE EXCEPTION 'review_stocktake_session manager bypass not found'; END IF;
  EXECUTE n;
END;
$migration$;
