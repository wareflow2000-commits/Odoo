-- Ensure warehouse creation always records the authorization decision.
-- Preserve the existing warehouse-scope gate; add the authoritative action check
-- at the RLS write boundary so SUPER_ADMIN break-glass is audited on actual INSERT.

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'warehouses'
      AND policyname = 'warehouses_manager_insert'
      AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'Expected warehouses_manager_insert policy was not found';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.authorize_action(text,text,uuid,uuid,jsonb,boolean)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated role cannot execute authorize_action';
  END IF;
END;
$guard$;

DROP POLICY IF EXISTS warehouses_manager_insert ON public.warehouses;

CREATE POLICY warehouses_manager_insert
ON public.warehouses
FOR INSERT
TO public
WITH CHECK (
  public.current_user_can_create_warehouse()
  AND public.authorize_action(
    'action:warehouse:manage',
    NULL,
    NULL,
    NULL,
    '{}'::jsonb,
    true
  )
);

DO $verify$
DECLARE
  v_check text;
BEGIN
  SELECT with_check INTO v_check
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'warehouses'
    AND policyname = 'warehouses_manager_insert'
    AND cmd = 'INSERT';

  IF v_check IS NULL
     OR position('current_user_can_create_warehouse' IN v_check) = 0
     OR position('authorize_action' IN v_check) = 0 THEN
    RAISE EXCEPTION 'Warehouse creation policy is missing scope or audited authorization';
  END IF;
END;
$verify$;
