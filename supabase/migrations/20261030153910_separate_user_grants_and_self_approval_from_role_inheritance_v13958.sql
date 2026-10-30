DROP TRIGGER IF EXISTS trg_sync_user_permissions ON public.profiles;
DROP FUNCTION IF EXISTS public.sync_user_permissions();

DROP TRIGGER IF EXISTS sync_profile_role_auto_approval_flag_before_write ON public.profiles;
DROP FUNCTION IF EXISTS public.sync_profile_role_auto_approval_flag();

UPDATE public.profiles p
SET custom_permissions = COALESCE((
  SELECT array_agg(cp.permission_key ORDER BY cp.permission_key)
  FROM unnest(COALESCE(p.custom_permissions,ARRAY[]::text[])) AS cp(permission_key)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role_name=p.role AND rp.permission_key=cp.permission_key
  )
),ARRAY[]::text[]),
can_approve_without_workflow=false;

DROP TRIGGER IF EXISTS guard_profile_privilege_changes_before_update ON public.profiles;
DROP FUNCTION IF EXISTS public.guard_profile_privilege_changes();
