CREATE OR REPLACE FUNCTION public.current_user_can_access_warehouse(p_warehouse_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_warehouse_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.role_warehouse_scopes rs ON rs.role_name=p.role
      WHERE p.id=(SELECT auth.uid())
        AND p.status='ACTIVE'
        AND (
          p.role='SUPER_ADMIN'
          OR (
            (cardinality(coalesce(p.assigned_warehouse_ids,ARRAY[]::uuid[]))>0
              AND p_warehouse_id=ANY(p.assigned_warehouse_ids))
            OR
            (cardinality(coalesce(p.assigned_warehouse_ids,ARRAY[]::uuid[]))=0
              AND rs.scope_mode='SELECTED'
              AND p_warehouse_id=ANY(rs.warehouse_ids))
            OR
            (cardinality(coalesce(p.assigned_warehouse_ids,ARRAY[]::uuid[]))=0
              AND rs.scope_mode='ALL')
          )
        )
        AND (
          p.role='SUPER_ADMIN'
          OR rs.scope_mode IS DISTINCT FROM 'SELECTED'
          OR p_warehouse_id=ANY(rs.warehouse_ids)
        )
    )
  END;
$function$;
