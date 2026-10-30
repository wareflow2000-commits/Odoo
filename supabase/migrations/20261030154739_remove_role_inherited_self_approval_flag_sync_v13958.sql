DROP TRIGGER IF EXISTS sync_role_auto_approval_flags_after_change ON public.role_permissions;
DROP FUNCTION IF EXISTS public.sync_role_auto_approval_flags();

UPDATE public.profiles SET can_approve_without_workflow=false
WHERE can_approve_without_workflow IS DISTINCT FROM false;
