-- Enforce the approved self-approval policy in both the RPC and status trigger.
-- This migration is intentionally guarded: it fails closed if the live function
-- definitions no longer match the reviewed source fragments.
DO $migration$
DECLARE
  v_approve text;
  v_guard text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.approve_transaction(uuid)'::regprocedure)
    INTO v_approve;

  v_old := '  IF v_actor_role IN (''SUPER_ADMIN'', ''MANAGER'', ''ADMIN'') THEN
    NULL; -- privileged manager path
  ELSIF NOT v_require_approval
        AND v_tx_rec.created_by = v_user_id
        AND v_has_create_permission THEN
    NULL; -- global direct-execution mode, limited to the creator''s permitted transaction type
  ELSIF v_tx_rec.created_by = v_user_id
        AND v_can_auto_approve
        AND v_has_auto_permission
        AND v_has_create_permission THEN
    NULL; -- per-user direct-execution permission
  ELSIF v_has_approve_permission THEN
    NULL; -- explicit approver permission
  ELSE
    RAISE EXCEPTION ''You do not have permission to post this transaction'';
  END IF;';

  v_new := '  IF v_tx_rec.created_by = v_user_id THEN
    IF ((NOT v_require_approval)
        AND v_actor_role IN (''SUPER_ADMIN'', ''MANAGER'', ''ADMIN''))
       OR (v_can_auto_approve AND v_has_auto_permission AND v_has_create_permission) THEN
      NULL; -- creator self-approval: elevated role only when workflow is globally disabled, otherwise explicit per-user grant
    ELSE
      RAISE EXCEPTION ''Transaction creator cannot approve their own transaction without explicit auto-approval authorization''
        USING ERRCODE = ''42501'';
    END IF;
  ELSIF v_actor_role IN (''SUPER_ADMIN'', ''MANAGER'', ''ADMIN'') THEN
    NULL; -- elevated approver, but not self-approval
  ELSIF v_has_approve_permission THEN
    NULL; -- explicit approver permission
  ELSE
    RAISE EXCEPTION ''You do not have permission to post this transaction'';
  END IF;';

  IF position(v_new IN v_approve) = 0 THEN
    IF position(v_old IN v_approve) = 0 THEN
      RAISE EXCEPTION 'approve_transaction source block mismatch; no changes applied';
    END IF;
    v_approve := replace(v_approve, v_old, v_new);
  END IF;

  v_old := '      ''approval_mode'', CASE
        WHEN v_actor_role IN (''SUPER_ADMIN'', ''MANAGER'', ''ADMIN'') THEN ''manager''
        WHEN NOT v_require_approval THEN ''global_direct''
        WHEN v_tx_rec.created_by = v_user_id THEN ''user_direct''
        ELSE ''approval''
      END)';
  v_new := '      ''approval_mode'', CASE
        WHEN v_tx_rec.created_by = v_user_id
             AND NOT v_require_approval
             AND v_actor_role IN (''SUPER_ADMIN'', ''MANAGER'', ''ADMIN'') THEN ''global_elevated_direct''
        WHEN v_tx_rec.created_by = v_user_id THEN ''user_direct''
        WHEN v_actor_role IN (''SUPER_ADMIN'', ''MANAGER'', ''ADMIN'') THEN ''manager''
        ELSE ''approval''
      END)';
  IF position(v_new IN v_approve) = 0 THEN
    IF position(v_old IN v_approve) = 0 THEN
      RAISE EXCEPTION 'approve_transaction audit block mismatch; no changes applied';
    END IF;
    v_approve := replace(v_approve, v_old, v_new);
  END IF;

  EXECUTE v_approve;

  SELECT pg_get_functiondef('public.guard_transaction_status_change()'::regprocedure)
    INTO v_guard;

  v_old := '  v_user_id uuid := (SELECT auth.uid());
  v_require_approval boolean := true;';
  v_new := '  v_user_id uuid := (SELECT auth.uid());
  v_actor_role text;
  v_require_approval boolean := true;';
  IF position(v_new IN v_guard) = 0 THEN
    IF position(v_old IN v_guard) = 0 THEN
      RAISE EXCEPTION 'status guard declaration mismatch; no changes applied';
    END IF;
    v_guard := replace(v_guard, v_old, v_new);
  END IF;

  v_old := '    SELECT
      COALESCE(p.can_approve_without_workflow, false),';
  v_new := '    SELECT
      p.role,
      COALESCE(p.can_approve_without_workflow, false),';
  IF position(v_new IN v_guard) = 0 THEN
    IF position(v_old IN v_guard) = 0 THEN
      RAISE EXCEPTION 'status guard profile lookup mismatch; no changes applied';
    END IF;
    v_guard := replace(v_guard, v_old, v_new);
  END IF;

  v_old := '    INTO v_can_auto_approve, v_has_auto_approve_permission';
  v_new := '    INTO v_actor_role, v_can_auto_approve, v_has_auto_approve_permission';
  IF position(v_new IN v_guard) = 0 THEN
    IF position(v_old IN v_guard) = 0 THEN
      RAISE EXCEPTION 'status guard INTO clause mismatch; no changes applied';
    END IF;
    v_guard := replace(v_guard, v_old, v_new);
  END IF;

  v_old := '    IF v_require_approval
       AND NOT (v_can_auto_approve AND v_has_auto_approve_permission) THEN';
  v_new := '    IF ((v_require_approval
         OR v_actor_role IS NULL
         OR v_actor_role NOT IN (''SUPER_ADMIN'', ''MANAGER'', ''ADMIN''))
        AND NOT (v_can_auto_approve AND v_has_auto_approve_permission)) THEN';
  IF position(v_new IN v_guard) = 0 THEN
    IF position(v_old IN v_guard) = 0 THEN
      RAISE EXCEPTION 'status guard policy condition mismatch; no changes applied';
    END IF;
    v_guard := replace(v_guard, v_old, v_new);
  END IF;

  EXECUTE v_guard;
END;
$migration$;

-- Static postconditions: both entry points remain callable only as before,
-- the approval RPC remains SECURITY DEFINER with an empty search_path.
DO $verify$
DECLARE
  v_config text[];
BEGIN
  SELECT proconfig INTO v_config
  FROM pg_proc
  WHERE oid = 'public.approve_transaction(uuid)'::regprocedure;

  IF NOT has_function_privilege('authenticated',
       'public.approve_transaction(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated approval RPC grant was unexpectedly lost';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.approve_transaction(uuid)'::regprocedure
      AND prosecdef = true
      AND proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION 'Approval RPC must remain SECURITY DEFINER with empty search_path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.guard_transaction_status_change()'::regprocedure
      AND prosecdef = false
  ) THEN
    RAISE EXCEPTION 'Status guard must remain SECURITY INVOKER';
  END IF;
END;
$verify$;
