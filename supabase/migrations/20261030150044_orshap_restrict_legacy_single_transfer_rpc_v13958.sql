-- The legacy single-transfer RPC is not used by the client.
-- It posts a completed same-warehouse transfer at dispatch and does not
-- enforce destination-warehouse scope. The order-based v3 RPC is the sole
-- supported dispatch entry point.
DO $preflight$
DECLARE
  v_signature regprocedure := to_regprocedure(
    'public.dispatch_stock_transfer(uuid,text,uuid,numeric,text,date,uuid,uuid,text)'
  );
BEGIN
  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'Legacy dispatch_stock_transfer RPC is missing; review migration target';
  END IF;
  IF NOT has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'Legacy dispatch_stock_transfer RPC is already inaccessible; no migration needed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.prokind='f'
      AND p.oid <> v_signature
      AND position('dispatch_stock_transfer(' in pg_get_functiondef(p.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'A database routine still calls legacy dispatch_stock_transfer; inspect before revoking';
  END IF;
END;
$preflight$;

REVOKE EXECUTE ON FUNCTION public.dispatch_stock_transfer(
  uuid, text, uuid, numeric, text, date, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('anon',
       'public.dispatch_stock_transfer(uuid,text,uuid,numeric,text,date,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.dispatch_stock_transfer(uuid,text,uuid,numeric,text,date,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Client EXECUTE privilege remains on legacy single-transfer RPC';
  END IF;
END;
$verify$;
