-- Enforce separation of duties at the data boundary. These guards protect
-- the workflow even when an elevated role or a generic approve permission is
-- used to invoke the underlying SECURITY DEFINER workflow.

CREATE OR REPLACE FUNCTION public.guard_transaction_status_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_require_approval boolean := true;
  v_can_auto_approve boolean := false;
  v_has_auto_approve_permission boolean := false;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- A transaction creator may only post their own transaction when the
  -- system-wide approval workflow is explicitly disabled, or when both the
  -- profile-level switch and the explicit auto-approval permission are set.
  IF NEW.status = 'APPROVED'
     AND OLD.status = 'PENDING_APPROVAL'
     AND v_user_id IS NOT NULL
     AND NEW.created_by = v_user_id THEN
    SELECT
      COALESCE(p.can_approve_without_workflow, false),
      (
        EXISTS (
          SELECT 1
          FROM public.role_permissions rp
          WHERE rp.role_name = p.role
            AND rp.permission_key = 'action:transaction:auto_approve'
        )
        OR COALESCE(p.custom_permissions, ARRAY[]::text[])
             @> ARRAY['action:transaction:auto_approve']::text[]
      )
    INTO v_can_auto_approve, v_has_auto_approve_permission
    FROM public.profiles p
    WHERE p.id = v_user_id
      AND p.status = 'ACTIVE';

    SELECT COALESCE(
      (SELECT s.value <> 'FALSE'
       FROM public.system_settings s
       WHERE s.key = 'REQUIRE_APPROVAL'),
      true
    )
    INTO v_require_approval;

    IF v_require_approval
       AND NOT (v_can_auto_approve AND v_has_auto_approve_permission) THEN
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

CREATE OR REPLACE FUNCTION public.guard_stock_transfer_return_review_separation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  IF OLD.return_review_status = 'PENDING'
     AND NEW.return_review_status IN ('ACCEPTED', 'REJECTED')
     AND OLD.return_requested_by IS NOT NULL
     AND OLD.return_requested_by = (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Return requester cannot review their own return request'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_stock_transfer_return_review_separation
  ON public.stock_transfers;

CREATE TRIGGER trg_guard_stock_transfer_return_review_separation
BEFORE UPDATE OF return_review_status
ON public.stock_transfers
FOR EACH ROW
EXECUTE FUNCTION public.guard_stock_transfer_return_review_separation();
