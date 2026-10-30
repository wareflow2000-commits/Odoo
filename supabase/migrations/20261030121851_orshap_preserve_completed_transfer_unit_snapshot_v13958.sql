-- Include immediately completed same-warehouse transfers when persisting
-- entered-unit evidence; the v2 writer marks these rows COMPLETED at dispatch.
DO $migration$
DECLARE
  v_definition text;
  v_old text := 'AND status IN (''IN_TRANSIT'', ''PARTIALLY_RECEIVED'');';
  v_new text := 'AND status IN (''IN_TRANSIT'', ''PARTIALLY_RECEIVED'', ''COMPLETED'');';
BEGIN
  SELECT pg_get_functiondef(
    'public.dispatch_stock_transfer_order_v3(uuid,text,uuid,uuid,jsonb,text)'::regprocedure
  ) INTO v_definition;

  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected transfer unit-snapshot status guard was not found; migration aborted';
  END IF;

  IF position(v_new IN v_definition) > 0 THEN
    RAISE NOTICE 'Completed transfer unit-snapshot guard is already present';
    RETURN;
  END IF;

  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;
END;
$migration$;
