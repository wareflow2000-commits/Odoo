-- The client uses the per-transfer reject_stock_transfer_receipt RPC.
-- The bulk order wrapper has no application caller and its aggregate status
-- calculation does not model all partial-return states. Keep it out of the
-- authenticated API rather than leave a stale callable write path exposed.
REVOKE ALL ON FUNCTION public.reject_stock_transfer_order(uuid, text)
FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_function_privilege(
       'authenticated',
       'public.reject_stock_transfer_order(uuid,text)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Unused bulk transfer rejection RPC remains executable by authenticated';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.reject_stock_transfer_order(uuid,text)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Unused bulk transfer rejection RPC remains executable by anon';
  END IF;
END;
$verify$;
