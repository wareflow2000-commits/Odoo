-- Separation of duties: self-approval is never implied by disabling the
-- approval workflow or by an elevated role. A creator may approve their own
-- transaction only when BOTH the per-user flag and explicit auto-approval
-- permission are present. This trigger is the final guard for every status
-- transition, including calls through approve_transaction().
CREATE OR REPLACE FUNCTION public.guard_transaction_status_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_can_auto_approve boolean := false;
  v_has_auto_approve_permission boolean := false;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'APPROVED'
     AND OLD.status = 'PENDING_APPROVAL'
     AND v_user_id IS NOT NULL
     AND NEW.created_by = v_user_id THEN
    SELECT
      COALESCE(p.can_approve_without_workflow, false),
      (
        EXISTS (
          SELECT 1 FROM public.role_permissions rp
          WHERE rp.role_name = p.role
            AND rp.permission_key = 'action:transaction:auto_approve'
        )
        OR COALESCE(p.custom_permissions, ARRAY[]::text[])
             @> ARRAY['action:transaction:auto_approve']::text[]
      )
    INTO v_can_auto_approve, v_has_auto_approve_permission
    FROM public.profiles p
    WHERE p.id = v_user_id AND p.status = 'ACTIVE';

    IF NOT (COALESCE(v_can_auto_approve, false)
            AND COALESCE(v_has_auto_approve_permission, false)) THEN
      RAISE EXCEPTION 'Transaction creator cannot approve their own transaction without explicit auto-approval authorization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF current_setting('request.jwt.claim.role', true) = 'service_role'
     OR current_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'PENDING_APPROVAL'
     AND NEW.status = 'REJECTED'
     AND (SELECT public.current_user_has_permission('action:transaction:reject')) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Transaction status can only be changed through an authorized posting or rejection workflow';
END;
$function$;
