-- This SECURITY DEFINER routine is a trigger entry point, not a client RPC.
-- PostgreSQL checks EXECUTE when the trigger is created, not when it fires.
-- Keep the installed trigger intact while removing direct API execution.
DO $preflight$
DECLARE
  v_signature regprocedure := to_regprocedure('public.guard_transaction_header_integrity()');
BEGIN
  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'Expected trigger function public.guard_transaction_header_integrity() is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgfoid = v_signature
      AND t.tgrelid = 'public.transactions'::regclass
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Expected installed transaction header trigger is missing';
  END IF;
END;
$preflight$;

REVOKE EXECUTE ON FUNCTION public.guard_transaction_header_integrity()
  FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.guard_transaction_header_integrity()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_transaction_header_integrity()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Client EXECUTE privilege remains on trigger-only header guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgfoid = 'public.guard_transaction_header_integrity()'::regprocedure
      AND tgrelid = 'public.transactions'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Transaction header trigger was unexpectedly detached';
  END IF;
END;
$verify$;
