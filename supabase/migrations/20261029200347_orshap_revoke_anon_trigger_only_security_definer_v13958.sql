-- ORSHAP WMS v13.9.58
-- These SECURITY DEFINER routines are trigger entry points, not client RPCs.
-- PostgreSQL checks EXECUTE privilege when a trigger is created, not for each row
-- processed by an already-installed trigger. Keep the trigger behavior intact while
-- removing direct API execution by PUBLIC/anon/authenticated.
DO $preflight$
DECLARE
  v_name text;
  v_signature regprocedure;
  v_expected text[] := ARRAY[
    'guard_item_base_unit_change()',
    'guard_posted_transaction_line()',
    'normalize_stock_transfer_dispatch_unit()',
    'normalize_stock_transfer_receive_snapshot()',
    'normalize_stock_transfer_return_snapshot()',
    'normalize_stocktake_line_unit()',
    'normalize_transaction_line_unit()',
    'validate_transaction_units_on_approval()'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_expected LOOP
    v_signature := to_regprocedure('public.' || v_name);
    IF v_signature IS NULL THEN
      RAISE EXCEPTION 'Expected trigger function public.% is missing; aborting', v_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgfoid = v_signature AND NOT t.tgisinternal
    ) THEN
      RAISE EXCEPTION 'Expected installed user trigger for public.% is missing; aborting', v_name;
    END IF;
  END LOOP;
END;
$preflight$;

REVOKE EXECUTE ON FUNCTION public.guard_item_base_unit_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_posted_transaction_line() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_stock_transfer_dispatch_unit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_stock_transfer_receive_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_stock_transfer_return_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_stocktake_line_unit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_transaction_line_unit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_transaction_units_on_approval() FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ')
  INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = ANY (ARRAY[
      'guard_item_base_unit_change',
      'guard_posted_transaction_line',
      'normalize_stock_transfer_dispatch_unit',
      'normalize_stock_transfer_receive_snapshot',
      'normalize_stock_transfer_return_snapshot',
      'normalize_stocktake_line_unit',
      'normalize_transaction_line_unit',
      'validate_transaction_units_on_approval'
    ])
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Client EXECUTE privileges remain on trigger-only functions: %', v_bad;
  END IF;
END;
$verify$;
