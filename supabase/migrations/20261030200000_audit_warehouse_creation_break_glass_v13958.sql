-- Route warehouse creation through the authorization engine so the
-- SUPER_ADMIN global break-glass decision is recorded at the actual RLS write
-- boundary. Preserve the existing no-assigned-warehouse restriction for
-- non-SUPER_ADMIN actors and keep the existing policy contract.

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='warehouses'
      AND policyname='warehouses_manager_insert' AND cmd='INSERT'
      AND with_check ILIKE '%current_user_can_create_warehouse%'
  ) THEN
    RAISE EXCEPTION 'Expected warehouse creation RLS policy anchor was not found';
  END IF;
  IF to_regprocedure('public.authorize_action(text,text,uuid,uuid,jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Contextual authorization engine is missing';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.current_user_can_create_warehouse()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_role text;
  v_status text;
  v_assigned uuid[];
BEGIN
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.role,p.status,COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[])
    INTO v_role,v_status,v_assigned
  FROM public.profiles p
  WHERE p.id=v_user_id;

  IF NOT FOUND OR v_status<>'ACTIVE' THEN
    RETURN false;
  END IF;

  -- A user already bound to one or more warehouses cannot create a new
  -- warehouse outside that assignment. SUPER_ADMIN is the sole global actor.
  IF v_role<>'SUPER_ADMIN' AND cardinality(v_assigned)>0 THEN
    RETURN false;
  END IF;

  -- authorize_action records explicit ALLOW/DENY decisions and always records
  -- SUPER_ADMIN break-glass even when a helper is called from an RLS policy.
  RETURN public.authorize_action(
    'action:warehouse:manage',
    NULL,
    NULL,
    NULL,
    '{}'::jsonb,
    true
  );
END;
$function$;

DO $verify$
DECLARE
  v_volatility "char";
  v_source text;
BEGIN
  SELECT p.provolatile,p.prosrc INTO v_volatility,v_source
  FROM pg_proc p
  WHERE p.oid='public.current_user_can_create_warehouse()'::regprocedure;

  IF v_volatility<>'v' OR position('authorize_action' IN v_source)=0 THEN
    RAISE EXCEPTION 'Warehouse creation helper is not volatile or does not use audited authorization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='warehouses'
      AND policyname='warehouses_manager_insert' AND cmd='INSERT'
      AND with_check ILIKE '%current_user_can_create_warehouse%'
  ) THEN
    RAISE EXCEPTION 'Warehouse creation RLS policy no longer uses the guarded helper';
  END IF;
END;
$verify$;
