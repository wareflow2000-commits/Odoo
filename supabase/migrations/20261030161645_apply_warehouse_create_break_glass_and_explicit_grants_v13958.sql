CREATE OR REPLACE FUNCTION public.current_user_can_create_warehouse()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id=(SELECT auth.uid()) AND p.status='ACTIVE'
      AND (
        p.role='SUPER_ADMIN'
        OR (
          cardinality(COALESCE(p.assigned_warehouse_ids,ARRAY[]::uuid[]))=0
          AND public.current_user_has_permission('action:warehouse:manage')
        )
      )
  );
$function$;
