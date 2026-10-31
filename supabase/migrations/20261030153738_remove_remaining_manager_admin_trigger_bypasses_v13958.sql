CREATE OR REPLACE FUNCTION public.guard_transaction_status_change()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public','auth','pg_temp'
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_can_auto_approve boolean := false;
  v_has_auto_approve_permission boolean := false;
  v_has_create_permission boolean := false;
  v_create_permission text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status='APPROVED' AND OLD.status='PENDING_APPROVAL'
     AND v_user_id IS NOT NULL AND NEW.created_by=v_user_id THEN
    SELECT COALESCE(p.can_approve_without_workflow,false) INTO v_can_auto_approve
    FROM public.profiles p WHERE p.id=v_user_id AND p.status='ACTIVE';
    v_has_auto_approve_permission := public.current_user_has_permission('action:transaction:auto_approve');
    v_create_permission := CASE NEW.transaction_type
      WHEN 'GRN' THEN 'action:transaction:grn:create'
      WHEN 'RETURN_FROM_USAGE' THEN 'action:transaction:grn:create'
      WHEN 'RETURN_FROM_CUSTOMER' THEN 'action:transaction:grn:create'
      WHEN 'ISSUE' THEN 'action:transaction:issue:create'
      WHEN 'RETURN_TO_SUPPLIER' THEN 'action:transaction:issue:create'
      WHEN 'ADJUSTMENT_IN' THEN 'action:transaction:adjustment:create'
      WHEN 'ADJUSTMENT_OUT' THEN 'action:transaction:adjustment:create'
      WHEN 'OPENING_BALANCE' THEN 'action:transaction:adjustment:create'
      ELSE 'action:transaction:never'
    END;
    v_has_create_permission := public.current_user_has_permission(v_create_permission);
    IF NOT (v_can_auto_approve AND v_has_auto_approve_permission AND v_has_create_permission) THEN
      RAISE EXCEPTION 'Transaction creator cannot approve their own transaction without explicit auto-approval authorization'
        USING ERRCODE='42501';
    END IF;
  END IF;
  IF current_setting('request.jwt.claim.role',true)='service_role'
     OR current_user IN ('postgres','supabase_admin') THEN RETURN NEW; END IF;
  IF OLD.status='PENDING_APPROVAL' AND NEW.status='REJECTED'
     AND (SELECT public.current_user_has_permission('action:transaction:reject')) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Transaction status can only be changed through an authorized posting or rejection workflow';
END;
$function$;

CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
AS $function$
DECLARE v_actor_role text;
BEGIN
  IF current_setting('request.jwt.claim.role',true)='service_role'
     OR (SELECT auth.uid()) IS NULL THEN RETURN NEW; END IF;
  SELECT p.role INTO v_actor_role FROM public.profiles p
  WHERE p.id=(SELECT auth.uid()) AND p.status='ACTIVE';
  IF v_actor_role='SUPER_ADMIN' THEN RETURN NEW; END IF;
  IF OLD.id <> (SELECT auth.uid()) THEN RAISE EXCEPTION 'You may only update your own profile'; END IF;
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.custom_permissions IS DISTINCT FROM OLD.custom_permissions
     OR NEW.can_approve_without_workflow IS DISTINCT FROM OLD.can_approve_without_workflow
     OR NEW.assigned_warehouse_ids IS DISTINCT FROM OLD.assigned_warehouse_ids
     OR NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'Only SUPER_ADMIN may change protected profile fields';
  END IF;
  RETURN NEW;
END;
$function$;
