-- The authenticated 6-argument idempotent receipt wrapper performs the
-- contextual authorization check. The internal 5-argument writer is not
-- directly executable by authenticated users and must not re-check a
-- context-free permission key that would reject warehouse-scoped user grants.
DO $migration$
DECLARE d text; n text;
BEGIN
 SELECT pg_get_functiondef('public.receive_stock_transfer_quantity_at_shelf_v2(uuid,numeric,uuid,boolean,text)'::regprocedure) INTO d;
 n:=replace(d,
  '  IF NOT public.current_user_has_permission(''action:stock_transfer:receive'') THEN RAISE EXCEPTION ''Permission denied to receive stock transfers''; END IF;' || E'\n',
  '');
 IF n=d THEN RAISE EXCEPTION 'legacy global receive permission check not found in base function'; END IF;
 EXECUTE n;
END;
$migration$;
